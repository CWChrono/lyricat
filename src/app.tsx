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
  PreviewDeps,
} from "./reccobeats";
import {
  KeyValueStore,
  readOverrides,
  getOverride,
  setStoredBpm,
  clearStoredBpm,
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

/**
 * Find a track's 30s preview mp3 url via Pathfinder GraphQL (`trackPreview`) —
 * the transport the client itself uses. CosmosAsync can't reach external or
 * internal hosts on current clients ("Resolver not found"), and the loaded
 * track object carries no preview, so this is the one hop that works.
 */
async function getPreviewUrl(id: string): Promise<string | null> {
  const gql = (Spicetify as any).GraphQL;
  try {
    const res = await gql.Request(gql.Definitions.trackPreview, {
      uris: [`spotify:track:${id}`],
    });
    const url =
      res?.data?.lookup?.[0]?.data?.previews?.audioPreviewsV2?.items?.[0]?.url;
    if (typeof url === "string" && url.startsWith("http")) return url;
  } catch {
    /* no preview available for this track */
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
const BPM_FIELD = "catjam-set-bpm"; // manual BPM override

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

/**
 * Filter the whitelist by a query — matched against song name (regex/substring,
 * `%kill%` style) and track id/URL. Empty query returns every entry.
 */
function searchWhitelist(pattern: string): Array<{ id: string; label: string }> {
  const map = readOverrides(overridesStore);
  const all = Object.entries(map).map(([id, o]) => ({
    id,
    label: o.name ? `${o.name}  ·  ${id}` : id,
  }));
  const q = pattern.trim();
  if (!q) return all;
  const nameIds = new Set(matchByName(overridesStore, q));
  const parsed = parseTrackId(q);
  const ql = q.toLowerCase();
  return all.filter(
    (e) => nameIds.has(e.id) || e.id === parsed || e.id.toLowerCase().includes(ql)
  );
}

// The preview defaults to the now-playing track's own entry; the full JSON
// list is available on demand.
let whitelistShowFull = false;
let whitelistSearch = ""; // preserved across re-renders so typing survives refreshes

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

const FIELD_STYLE =
  "padding: 6px 10px; border-radius: 8px; border: 1px solid var(--spice-button-disabled, #555); " +
  "background: var(--spice-main, rgba(0,0,0,.3)); color: var(--spice-text, #fff);";

/**
 * Search-and-remove widget: a text box filters the whitelist as you type, a
 * dropdown lists the matches, and the button deletes the selected one — all in
 * one row. `host` is re-rendered after a deletion to refresh the list + preview.
 */
function buildRemovalWidget(host: HTMLElement): HTMLElement {
  const row = document.createElement("div");
  row.setAttribute("style", "display: flex; gap: 8px; flex-wrap: wrap; align-items: center; margin: 6px 0 10px;");

  const search = document.createElement("input");
  search.type = "text";
  search.placeholder = "Search whitelist to remove (name or id)…";
  search.value = whitelistSearch;
  search.setAttribute("style", `flex: 1 1 160px; ${FIELD_STYLE}`);

  const select = document.createElement("select");
  select.setAttribute("style", `flex: 2 1 220px; ${FIELD_STYLE}`);

  const remove = whitelistButton("Remove selected", () => {
    const id = select.value;
    if (!id) {
      Spicetify.showNotification("Cat-Jam: no entry selected", true);
      return;
    }
    const name = getOverride(overridesStore, id)?.name ?? id;
    removeOverride(overridesStore, id);
    Spicetify.showNotification(`Cat-Jam: removed ${name}`);
    renderWhitelistInto(host);
  });

  const fill = (): void => {
    const matches = searchWhitelist(whitelistSearch);
    select.textContent = "";
    if (matches.length === 0) {
      const opt = document.createElement("option");
      opt.value = "";
      opt.textContent = "(no matches)";
      select.appendChild(opt);
      return;
    }
    for (const m of matches) {
      const opt = document.createElement("option");
      opt.value = m.id;
      opt.textContent = m.label;
      select.appendChild(opt);
    }
  };
  search.oninput = () => {
    whitelistSearch = search.value;
    fill();
  };
  fill();

  row.append(search, select, remove);
  return row;
}

/** Render the whitelist preview into an injected section (current song or full list). */
function renderWhitelistInto(host: HTMLElement): void {
  host.textContent = "";

  const heading = document.createElement("h2");
  heading.className = "TypeElement-cello-textBase-type";
  heading.textContent = whitelistShowFull
    ? "Cat-Jam Whitelist — full list"
    : "Cat-Jam Whitelist — now playing";

  const removal = buildRemovalWidget(host);

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

  host.append(heading, removal, toggle, refresh, pre);
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

/** Point the manual-BPM field at the current song's stored bpm (blank if none). */
function syncBpmField(): void {
  const id = spotifyIdFromUri(Spicetify.Player.data?.item?.uri);
  const bpm = id ? getOverride(overridesStore, id)?.bpm : undefined;
  const value = bpm ? String(Math.round(bpm)) : "";
  settings.setFieldValue(BPM_FIELD, value);
  const el = document.getElementById(`${SETTINGS_ID}.${BPM_FIELD}`) as HTMLInputElement | null;
  if (el) el.value = value;
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
    const id = spotifyIdFromUri(uri);
    // 1) A stored bpm (manual override, or a cached preview result) always wins.
    const stored = id ? getOverride(overridesStore, id)?.bpm : undefined;
    if (stored) return { tempoBpm: stored };
    // 2) ReccoBeats id lookup (Spotify's tempo) covers most tracks.
    const live = await liveFetch(uri);
    if (live?.tempoBpm) return live;
    if (!id) return live;
    // 3) Missing from ReccoBeats: analyse the 30s preview once (rough), persist it.
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
  // Manual BPM override: authoritative over detection (accurate for songs the
  // preview analysis gets wrong). Blank clears it back to auto-detection.
  settings.addInput(
    BPM_FIELD,
    "Set exact BPM for the current song (blank = auto-detect)",
    "",
    () => {
      const uri = Spicetify.Player.data?.item?.uri;
      const id = spotifyIdFromUri(uri);
      if (!id) return;
      const value = Number(settings.getFieldValue(BPM_FIELD));
      if (value > 0 && Number.isFinite(value)) {
        setStoredBpm(overridesStore, id, value);
        recordName(uri, id);
      } else {
        clearStoredBpm(overridesStore, id);
      }
      controller.onSongChange(uri!, playerState());
    },
    "number",
    { min: "0", max: "400", step: "1" }
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
  void settings.pushSettings();
  // The whitelist preview + search-and-remove widget are injected below the
  // settings (spcr-settings can't render a dynamic dropdown).
  void setupWhitelistPreview();

  await ensureMounted();

  Spicetify.Player.addEventListener("songchange", () => {
    if (!document.getElementById(VIDEO_ID)?.isConnected) {
      void ensureMounted(); // Spotify rebuilt its DOM; remount lazily
    }
    controller.onSongChange(Spicetify.Player.data?.item?.uri, playerState());
    syncDelaySlider(); // show the new song's stored delay in the slider
    syncBpmField(); // show the new song's manual bpm override (if any)
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
