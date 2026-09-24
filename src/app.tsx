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
  fetchAnalysisByIsrc,
  spotifyIdFromUri,
  fetchTempoViaPreview,
  PreviewDeps,
} from "./reccobeats";
import {
  KeyValueStore,
  TrackOverride,
  BpmSource,
  readOverrides,
  getOverride,
  setStoredBpm,
  setDetectedBpm,
  clearStoredBpm,
  setDelayMs,
  setTrackName,
  setIsrc,
  flipDoubleTime,
  clearDoubleTime,
  removeOverride,
  matchByName,
  clampDelay,
  MAX_DELAY_MS,
} from "./overrides";
import { BONGOCAT_VIDEO_URL } from "./resources/bongocat";
import { createVideoPulse, PulseConfig } from "./pulse";
import { createSpicyOnsetReader } from "./spicylyrics";
import { fetchIsrcByText } from "./musicbrainz";
import { fetchGetSongBpm } from "./bpmproviders";

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

/** Depth-first scan for an `isrc`-keyed string in an arbitrary response object. */
function findIsrc(node: unknown, depth = 0): string | null {
  if (!node || typeof node !== "object" || depth > 6) return null;
  for (const [key, value] of Object.entries(node as Record<string, unknown>)) {
    if (key.toLowerCase() === "isrc" && typeof value === "string" && value) return value;
    const nested = findIsrc(value, depth + 1);
    if (nested) return nested;
  }
  return null;
}

// MusicBrainz asks for <=1 request/sec per IP. Our lookups are rare (only on an
// id miss with no in-client ISRC) and cached per track, but rapid track-skipping
// could still burst them — so serialize through a chain that holds each slot for
// MB_MIN_GAP_MS after a request completes. The returned value isn't delayed; only
// the *next* queued lookup waits.
const MB_MIN_GAP_MS = 1100;
let mbGate: Promise<unknown> = Promise.resolve();
function musicBrainzIsrc(title: string, artist?: string): Promise<string | null> {
  const run = mbGate.then(() => fetchIsrcByText((url) => fetch(url), title, artist));
  // Reopen the gate MB_MIN_GAP_MS after this request settles (success or failure).
  mbGate = run.then(
    () => sleep(MB_MIN_GAP_MS),
    () => sleep(MB_MIN_GAP_MS)
  );
  return run.catch(() => null);
}

/**
 * Best-effort ISRC lookup for a track. When ReccoBeats has no features for the
 * exact Spotify id, the same recording may be indexed under another release —
 * the ISRC finds it. Sources, cheapest first: the loaded track's metadata (free),
 * Pathfinder GraphQL, then a MusicBrainz title+artist search (`hint`). Returns
 * null when none expose an ISRC, in which case the caller falls back to preview
 * analysis — so this is purely additive and an absent ISRC never regresses.
 */
// An ISRC plus where it came from — Spotify metadata vs a MusicBrainz search — so
// the tempo it unlocks can record the fuller provenance.
type IsrcResult = { isrc: string; via: "spotify" | "musicbrainz" };

async function getIsrc(
  id: string,
  hint?: { title: string; artist?: string } | null
): Promise<IsrcResult | null> {
  const item = Spicetify.Player?.data?.item as any;
  if (item && spotifyIdFromUri(item.uri) === id) {
    const fromItem = findIsrc(item.external_ids) ?? findIsrc(item.metadata);
    if (fromItem) return { isrc: fromItem, via: "spotify" };
  }
  const gql = (Spicetify as any).GraphQL;
  try {
    const def = gql?.Definitions?.getTrack ?? gql?.Definitions?.trackMetadata;
    if (def) {
      const res = await gql.Request(def, { uri: `spotify:track:${id}` });
      const fromGql = findIsrc(res?.data);
      if (fromGql) return { isrc: fromGql, via: "spotify" };
    }
  } catch {
    /* no metadata available for this track */
  }
  if (hint?.title) {
    const fromMb = await musicBrainzIsrc(hint.title, hint.artist);
    if (fromMb) return { isrc: fromMb, via: "musicbrainz" };
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
const PULSE_BRIGHTNESS_INTENSITY_FIELD = "catjam-pulse-brightness-intensity";
const PULSE_SCALE_FIELD = "catjam-pulse-scale";
const PULSE_SCALE_INTENSITY_FIELD = "catjam-pulse-scale-intensity";
const PULSE_LYRIC_FIELD = "catjam-pulse-lyricsync";

function lyricSyncEnabled(): boolean {
  return settings.getFieldValue(PULSE_LYRIC_FIELD) === true;
}

/** Read a 0-100 intensity field as a 0..1 fraction, defaulting to 0.7. */
function intensityFraction(field: string): number {
  const raw = Number(settings.getFieldValue(field));
  return Math.min(1, Math.max(0, (Number.isFinite(raw) ? raw : 70) / 100));
}

function getPulseConfig(): PulseConfig {
  return {
    // Default ON: only an explicit false disables (guards the pre-load default).
    brightness: settings.getFieldValue(PULSE_BRIGHTNESS_FIELD) !== false,
    scale: settings.getFieldValue(PULSE_SCALE_FIELD) !== false,
    brightnessIntensity: intensityFraction(PULSE_BRIGHTNESS_INTENSITY_FIELD),
    scaleIntensity: intensityFraction(PULSE_SCALE_INTENSITY_FIELD),
  };
}

// Bongo Cat is a 2-frame loop of 200 ms (10 fps), so at rate 1 the paws flap
// 600×/min. A video BPM of 600 makes each frame land on a beat, and its rates
// (~0.1–0.25) need a lower clamp than the cat's. Extra style nudges him into
// place (a little right padding, and down out of the way of the player text).
const BONGO_DEFAULT_BPM = 600;
const BONGO_MIN_RATE = 0.1;
const BONGO_MAX_RATE = 0.35;
// Position fine-tuning: a translate offset (px) applied to the cat's rest
// transform. The pulse composes its bounce on top, so the offset survives it.
const POSITION_X_FIELD = "catjam-webm-offset-x";
const POSITION_Y_FIELD = "catjam-webm-offset-y";

/** The rest transform from the X/Y offset settings, or "" when both are 0. */
function positionTransform(): string {
  const x = Number(settings.getFieldValue(POSITION_X_FIELD)) || 0;
  const y = Number(settings.getFieldValue(POSITION_Y_FIELD)) || 0;
  return x || y ? `translate(${x}px, ${y}px)` : "";
}

// Optional mirror cat: a horizontally-flipped duplicate placed beside the main
// with an adjustable gap. Driven in lock-step by the pulse (same brightness +
// bounce, playback frame-locked), so the two cats stay in sync.
const MIRROR_ID = "catjam-webm-mirror";
// The main cat lives inside a positioning wrapper sized to the cat only, so the
// mirror (absolutely positioned inside it) can sit at a distance without ever
// reflowing/moving the original.
const WRAP_ID = "catjam-webm-wrap";
const MIRROR_ENABLED_FIELD = "catjam-mirror-enabled";

// Both bottom-player overlays anchor to the transport (symmetric around the play
// button) — set by mountVideo / mountMirror, called on resize / song change to keep
// them aligned as the bar reflows. Null when the cat is in the left library.
let reanchorOverlay: (() => void) | null = null;
let reanchorMirror: (() => void) | null = null;

function mirrorEnabled(): boolean {
  return settings.getFieldValue(MIRROR_ENABLED_FIELD) === true;
}

function isBottomPlayerPosition(): boolean {
  return String(settings.getFieldValue("catjam-webm-position") || "") === "Bottom (Player)";
}

/**
 * The mirror's rest transform: the position offset (X **inverted**) + a horizontal
 * flip. The play button is the axis of symmetry, so X pushes the pair apart/together
 * (main +X → mirror −X); Y moves both the same way. The flip is composed by the
 * pulse's bounce about a center-bottom pivot, so it flips in place.
 */
function mirrorBaseTransform(): string {
  const x = Number(settings.getFieldValue(POSITION_X_FIELD)) || 0;
  const y = Number(settings.getFieldValue(POSITION_Y_FIELD)) || 0;
  const offset = x || y ? `translate(${-x}px, ${y}px) ` : "";
  return `${offset}scaleX(-1)`;
}

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

/** Structured title/artist for the loaded track (for a MusicBrainz search), else null. */
function nameArtistFor(uri: string | undefined): { title: string; artist?: string } | null {
  const item = Spicetify.Player.data?.item;
  if (!item || item.uri !== uri || !item.name) return null;
  return { title: item.name, artist: item.artists?.[0]?.name };
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
// Force a fresh detection via a chosen mechanism (or the default cascade), bypassing
// the cache; persists + tags the result. Set in main(), used by the rescan dropdown.
let redetect:
  | ((mechanism: RedetectMechanism, uri: string) => Promise<{ bpm: number; source: BpmSource } | null>)
  | undefined;
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
// Provenance of a track's detected BPM, shown in the Currently Playing card + the
// rescan menu. A manual value (`o.bpm`) is labelled separately.
const BPM_SOURCE_LABEL: Record<BpmSource, string> = {
  reccobeats: "ReccoBeats (Spotify catalog)",
  "reccobeats-isrc": "ReccoBeats (ISRC match)",
  "reccobeats-isrc-mb": "ReccoBeats (ISRC via MusicBrainz)",
  getsongbpm: "GetSongBPM",
  preview: "preview scan — unverified",
};

// Optional GetSongBPM provider, gated on a user-supplied API key in settings.
const GETSONGBPM_KEY_FIELD = "catjam-getsongbpm-key";
const providerKey = (field: string): string => String(settings.getFieldValue(field) || "").trim();

/** Tempo provenance for an ISRC-matched BPM, by where the ISRC came from. */
function isrcSource(via: "spotify" | "musicbrainz"): BpmSource {
  return via === "musicbrainz" ? "reccobeats-isrc-mb" : "reccobeats-isrc";
}

/** How to re-run detection: a single mechanism, or the full default cascade. */
type RedetectMechanism = BpmSource | "default";

/** Human-readable provenance line for a track's effective BPM ("BPM from …"). */
function bpmStatusLabel(o: TrackOverride | undefined): string {
  if (o?.bpm != null) return "BPM from manual override";
  if (o?.detectedBpm != null) {
    return o.bpmSource
      ? `BPM from ${BPM_SOURCE_LABEL[o.bpmSource]}`
      : "BPM from an earlier scan (source not recorded — re-detect to label)";
  }
  // Reached only transiently (a value resolved this session that isn't persisted —
  // e.g. removed from the library while still playing); every detection is saved.
  return "BPM from this session (not in library — re-detect to save)";
}

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

  return head + JSON.stringify(display, null, 2) + `\n\n${bpmStatusLabel(o)}`;
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

  // Re-detect: pick a mechanism (or the default cascade) and force a fresh scan,
  // bypassing the cached value. Persists + tags the result and re-syncs the cat.
  const rescanRow = document.createElement("div");
  rescanRow.setAttribute("style", "display: flex; align-items: center; gap: 8px; flex-wrap: wrap; margin-top: 8px;");
  const mechanism = document.createElement("select");
  mechanism.setAttribute("style", `${FIELD_STYLE} cursor: pointer;`);
  const MECHANISMS: Array<{ value: RedetectMechanism; label: string }> = [
    { value: "default", label: "Default cascade (id → ISRC → providers → preview)" },
    { value: "reccobeats", label: "ReccoBeats (Spotify id)" },
    { value: "reccobeats-isrc", label: "ReccoBeats (ISRC — Spotify / MusicBrainz)" },
    { value: "getsongbpm", label: "GetSongBPM (needs API key)" },
    { value: "preview", label: "Preview scan (unverified)" },
  ];
  for (const m of MECHANISMS) {
    const opt = document.createElement("option");
    opt.value = m.value;
    opt.textContent = m.label;
    mechanism.appendChild(opt);
  }
  const rescan = whitelistButton("Re-detect BPM", () => {
    if (!redetect) return;
    const choice = mechanism.value as RedetectMechanism;
    rescan.disabled = true;
    rescan.textContent = "Detecting…";
    void redetect(choice, uri!)
      .then((found) => {
        Spicetify.showNotification(
          found
            ? `Cat-Jam: ${Math.round(found.bpm)} BPM via ${BPM_SOURCE_LABEL[found.source]}`
            : "Cat-Jam: that method found no BPM",
          !found
        );
        if (found) apply(); // re-sync the cat to the freshly detected tempo
      })
      .finally(() => renderWhitelistInto(host)); // redraw with the new value/label
  });
  rescanRow.append(mechanism, rescan);

  wrap.append(delayRow, controlsRow, rescanRow);
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

/** Common video-element setup (loop, muted, source). Style is set by the caller. */
function makeCatVideo(id: string): HTMLVideoElement {
  const video = document.createElement("video");
  video.id = id;
  video.loop = true;
  video.muted = true;
  video.playsInline = true;
  video.preload = "auto";
  video.setAttribute("aria-hidden", "true");
  video.src = getConfig().videoUrl;
  return video;
}

/** The main cat's own style inside the wrapper (size + rest transform offset). */
function mainCatStyle(isBottomPlayer: boolean): string {
  const offset = positionTransform();
  const t = offset ? ` transform: ${offset};` : "";
  return isBottomPlayer
    ? `width: 65px; height: 65px; display: block;${t}`
    : `width: 100%; height: auto; display: block;${t}`;
}

/** Left-library mirror: an absolute clone a fixed gap to the right of the main. */
function mirrorPlacement(): string {
  return "position: absolute; bottom: 0; left: calc(100% + 12px);";
}

/**
 * Mount the mirror cat as an absolutely-positioned clone inside the wrapper, or
 * remove it / no-op when disabled. It's a full second video (same source), driven
 * in lock-step by the pulse (see `pulse.setMirror`) so it inherits every behavior.
 */
function mountMirror(main: HTMLVideoElement): HTMLVideoElement | null {
  document.getElementById(MIRROR_ID)?.remove();
  reanchorMirror = null;
  if (!mirrorEnabled()) return null;
  const mirror = makeCatVideo(MIRROR_ID);

  if (isBottomPlayerPosition()) {
    // Its own top-level overlay, mirrored across the play button from the main —
    // fully dynamic (tracks the transport, flexes with the window), no fixed gap.
    mirror.setAttribute(
      "style",
      `position: fixed; pointer-events: none; z-index: 9999; width: 65px; height: 65px; display: block; transform: ${mirrorBaseTransform()};`
    );
    document.body.appendChild(mirror);
    reanchorMirror = () => anchorBottomMirror(mirror);
    reanchorMirror();
    requestAnimationFrame(() => reanchorMirror?.());
  } else {
    // Left library: an absolute clone a fixed gap right of the main, in its wrapper.
    const wrapper = main.parentElement;
    if (!wrapper) return null;
    mirror.setAttribute(
      "style",
      `width: 100%; height: auto; ${mirrorPlacement()} transform: ${mirrorBaseTransform()}; pointer-events: none;`
    );
    wrapper.appendChild(mirror);
  }

  if (Spicetify.Player.isPlaying()) safePlay(mirror);
  return mirror;
}

/** Resolve an element by selector, waiting (via observer) up to the timeout. */
async function waitForElement(selector: string): Promise<Element | null> {
  const now = document.querySelector(selector);
  if (now) return now;
  console.log("[CAT-JAM] Waiting for player UI via observer...");
  return new Promise<Element | null>((resolve) => {
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

// Both cats anchor to the transport buttons row (shuffle…loop, centered on the play
// button): the main just to its right, the mirror symmetrically to its left, each
// vertically centered on the row. Tracking the centered transport makes them a
// symmetric pair that flexes with the window — no manual distance.
const CAT_PX = 65;
const TRANSPORT_GAP_PX = 8;

/** The transport buttons row (centered on the play button), or a fallback. */
function findTransport(): Element | null {
  return (
    document.querySelector(".player-controls__buttons") ??
    document.querySelector('[data-testid="control-button-playpause"]')?.parentElement ??
    document.querySelector(".main-nowPlayingBar-center")
  );
}

/** `top` (px) that vertically centers a cat on the transport row `r`. */
function transportTop(r: DOMRect): number {
  return Math.round(r.top + r.height / 2 - CAT_PX / 2);
}

function anchorBottomOverlay(wrapper: HTMLElement): void {
  const t = findTransport();
  if (!t) return;
  const r = t.getBoundingClientRect();
  if (!r.width) return; // not laid out yet
  wrapper.style.left = `${Math.round(r.right + TRANSPORT_GAP_PX)}px`;
  wrapper.style.right = "";
  wrapper.style.top = `${transportTop(r)}px`;
  wrapper.style.bottom = "";
}

function anchorBottomMirror(mirror: HTMLElement): void {
  const t = findTransport();
  if (!t) {
    console.warn("[CAT-JAM] mirror: transport not found; can't anchor");
    return;
  }
  const r = t.getBoundingClientRect();
  if (!r.width) return;
  mirror.style.right = `${Math.round(window.innerWidth - (r.left - TRANSPORT_GAP_PX))}px`;
  mirror.style.left = "";
  mirror.style.top = `${transportTop(r)}px`;
  mirror.style.bottom = "";
}

// When the Spicy Lyrics extension is installed, its lyrics button replaces
// Spotify's built-in one: slot the Spicy button (`#SpicyLyrics_PopupLyricsButton`)
// in where the Spotify lyrics button (`[data-testid="lyrics-button"]`) sits, and
// hide the built-in. No-op when Spicy Lyrics isn't present; idempotent.
const SPICY_LYRICS_BTN_ID = "SpicyLyrics_PopupLyricsButton";
const SPOTIFY_LYRICS_SELECTOR = '[data-testid="lyrics-button"]';
let spicyRelocateObserver: MutationObserver | null = null;

function relocateSpicyLyricsIcon(): void {
  const spicy = document.getElementById(SPICY_LYRICS_BTN_ID);
  const spotify = document.querySelector(SPOTIFY_LYRICS_SELECTOR) as HTMLElement | null;
  if (!spicy || !spotify?.parentElement) return; // Spicy Lyrics absent → leave the UI alone
  if (spotify.previousElementSibling !== spicy) {
    spotify.parentElement.insertBefore(spicy, spotify); // Spicy takes the lyrics slot
  }
  if (spotify.style.display !== "none") spotify.style.display = "none"; // hide the built-in
}

/** Apply the swap and keep it applied as the bar reflows / Spicy Lyrics loads late. */
function setupSpicyLyricsRelocation(): void {
  relocateSpicyLyricsIcon();
  const bar = document.querySelector(BOTTOM_PLAYER_SELECTOR);
  if (!bar) return;
  // Re-establish on the current bar (covers Spotify rebuilding it); the callback is
  // idempotent so its own DOM edits don't loop the observer.
  spicyRelocateObserver?.disconnect();
  spicyRelocateObserver = new MutationObserver(() => relocateSpicyLyricsIcon());
  spicyRelocateObserver.observe(bar, { childList: true, subtree: true });
}

/**
 * Mounts the cat. In the bottom player it's a **top-level fixed overlay** (added to
 * <body>, pointer-events:none), anchored beside the transport — so it never pushes,
 * clips, squeezes, or blocks the player's own controls. In the left library it's an
 * in-flow absolute child of the library container. Returns the main video, or null.
 */
async function mountVideo(): Promise<HTMLVideoElement | null> {
  document.getElementById(WRAP_ID)?.remove();
  document.getElementById(VIDEO_ID)?.remove(); // stray (older builds inserted the bare video)
  document.getElementById(MIRROR_ID)?.remove();
  reanchorOverlay = null;

  const isBottomPlayer = isBottomPlayerPosition();
  const container = await waitForElement(
    isBottomPlayer ? BOTTOM_PLAYER_SELECTOR : LEFT_LIBRARY_SELECTOR
  );
  if (!container) {
    console.warn("[CAT-JAM] Player container not found; cat-jam disabled cleanly.");
    return null;
  }

  const video = makeCatVideo(VIDEO_ID);
  video.setAttribute("style", mainCatStyle(isBottomPlayer));

  const wrapper = document.createElement("div");
  wrapper.id = WRAP_ID;
  wrapper.setAttribute("aria-hidden", "true");
  wrapper.appendChild(video);

  // Dedupe here (not at function start): parallel mounts both pass the wait, so
  // whoever inserts second must clear the first.
  document.getElementById(WRAP_ID)?.remove();

  if (isBottomPlayer) {
    // Top-level overlay: out of the control row entirely. Fixed + pointer-events:none
    // → it can't move, clip, or block the icons; clicks pass straight through.
    wrapper.setAttribute("style", "position: fixed; pointer-events: none; z-index: 9999;");
    document.body.appendChild(wrapper);
    reanchorOverlay = () => anchorBottomOverlay(wrapper);
    reanchorOverlay();
    requestAnimationFrame(() => reanchorOverlay?.()); // re-measure once layout settles
  } else {
    const leftSize = Number(settings.getFieldValue("catjam-webm-position-left-size")) || 100;
    wrapper.setAttribute(
      "style",
      `position: absolute; bottom: 0; left: 0; width: ${leftSize}%; max-width: 300px; pointer-events: none; z-index: 1;`
    );
    container.insertBefore(wrapper, container.firstChild);
  }

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
  // The ReccoBeats features endpoint accepts a Spotify id *or* an ISRC; this is a
  // non-cached fetch by either (the caller persists the result).
  const featuresFetch = (ids: string) => fetchAnalysisByIsrc((url) => fetch(url), sleep, ids);

  /** Persist a detected value (bpm + provenance + name), so replays skip the APIs. */
  const cacheDetected = (id: string, bpm: number, source: BpmSource, uri: string): void => {
    setDetectedBpm(overridesStore, id, bpm, source);
    const label = labelFor(uri);
    if (label) setTrackName(overridesStore, id, label);
  };

  const fetchLike = (url: string, init?: RequestInit) => fetch(url, init);
  /**
   * Optional GetSongBPM provider — skipped without an API key. Returns a hit or null.
   */
  const runProviders = async (
    hint: { title: string; artist?: string } | null
  ): Promise<{ bpm: number; source: BpmSource } | null> => {
    if (!hint?.title) return null;
    const gs = providerKey(GETSONGBPM_KEY_FIELD);
    if (gs) {
      const b = await fetchGetSongBpm(fetchLike, gs, hint.title, hint.artist);
      if (b) return { bpm: b, source: "getsongbpm" };
    }
    return null;
  };

  const resolveAnalysis = async (uri: string): Promise<AnalysisResult | null> => {
    const id = spotifyIdFromUri(uri);
    const o = id ? getOverride(overridesStore, id) : undefined;
    // 1) Manual override wins; else a cached detected value (any prior detection).
    const effective = o?.bpm ?? o?.detectedBpm;
    if (effective) return { tempoBpm: effective };
    // 2) ReccoBeats id lookup (Spotify's tempo) covers most tracks. Persist it now
    //    (tagged), so subsequent plays reuse it instead of re-hitting ReccoBeats.
    const live = await liveFetch(uri);
    if (id && live?.isrc) setIsrc(overridesStore, id, live.isrc); // primes the ISRC fallback
    if (live?.tempoBpm) {
      if (id) cacheDetected(id, live.tempoBpm, "reccobeats", uri);
      return live;
    }
    if (!id) return live;

    const hint = nameArtistFor(uri); // capture now; the track may change during the async work

    // 3) Id miss: the exact pressing isn't in ReccoBeats, but another release of
    //    the same recording may be. Resolve the ISRC (stored first, else from
    //    Spotify metadata / MusicBrainz — backpopulating the whitelist) and look
    //    it up by ISRC. Only when no ISRC is available do we skip straight to
    //    preview analysis.
    // A stored / id-lookup ISRC is Spotify-origin; only a fresh getIsrc may be MB.
    let isrc = o?.isrc ?? live?.isrc ?? null;
    let isrcVia: IsrcResult["via"] = "spotify";
    if (!isrc) {
      const resolved = await getIsrc(id, hint);
      if (resolved) {
        isrc = resolved.isrc;
        isrcVia = resolved.via;
        setIsrc(overridesStore, id, isrc);
      }
    }
    if (isrc) {
      const byIsrc = await featuresFetch(isrc);
      if (byIsrc?.tempoBpm) {
        cacheDetected(id, byIsrc.tempoBpm, isrcSource(isrcVia), uri);
        return byIsrc;
      }
    }

    // 4) Optional GetSongBPM lookup (if an API key is set).
    const prov = await runProviders(hint);
    if (prov) {
      cacheDetected(id, prov.bpm, prov.source, uri);
      return { tempoBpm: prov.bpm };
    }

    // 5) Still nothing: analyse the 30s preview once (rough), cache it as the
    //    detected value.
    const bpm = await fetchTempoViaPreview(id, previewDeps);
    if (bpm) {
      cacheDetected(id, bpm, "preview", uri);
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

  // Force a fresh detection, bypassing the cached/override value. `default` runs the
  // normal cascade (id → ISRC → preview); a specific mechanism runs only that hop.
  // Persists + tags the result and busts the in-memory features cache so playback
  // picks it up. Returns the new value, or null if that mechanism found nothing.
  redetect = async (mechanism, uri) => {
    const id = spotifyIdFromUri(uri);
    if (!id) return null;
    const hint = nameArtistFor(uri);
    const wants = (m: RedetectMechanism) => mechanism === "default" || mechanism === m;
    let found: { bpm: number; source: BpmSource } | null = null;

    if (wants("reccobeats")) {
      const a = await featuresFetch(id); // non-cached id lookup
      if (a?.isrc) setIsrc(overridesStore, id, a.isrc);
      if (a?.tempoBpm) found = { bpm: a.tempoBpm, source: "reccobeats" };
    }
    if (!found && wants("reccobeats-isrc")) {
      let isrc = getOverride(overridesStore, id)?.isrc ?? null;
      let via: IsrcResult["via"] = "spotify";
      if (!isrc) {
        const resolved = await getIsrc(id, hint); // may fall through to MusicBrainz
        if (resolved) ({ isrc, via } = resolved);
      }
      if (isrc) setIsrc(overridesStore, id, isrc);
      const a = isrc ? await featuresFetch(isrc) : null;
      if (a?.tempoBpm) found = { bpm: a.tempoBpm, source: isrcSource(via) };
    }
    if (!found && wants("getsongbpm")) {
      const prov = await runProviders(hint);
      if (prov) found = prov;
    }
    if (!found && wants("preview")) {
      const bpm = await fetchTempoViaPreview(id, previewDeps);
      if (bpm) found = { bpm, source: "preview" };
    }

    if (found) {
      cacheDetected(id, found.bpm, found.source, uri);
      inFlight.delete(uri); // bust the dedup cache so a re-resolve sees the new value
    }
    return found;
  };

  // Beat-synced brightness/scale pulse. Self-clocked off Spicetify.Player, so it
  // stays smooth between the coarse progress events; the controller feeds it the
  // felt tempo + danceability per track.
  const pulse = createVideoPulse({
    getProgress: () => Spicetify.Player.getProgress(),
  });
  // Config is applied per-song (and via the Apply button) rather than polled every
  // frame. `applyPulseSettings` re-reads the settings + re-fetches lyric onsets.
  const applyPulseSettings = (): void => {
    pulse.setConfig(getPulseConfig());
    pulse.setPosition(positionTransform()); // live-apply the X/Y offset, no remount
    reanchorOverlay?.(); // keep the main aligned to the transport
    // Live-apply the mirror's offset + flip and re-place it symmetric to the transport.
    const mirror = document.getElementById(MIRROR_ID) as HTMLVideoElement | null;
    if (mirror) {
      mirror.style.transform = mirrorBaseTransform();
      reanchorMirror?.(); // bottom player: re-place symmetric to the transport
      pulse.setMirror(mirror); // recapture its rest transform (offset + flip)
    }
    const uri = Spicetify.Player.data?.item?.uri;
    if (uri) void readSpicyOnsets(uri).then((onsets) => pulse.setOnsets(onsets));
  };

  // Best-effort lyric-synced onsets, read from the Spicy Lyrics extension's
  // per-origin lyrics CacheStorage when the user opts in. Returns null (→ beat
  // fallback) when it's off, Spicy Lyrics is absent, or the track isn't cached.
  const readSpicyOnsets = createSpicyOnsetReader(lyricSyncEnabled);

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
    fetchOnsets: readSpicyOnsets,
  });
  catController = controller; // used by the injected panel's per-song controls

  // Single-flight: startup mount, songchange remounts and the settings
  // reload button can overlap while waiting for the player UI; without
  // this, two videos get inserted.
  const ensureMounted = singleFlight(async () => {
    const video = await mountVideo();
    controller.setVideo(video);
    pulse.attach(video);
    pulse.setMirror(video ? mountMirror(video) : null);
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
  // Fine-position offset (px). Negative X = left, negative Y = up. Applied live by
  // the "Apply pulse settings" button below, and on mount/reload.
  const OFFSET_PROPS = { step: "1" } as const;
  settings.addInput(POSITION_X_FIELD, "Position offset X (px, − left / + right)", "0", undefined, "number", OFFSET_PROPS);
  settings.addInput(POSITION_Y_FIELD, "Position offset Y (px, − up / + down)", "0", undefined, "number", OFFSET_PROPS);
  // Optional mirror cat — a flipped duplicate mirrored across the play button from
  // the main (fully dynamic, no gap to set). Toggling it remounts the overlay.
  settings.addToggle(MIRROR_ENABLED_FIELD, "Mirror cat — a second, flipped cat mirrored across the play button", false, () => {
    void ensureMounted();
  });
  // Beat-synced pulse — two independent controls, each a toggle + its own
  // intensity (0-100). Dancier songs pulse harder on top of the intensity.
  const INTENSITY_PROPS = { min: "0", max: "100", step: "5" } as const;
  settings.addToggle(PULSE_BRIGHTNESS_FIELD, "Pulse — brighten on the beat", true);
  settings.addInput(
    PULSE_BRIGHTNESS_INTENSITY_FIELD,
    "   ↳ brightness intensity (0-100)",
    "70",
    undefined,
    "number",
    INTENSITY_PROPS
  );
  settings.addToggle(PULSE_SCALE_FIELD, "Pulse — bounce (grow slightly) on the beat", true);
  settings.addInput(
    PULSE_SCALE_INTENSITY_FIELD,
    "   ↳ bounce intensity (0-100)",
    "70",
    undefined,
    "number",
    INTENSITY_PROPS
  );
  // Manual, off by default. Requires the third-party Spicy Lyrics extension —
  // without it (or without cached synced lyrics for a track) the pulse just
  // stays on the beat.
  settings.addToggle(
    PULSE_LYRIC_FIELD,
    "Pulse on lyrics instead of the beat — ⚠ needs the Spicy Lyrics extension installed; " +
      "falls back to the beat when it's missing or a track has no synced lyrics",
    false
  );
  // Optional GetSongBPM lookup — leave blank to skip. Tried only when ReccoBeats
  // can't resolve a tempo, before the preview scan. Also in the Re-detect menu.
  settings.addInput(GETSONGBPM_KEY_FIELD, "GetSongBPM API key (getsongbpm.com/api) — real BPM lookup", "");
  // Pulse settings are read once per song (not polled every frame, for performance).
  // This applies the current values to the song playing right now.
  settings.addButton(
    "catjam-pulse-apply",
    "Apply the pulse settings + position offset above to the current song (they otherwise take effect on the next song)",
    "Apply pulse settings now",
    applyPulseSettings
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
  pulse.setConfig(getPulseConfig()); // read settings once at startup
  pulse.setPlaying(Spicetify.Player.isPlaying());
  if (startUri) controller.onSongChange(startUri, playerState());
  void refreshNowPlaying(); // populate detected bpm for the track already playing
  setupSpicyLyricsRelocation(); // swap in the Spicy Lyrics button when it's installed

  Spicetify.Player.addEventListener("songchange", () => {
    if (!document.getElementById(VIDEO_ID)?.isConnected) {
      void ensureMounted(); // Spotify rebuilt its DOM; remount lazily
    }
    pulse.setConfig(getPulseConfig()); // re-read the pulse settings for the new song
    pulse.setPlaying(Spicetify.Player.isPlaying());
    controller.onSongChange(Spicetify.Player.data?.item?.uri, playerState());
    void refreshNowPlaying(); // move the panel + its controls to the now-playing song
    reanchorOverlay?.(); // the bar may have reflowed; keep the overlay aligned
    reanchorMirror?.();
    setupSpicyLyricsRelocation(); // re-apply the lyrics-button swap after any rebuild
  });

  // Keep the fixed bottom-player overlay + mirror aligned to the bar as it resizes.
  // Coalesce the burst of resize events during a drag into one reanchor per frame,
  // so we don't force a synchronous layout (getBoundingClientRect) on every event.
  let resizePending = false;
  window.addEventListener("resize", () => {
    if (resizePending) return;
    resizePending = true;
    requestAnimationFrame(() => {
      resizePending = false;
      reanchorOverlay?.();
      reanchorMirror?.();
    });
  });

  Spicetify.Player.addEventListener("onplaypause", () => {
    pulse.setPlaying(Spicetify.Player.isPlaying());
    controller.onPlayPause(playerState());
  });

  Spicetify.Player.addEventListener("onprogress", () => {
    controller.onProgress(playerState());
  });
}

export default main;
