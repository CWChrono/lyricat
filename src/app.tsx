import { SettingsSection } from "spcr-settings";
import {
  CatJamController,
  AnalysisResult,
  CatJamConfig,
  PlaybackState,
  safePlay,
  singleFlight,
} from "./controller";
import {
  DEFAULT_VIDEO_BPM,
  computePlaybackRate,
  normalizeTempo,
  effectiveTempo,
} from "./tempo";
import {
  createAnalysisFetcher,
  spotifyIdFromUri,
  fetchTempoViaPreview,
  parsePreviewUrl,
  PreviewDeps,
} from "./reccobeats";
import {
  KeyValueStore,
  readOverrides,
  getOverride,
  setStoredBpm,
  setDelayMs,
  setTrackName,
  flipDoubleTime,
  removeOverride,
  matchByName,
  clampDelay,
  MAX_DELAY_MS,
} from "./overrides";
import { BONGOCAT_VIDEO_URL } from "./resources/bongocat";

// Per-track overrides (bpm / double-time / delay) live in Spicetify LocalStorage.
const overridesStore: KeyValueStore = {
  get: (key) => Spicetify.LocalStorage.get(key),
  set: (key, value) => Spicetify.LocalStorage.set(key, value),
};

/** Best-effort cross-origin GET of text via CosmosAsync (may fail on this client). */
async function cosmosText(url: string): Promise<string> {
  try {
    const body = await Spicetify.CosmosAsync.get(url);
    if (typeof body === "string" && body) return body;
  } catch {
    /* fall through to request */
  }
  const res = await Spicetify.CosmosAsync.request("GET", url);
  const body = (res as { body?: unknown })?.body;
  return typeof body === "string" ? body : JSON.stringify(body ?? "");
}

/**
 * Find a track's 30s preview mp3 url:
 *  1. the client's already-loaded metadata (no network),
 *  2. Spotify's internal metadata service — CosmosAsync CAN reach spclient
 *     (external hosts like open.spotify.com return "Resolver not found"), and it
 *     carries the preview file id,
 *  3. the public embed page (usually blocked in-app; kept as a last resort).
 */
async function getPreviewUrl(id: string): Promise<string | null> {
  const item = Spicetify.Player.data?.item as any;
  if (item && spotifyIdFromUri(item.uri) === id) {
    const meta = item.metadata ?? {};
    for (const c of [item.previewUrl, item.preview_url, meta.preview_url, meta.audio_preview_url]) {
      if (typeof c === "string" && c.startsWith("http")) return c;
    }
  }
  try {
    const gid = Spicetify.URI.idToHex(id);
    const meta: any = await Spicetify.CosmosAsync.get(
      `https://spclient.wg.spotify.com/metadata/4/track/${gid}?market=from_token`
    );
    const fileId = Array.isArray(meta?.preview) ? meta.preview[0]?.file_id : undefined;
    if (typeof fileId === "string" && fileId) {
      return `https://p.scdn.co/mp3-preview/${fileId}`;
    }
  } catch {
    /* fall through */
  }
  try {
    const url = parsePreviewUrl(await cosmosText(`https://open.spotify.com/embed/track/${id}`));
    if (url) return url;
  } catch {
    /* ignore — logged by the caller */
  }
  return null;
}

// The preview CDN and ReccoBeats allow CORS, so plain fetch handles the audio
// download and multipart upload. The audio is streamed straight into the upload
// and never stored.
const previewDeps: PreviewDeps = {
  getPreviewUrl,
  fetchBlob: (url) => fetch(url).then((r) => r.blob()),
  postForm: (url, form) => fetch(url, { method: "POST", body: form }).then((r) => r.json()),
};

// ponytail: pinned to a commit SHA so the default asset is immutable
const DEFAULT_VIDEO_URL =
  "https://github.com/caml07/spicetify-cat-jam-synced/raw/e7bfd49fcc13457bbc98e696294cf5cf43eb6c31/src/resources/catjam.webm";

const VIDEO_ID = "catjam-webm";
const BOTTOM_PLAYER_SELECTOR = ".main-nowPlayingBar-right";
const LEFT_LIBRARY_SELECTOR = ".main-yourLibraryX-libraryItemContainer";
const OBSERVER_TIMEOUT_MS = 30_000;
const SETTINGS_ID = "catjam-settings";
const DELAY_FIELD = "catjam-delay"; // coarse slider
const DELAY_TEXT_FIELD = "catjam-delay-ms"; // fine-tune number input

const settings = new SettingsSection("Cat-Jam Settings", SETTINGS_ID);

const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

const VIDEO_SOURCES = {
  DEFAULT: "Cat Jam",
  BONGO: "Bongo Cat",
  CUSTOM: "Custom webM URL",
} as const;
const VIDEO_SOURCE_FIELD = "catjam-video-source";

// Bongo Cat is a 2-frame loop of 200 ms (10 fps), so at rate 1 the paws flap
// 600×/min. A video BPM of 600 makes each frame land on a beat, and its rates
// (~0.1–0.25) need a lower clamp than the cat's. Extra style nudges him into
// place (a little right padding, and down out of the way of the player text).
const BONGO_DEFAULT_BPM = 600;
const BONGO_MIN_RATE = 0.1;
const BONGO_MAX_RATE = 0.35;
const BONGO_EXTRA_STYLE = "margin-right: 10px; transform: translateY(17px);";

function currentSource(): string {
  return String(settings.getFieldValue(VIDEO_SOURCE_FIELD) || "");
}

function getConfig(): CatJamConfig {
  if (currentSource() === VIDEO_SOURCES.BONGO) {
    return {
      videoUrl: BONGOCAT_VIDEO_URL,
      defaultBpm: BONGO_DEFAULT_BPM,
      minRate: BONGO_MIN_RATE,
      maxRate: BONGO_MAX_RATE,
    };
  }
  const url =
    currentSource() === VIDEO_SOURCES.CUSTOM
      ? String(settings.getFieldValue("catjam-webm-link") || "") || DEFAULT_VIDEO_URL
      : DEFAULT_VIDEO_URL;
  return {
    videoUrl: url,
    defaultBpm: Number(settings.getFieldValue("catjam-webm-bpm")) || DEFAULT_VIDEO_BPM,
  };
}

function playerState(): PlaybackState {
  return {
    progressMs: Spicetify.Player.getProgress(),
    isPlaying: Spicetify.Player.isPlaying(),
  };
}

/** "Song - Artist" for a uri, but only when it is the current track. */
function labelFor(uri: string | undefined): string | undefined {
  const item = Spicetify.Player.data?.item;
  if (!item || item.uri !== uri) return undefined;
  const artist = item.artists?.[0]?.name;
  return artist ? `${item.name} - ${artist}` : item.name || undefined;
}

/** Persist the "Song - Artist" label for a track when we can determine it. */
function recordName(uri: string | undefined, id: string): void {
  const label = labelFor(uri);
  if (label) setTrackName(overridesStore, id, label);
}

/** Check BPM button: resolve the tempo, apply it, and toast the result. */
async function reportCurrentBpm(
  fetchAnalysis: (uri: string) => Promise<AnalysisResult | null>,
  controller: CatJamController
): Promise<void> {
  const item = Spicetify.Player.data?.item;
  const uri = item?.uri;
  const id = spotifyIdFromUri(uri);
  if (!id) {
    Spicetify.showNotification("Cat-Jam: no Spotify track is playing", true);
    return;
  }
  Spicetify.showNotification("Cat-Jam: checking BPM…");
  const bpm = (await fetchAnalysis(uri!))?.tempoBpm;
  if (!bpm) {
    Spicetify.showNotification("Cat-Jam: BPM unavailable for this track", true);
    return;
  }
  controller.onSongChange(uri!, playerState()); // reflect any newly-stored bpm on the cat

  const doubleTime = getOverride(overridesStore, id)?.doubleTime;
  const cfg = getConfig();
  const felt = effectiveTempo(bpm, doubleTime);
  const rate = computePlaybackRate(bpm, cfg.defaultBpm, doubleTime, cfg.minRate, cfg.maxRate);
  const foldNote = felt < bpm - 0.5 ? ` → ${felt.toFixed(0)} felt` : "";
  const tag = doubleTime !== undefined ? " [manual]" : "";
  Spicetify.showNotification(
    `Cat-Jam: ${item?.name ?? "Current track"} — ${bpm.toFixed(0)} BPM${foldNote} ` +
      `(cat ${rate.toFixed(2)}×)${tag}`
  );
}

/** Toggle button: ensure a tempo exists, flip the double-time flag, re-sync. */
async function toggleDoubleTime(
  fetchAnalysis: (uri: string) => Promise<AnalysisResult | null>,
  controller: CatJamController
): Promise<void> {
  const item = Spicetify.Player.data?.item;
  const uri = item?.uri;
  const id = spotifyIdFromUri(uri);
  if (!id) {
    Spicetify.showNotification("Cat-Jam: no Spotify track is playing", true);
    return;
  }
  const bpm = (await fetchAnalysis(uri!))?.tempoBpm;
  if (!bpm) {
    Spicetify.showNotification("Cat-Jam: BPM unavailable — can't set double-time", true);
    return;
  }
  const next = flipDoubleTime(overridesStore, id, normalizeTempo(bpm) < bpm);
  recordName(uri, id);
  controller.onSongChange(uri!, playerState());
  const cfg = getConfig();
  const rate = computePlaybackRate(bpm, cfg.defaultBpm, next, cfg.minRate, cfg.maxRate);
  Spicetify.showNotification(
    `Cat-Jam: ${item?.name ?? "Track"} — double-time ${next ? "ON" : "OFF"} ` +
      `(cat ${rate.toFixed(2)}×)`
  );
}

const WHITELIST_VIEW_ID = "catjam-whitelist-view";
const REMOVE_FIELD = "catjam-remove-id";

/** Extract a base-62 track id from a raw id, spotify: uri, or open.spotify URL. */
function parseTrackId(input: string): string | null {
  const s = input.trim();
  const uriId = spotifyIdFromUri(s);
  if (uriId) return uriId;
  const url = s.match(/track[/:]([A-Za-z0-9]{22})/); // open.spotify.com/track/ID
  if (url) return url[1];
  if (/^[A-Za-z0-9]{22}$/.test(s)) return s; // bare id
  return null;
}

/** Remove-field action: delete by track id/URL, else by best-effort name regex. */
function removeFromWhitelist(): void {
  const raw = String(settings.getFieldValue(REMOVE_FIELD) || "").trim();
  if (!raw) {
    Spicetify.showNotification("Cat-Jam: enter a track id, URL, or song name", true);
    return;
  }
  const id = parseTrackId(raw);
  if (id) {
    const removed = removeOverride(overridesStore, id);
    Spicetify.showNotification(
      removed ? `Cat-Jam: removed ${id}` : `Cat-Jam: ${id} not in whitelist`,
      !removed
    );
  } else {
    const ids = matchByName(overridesStore, raw);
    if (ids.length === 0) {
      Spicetify.showNotification(`Cat-Jam: no whitelist names match "${raw}"`, true);
      return;
    }
    const names = ids.map((i) => getOverride(overridesStore, i)?.name ?? i);
    ids.forEach((i) => removeOverride(overridesStore, i));
    Spicetify.showNotification(`Cat-Jam: removed ${ids.length} — ${names.join(", ")}`);
  }
  settings.setFieldValue(REMOVE_FIELD, "");
  settings.rerender();
  void mountWhitelistPreview(); // refresh the inline preview
}

// The preview defaults to the now-playing track's own entry; the full JSON
// list is available on demand.
let whitelistShowFull = false;

function whitelistPreviewText(): string {
  if (whitelistShowFull) {
    const map = readOverrides(overridesStore);
    return Object.keys(map).length
      ? JSON.stringify(map, null, 2)
      : "{}\n\n(empty — play some songs, or use Check BPM / Toggle double-time)";
  }
  const item = Spicetify.Player.data?.item;
  const id = spotifyIdFromUri(item?.uri);
  if (!id) return "No Spotify track playing.";
  const entry = getOverride(overridesStore, id);
  const head = `${item?.name ?? "Current track"} — ${id}\n\n`;
  return head + (entry ? JSON.stringify(entry, null, 2) : "(not in whitelist yet)");
}

function whitelistButton(label: string, onClick: () => void): HTMLButtonElement {
  const button = document.createElement("button");
  button.textContent = label;
  button.setAttribute(
    "style",
    "margin: 4px 8px 8px 0; padding: 4px 14px; border-radius: 16px; cursor: pointer; " +
      "border: 1px solid var(--spice-button-disabled, #555); background: transparent; " +
      "color: var(--spice-text, #fff);"
  );
  button.onclick = onClick;
  return button;
}

/** Render the whitelist preview into an injected section (current song or full list). */
function renderWhitelistInto(host: HTMLElement): void {
  host.textContent = "";

  const heading = document.createElement("h2");
  heading.className = "TypeElement-cello-textBase-type";
  heading.textContent = whitelistShowFull
    ? "Cat-Jam Whitelist — full list"
    : "Cat-Jam Whitelist — now playing";

  const toggle = whitelistButton(
    whitelistShowFull ? "Show current song" : "Show full list",
    () => {
      whitelistShowFull = !whitelistShowFull;
      renderWhitelistInto(host);
    }
  );
  const refresh = whitelistButton("Refresh", () => renderWhitelistInto(host));

  const pre = document.createElement("pre");
  pre.textContent = whitelistPreviewText();
  pre.setAttribute(
    "style",
    "max-height: 40vh; overflow: auto; white-space: pre-wrap; word-break: break-all; margin: 0; " +
      "padding: 12px; font-family: var(--font-mono, monospace); font-size: 12px; line-height: 1.5; " +
      "background: var(--spice-main, rgba(0,0,0,.25)); border-radius: 8px; user-select: text;"
  );

  host.append(heading, toggle, refresh, pre);
}

/** Inject the preview as a sibling right after the Cat-Jam settings section. */
async function mountWhitelistPreview(): Promise<void> {
  for (let attempt = 0; attempt < 50; attempt++) {
    const section = document.getElementById("catjam-settings");
    if (section?.parentElement) {
      let host = document.getElementById(WHITELIST_VIEW_ID);
      if (!host || host.parentElement !== section.parentElement) {
        host?.remove();
        host = document.createElement("div");
        host.id = WHITELIST_VIEW_ID;
        host.className = "x-settings-section";
        section.parentElement.insertBefore(host, section.nextSibling);
      }
      renderWhitelistInto(host);
      return;
    }
    await sleep(100);
  }
}

/** Re-inject the preview whenever the user opens Spotify's preferences page. */
async function setupWhitelistPreview(): Promise<void> {
  while (!Spicetify?.Platform?.History?.listen) await sleep(100);
  Spicetify.Platform.History.listen((loc: { pathname?: string }) => {
    if (loc?.pathname === "/preferences") void mountWhitelistPreview();
  });
  if (Spicetify.Platform.History.location?.pathname === "/preferences") {
    void mountWhitelistPreview();
  }
}

/**
 * Reflect a delay value in both delay controls (slider + number). Updates the
 * stored field value and the live DOM value directly — no rerender, so a
 * focused input keeps its cursor. `skipDomField` leaves the just-edited control
 * alone so typing isn't disturbed.
 */
function writeDelayDisplays(ms: number, skipDomField?: string): void {
  const value = String(ms);
  for (const field of [DELAY_FIELD, DELAY_TEXT_FIELD]) {
    settings.setFieldValue(field, value);
    if (field !== skipDomField) {
      const el = document.getElementById(`${SETTINGS_ID}.${field}`) as HTMLInputElement | null;
      if (el) el.value = value;
    }
  }
}

/** Point both delay controls at the current song's stored value (0 if none). */
function syncDelaySlider(): void {
  const id = spotifyIdFromUri(Spicetify.Player.data?.item?.uri);
  writeDelayDisplays(id ? getOverride(overridesStore, id)?.delayMs ?? 0 : 0);
}

/** Mounts the video into the first available container; null if UI changed shape. */
async function mountVideo(): Promise<HTMLVideoElement | null> {
  const existing = document.getElementById(VIDEO_ID);
  if (existing) existing.remove();

  const position = String(settings.getFieldValue("catjam-webm-position") || "");
  const isBottomPlayer = position === "Bottom (Player)";
  const selector = isBottomPlayer ? BOTTOM_PLAYER_SELECTOR : LEFT_LIBRARY_SELECTOR;

  const leftSize =
    Number(settings.getFieldValue("catjam-webm-position-left-size")) || 100;
  const baseStyle = isBottomPlayer
    ? "width: 65px; height: 65px;"
    : `width: ${leftSize}%; max-width: 300px; height: auto; max-height: 100%; position: absolute; bottom: 0; pointer-events: none; z-index: 1;`;
  const style =
    currentSource() === VIDEO_SOURCES.BONGO ? `${baseStyle} ${BONGO_EXTRA_STYLE}` : baseStyle;

  const video = document.createElement("video");
  video.id = VIDEO_ID;
  video.loop = true;
  video.muted = true;
  video.playsInline = true;
  video.preload = "auto";
  video.setAttribute("aria-hidden", "true");
  video.setAttribute("style", style);
  video.src = getConfig().videoUrl;

  let container = document.querySelector(selector);

  if (!container) {
    console.log("[CAT-JAM] Waiting for player UI via observer...");
    container = await new Promise<Element | null>((resolve) => {
      const observer = new MutationObserver(() => {
        const found = document.querySelector(selector);
        if (found) {
          cleanup();
          resolve(found);
        }
      });
      const timeout = setTimeout(() => {
        cleanup();
        resolve(null);
      }, OBSERVER_TIMEOUT_MS);
      const cleanup = () => {
        observer.disconnect();
        clearTimeout(timeout);
      };
      observer.observe(document.body, { childList: true, subtree: true });
    });
  }

  if (!container) {
    console.warn("[CAT-JAM] Player container not found; cat-jam disabled cleanly.");
    return null;
  }

  // Dedupe here (not at function start): parallel mounts both pass the
  // early check, so whoever inserts second must clear the first.
  document.getElementById(VIDEO_ID)?.remove();

  container.insertBefore(video, container.firstChild);
  if (Spicetify.Player.isPlaying()) safePlay(video);
  return video;
}

async function main() {
  while (!Spicetify?.Player?.addEventListener) {
    await sleep(100);
  }
  console.log("[CAT-JAM] Extension loaded.");

  // Spotify removed its own audio-analysis endpoint (Nov 2024); tempo now comes
  // from ReccoBeats. The id lookup covers most tracks; anything it misses falls
  // back to a stored value (from the preview analysis run via the buttons).
  const liveFetch = createAnalysisFetcher((url) => fetch(url), sleep);
  const fetchAnalysis = async (uri: string): Promise<AnalysisResult | null> => {
    const live = await liveFetch(uri);
    if (live?.tempoBpm) return live;
    const id = spotifyIdFromUri(uri);
    if (!id) return live;
    const stored = getOverride(overridesStore, id)?.bpm;
    if (stored) return { tempoBpm: stored };
    // Missing from ReccoBeats' id DB: analyse the 30s preview once, persist it,
    // so subsequent plays use the stored value instead of re-analysing.
    const label = labelFor(uri); // capture now; the current track may change during analysis
    const bpm = await fetchTempoViaPreview(id, previewDeps);
    if (bpm) {
      setStoredBpm(overridesStore, id, bpm);
      if (label) setTrackName(overridesStore, id, label);
      return { tempoBpm: bpm };
    }
    return live; // null — no preview available / analysis failed
  };

  const controller = new CatJamController({
    getConfig,
    fetchAnalysis,
    getDoubleTime: (uri) => {
      const id = spotifyIdFromUri(uri);
      return id ? getOverride(overridesStore, id)?.doubleTime : undefined;
    },
    getDelayMs: (uri) => {
      const id = spotifyIdFromUri(uri);
      return id ? getOverride(overridesStore, id)?.delayMs ?? 0 : 0;
    },
  });

  // Single-flight: startup mount, songchange remounts and the settings
  // reload button can overlap while waiting for the player UI; without
  // this, two videos get inserted.
  const ensureMounted = singleFlight(async () => {
    controller.setVideo(await mountVideo());
  });

  settings.addDropDown(
    VIDEO_SOURCE_FIELD,
    "Which video to show",
    [VIDEO_SOURCES.DEFAULT, VIDEO_SOURCES.BONGO, VIDEO_SOURCES.CUSTOM],
    0,
    () => {
      void ensureMounted(); // remount with the newly selected video
    }
  );
  settings.addInput(
    "catjam-webm-link",
    `Custom webM video URL (used when source is "${VIDEO_SOURCES.CUSTOM}")`,
    ""
  );
  settings.addInput("catjam-webm-bpm", "Custom default BPM of webM video (Example: 135.48)", "");
  settings.addDropDown(
    "catjam-webm-position",
    "Position where webM video should be rendered",
    ["Bottom (Player)", "Left (Library)"],
    0
  );
  settings.addInput(
    "catjam-webm-position-left-size",
    "Size of webM video on the left library (Only works for left library, Default: 100)",
    ""
  );
  // Manual sync delay: a coarse slider and a fine-tune number input, both
  // writing the current song's delay and mirroring each other's value.
  const applyDelay = (ms: number, sourceField: string): void => {
    // spcr-settings persists the field value before onChange fires; we read it back.
    const uri = Spicetify.Player.data?.item?.uri;
    const id = spotifyIdFromUri(uri);
    if (!id) return;
    const clamped = clampDelay(ms);
    setDelayMs(overridesStore, id, clamped);
    recordName(uri, id);
    writeDelayDisplays(clamped, sourceField); // update the peer control (not the one being edited)
    controller.onSongChange(uri!, playerState());
  };
  settings.addInput(
    DELAY_FIELD,
    `Manual sync delay for the current song (ms slider, max ${MAX_DELAY_MS})`,
    "0",
    () => applyDelay(Number(settings.getFieldValue(DELAY_FIELD)) || 0, DELAY_FIELD),
    "range",
    { min: "0", max: String(MAX_DELAY_MS), step: "10" }
  );
  settings.addInput(
    DELAY_TEXT_FIELD,
    `Manual sync delay — fine tune (exact ms, 0-${MAX_DELAY_MS})`,
    "0",
    () => applyDelay(Number(settings.getFieldValue(DELAY_TEXT_FIELD)) || 0, DELAY_TEXT_FIELD),
    "number",
    { min: "0", max: String(MAX_DELAY_MS), step: "1" }
  );
  settings.addButton("catjam-reload", "Reload custom values", "Save and reload", () => {
    void ensureMounted();
  });
  settings.addButton(
    "catjam-check-bpm",
    "Check the BPM of the current song",
    "Check BPM",
    () => {
      void reportCurrentBpm(fetchAnalysis, controller);
    }
  );
  settings.addButton(
    "catjam-toggle-doubletime",
    "Toggle double-time for the current song (override auto BPM detection)",
    "Toggle double-time",
    () => {
      void toggleDoubleTime(fetchAnalysis, controller);
    }
  );
  settings.addInput(
    REMOVE_FIELD,
    "Remove from whitelist — track id / URL, or song name (regex)",
    ""
  );
  settings.addButton(
    "catjam-remove",
    "Delete the whitelist entry matching the field above",
    "Remove from whitelist",
    () => {
      removeFromWhitelist();
    }
  );
  void settings.pushSettings();
  void setupWhitelistPreview(); // inject the scrollable whitelist below the settings

  await ensureMounted();

  Spicetify.Player.addEventListener("songchange", () => {
    if (!document.getElementById(VIDEO_ID)?.isConnected) {
      void ensureMounted(); // Spotify rebuilt its DOM; remount lazily
    }
    controller.onSongChange(Spicetify.Player.data?.item?.uri, playerState());
    syncDelaySlider(); // show the new song's stored delay in the slider
    const host = document.getElementById(WHITELIST_VIEW_ID);
    if (host) renderWhitelistInto(host); // keep the preview on the now-playing song
  });

  Spicetify.Player.addEventListener("onplaypause", () => {
    controller.onPlayPause(playerState());
  });

  Spicetify.Player.addEventListener("onprogress", () => {
    controller.onProgress(playerState());
  });
}

export default main;
