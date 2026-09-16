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
  clearDoubleTime,
  removeOverride,
  matchByName,
  clampDelay,
  MAX_DELAY_MS,
} from "./overrides";
import { BONGOCAT_VIDEO_URL } from "./resources/bongocat";
import { createVideoPulse, PulseConfig } from "./pulse";

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

const settings = new SettingsSection("Cat-Jam Settings", SETTINGS_ID);

const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

const VIDEO_SOURCES = {
  DEFAULT: "Cat Jam",
  BONGO: "Bongo Cat",
  CUSTOM: "Custom webM URL",
} as const;
const VIDEO_SOURCE_FIELD = "catjam-video-source";

// Beat-synced pulse: brighten and/or bounce the cat on the beat, scaled by how
// danceable the track is. The two effects toggle independently.
const PULSE_BRIGHTNESS_FIELD = "catjam-pulse-brightness";
const PULSE_SCALE_FIELD = "catjam-pulse-scale";
const PULSE_INTENSITY_FIELD = "catjam-pulse-intensity";

function getPulseConfig(): PulseConfig {
  const intensity = Number(settings.getFieldValue(PULSE_INTENSITY_FIELD));
  return {
    // Default ON: only an explicit false disables (guards the pre-load default).
    brightness: settings.getFieldValue(PULSE_BRIGHTNESS_FIELD) !== false,
    scale: settings.getFieldValue(PULSE_SCALE_FIELD) !== false,
    intensity: Math.min(1, Math.max(0, (Number.isFinite(intensity) ? intensity : 70) / 100)),
  };
}

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
let catController: CatJamController | undefined; // set in main(), for the panel's per-song controls
let nowPlayingBpm: { id: string; bpm?: number } = { id: "" };

/** The full whitelist JSON (Song Library view). */
function fullListText(): string {
  const map = readOverrides(overridesStore);
  return Object.keys(map).length
    ? JSON.stringify(map, null, 2)
    : "{}\n\n(empty — play some songs, or set BPM / toggle double-time)";
}

/** The current song's effective stats (Currently Playing card). Mirrors the
 *  card shown when a search result is selected. */
function nowPlayingCardText(): string {
  const item = Spicetify.Player.data?.item;
  const id = spotifyIdFromUri(item?.uri);
  if (!id) return "No Spotify track playing.";
  const head = `${item?.name ?? "Current track"} — ${id}\n\n`;

  // Manual override wins, else the detected value; double-time is the manual
  // flag, else the automatic octave fold.
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
  const matches = searchWhitelist(t); // resolves once the search narrows to one entry
  return matches.length === 1 ? matches[0].id : null;
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
        e.preventDefault(); // set the value before the blur hides the list
        input.value = m.label;
        whitelistSearch = m.label;
        dropdown.style.display = "none";
        updateSelected();
        input.blur(); // so clicking back in later re-fires focus and clears
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
  // Clear on focus so clicking back in starts a fresh search.
  input.onfocus = () => {
    input.value = "";
    whitelistSearch = "";
    openDropdown();
    updateSelected();
  };
  input.onblur = () => window.setTimeout(() => (dropdown.style.display = "none"), 150);
  updateSelected();

  // Inline "are you sure" confirmation (PopupModal doesn't fire on some clients).
  const confirmRow = document.createElement("div");
  confirmRow.setAttribute(
    "style",
    "display: none; align-items: center; flex-wrap: wrap; gap: 8px; margin: 0 0 10px; color: var(--spice-text, #fff);"
  );

  const remove = whitelistButton("Remove selected", () => {
    const id = resolveRemovalTarget(input.value);
    if (!id) {
      Spicetify.showNotification("Cat-Jam: pick a track from the list first", true);
      return;
    }
    const name = getOverride(overridesStore, id)?.name ?? id;
    confirmRow.textContent = "";
    const prompt = document.createElement("span");
    prompt.textContent = `Remove "${name}"?`;
    confirmRow.append(
      prompt,
      whitelistButton("Yes, remove", () => {
        removeOverride(overridesStore, id);
        whitelistSearch = "";
        Spicetify.showNotification(`Cat-Jam: removed ${name}`);
        renderWhitelistInto(host);
      }),
      whitelistButton("Cancel", () => (confirmRow.style.display = "none"))
    );
    confirmRow.style.display = "flex";
  });

  combo.append(input, dropdown);
  row.append(combo, remove);
  container.append(row, confirmRow, selectedInfo);
  return container;
}

/** A styled stats card (same look as the search-selection card). */
function trackCard(text: string): HTMLPreElement {
  const card = document.createElement("pre");
  card.textContent = text;
  card.setAttribute(
    "style",
    "margin: 0; padding: 12px; font-family: var(--font-mono, monospace); font-size: 12px; line-height: 1.6; " +
      "background: var(--spice-card, rgba(255,255,255,.05)); border-radius: 8px; white-space: pre-wrap; " +
      "word-break: break-all; user-select: text;"
  );
  return card;
}

/** A small section sub-heading ("Currently Playing" / "Song Library"). */
function sectionLabel(text: string): HTMLElement {
  const el = document.createElement("div");
  el.textContent = text;
  el.setAttribute(
    "style",
    "margin: 14px 0 6px; font-weight: 700; font-size: 14px; color: var(--spice-text, #fff);"
  );
  return el;
}

/** Per-song controls (sync delay + BPM + double-time), shown under the card in
 *  Currently Playing. `card` is updated in place on delay changes. */
function perSongControls(host: HTMLElement, card: HTMLElement): HTMLElement {
  const wrap = document.createElement("div");
  wrap.setAttribute("style", "margin-top: 10px;");
  const uri = Spicetify.Player.data?.item?.uri;
  const id = spotifyIdFromUri(uri);
  if (!id) return wrap;

  const o = getOverride(overridesStore, id);
  const effBpm = o?.bpm ?? o?.detectedBpm ?? (nowPlayingBpm.id === id ? nowPlayingBpm.bpm : undefined);
  const apply = () => catController?.onSongChange(uri!, playerState());

  // sync delay (0-500ms): label + slider + number, inline.
  const delayRow = document.createElement("div");
  delayRow.setAttribute("style", "display: flex; align-items: center; gap: 8px; flex-wrap: wrap; margin-bottom: 8px;");
  const delayLabel = document.createElement("span");
  delayLabel.textContent = "sync delay (0-500ms)";
  const slider = document.createElement("input");
  slider.type = "range";
  slider.min = "0";
  slider.max = String(MAX_DELAY_MS);
  slider.step = "10";
  slider.value = String(o?.delayMs ?? 0);
  slider.setAttribute("style", "flex: 1 1 120px;");
  const num = document.createElement("input");
  num.type = "number";
  num.min = "0";
  num.max = String(MAX_DELAY_MS);
  num.step = "1";
  num.value = String(o?.delayMs ?? 0);
  num.setAttribute("style", `width: 64px; ${FIELD_STYLE}`);
  const setDelay = (ms: number): void => {
    const c = clampDelay(ms);
    slider.value = String(c);
    num.value = String(c);
    setDelayMs(overridesStore, id, c);
    recordName(uri, id);
    apply();
    card.textContent = nowPlayingCardText();
  };
  slider.oninput = () => setDelay(Number(slider.value) || 0);
  num.oninput = () => setDelay(Number(num.value) || 0);
  delayRow.append(delayLabel, slider, num);

  // Set exact BPM + buttons.
  const bpmInput = document.createElement("input");
  bpmInput.type = "number";
  bpmInput.min = "0";
  bpmInput.max = "400";
  bpmInput.step = "1";
  bpmInput.placeholder = "Set exact BPM";
  bpmInput.value = effBpm ? String(Math.round(effBpm)) : "";
  bpmInput.setAttribute("style", `width: 120px; ${FIELD_STYLE}`);
  bpmInput.onchange = () => {
    const value = Number(bpmInput.value);
    if (value > 0 && Number.isFinite(value)) {
      const existing = getOverride(overridesStore, id);
      if (existing?.detectedBpm === undefined && nowPlayingBpm.id === id && nowPlayingBpm.bpm) {
        setDetectedBpm(overridesStore, id, nowPlayingBpm.bpm);
      }
      setStoredBpm(overridesStore, id, value);
      clearDoubleTime(overridesStore, id); // re-fire auto double-time against the felt tempo
      recordName(uri, id);
    } else {
      clearStoredBpm(overridesStore, id);
    }
    apply();
    renderWhitelistInto(host);
  };

  const controlsRow = document.createElement("div");
  controlsRow.setAttribute("style", "display: flex; align-items: center; gap: 8px; flex-wrap: wrap;");
  controlsRow.append(
    bpmInput,
    whitelistButton("Reset BPM", () => {
      clearStoredBpm(overridesStore, id);
      apply();
      renderWhitelistInto(host);
    }),
    whitelistButton("Check BPM", () => {
      if (analyze && catController) {
        void reportCurrentBpm(analyze, catController).then(() => void refreshNowPlaying());
      }
    }),
    whitelistButton("Toggle double-time", () => {
      if (analyze && catController) {
        void toggleDoubleTime(analyze, catController).then(() => renderWhitelistInto(host));
      }
    })
  );

  wrap.append(delayRow, controlsRow);
  return wrap;
}

/** Render the injected Cat-Jam Library panel (current song card or full list). */
function renderWhitelistInto(host: HTMLElement): void {
  host.textContent = "";

  const heading = document.createElement("h2");
  heading.className = "TypeElement-cello-textBase-type";
  heading.textContent = "Cat-Jam Library";

  const removal = buildRemovalWidget(host);

  const toggle = whitelistButton(
    whitelistShowFull ? "Show current song" : "Show full list",
    () => {
      whitelistShowFull = !whitelistShowFull;
      renderWhitelistInto(host);
    }
  );
  const refresh = whitelistButton("Refresh", () => renderWhitelistInto(host));
  const toggleRow = document.createElement("div");
  toggleRow.append(toggle, refresh);

  host.append(heading, removal, toggleRow);

  if (whitelistShowFull) {
    host.append(sectionLabel("Song Library"));
    const pre = document.createElement("pre");
    pre.textContent = fullListText();
    pre.setAttribute(
      "style",
      "max-height: 40vh; overflow: auto; white-space: pre-wrap; word-break: break-all; margin: 0; " +
        "padding: 12px; font-family: var(--font-mono, monospace); font-size: 12px; line-height: 1.5; " +
        "background: var(--spice-main, rgba(0,0,0,.25)); border-radius: 8px; user-select: text;"
    );
    host.append(pre);
  } else {
    host.append(sectionLabel("Currently Playing"));
    const card = trackCard(nowPlayingCardText());
    host.append(card, perSongControls(host, card));
  }
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

  // Beat-synced brightness/scale pulse. Self-clocked off Spicetify.Player, so it
  // stays smooth between the coarse progress events; the controller feeds it the
  // felt tempo + danceability per track.
  const pulse = createVideoPulse(getPulseConfig, {
    getProgress: () => Spicetify.Player.getProgress(),
    isPlaying: () => Spicetify.Player.isPlaying(),
  });

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
    pulse,
  });
  catController = controller; // used by the injected panel's per-song controls

  // Single-flight: startup mount, songchange remounts and the settings
  // reload button can overlap while waiting for the player UI; without
  // this, two videos get inserted.
  const ensureMounted = singleFlight(async () => {
    controller.setVideo(await mountVideo());
  });

  // Only the general video settings live in the native list; the per-song
  // controls (delay / BPM / double-time) are rendered in the injected Cat-Jam
  // Library panel, under the Currently Playing card.
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
  // Beat-synced pulse (independently toggleable). Dancier songs pulse harder.
  settings.addToggle(
    PULSE_BRIGHTNESS_FIELD,
    "Pulse: brighten on the beat (dancier songs pulse harder)",
    true
  );
  settings.addToggle(
    PULSE_SCALE_FIELD,
    "Pulse: bounce — grow very slightly on the beat",
    true
  );
  settings.addInput(
    PULSE_INTENSITY_FIELD,
    "Pulse intensity (0-100, scales brightness + bounce)",
    "70",
    undefined,
    "number",
    { min: "0", max: "100", step: "5" }
  );
  settings.addButton("catjam-reload", "Reload custom values", "Save and reload", () => {
    void ensureMounted();
  });
  void settings.pushSettings();
  // The whitelist preview + search-and-remove widget are injected below the
  // settings (spcr-settings can't render a dynamic dropdown).
  void setupWhitelistPreview();

  await ensureMounted();
  // Initialise rate + pulse for the track already playing (the songchange event
  // only fires on the next track otherwise).
  const startUri = Spicetify.Player.data?.item?.uri;
  if (startUri) controller.onSongChange(startUri, playerState());
  void refreshNowPlaying(); // populate detected bpm for the track already playing

  Spicetify.Player.addEventListener("songchange", () => {
    if (!document.getElementById(VIDEO_ID)?.isConnected) {
      void ensureMounted(); // Spotify rebuilt its DOM; remount lazily
    }
    controller.onSongChange(Spicetify.Player.data?.item?.uri, playerState());
    void refreshNowPlaying(); // move the panel + its controls to the now-playing song
  });

  Spicetify.Player.addEventListener("onplaypause", () => {
    controller.onPlayPause(playerState());
  });

  Spicetify.Player.addEventListener("onprogress", () => {
    controller.onProgress(playerState());
  });
}

export default main;
