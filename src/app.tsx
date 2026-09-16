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
  setDetectedBpm,
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
// Nudge into place and force it above every overlay (max z-index). `position`
// is added per-slot in mountVideo so z-index applies without breaking the
// absolutely-positioned left-library layout.
const BONGO_EXTRA_STYLE = "margin-right: 10px; transform: translateY(17px); z-index: 2147483647;";

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

// The current track's resolved bpm, so the preview can show detected values for
// songs that aren't in the whitelist. `analyze` is the (deduped) fetcher, set up
// in main().
let analyze: ((uri: string) => Promise<AnalysisResult | null>) | undefined;
let nowPlayingBpm: { id: string; bpm?: number } = { id: "" };

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
  const head = `${item?.name ?? "Current track"} — ${id}\n\n`;

  // Always show the effective bpm + double-time for the current song, whether or
  // not it's saved: manual override wins, else the detected value; double-time is
  // the manual flag, else the automatic octave fold.
  const o = getOverride(overridesStore, id);
  const effBpm = o?.bpm ?? o?.detectedBpm ?? (nowPlayingBpm.id === id ? nowPlayingBpm.bpm : undefined);
  if (effBpm == null) return head + "(detecting BPM…)";

  const display: Record<string, number | boolean> = {
    bpm: Math.round(effBpm),
    doubleTime: o?.doubleTime ?? normalizeTempo(effBpm) < effBpm,
  };
  if (o?.detectedBpm != null && Math.round(o.detectedBpm) !== Math.round(effBpm)) {
    display.detectedBpm = Math.round(o.detectedBpm);
  }
  if (o?.delayMs) display.delayMs = o.delayMs;

  const status =
    o?.bpm != null ? "manual BPM override" : o ? "detected (in whitelist)" : "detected (not saved)";
  return head + JSON.stringify(display, null, 2) + `\n\n${status}`;
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
 * Resolve the removal field to a track id: the id trailing a chosen "Name · id"
 * option, a pasted id/uri/url, or a single name match. Null if unresolved.
 */
function resolveRemovalTarget(text: string): string | null {
  const t = text.trim();
  if (!t) return null;
  const trailing = t.match(/([A-Za-z0-9]{22})\s*$/); // id embedded in a chosen option
  if (trailing && getOverride(overridesStore, trailing[1])) return trailing[1];
  const direct = parseTrackId(t);
  if (direct && getOverride(overridesStore, direct)) return direct;
  const ids = matchByName(overridesStore, t);
  return ids.length === 1 ? ids[0] : null;
}

/** Show an "are you sure" prompt, running onConfirm only if the user confirms. */
function confirmRemove(label: string, onConfirm: () => void): void {
  const box = document.createElement("div");
  const msg = document.createElement("p");
  msg.textContent = `Are you sure you want to remove "${label}" from the whitelist?`;
  msg.setAttribute("style", "margin: 0 0 16px;");
  const buttons = document.createElement("div");
  buttons.setAttribute("style", "display: flex; gap: 8px; justify-content: flex-end;");
  buttons.append(
    whitelistButton("Cancel", () => Spicetify.PopupModal.hide()),
    whitelistButton("Remove", () => {
      Spicetify.PopupModal.hide();
      onConfirm();
    })
  );
  box.append(msg, buttons);
  Spicetify.PopupModal.display({ title: "Cat-Jam", content: box });
}

/**
 * Type-to-search removal: a styled custom combobox filters the whitelist as you
 * type, the picked entry's data shows underneath, and "Remove selected" confirms
 * then deletes it. `host` is re-rendered afterwards to refresh the list + preview.
 */
function buildRemovalWidget(host: HTMLElement): HTMLElement {
  const container = document.createElement("div");

  const row = document.createElement("div");
  row.setAttribute("style", "display: flex; gap: 8px; align-items: flex-start; margin: 6px 0 8px;");

  // The input + dropdown live in a positioned wrapper so the list floats below.
  const combo = document.createElement("div");
  combo.setAttribute("style", "position: relative; flex: 1 1 260px;");

  const input = document.createElement("input");
  input.type = "text";
  input.placeholder = "Type a song name or id to remove…";
  input.value = whitelistSearch;
  input.setAttribute("style", `width: 100%; box-sizing: border-box; ${FIELD_STYLE}`);

  const dropdown = document.createElement("div");
  dropdown.setAttribute(
    "style",
    "position: absolute; top: calc(100% + 4px); left: 0; right: 0; z-index: 1000; max-height: 240px; " +
      "overflow-y: auto; background: var(--spice-card, #282828); border: 1px solid var(--spice-button-disabled, #555); " +
      "border-radius: 8px; box-shadow: 0 8px 24px rgba(0,0,0,.45); display: none;"
  );

  // The picked entry's stored data, shown under the search once resolved.
  const selectedInfo = document.createElement("pre");
  selectedInfo.setAttribute(
    "style",
    "margin: 0 0 10px; padding: 8px 12px; font-family: var(--font-mono, monospace); font-size: 12px; " +
      "line-height: 1.5; background: var(--spice-card, rgba(255,255,255,.05)); border-radius: 8px; " +
      "white-space: pre-wrap; word-break: break-all; display: none;"
  );
  const updateSelected = (): void => {
    const id = resolveRemovalTarget(input.value);
    const entry = id ? getOverride(overridesStore, id) : undefined;
    if (id && entry) {
      selectedInfo.textContent = `${entry.name ?? id} — ${id}\n${JSON.stringify(entry, null, 2)}`;
      selectedInfo.style.display = "block";
    } else {
      selectedInfo.style.display = "none";
    }
  };

  const renderOptions = (): void => {
    dropdown.textContent = "";
    const matches = searchWhitelist(input.value);
    if (matches.length === 0) {
      const empty = document.createElement("div");
      empty.textContent = "(no matches)";
      empty.setAttribute("style", "padding: 8px 12px; color: var(--spice-subtext, #a7a7a7);");
      dropdown.appendChild(empty);
      return;
    }
    for (const m of matches) {
      const opt = document.createElement("div");
      opt.textContent = m.label;
      opt.setAttribute(
        "style",
        "padding: 8px 12px; cursor: pointer; white-space: nowrap; overflow: hidden; text-overflow: ellipsis;"
      );
      opt.onmouseenter = () => (opt.style.background = "var(--spice-highlight, rgba(255,255,255,.1))");
      opt.onmouseleave = () => (opt.style.background = "transparent");
      opt.onmousedown = (e) => {
        e.preventDefault(); // keep input focus; fires before blur
        input.value = m.label;
        whitelistSearch = m.label;
        dropdown.style.display = "none";
        updateSelected();
      };
      dropdown.appendChild(opt);
    }
  };
  const openDropdown = (): void => {
    renderOptions();
    dropdown.style.display = "block";
  };

  input.oninput = () => {
    whitelistSearch = input.value;
    openDropdown();
    updateSelected();
  };
  input.onfocus = () => openDropdown();
  input.onblur = () => window.setTimeout(() => (dropdown.style.display = "none"), 150);
  updateSelected();

  const remove = whitelistButton("Remove selected", () => {
    const id = resolveRemovalTarget(input.value);
    if (!id) {
      Spicetify.showNotification("Cat-Jam: pick a track from the list first", true);
      return;
    }
    const name = getOverride(overridesStore, id)?.name ?? id;
    confirmRemove(name, () => {
      removeOverride(overridesStore, id);
      whitelistSearch = "";
      Spicetify.showNotification(`Cat-Jam: removed ${name}`);
      renderWhitelistInto(host);
    });
  });

  combo.append(input, dropdown);
  row.append(combo, remove);
  container.append(row, selectedInfo);
  return container;
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

/** Resolve the current track's bpm and refresh the preview to show it. */
async function refreshNowPlaying(): Promise<void> {
  const uri = Spicetify.Player.data?.item?.uri;
  const id = spotifyIdFromUri(uri);
  nowPlayingBpm = { id: id ?? "" };
  let host = document.getElementById(WHITELIST_VIEW_ID);
  if (host) renderWhitelistInto(host); // reflect the new track (may show "detecting…")
  if (!id || !analyze) return;
  const a = await analyze(uri!);
  if (spotifyIdFromUri(Spicetify.Player.data?.item?.uri) !== id) return; // track changed
  nowPlayingBpm = { id, bpm: a?.tempoBpm ?? undefined };
  syncBpmField(); // the field can now show the resolved (detected) value
  host = document.getElementById(WHITELIST_VIEW_ID);
  if (host) renderWhitelistInto(host);
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

/** Point the manual-BPM field at the current song's effective bpm (manual, else detected). */
function syncBpmField(): void {
  const id = spotifyIdFromUri(Spicetify.Player.data?.item?.uri);
  const o = id ? getOverride(overridesStore, id) : undefined;
  const bpm = o?.bpm ?? o?.detectedBpm ?? (nowPlayingBpm.id === id ? nowPlayingBpm.bpm : undefined);
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
    currentSource() === VIDEO_SOURCES.BONGO
      ? // bottom-player slot is statically positioned, so add position:relative
        // there for z-index to take effect; the left library is already absolute.
        `${baseStyle} ${BONGO_EXTRA_STYLE}${isBottomPlayer ? " position: relative;" : ""}`
      : baseStyle;

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
  const resolveAnalysis = async (uri: string): Promise<AnalysisResult | null> => {
    const id = spotifyIdFromUri(uri);
    const o = id ? getOverride(overridesStore, id) : undefined;
    // 1) Manual override wins; else a cached detected value (preview result).
    const effective = o?.bpm ?? o?.detectedBpm;
    if (effective) return { tempoBpm: effective };
    // 2) ReccoBeats id lookup (Spotify's tempo) covers most tracks.
    const live = await liveFetch(uri);
    if (live?.tempoBpm) return live;
    if (!id) return live;
    // 3) Missing from ReccoBeats: analyse the 30s preview once (rough), cache it
    //    as the detected value.
    const label = labelFor(uri); // capture now; the current track may change during analysis
    const bpm = await fetchTempoViaPreview(id, previewDeps);
    if (bpm) {
      setDetectedBpm(overridesStore, id, bpm);
      if (label) setTrackName(overridesStore, id, label);
      return { tempoBpm: bpm };
    }
    return live; // null — no preview available / analysis failed
  };
  // Dedupe concurrent lookups for the same uri (controller + preview both ask on
  // song change) so a missing track's preview isn't analysed twice.
  const inFlight = new Map<string, Promise<AnalysisResult | null>>();
  const fetchAnalysis = (uri: string): Promise<AnalysisResult | null> => {
    let pending = inFlight.get(uri);
    if (!pending) {
      pending = resolveAnalysis(uri).finally(() => inFlight.delete(uri));
      inFlight.set(uri, pending);
    }
    return pending;
  };
  analyze = fetchAnalysis;

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
  // preview analysis gets wrong). Blank clears it back to the detected value.
  settings.addInput(
    BPM_FIELD,
    "Set exact BPM for the current song (blank = use detected)",
    "",
    () => {
      const uri = Spicetify.Player.data?.item?.uri;
      const id = spotifyIdFromUri(uri);
      if (!id) return;
      const value = Number(settings.getFieldValue(BPM_FIELD));
      if (value > 0 && Number.isFinite(value)) {
        // Preserve the detected value the first time it's overridden, so it can
        // be reset to later.
        const existing = getOverride(overridesStore, id);
        if (existing?.detectedBpm === undefined && nowPlayingBpm.id === id && nowPlayingBpm.bpm) {
          setDetectedBpm(overridesStore, id, nowPlayingBpm.bpm);
        }
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
  settings.addButton(
    "catjam-reset-bpm",
    "Reset the exact BPM back to the auto-detected value",
    "Reset BPM to detected",
    () => {
      const uri = Spicetify.Player.data?.item?.uri;
      const id = spotifyIdFromUri(uri);
      if (!id) return;
      clearStoredBpm(overridesStore, id);
      controller.onSongChange(uri!, playerState());
      syncBpmField();
      void refreshNowPlaying();
    }
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
  void refreshNowPlaying(); // populate detected bpm for the track already playing

  Spicetify.Player.addEventListener("songchange", () => {
    if (!document.getElementById(VIDEO_ID)?.isConnected) {
      void ensureMounted(); // Spotify rebuilt its DOM; remount lazily
    }
    controller.onSongChange(Spicetify.Player.data?.item?.uri, playerState());
    syncDelaySlider(); // show the new song's stored delay in the slider
    syncBpmField(); // show the new song's manual bpm override (if any)
    void refreshNowPlaying(); // keep the preview on the now-playing song + its detected bpm
  });

  Spicetify.Player.addEventListener("onplaypause", () => {
    controller.onPlayPause(playerState());
  });

  Spicetify.Player.addEventListener("onprogress", () => {
    controller.onProgress(playerState());
  });
}

export default main;
