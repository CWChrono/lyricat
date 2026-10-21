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
  previewBackfillCandidates,
  unsourcedBackfillCandidates,
  setStoredBpm,
  setDetectedBpm,
  recordDetection,
  clearStoredBpm,
  setDelayMs,
  setTrackName,
  setIsrc,
  setDoubleTime,
  setDetectedMeter,
  clearDoubleTime,
  removeOverride,
  matchByName,
  clampDelay,
  MAX_DELAY_MS,
  getLyricOffset,
  setLyricOffset,
  clampLyricOffset,
  MAX_LYRIC_OFFSET_MS,
  getBookmark,
  setBookmark,
  clearBookmark,
  getSingerNames,
  setSingerName,
  DEFAULT_SINGER_NAMES,
  getTrackLanguage,
  setTrackLanguage,
} from "./overrides";
import { BONGOCAT_CLOSED_URL, BONGOCAT_OPEN_URL } from "./resources/bongocat";
import { POPCAT_CLOSED_URL, POPCAT_OPEN_URL } from "./resources/popcat";
import { createVideoPulse, PulseConfig, CatMedia, PulseOnset } from "./pulse";
import { createSpicyOnsetReader, lyricSpans, spansToOnsets, readSpicyLyricsCache, listSpicyLyricsCache, lyricLines, plainLyricLines, romanizationSpans } from "./spicylyrics";
import { timedLines, TimedLine, LyricSpan, splitRomanWords } from "./syllables";
import { tokenizeLine, reconcileLine } from "./lineedit";
import { detectSongLanguage, LANG_LABEL, SongLang } from "./langdetect";
import { romanizeWordsAsync, canRomanize } from "./romanize";
import { readOnsetCache, writeOnsetCache, clearOnsetCache, removeOnsetCache } from "./onsetcache";
import { fetchAudioAnalysis, loudnessAt, AudioAnalysis } from "./audioanalysis";
import { fetchIsrcByText } from "./musicbrainz";
import { fetchLrclibSynced, parseLrc, LrcTrack } from "./lrclib";
import { readLrcCache, writeLrcCache, listLrcCache, deleteLrcCache, LRC_VERSION } from "./lyriccache";
import {
  hasWordTimestamps,
  parseWordLrc,
  wordOnsets,
  mirrorWordOnsets,
  parseWordLrcLines,
  serializeWordLrcLines,
  LrcWord,
} from "./lrcwords";
import { wordLrcToTtml } from "./ttml";
import { writeSpicyLocalLyric, removeSpicyLocalLyric, syncSpicyLocalLyrics } from "./spicydb";
import { fetchGetSongBpm, fetchMusicaeFeatures, fetchMusicaeDj, ProviderResult } from "./bpmproviders";
import { remaining as rateRemaining, consume as rateConsume, utcDay } from "./ratelimit";
import {
  DriveCreds,
  BundleParts,
  SyncState,
  DriveClient,
  hasCreds as hasDriveCreds,
  buildBundle,
  buildLibraryBundle,
  readBundle,
  fingerprint as bundleFingerprint,
  hashContent,
  lyricFileName,
  trackIdFromFileName,
  lyricCategory,
  LYRIC_CATEGORIES,
  LyricCategory,
  decideAutoSync,
  needsDownload,
  createDriveClient,
  buildAuthUrl,
  parseAuthCode,
  exchangeCode,
  LIBRARY_FILENAME,
  LYRICS_FOLDER,
} from "./drivesync";

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
// Readiness gate for the bottom player. Spotify 1.3.5 dropped `.main-nowPlayingBar-right`, so match
// the stable now-playing-bar testid first, then legacy/hashed class fallbacks (the bottom cat is a
// body-level overlay anchored via findTransport(), so this only needs to confirm the bar exists).
const BOTTOM_PLAYER_SELECTOR =
  '[data-testid="now-playing-bar"], .main-nowPlayingBar-right, [class*="nowPlayingBar"], [class*="now-playing-bar"]';
const LEFT_LIBRARY_SELECTOR = ".main-yourLibraryX-libraryItemContainer";
const OBSERVER_TIMEOUT_MS = 30_000;
const SETTINGS_ID = "catjam-settings";

const settings = new SettingsSection("Lyricat Settings", SETTINGS_ID);

const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

const VIDEO_SOURCES = {
  DEFAULT: "Cat Jam",
  BONGO: "Bongo Cat",
  POP: "Pop Cat",
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
// Experimental (visualizer): time line-synced syllable pops to Spotify's audio-analysis
// segment boundaries instead of even spacing. Needs the internal analysis endpoint.
const AUDIO_WORD_TIMING_FIELD = "catjam-audio-word-timing";
// Experimental (visualizer): Bongo's pulse strength follows the exact audio loudness.
const BONGO_FLUX_FIELD = "catjam-bongo-fluctuations";
// Debug: a real-time overlay colouring each lyric word white once the mechanism marks it
// "played" (grey before), so the word-timing can be eyeballed against the music.
const WORD_DEBUG_FIELD = "catjam-word-debug";
// The keys tapped per word in the lyric editor's record feature (any of several single keys, so
// you can alternate hands rhythmically; default "." and "/", which sit together under the right
// hand). Other editor hotkeys are fixed: "," = green bar, "b" = bookmark, "s" = save, "z" = undo.
const RECORD_KEY_FIELD = "catjam-record-key";

/** The configured record-tap keys (lowercased single chars), default {".", "/"}. */
function recordKeys(): Set<string> {
  const v = settings.getFieldValue(RECORD_KEY_FIELD);
  // Keep alphanumerics plus the punctuation keys we allow as taps (. and /); drop everything else.
  const chars = typeof v === "string" ? v.toLowerCase().replace(/[^a-z0-9./]/g, "").split("") : [];
  return chars.length ? new Set(chars) : new Set([".", "/"]);
}

function lyricSyncEnabled(): boolean {
  return settings.getFieldValue(PULSE_LYRIC_FIELD) === true;
}

function audioWordTiming(): boolean {
  return settings.getFieldValue(AUDIO_WORD_TIMING_FIELD) === true;
}

function bongoFollowsFluctuations(): boolean {
  return settings.getFieldValue(BONGO_FLUX_FIELD) === true;
}

function wordDebugEnabled(): boolean {
  return settings.getFieldValue(WORD_DEBUG_FIELD) === true;
}

// Cloud sync (Google Drive, OAuth refresh-token flow). These four + the enable toggle drive the
// daily upload-only auto-sync and the manual Upload/Download buttons. A plain API key can't write
// private Drive files, so the full OAuth triple (client id/secret/refresh token) is required.
const SYNC_ENABLED_FIELD = "catjam-sync-enabled";
const DRIVE_CLIENT_FIELD = "catjam-drive-client";
const DRIVE_SECRET_FIELD = "catjam-drive-secret";
const DRIVE_REFRESH_FIELD = "catjam-drive-refresh";
const DRIVE_FOLDER_FIELD = "catjam-drive-folder";
// Where the daily-check bookkeeping (fingerprint / cloud modifiedTime / lastCheckDay) is kept, and
// the single pre-download backup slot (overwritten each Download → "the most recent replica").
const SYNC_STATE_KEY = "catjam-cloudsync-state";
const SYNC_BACKUP_KEY = "catjam-cloudsync-backup";
// Loopback redirect for the manual in-panel re-auth. No server listens on it — the browser lands on a
// "can't connect" page whose address bar holds the ?code=… the user copies back. Matches the
// installed-client's registered "http://localhost".
const DRIVE_REAUTH_REDIRECT = "http://localhost";
// Settings fields NEVER carried in the bundle: the Drive credentials themselves (so a Download can't
// wipe the creds you just typed on this machine) and the enable toggle (kept per-machine).
const SYNC_EXCLUDED_FIELDS = new Set([
  SYNC_ENABLED_FIELD,
  DRIVE_CLIENT_FIELD,
  DRIVE_SECRET_FIELD,
  DRIVE_REFRESH_FIELD,
  DRIVE_FOLDER_FIELD,
]);

function syncEnabled(): boolean {
  return settings.getFieldValue(SYNC_ENABLED_FIELD) === true;
}

function driveCreds(): DriveCreds {
  const s = (f: string): string => {
    const v = settings.getFieldValue(f);
    return typeof v === "string" ? v.trim() : "";
  };
  return {
    clientId: s(DRIVE_CLIENT_FIELD),
    clientSecret: s(DRIVE_SECRET_FIELD),
    refreshToken: s(DRIVE_REFRESH_FIELD),
    folderId: s(DRIVE_FOLDER_FIELD),
  };
}

// Per-track analysis fetcher (segments + beats), set in main() — used by the word-timing
// debug overlay so it matches the audio-timed path when that's on.
let getTrackAnalysis: ((uri: string) => Promise<AudioAnalysis | null>) | undefined;
// Resolve a track's lyric LINES through the full chain (Spicy Lyrics → saved LRC → LRCLIB) for
// the debug overlay. Set in main() where the lyric sources + track metadata are in scope.
let getTrackLyricLines: ((uri: string) => Promise<LyricSpan[][] | null>) | undefined;
// Drop a track's memoized own-LRC generation after the editor saves, so the next read picks up
// the committed (edited) version instead of the stale generated one. Set in main().
let invalidateOwnLrc: ((id: string) => void) | undefined;
// Forget ALL derived state for a track (own-LRC memo + LRCLIB-miss flag + cached onsets) so a
// freshly-deleted generated LRC is rebuilt from scratch on the next resolve. Set in main().
let forgetLrc: ((id: string) => void) | undefined;
// The currently-open word-timing editor, so a song change can auto-load the next track's lyrics into
// the same host when the editor is FOLLOWING the playing track. `token` disambiguates reused hosts.
let activeLyricEditor: { host: HTMLElement; token: number; following: boolean } | null = null;
let editorSeq = 0;
// Bumped on every follow-reload; a resolution/open that finds its gen stale bails, so rapid skips
// never render a stale editor (only the latest reload wins).
let editorReloadGen = 0;
// Resolve a track's best lyrics (saved → generated → read-only Spicy) and open the editor. `gen` ties
// a follow-reload to its generation (omitted for a manual open). Set in main().
let resolveAndOpenEditor: ((id: string, host: HTMLElement, gen?: number) => void) | undefined;

// --- Word-timing debug overlay -------------------------------------------------------
// A fixed strip near the top that shows the current lyric line and turns each word white
// the moment the mechanism marks it played (grey before) — a live read on the timing.
const WORD_DEBUG_ID = "catjam-word-debug-overlay";
let wordDebugLines: TimedLine[] | null = null;
let wordDebugTrackId = "";
let wordDebugTimer: ReturnType<typeof setInterval> | null = null;
let wordDebugLineIdx = -2;
let wordDebugWordEls: HTMLElement[] = [];

// Lyrics land a few seconds into a cold track — probe repeatedly after the song loads so the
// overlay fills in automatically once the sync is available, instead of giving up on the first
// miss. Per-iteration sleeps (ms); the chain (Spicy → saved LRC → LRCLIB) is retried each time.
const WORD_DEBUG_PROBES_MS = [0, 400, 800, 1500, 2500, 3500, 5000];

async function loadWordDebug(uri: string | undefined): Promise<void> {
  const id = spotifyIdFromUri(uri);
  wordDebugLineIdx = -2; // force a re-render of the line
  if (!id) {
    wordDebugLines = null;
    wordDebugTrackId = "";
    return;
  }
  wordDebugTrackId = id;
  for (const delay of WORD_DEBUG_PROBES_MS) {
    if (delay > 0) await sleep(delay);
    if (wordDebugTrackId !== id || !wordDebugEnabled()) return; // track changed / toggled off
    const grouped = getTrackLyricLines ? await getTrackLyricLines(uri!) : null;
    if (wordDebugTrackId !== id) return; // track changed during the lookup
    if (grouped) {
      // Match the audio-timed path when it's on, so the overlay shows what the cat uses.
      let a: AudioAnalysis | null = null;
      if (audioWordTiming() && getTrackAnalysis) {
        a = await getTrackAnalysis(uri!);
        if (wordDebugTrackId !== id) return; // track changed during the analysis fetch
      }
      wordDebugLines = timedLines(grouped, a?.segments, a?.beats);
      wordDebugLineIdx = -2; // re-render with the freshly loaded lines
      return;
    }
    wordDebugLines = null; // nothing yet → "(no synced lyrics)" placeholder, then retry
  }
}

function wordDebugBox(): HTMLElement {
  let box = document.getElementById(WORD_DEBUG_ID);
  if (!box) {
    box = document.createElement("div");
    box.id = WORD_DEBUG_ID;
    box.setAttribute(
      "style",
      "position:fixed; top:72px; left:50%; transform:translateX(-50%); z-index:800; max-width:70vw; " +
        "padding:10px 18px; border-radius:10px; background:rgba(0,0,0,.72); color:#666; " +
        "font-size:20px; font-weight:700; line-height:1.35; text-align:center; pointer-events:none; " +
        "white-space:normal; backdrop-filter:blur(2px);"
    );
    document.body.appendChild(box);
  }
  return box;
}

// `getProgress()` reports the player's position, which trails the *audible* audio by the output
// latency — so lighting a word exactly at `now >= start` lands after you've sung it (reads as
// "completed"). Light it slightly ahead of its onset so it lights up as the word plays.
const WORD_DEBUG_LEAD_MS = 200;

function renderWordDebug(nowMs: number): void {
  // Anticipate the onset to counter playback-position lag, then subtract the track's lyric offset so
  // each word lights at its effective (offset-applied) time — matching the shifted onsets/editor.
  const now = nowMs + WORD_DEBUG_LEAD_MS - getLyricOffset(overridesStore, wordDebugTrackId);
  const lines = wordDebugLines;
  const box = wordDebugBox();
  if (!lines || lines.length === 0) {
    if (wordDebugLineIdx !== -1) {
      box.textContent = "♪ (no synced lyrics)";
      box.style.color = "#888";
      wordDebugLineIdx = -1;
      wordDebugWordEls = [];
    }
    return;
  }
  // Current line = the latest whose start ≤ now (and still before the next line's start).
  let idx = -1;
  for (let i = 0; i < lines.length; i++) {
    if (lines[i].start <= now) idx = i;
    else break;
  }
  if (idx !== wordDebugLineIdx) {
    wordDebugLineIdx = idx;
    box.textContent = "";
    wordDebugWordEls = [];
    if (idx < 0) {
      box.textContent = "♪";
      return;
    }
    for (const w of lines[idx].words) {
      const span = document.createElement("span");
      span.textContent = w.text + " ";
      span.style.cssText = "color:#666; transition:color 90ms linear;";
      box.appendChild(span);
      wordDebugWordEls.push(span);
    }
  }
  if (idx < 0) return;
  const words = lines[idx].words;
  for (let i = 0; i < words.length && i < wordDebugWordEls.length; i++) {
    wordDebugWordEls[i].style.color = words[i].start <= now ? "#fff" : "#666";
  }
}

function startWordDebug(): void {
  if (wordDebugTimer) return;
  wordDebugTimer = setInterval(() => {
    if (!wordDebugEnabled()) {
      stopWordDebug();
      return;
    }
    renderWordDebug(Spicetify.Player.getProgress());
  }, 50);
}

function stopWordDebug(): void {
  if (wordDebugTimer) {
    clearInterval(wordDebugTimer);
    wordDebugTimer = null;
  }
  document.getElementById(WORD_DEBUG_ID)?.remove();
  wordDebugLineIdx = -2;
  wordDebugWordEls = [];
}

/** (Re)load the current track's timed words and start/stop the overlay per the toggle. */
function refreshWordDebug(uri: string | undefined): void {
  if (!wordDebugEnabled()) {
    stopWordDebug();
    return;
  }
  void loadWordDebug(uri).then(() => startWordDebug());
}

/** Pop Cat animates its frame off syllables (mouth open while singing) by design. */
function perPulseSource(): boolean {
  return currentSource() === VIDEO_SOURCES.POP;
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

// Bongo and Pop Cat are 2-frame <img> sources — the pulse drives their frames off
// the beat/syllable clock, not video playback — so no playback-rate constants are
// needed. `defaultBpm` is a required config field but unused for image sources
// (the beat clock runs off the track's felt tempo).
const BONGO_DEFAULT_BPM = 600;
const POP_DEFAULT_BPM = 300;
// Pop Cat's art fills its frame more than the others, so it reads oversized at the
// shared cat size — render it a bit smaller (both cats + their bottom-player anchor).
const POP_SIZE_SCALE = 0.72;
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
// Experimental: the MIRROR Pop Cat "sings" the background/secondary vocals (pops on their onsets)
// while the main Pop Cat sings the lead — so a line with both parts drives the two cats separately.
const MIRROR_BG_VOCALS_FIELD = "catjam-mirror-background-vocals";

// Both bottom-player overlays anchor to the transport (symmetric around the play
// button) — set by mountVideo / mountMirror, called on resize / song change to keep
// them aligned as the bar reflows. Null when the cat is in the left library.
let reanchorOverlay: (() => void) | null = null;
let reanchorMirror: (() => void) | null = null;
// Advance the video source to the next choice (Bongo → Pop → Cat Jam → Custom →…)
// and remount. Set in main(); invoked by clicking the cat or its mirror.
let cycleVideoSource: (() => void) | undefined;

function mirrorEnabled(): boolean {
  return settings.getFieldValue(MIRROR_ENABLED_FIELD) === true;
}

function mirrorBackgroundVocals(): boolean {
  return settings.getFieldValue(MIRROR_BG_VOCALS_FIELD) === true;
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
  // Bongo Cat is the default when nothing is stored yet.
  return String(settings.getFieldValue(VIDEO_SOURCE_FIELD) || VIDEO_SOURCES.BONGO);
}

function getConfig(): CatJamConfig {
  const customLink = String(settings.getFieldValue("catjam-webm-link") || "").trim();
  // A Custom source with no URL falls back to Bongo Cat (behaves exactly like it).
  const source =
    currentSource() === VIDEO_SOURCES.CUSTOM && !customLink ? VIDEO_SOURCES.BONGO : currentSource();
  if (source === VIDEO_SOURCES.BONGO) {
    // Bongo Cat is now a 2-frame <img> source too: the pulse swaps the paws on the
    // beat clock (no playback-rate floor), so even very slow BPMs animate correctly.
    return {
      videoUrl: BONGOCAT_CLOSED_URL, // the <img>'s initial src (frames drive it thereafter)
      defaultBpm: BONGO_DEFAULT_BPM, // used only for the felt-tempo beat clock
      frames: { closed: BONGOCAT_CLOSED_URL, open: BONGOCAT_OPEN_URL },
    };
  }
  if (source === VIDEO_SOURCES.POP) {
    // Pop Cat is a 2-frame <img> source: it always animates per pulse (the mouth
    // follows the sung syllable), and rests + bounces on the beat with no lyrics.
    return {
      videoUrl: POPCAT_CLOSED_URL, // the <img>'s initial src (frames drive it thereafter)
      defaultBpm: POP_DEFAULT_BPM,
      syllableFrames: true,
      frames: { closed: POPCAT_CLOSED_URL, open: POPCAT_OPEN_URL },
    };
  }
  // Cat Jam, or Custom with a URL.
  const url = source === VIDEO_SOURCES.CUSTOM ? customLink : DEFAULT_VIDEO_URL;
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

/** Round a BPM to one decimal place (for display / input). */
function round1(n: number): number {
  return Math.round(n * 10) / 10;
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

/** Title/artist/album/duration for the loaded track (for an LRCLIB lookup), else null. */
function lrcTrackFor(uri: string | undefined): LrcTrack | null {
  const item = Spicetify.Player.data?.item;
  if (!item || item.uri !== uri || !item.name) return null;
  const extra = item as unknown as { album?: { name?: string }; duration?: { milliseconds?: number } };
  const durMs = extra.duration?.milliseconds ?? Spicetify.Player.data?.duration;
  return {
    title: item.name,
    artist: item.artists?.[0]?.name,
    album: extra.album?.name,
    durationSec: typeof durMs === "number" && durMs > 0 ? Math.round(durMs / 1000) : undefined,
  };
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
    Spicetify.showNotification("Lyricat: no Spotify track is playing", true);
    return;
  }
  Spicetify.showNotification("Lyricat: checking BPM…");
  const bpm = (await fetchAnalysis(uri!))?.tempoBpm;
  if (!bpm) {
    Spicetify.showNotification("Lyricat: BPM unavailable for this track", true);
    return;
  }
  controller.onSongChange(uri!, playerState()); // reflect any newly-stored bpm on the cat

  const doubleTime = getOverride(overridesStore, id)?.doubleTime;
  const cfg = getConfig();
  const felt = effectiveTempo(bpm, doubleTime);
  const rate = computePlaybackRate(bpm, cfg.defaultBpm, doubleTime, cfg.minRate, cfg.maxRate);
  const foldNote = felt < bpm - 0.5 ? ` → ${felt.toFixed(1)} felt` : "";
  const tag = doubleTime !== undefined ? " [manual]" : "";
  Spicetify.showNotification(
    `Lyricat: ${item?.name ?? "Current track"} — ${bpm.toFixed(1)} BPM${foldNote} ` +
      `(cat ${rate.toFixed(2)}×)${tag}`
  );
}

// Meter divisor options for the per-song control. "detected" clears the manual
// override and re-detects (once per bar); the numbers cut the tempo into that meter.
// The default meter is "Detected": the cat bounces once per bar (BPM ÷ the track's
// time signature), resolved automatically from the free providers on play. "1×" is
// the raw override (a bounce per beat); the rest are explicit manual cuts.
const METER_OPTIONS: ReadonlyArray<{ value: string; label: string }> = [
  { value: "detected", label: "Meter: Detected" },
  { value: "1", label: "Meter: 1× (raw)" },
  { value: "2", label: "Meter: ½ (÷2)" },
  { value: "3", label: "Meter: ⅓ (÷3)" },
  { value: "4", label: "Meter: ¼ (÷4)" },
  { value: "8", label: "Meter: ⅛ (÷8)" },
  { value: "16", label: "Meter: 1/16 (÷16)" },
];

// A detected meter is only applied for meters *other* than common time: 4/4 (the
// overwhelming majority) bounces on every beat with no override, so it reads as plain
// 1×; 3/4 → ÷3, 6/8 → ÷6, … land the cat on the downbeat (once per bar).
function isMeterfulTimeSignature(timeSignature: number | null | undefined): timeSignature is number {
  return typeof timeSignature === "number" && timeSignature >= 2 && timeSignature !== 4;
}

/**
 * The auto-detected felt-tempo divisor for a track: an odd time signature wins (3/4 →
 * ÷3), otherwise fall back to the octave fold — a beat detector reports double (or
 * quadruple) the felt tempo for slow/sparse songs, so a raw ~168 is really ~84 (÷2).
 * Returns 1 when neither applies (common time at a normal tempo → bounce per beat).
 */
function autoMeterDivisor(bpm: number | undefined, timeSignature: number | null | undefined): number {
  if (isMeterfulTimeSignature(timeSignature)) return timeSignature;
  if (typeof bpm === "number" && bpm > 0) return Math.max(1, Math.round(bpm / normalizeTempo(bpm)));
  return 1;
}

/** Apply a chosen meter divisor to a track. "detected" clears manual state and
 *  re-runs meter detection (caller wires the async detect via detectMeter). */
function setMeterForTrack(id: string, uri: string | undefined, choice: string): void {
  if (choice === "detected") clearDoubleTime(overridesStore, id);
  else setDoubleTime(overridesStore, id, Number(choice));
  recordName(uri, id);
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
let whitelistSourceFilter = "all"; // full-list filter/sort by BPM source (see fullListText)

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
// Sweep every "preview"-sourced whitelist entry through the rate-limited providers,
// upgrading rough preview BPMs to real ones until the daily API budget runs out.
// Set in main(); driven by the panel's Backfill button. `onProgress` ticks per track.
type BackfillSummary = { candidates: number; updated: number; spent: number; budgetExhausted: boolean; noKey?: boolean };
let backfillPreview:
  | ((onProgress?: (done: number, total: number) => void) => Promise<BackfillSummary>)
  | undefined;
// Detect a track's time signature from the providers and set it as the (detected)
// meter divisor. Returns the numerator, or null if none found. Set in main().
let detectMeter: ((uri: string) => Promise<number | null>) | undefined;
// Auto-apply the default "Detected" meter for a freshly-played track that has no
// meter set yet — free providers only (no rate-limited budget), silent, only when
// unset. Re-applies to the cat + UI when it lands. Set in main().
let autoDetectMeter: ((uri: string | undefined) => Promise<void>) | undefined;
let nowPlayingBpm: { id: string; bpm?: number } = { id: "" };

/** The full whitelist JSON (Song Library view). */
/** The BPM-source bucket a track sorts/filters under ("unsourced" when none). */
function sourceBucket(o: TrackOverride): string {
  return effectiveBpmSource(o) ?? "unsourced";
}

/** The full library as JSON, grouped/sorted by BPM source, optionally filtered to one
 *  source. `filter === "all"` keeps every entry (still grouped by source, then name). */
function fullListText(filter: string): string {
  const map = readOverrides(overridesStore);
  let entries = Object.entries(map);
  if (!entries.length) return "{}\n\n(empty — play some songs, or set BPM / toggle double-time)";
  entries.sort(([ka, a], [kb, b]) => {
    const sa = sourceBucket(a);
    const sb = sourceBucket(b);
    if (sa !== sb) return sa.localeCompare(sb);
    return (a.name ?? ka).localeCompare(b.name ?? kb);
  });
  if (filter !== "all") entries = entries.filter(([, o]) => sourceBucket(o) === filter);
  if (!entries.length) return `(no entries with BPM source "${filter}")`;
  return JSON.stringify(Object.fromEntries(entries), null, 2);
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
  "musicae-spotify": "Musicae Spotify (RapidAPI)",
  "musicae-dj": "Musicae DJ (RapidAPI)",
  preview: "preview scan — unverified",
};

// Terse provenance for the compact sidebar panel — no "(Spotify catalog)" tails
// that overflow the narrow now-playing column.
const BPM_SOURCE_SHORT: Record<BpmSource | "manual", string> = {
  manual: "manual override",
  reccobeats: "ReccoBeats",
  "reccobeats-isrc": "ReccoBeats (ISRC)",
  "reccobeats-isrc-mb": "ReccoBeats (ISRC)",
  getsongbpm: "GetSongBPM",
  "musicae-spotify": "Musicae Spotify",
  "musicae-dj": "Musicae DJ",
  preview: "preview scan",
};

/** Short "BPM from …" line for the compact panel, or "detecting…" when unknown. */
function bpmSourceShort(o: TrackOverride | undefined): string {
  const src = effectiveBpmSource(o);
  return src ? `BPM from ${BPM_SOURCE_SHORT[src]}` : "detecting…";
}

// Optional GetSongBPM provider, gated on a user-supplied API key in settings.
const GETSONGBPM_KEY_FIELD = "catjam-getsongbpm-key";
// One RapidAPI key shared by the Musicae providers below.
const RAPIDAPI_KEY_FIELD = "catjam-rapidapi-key";
const providerKey = (field: string): string => String(settings.getFieldValue(field) || "").trim();

// Rate-limited BPM providers, tried in order after GetSongBPM and before the
// preview scan. Each resolves a real tempo straight from the Spotify id; each has
// its own small daily budget (enforced via ./ratelimit) so the shared key isn't
// throttled. Appending a future provider here is all it takes to extend the chain.
interface RateLimitedProvider {
  source: BpmSource; // provenance tag + rate-limit bucket id
  dailyLimit: number;
  fetch: (key: string, id: string) => Promise<ProviderResult>;
}
const RATE_LIMITED_PROVIDERS: readonly RateLimitedProvider[] = [
  { source: "musicae-spotify", dailyLimit: 10, fetch: (k, id) => fetchMusicaeFeatures((u, i) => fetch(u, i), k, id) },
  { source: "musicae-dj", dailyLimit: 10, fetch: (k, id) => fetchMusicaeDj((u, i) => fetch(u, i), k, id) },
];

/** Tempo provenance for an ISRC-matched BPM, by where the ISRC came from. */
function isrcSource(via: "spotify" | "musicbrainz"): BpmSource {
  return via === "musicbrainz" ? "reccobeats-isrc-mb" : "reccobeats-isrc";
}

/** How to re-run detection: a single mechanism, or the full default cascade. */
type RedetectMechanism = BpmSource | "default";

/**
 * The source of a track's *effective* BPM as a tag: "manual" for a hand-set value,
 * the provider tag for a detected/promoted value, else undefined. Mirrors
 * bpmStatusLabel's precedence so the card's `bpmSource` field matches its label.
 */
function effectiveBpmSource(o: TrackOverride | undefined): BpmSource | "manual" | undefined {
  if (o?.bpm != null) {
    return o.bpmSource && o.detectedBpm === o.bpm ? o.bpmSource : "manual";
  }
  return o?.detectedBpm != null ? o.bpmSource : undefined;
}

/** Human-readable provenance line for a track's effective BPM ("BPM from …"). */
function bpmStatusLabel(o: TrackOverride | undefined): string {
  if (o?.bpm != null) {
    // A real-provider value promoted to the authoritative bpm still credits its
    // source; only a hand-set value (no source, or edited away from the detection)
    // reads as a manual override.
    if (o.bpmSource && o.detectedBpm === o.bpm) return `BPM from ${BPM_SOURCE_LABEL[o.bpmSource]}`;
    return "BPM from manual override";
  }
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

  // `detectedBpm` is the raw value from the provider (or a manual override); `timeCut`
  // is the applied meter divisor; `bpm` is what the cat actually uses = detectedBpm ÷
  // timeCut. When there's no cut, bpm == detectedBpm and detectedBpm is omitted.
  const o = getOverride(overridesStore, id);
  const detected = o?.bpm ?? o?.detectedBpm ?? (nowPlayingBpm.id === id ? nowPlayingBpm.bpm : undefined);
  if (detected == null) return head + "(detecting BPM…)";

  const divisor = o?.doubleTime ?? 1;
  const display: Record<string, number | string> = {
    bpm: round1(detected / divisor), // the tempo the cat actually bounces at
    bpmSource: effectiveBpmSource(o) ?? "detecting…", // "manual" for a hand-set override
    timeCut: divisor,
  };
  if (divisor > 1) display.detectedBpm = round1(detected); // raw, before the cut
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

/** Dropdown to filter/sort the full library by BPM source. Options: All, each provider
 *  (+ manual), and Unsourced. Persists the choice in `whitelistSourceFilter`. */
function buildSourceFilter(host: HTMLElement): HTMLSelectElement {
  const options: ReadonlyArray<readonly [string, string]> = [
    ["all", "All sources"],
    ...Object.entries(BPM_SOURCE_SHORT).map(([k, v]) => [k, v] as const),
    ["unsourced", "Unsourced"],
  ];
  const select = document.createElement("select");
  select.setAttribute("style", `margin: 4px 8px 8px 0; cursor: pointer; ${FIELD_STYLE}`);
  select.title = "Filter the library by BPM source";
  for (const [value, label] of options) {
    const opt = document.createElement("option");
    opt.value = value;
    opt.textContent = value === "all" ? label : `Source: ${label}`;
    if (value === whitelistSourceFilter) opt.selected = true;
    select.appendChild(opt);
  }
  select.onchange = () => {
    whitelistSourceFilter = select.value;
    renderWhitelistInto(host);
  };
  return select;
}

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
      Spicetify.showNotification("Lyricat: pick a track from the list first", true);
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
        Spicetify.showNotification(`Lyricat: removed ${name}`);
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
  // The BPM field shows the *felt* tempo (raw ÷ meter) so it matches the card + meter.
  const rawBpm = o?.bpm ?? o?.detectedBpm ?? (nowPlayingBpm.id === id ? nowPlayingBpm.bpm : undefined);
  const divisor = o?.doubleTime ?? 1;
  const feltBpm = rawBpm != null ? round1(rawBpm / divisor) : undefined;
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
  bpmInput.step = "0.1";
  bpmInput.placeholder = "Set felt BPM";
  bpmInput.value = feltBpm != null ? String(feltBpm) : "";
  bpmInput.setAttribute("style", `width: 120px; ${FIELD_STYLE}`);
  bpmInput.onchange = () => {
    const felt = Number(bpmInput.value);
    if (felt > 0 && Number.isFinite(felt)) {
      const existing = getOverride(overridesStore, id);
      if (existing?.detectedBpm === undefined && nowPlayingBpm.id === id && nowPlayingBpm.bpm) {
        setDetectedBpm(overridesStore, id, nowPlayingBpm.bpm);
      }
      setStoredBpm(overridesStore, id, round1(felt * divisor)); // store raw; meter re-divides
      recordName(uri, id); // keep the current meter override — editing BPM doesn't reset it
    } else {
      clearStoredBpm(overridesStore, id);
    }
    apply();
    renderWhitelistInto(host);
  };

  // Meter divisor: Detected (once per bar, the default) or a manual cut.
  const meterOverride = getOverride(overridesStore, id);
  const meterSelect = document.createElement("select");
  meterSelect.setAttribute("style", `${FIELD_STYLE} cursor: pointer;`);
  // Show the concrete meter the cat is actually using: "Detected ÷N" only for a real
  // (non-4/4) detected meter; a manual cut selects its own divisor; everything else —
  // common time, undetected, not yet resolved — reads as raw 1×.
  const currentMeter = meterOverride?.meterDetected
    ? "detected"
    : meterOverride?.doubleTime !== undefined
      ? String(meterOverride.doubleTime)
      : "1";
  for (const m of METER_OPTIONS) {
    const opt = document.createElement("option");
    opt.value = m.value;
    opt.textContent = m.label;
    if (m.value === currentMeter) opt.selected = true;
    meterSelect.appendChild(opt);
  }
  // A detected meter replaces the plain "Detected" label with the resolved divisor.
  if (meterOverride?.meterDetected) {
    (meterSelect.children[0] as HTMLOptionElement).textContent =
      `Meter: Detected ÷${meterOverride.doubleTime}${meterOverride.timeSignature ? ` (${meterOverride.timeSignature}/4)` : ""}`;
  }
  meterSelect.onchange = () => {
    const choice = meterSelect.value;
    if (choice === "detected") {
      if (!detectMeter) return;
      setMeterForTrack(id, uri, "detected"); // clear any manual cut first
      meterSelect.disabled = true;
      void detectMeter(uri!)
        .then((divisor) => {
          Spicetify.showNotification(
            divisor && divisor > 1
              ? `Lyricat: meter detected — ÷${divisor}`
              : "Lyricat: no cut needed — bouncing per beat"
          );
          apply();
        })
        .finally(() => renderWhitelistInto(host));
      return;
    }
    setMeterForTrack(id, uri, choice);
    apply();
    renderWhitelistInto(host);
  };
  // Re-detect button, shown to the right of the bar only when a manual cut is set.
  const meterReset = whitelistButton("Re-detect", () => {
    setMeterForTrack(id, uri, "detected");
    apply();
    void detectMeter?.(uri!).finally(() => renderWhitelistInto(host));
    renderWhitelistInto(host);
  });

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
    meterSelect
  );
  // Only offer "Re-detect" when a manual cut is overriding the detected default.
  if (meterOverride?.doubleTime !== undefined && !meterOverride?.meterDetected) controlsRow.append(meterReset);

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
    { value: "musicae-spotify", label: "Musicae Spotify (RapidAPI key, 10/day)" },
    { value: "musicae-dj", label: "Musicae DJ (RapidAPI key, 10/day)" },
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
            ? `Lyricat: ${found.bpm.toFixed(1)} BPM via ${BPM_SOURCE_LABEL[found.source]}`
            : "Lyricat: that method found no BPM",
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

/**
 * GetSongBPM requires a backlink to getsongbpm.com wherever its API is used. Shown
 * in the panel whenever a GetSongBPM key is configured (i.e. when we call their API).
 */
function buildGetSongBpmCredit(): HTMLElement | null {
  if (!providerKey(GETSONGBPM_KEY_FIELD)) return null;
  const wrap = document.createElement("div");
  wrap.setAttribute(
    "style",
    "margin-top: 16px; padding-top: 10px; border-top: 1px solid var(--spice-button-disabled, #333); " +
      "font-size: 12px; color: var(--spice-subtext, #a7a7a7);"
  );
  const link = document.createElement("a");
  link.href = "https://getsongbpm.com/";
  link.textContent = "BPM data powered by GetSongBPM";
  link.setAttribute("style", "color: var(--spice-text, #1ed760); text-decoration: underline; cursor: pointer;");
  link.onclick = (e) => {
    e.preventDefault();
    try {
      window.open("https://getsongbpm.com/", "_blank"); // open in the default browser
    } catch {
      /* the visible credit still satisfies the attribution */
    }
  };
  wrap.appendChild(link);
  return wrap;
}

/**
 * spcr-settings renders field labels as escaped text, so the "(getsongbpm.com/api)"
 * in the API-key label is inert. Rewrite that fragment into a real anchor once the
 * label exists. Idempotent — re-runs harmlessly on every preferences re-render.
 */
let getSongBpmLabelObserver: MutationObserver | undefined;

function patchGetSongBpmKeyLabel(): void {
  const label = document.querySelector<HTMLLabelElement>(
    `label[for="${SETTINGS_ID}.${GETSONGBPM_KEY_FIELD}"]`
  );
  if (label && !getSongBpmLabelObserver && label.parentElement) {
    // spcr re-renders the label (input changes, navigation) and wipes the patch;
    // re-apply on any subtree change. Idempotent guard below prevents loops.
    getSongBpmLabelObserver = new MutationObserver(() => patchGetSongBpmKeyLabel());
    getSongBpmLabelObserver.observe(label.parentElement, { childList: true, subtree: true });
  }
  if (!label || label.querySelector("a[data-catjam-getsongbpm-link]")) return;

  const marker = "getsongbpm.com/api";
  const idx = label.textContent?.indexOf(marker) ?? -1;
  if (idx < 0) return;
  const full = label.textContent ?? "";

  const link = document.createElement("a");
  link.href = "https://getsongbpm.com/api";
  link.textContent = marker;
  link.setAttribute("data-catjam-getsongbpm-link", "1");
  link.setAttribute("style", "color: var(--spice-text, #1ed760); text-decoration: underline; cursor: pointer;");
  link.onclick = (e) => {
    e.preventDefault();
    try {
      window.open("https://getsongbpm.com/api", "_blank"); // open in the default browser
    } catch {
      /* no-op */
    }
  };

  label.textContent = "";
  label.append(
    document.createTextNode(full.slice(0, idx)),
    link,
    document.createTextNode(full.slice(idx + marker.length))
  );
}

/** Count of timed words/lines a cached LRC holds (its timestamp tags). */
function lrcEntryCount(lrc: string): number {
  return hasWordTimestamps(lrc) ? parseWordLrc(lrc).length : (lrc.match(/\[\d{1,3}:\d{2}/g) ?? []).length;
}

// A word's bar segment, carrying refs to its two resize nibs (a word spanning a row boundary is
// drawn as several segments — see layoutWord).
interface SegEl extends HTMLElement {
  _leftNib?: HTMLElement;
  _rightNib?: HTMLElement;
  // Last-applied layout values, so a relayout that doesn't actually change a segment skips the
  // style writes (and the style recalc they trigger).
  _x?: number;
  _w?: number;
  _title?: string;
}
// One editable word in the timeline editor: an LrcWord plus the DOM bars + label that show it,
// and the index of the lyric line it belongs to (kept so line markers survive a save).
interface EditWord extends LrcWord {
  line: number;
  els?: SegEl[];
  label?: HTMLElement;
  roman?: string; // romanization from Spicy Lyrics (lazy-loaded), shown when the "w" toggle is on
}

// Clicking a seekable marker (yellow line start, purple bookmark) jumps playback this far BEFORE
// the target so you hear the lead-in rather than landing exactly on it.
const LINE_SEEK_LEAD_MS = 500;
// Word-timing editor geometry.
const PX_PER_SEC = 200; // the whole song spans (durationSec × 200)px, wrapped into rows
const PX_PER_MS = PX_PER_SEC / 1000;
const EDITOR_BAR_H = 22; // the draggable bar…
const EDITOR_LABEL_H = 16; // …plus the word label beneath it
const EDITOR_ROW_H = EDITOR_BAR_H + EDITOR_LABEL_H + 10;
const EDITOR_ROW_GAP = 8;
const EDIT_MIN_DUR = 60; // ms — smallest word window
const EDIT_MIN_GAP = 20; // ms — smallest gap between consecutive word starts

// All the editor's STATIC per-element styling lives in one injected stylesheet (classes), so each of
// the ~2.5k nodes a build() creates sets a className instead of a parsed `setAttribute("style", …)`
// string — the dominant cost of a rebuild. Only genuinely dynamic values (left/width/display/…) stay
// inline. Lock/read-only recolouring is a single container-class toggle (`cj-starred`/`cj-ro`). The
// sheet is static (derived from the geometry constants), so it's injected once per app session.
let editorCssInjected = false;
function ensureEditorCss(): void {
  if (editorCssInjected || typeof document === "undefined") return;
  editorCssInjected = true;
  if (document.getElementById("catjam-editor-css")) return;
  const style = document.createElement("style");
  style.id = "catjam-editor-css";
  style.textContent =
    `.cj-row{position:relative;height:${EDITOR_ROW_H}px;margin-bottom:${EDITOR_ROW_GAP}px;border-radius:6px;background:var(--spice-main,rgba(255,255,255,.04));box-shadow:inset 0 0 0 1px rgba(255,255,255,.06);}` +
    `.cj-rowlabel{position:absolute;left:4px;top:2px;font-size:10px;opacity:.4;pointer-events:none;}` +
    `.cj-grid{position:absolute;top:0;width:1px;height:${EDITOR_ROW_H}px;background:rgba(255,255,255,.1);pointer-events:none;z-index:0;}` +
    `.cj-line{position:absolute;top:0;width:3px;height:${EDITOR_ROW_H}px;background:#ffd23f;opacity:.9;cursor:pointer;z-index:4;}` +
    // An overlapping-main line: a 1px purple (background-lane colour) outline around the gold marker,
    // flagging that this line's trailing note stretches past the following lines (edit its tail in the bg lane).
    `.cj-line-overlap{outline:1px solid #c79bff;}` +
    `.cj-bar{position:absolute;cursor:grab;box-shadow:0 1px 3px rgba(0,0,0,.4);touch-action:none;overflow:visible;}` +
    // PROMINENCE is independent of colour: the ACTIVE edit lane renders as cj-prom (tall bars with
    // labels); the other lane drops to cj-minor (the thin dimmed top strip). The "t" toggle swaps which
    // lane is which, so mapping/editing always focuses on the active lane's words.
    `.cj-prom{top:5px;height:${EDITOR_BAR_H}px;}` +
    `.cj-minor{top:0;height:5px;border-radius:3px;opacity:.6;}` +
    // COLOUR = lane (lead vs background) × voice (both / a=Mittens / b=Biscuit). Single-class (0,1,0) so
    // the container starred/read-only overrides (0,2,0) below always win without specificity ties.
    `.cj-c-both-lead{background:var(--spice-button,#1db954);}` +
    `.cj-c-both-bg{background:#c79bff;}` +
    `.cj-c-a-lead{background:#7ed957;}` +
    `.cj-c-a-bg{background:#e24bc4;}` +
    `.cj-c-b-lead{background:#0f7a3d;}` +
    `.cj-c-b-bg{background:#6257e0;}` +
    `.cj-nib-l{position:absolute;left:-1px;top:-1px;width:0;height:0;border-right:9px solid transparent;border-top:9px solid rgba(255,255,255,.85);cursor:ew-resize;}` +
    `.cj-nib-r{position:absolute;right:-1px;bottom:-1px;width:0;height:0;border-left:9px solid transparent;border-bottom:9px solid rgba(255,255,255,.85);cursor:ew-resize;}` +
    `.cj-nib-sec-l{position:absolute;left:-1px;top:0;width:4px;height:5px;background:rgba(255,255,255,.9);cursor:ew-resize;border-radius:2px;}` +
    `.cj-nib-sec-r{position:absolute;right:-1px;top:0;width:4px;height:5px;background:rgba(255,255,255,.9);cursor:ew-resize;border-radius:2px;}` +
    `.cj-label{position:absolute;top:${5 + EDITOR_BAR_H + 1}px;height:${EDITOR_LABEL_H}px;line-height:${EDITOR_LABEL_H}px;font-size:11px;white-space:nowrap;max-width:160px;overflow:hidden;text-overflow:ellipsis;opacity:.85;pointer-events:none;}` +
    // Starred (locked) recolours the LEAD-lane words per voice ("both" stays classic gold); the
    // background lane keeps its colour. (0,2,0) container selectors beat the (0,1,0) colour classes.
    `.cj-starred .cj-c-both-lead{background:#ffd700;box-shadow:0 0 8px rgba(255,215,0,.8);}` +
    `.cj-starred .cj-c-a-lead{background:#fff59d;box-shadow:0 0 8px rgba(255,245,157,.85);}` +
    `.cj-starred .cj-c-b-lead{background:#e0912f;box-shadow:0 0 8px rgba(224,145,47,.85);}` +
    // Read-only preview → blue lead for every voice.
    `.cj-ro .cj-c-both-lead,.cj-ro .cj-c-a-lead,.cj-ro .cj-c-b-lead{background:#4aa3ff;box-shadow:0 0 8px rgba(74,163,255,.6);}` +
    `.cj-starred .cj-label{color:#ffd700;}`;
  document.head.appendChild(style);
}

// Starred tracks are LOCKED: their word timing can't be edited or deleted. Persisted in
// localStorage as a set of track ids.
const STARRED_KEY = "catjam-starred";
// Cached by raw string so isStarred() (called per cache-list row) doesn't re-parse each time; a
// write changes the raw string, so the next read re-parses.
let starredRaw: string | null = null;
let starredCache = new Set<string>();
function starredIds(): Set<string> {
  try {
    const raw = localStorage.getItem(STARRED_KEY) ?? "[]";
    if (raw === starredRaw) return starredCache;
    const arr = JSON.parse(raw);
    starredRaw = raw;
    starredCache = new Set(Array.isArray(arr) ? (arr as string[]) : []);
    return starredCache;
  } catch {
    return new Set();
  }
}
function isStarred(id: string): boolean {
  return !!id && starredIds().has(id);
}
function setStarred(id: string, on: boolean): void {
  if (!id) return;
  const s = new Set(starredIds()); // clone so the cache isn't mutated before the write
  if (on) s.add(id);
  else s.delete(id);
  try {
    localStorage.setItem(STARRED_KEY, JSON.stringify([...s]));
  } catch {
    /* storage unavailable */
  }
}

// ───────────────────────── Cloud sync (Google Drive) engine ─────────────────────────
// The overrides blob key (mirrors overrides.ts STORAGE_KEY — stable, not exported).
const OVERRIDES_KEY = "catjam-doubletime-overrides";
// Panel host element ids, so a Download/Restore can re-render settings + cloud rows in place.
const SETTINGS_HOST_ID = "catjam-settings-host";
const CLOUD_HOST_ID = "catjam-cloud-host";
// Set by the panel's Cloud Sync section so sync ops can surface progress; no-op when it's closed.
let setCloudStatus: (msg: string) => void = () => {};
// Set in main() to refresh the UI (re-render panel + onsets) after a Download/Restore applies data.
let onBundleApplied: () => void = () => {};
let syncInFlight = false; // serialises sync ops so Upload/Download/daily can't overlap
let dailyCheckedThisSession = false; // the daily auto-check runs at most once per session

const nowIso = (): string => new Date().toISOString();
const liveFetchForSync = (u: string, i?: RequestInit): Promise<Response> => fetch(u, i);

function readSyncState(): SyncState {
  try {
    return (JSON.parse(overridesStore.get(SYNC_STATE_KEY) ?? "{}") as SyncState) ?? {};
  } catch {
    return {};
  }
}
function writeSyncState(s: SyncState): void {
  try {
    overridesStore.set(SYNC_STATE_KEY, JSON.stringify(s));
  } catch {
    /* storage unavailable */
  }
}

/** Gather everything syncable from local storage into bundle parts (settings minus the excluded
 *  credential fields, the per-track overrides, the starred set, and every saved word-level LRC). */
async function collectBundleParts(): Promise<BundleParts> {
  const settingsOut: Record<string, unknown> = {};
  try {
    for (let i = 0; i < localStorage.length; i++) {
      const key = localStorage.key(i);
      if (!key || !key.startsWith(`${SETTINGS_ID}.`)) continue;
      const field = key.slice(SETTINGS_ID.length + 1);
      if (SYNC_EXCLUDED_FIELDS.has(field)) continue; // never carry the Drive creds / enable flag
      try {
        settingsOut[field] = JSON.parse(localStorage.getItem(key) ?? "null")?.value;
      } catch {
        /* skip a malformed field */
      }
    }
  } catch {
    /* storage unavailable */
  }

  let overrides: Record<string, unknown> = {};
  try {
    overrides = (JSON.parse(overridesStore.get(OVERRIDES_KEY) ?? "{}") as Record<string, unknown>) ?? {};
  } catch {
    overrides = {};
  }

  let starred: string[] = [];
  try {
    const a = JSON.parse(localStorage.getItem(STARRED_KEY) ?? "[]");
    starred = Array.isArray(a) ? a.filter((x): x is string => typeof x === "string") : [];
  } catch {
    starred = [];
  }

  const lyrics: Record<string, string> = {};
  try {
    for (const { id, lrc } of await listLrcCache()) lyrics[id] = lrc;
  } catch {
    /* leave lyrics empty on failure */
  }

  return { settings: settingsOut, overrides, starred, lyrics };
}

/** Apply a downloaded bundle to local storage. Settings/overrides/starred are REPLACED wholesale;
 *  lyrics are UPSERTED (a local-only saved LRC is never deleted by a download — the next upload
 *  reconciles it). A pre-download backup is taken by the caller for true rollback. */
async function applyBundleParts(parts: BundleParts): Promise<void> {
  for (const [field, value] of Object.entries(parts.settings ?? {})) {
    if (SYNC_EXCLUDED_FIELDS.has(field)) continue; // defensive: never let a bundle set local creds
    try {
      Spicetify.LocalStorage.set(`${SETTINGS_ID}.${field}`, JSON.stringify({ value }));
    } catch {
      /* skip */
    }
  }
  try {
    overridesStore.set(OVERRIDES_KEY, JSON.stringify(parts.overrides ?? {}));
  } catch {
    /* skip */
  }
  try {
    localStorage.setItem(STARRED_KEY, JSON.stringify(parts.starred ?? []));
  } catch {
    /* skip */
  }
  for (const [id, lrc] of Object.entries(parts.lyrics ?? {})) {
    try {
      await writeLrcCache(id, lrc);
    } catch {
      /* skip a single bad entry */
    }
  }
}

/** Push local → Drive: for each song write both `lyrics/lrc/<cat>/…​.lrc` (the round-tripped source)
 *  and `lyrics/ttml/<cat>/…​.ttml` (a derived export), filed by category (starred/bookmarked/normal),
 *  plus the catjam-sync.json library file (written LAST → its modifiedTime marks the latest sync).
 *  Unchanged LRCs are skipped; category changes MOVE files between subfolders; TTML is regenerated
 *  when its LRC changed or is missing; legacy flat/`lyrics/<cat>` LRCs are migrated into `lyrics/lrc/`. */
async function uploadAll(
  client: DriveClient,
  parts: BundleParts,
  prevHashes: Record<string, string>,
): Promise<{ state: SyncState; uploaded: number }> {
  const folderId = driveCreds().folderId;
  const lyricsFolderId = await client.ensureFolder(LYRICS_FOLDER, folderId);
  const lrcRoot = await client.ensureFolder("lrc", lyricsFolderId);
  const ttmlRoot = await client.ensureFolder("ttml", lyricsFolderId);
  const catFolders = async (rootId: string): Promise<Record<LyricCategory, string>> => ({
    starred: await client.ensureFolder("starred", rootId),
    bookmarked: await client.ensureFolder("bookmarked", rootId),
    normal: await client.ensureFolder("normal", rootId),
  });
  const lrcSub = await catFolders(lrcRoot);
  const ttmlSub = await catFolders(ttmlRoot);

  // Scan existing remote files. LRC across new (lrc/<cat>) + legacy (flat, lyrics/<cat>) so legacy
  // files migrate; TTML only under ttml/<cat>. Filter by extension (trackId matches both).
  const remoteLrc = new Map<string, { id: string; parentId: string; modifiedTime?: string }>();
  const remoteTtml = new Map<string, { id: string; parentId: string }>();
  const scanInto = async (parentId: string, ext: ".lrc" | ".ttml"): Promise<void> => {
    for (const f of await client.listChildren(parentId)) {
      const tid = trackIdFromFileName(f.name ?? "");
      if (!tid || !(f.name ?? "").toLowerCase().endsWith(ext)) continue;
      if (ext === ".lrc") remoteLrc.set(tid, { id: f.id, parentId, modifiedTime: f.modifiedTime });
      else remoteTtml.set(tid, { id: f.id, parentId });
    }
  };
  for (const cat of LYRIC_CATEGORIES) await scanInto(lrcSub[cat], ".lrc");
  await scanInto(lyricsFolderId, ".lrc"); // legacy flat
  for (const cat of LYRIC_CATEGORIES) {
    const legacy = await client.findFile(cat, lyricsFolderId); // legacy lyrics/<cat>
    if (legacy) await scanInto(legacy.id, ".lrc");
  }
  for (const cat of LYRIC_CATEGORIES) await scanInto(ttmlSub[cat], ".ttml");

  const over = parts.overrides as Record<string, { name?: string; bookmarkMs?: number } | undefined>;
  const starred = new Set(parts.starred ?? []);
  const newHashes: Record<string, string> = {};
  const newMtimes: Record<string, string> = {}; // trackId → cloud modifiedTime after this sync (ETag-like)
  let uploaded = 0;
  for (const [id, lrc] of Object.entries(parts.lyrics ?? {})) {
    const h = hashContent(lrc);
    newHashes[id] = h;
    const cat = lyricCategory(starred.has(id), over[id]?.bookmarkMs != null);
    const name = over[id]?.name;

    // LRC — the round-tripped source of truth; drives the ETag-like modifiedTime record.
    const lrcTarget = lrcSub[cat];
    const exLrc = remoteLrc.get(id);
    let mtime = exLrc?.modifiedTime;
    const lrcChanged = !(exLrc && prevHashes[id] === h);
    if (lrcChanged) {
      const saved = await client.upload({ name: lyricFileName(id, name, ".lrc"), content: lrc, parentId: lrcTarget, existingId: exLrc?.id, mimeType: "text/plain" });
      mtime = saved.modifiedTime;
      uploaded++;
    }
    if (exLrc && exLrc.parentId !== lrcTarget) {
      const moved = await client.move(exLrc.id, lrcTarget, exLrc.parentId);
      mtime = moved.modifiedTime ?? mtime;
      if (!lrcChanged) uploaded++;
    }
    if (mtime) newMtimes[id] = mtime;

    // TTML — derived export; regenerate when the LRC changed or the file is missing.
    const ttmlTarget = ttmlSub[cat];
    const exTtml = remoteTtml.get(id);
    const ttmlChanged = lrcChanged || !exTtml;
    if (ttmlChanged) {
      await client.upload({ name: lyricFileName(id, name, ".ttml"), content: wordLrcToTtml(lrc, getSingerNames(overridesStore, id)), parentId: ttmlTarget, existingId: exTtml?.id, mimeType: "application/ttml+xml" });
      uploaded++;
    }
    if (exTtml && exTtml.parentId !== ttmlTarget) {
      await client.move(exTtml.id, ttmlTarget, exTtml.parentId);
      if (!ttmlChanged) uploaded++;
    }
  }
  // Library JSON last → its modifiedTime is the canonical "cloud changed since last sync" signal.
  const libFile = await client.findFile(LIBRARY_FILENAME, folderId);
  const saved = await client.upload({
    name: LIBRARY_FILENAME,
    content: JSON.stringify(buildLibraryBundle(parts, nowIso())),
    parentId: folderId,
    existingId: libFile?.id,
  });
  return {
    state: { fingerprint: bundleFingerprint(parts), modifiedTime: saved.modifiedTime, lyricHashes: newHashes, lyricMtimes: newMtimes },
    uploaded,
  };
}

/** Manual Upload — force-push local → cloud (per-file lyrics + library JSON). */
async function manualUpload(): Promise<void> {
  const creds = driveCreds();
  if (!hasDriveCreds(creds)) return void setCloudStatus("Set all four Google Drive credentials first.");
  if (syncInFlight) return void setCloudStatus("A sync is already in progress…");
  syncInFlight = true;
  try {
    setCloudStatus("Uploading to Drive…");
    const client = createDriveClient(creds, liveFetchForSync);
    const parts = await collectBundleParts();
    const { state, uploaded } = await uploadAll(client, parts, readSyncState().lyricHashes ?? {});
    writeSyncState({ ...state, lastCheckDay: utcDay(new Date()) });
    setCloudStatus(`Uploaded ✓ ${uploaded} lyric file(s) + library · ${new Date().toLocaleTimeString()}`);
  } catch (e) {
    setCloudStatus(`Upload failed: ${(e as Error).message}`);
  } finally {
    syncInFlight = false;
  }
}

/** Manual Download — snapshot the current local data (single backup slot), then pull + apply cloud:
 *  the library JSON (settings + overrides + stars) and every `.lrc` in the lyrics/ subfolder. */
async function manualDownload(): Promise<void> {
  const creds = driveCreds();
  if (!hasDriveCreds(creds)) return void setCloudStatus("Set all four Google Drive credentials first.");
  if (syncInFlight) return void setCloudStatus("A sync is already in progress…");
  syncInFlight = true;
  try {
    setCloudStatus("Downloading from Drive…");
    const client = createDriveClient(creds, liveFetchForSync);
    const folderId = creds.folderId;
    const libFile = await client.findFile(LIBRARY_FILENAME, folderId);
    if (!libFile) return void setCloudStatus("Nothing in the cloud yet — press Upload first.");
    // Persist the most-recent replica of the CURRENT local state before we overwrite it.
    try {
      overridesStore.set(SYNC_BACKUP_KEY, JSON.stringify(buildBundle(await collectBundleParts(), nowIso())));
    } catch {
      /* best-effort backup */
    }
    // Library (settings + overrides + stars); also upserts any embedded lyrics for back-compat.
    await applyBundleParts(readBundle(await client.download(libFile.id)));
    // Per-file lyrics, pulled INCREMENTALLY: only files we lack locally or whose cloud version
    // (modifiedTime) changed since we last synced — so pulling after one remote edit fetches one file.
    const prev = readSyncState();
    const prevMtimes = prev.lyricMtimes ?? {};
    const newMtimes: Record<string, string> = {};
    let pulled = 0;
    let skipped = 0;
    const lyricsFolder = await client.findFile(LYRICS_FOLDER, folderId);
    if (lyricsFolder) {
      // Pull only LRC (the source of truth — TTML is a derived export, regenerated on upload).
      // Scan lyrics/lrc/<cat> + legacy lyrics/<cat> + the flat parent.
      const parentsToScan = [lyricsFolder.id];
      const lrcRoot = await client.findFile("lrc", lyricsFolder.id);
      if (lrcRoot) {
        parentsToScan.push(lrcRoot.id);
        for (const cat of LYRIC_CATEGORIES) {
          const sub = await client.findFile(cat, lrcRoot.id);
          if (sub) parentsToScan.push(sub.id);
        }
      }
      for (const cat of LYRIC_CATEGORIES) {
        const legacy = await client.findFile(cat, lyricsFolder.id); // legacy lyrics/<cat>
        if (legacy) parentsToScan.push(legacy.id);
      }
      const seen = new Set<string>(); // a file briefly in two places (mid-migration) is pulled once
      for (const parentId of parentsToScan) {
        for (const f of await client.listChildren(parentId)) {
          const tid = trackIdFromFileName(f.name ?? "");
          if (!tid || seen.has(tid) || !(f.name ?? "").toLowerCase().endsWith(".lrc")) continue;
          seen.add(tid);
          if (f.modifiedTime) newMtimes[tid] = f.modifiedTime; // record the cloud version either way
          const hasLocal = !!(await readLrcCache(tid));
          if (!needsDownload(f.modifiedTime, prevMtimes[tid], hasLocal)) {
            skipped++;
            continue; // already current locally → no fetch
          }
          await writeLrcCache(tid, await client.download(f.id));
          pulled++;
        }
      }
    }
    const applied = await collectBundleParts();
    const lyricHashes: Record<string, string> = {};
    for (const [id, lrc] of Object.entries(applied.lyrics)) lyricHashes[id] = hashContent(lrc);
    writeSyncState({
      fingerprint: bundleFingerprint(applied),
      modifiedTime: libFile.modifiedTime,
      lastCheckDay: utcDay(new Date()),
      lyricHashes,
      lyricMtimes: newMtimes,
    });
    onBundleApplied();
    setCloudStatus(`Downloaded ✓ ${pulled} changed lyric file(s), ${skipped} already current · previous data backed up. Reload Spotify if settings look stale.`);
  } catch (e) {
    setCloudStatus(`Download failed: ${(e as Error).message}`);
  } finally {
    syncInFlight = false;
  }
}

/** Restore the single pre-download backup (the most recent replica), undoing the last Download. */
async function restoreBackup(): Promise<void> {
  if (syncInFlight) return void setCloudStatus("A sync is already in progress…");
  const raw = overridesStore.get(SYNC_BACKUP_KEY);
  if (!raw) return void setCloudStatus("No backup saved yet (one is made before each Download).");
  syncInFlight = true;
  try {
    await applyBundleParts(readBundle(raw));
    onBundleApplied();
    setCloudStatus("Restored your pre-download backup ✓ — reload Spotify if settings look stale.");
  } catch (e) {
    setCloudStatus(`Restore failed: ${(e as Error).message}`);
  } finally {
    syncInFlight = false;
  }
}

/** The daily auto-check (upload-only). Runs at most once per UTC day and never auto-overwrites
 *  local: it pushes when local is ahead, and only flags when the cloud is ahead or diverged. */
async function runDailyCheck(): Promise<void> {
  if (!syncEnabled()) return;
  const creds = driveCreds();
  if (!hasDriveCreds(creds) || dailyCheckedThisSession) return;
  const state = readSyncState();
  const today = utcDay(new Date());
  if (state.lastCheckDay === today) {
    dailyCheckedThisSession = true;
    return; // already reconciled today
  }
  if (syncInFlight) return;
  dailyCheckedThisSession = true; // one attempt per session (reset below on transient failure)
  syncInFlight = true;
  try {
    const client = createDriveClient(creds, liveFetchForSync);
    const parts = await collectBundleParts();
    const fp = bundleFingerprint(parts);
    const libFile = await client.findFile(LIBRARY_FILENAME, creds.folderId);
    const action = decideAutoSync(fp, state, { exists: !!libFile, modifiedTime: libFile?.modifiedTime });
    if (action === "upload") {
      const { state: newState, uploaded } = await uploadAll(client, parts, state.lyricHashes ?? {});
      writeSyncState({ ...newState, lastCheckDay: today });
      setCloudStatus(`Auto-synced to Drive ✓ ${uploaded} file(s) · ${new Date().toLocaleTimeString()}`);
    } else if (action === "noop") {
      writeSyncState({ ...state, lastCheckDay: today });
    } else {
      writeSyncState({ ...state, lastCheckDay: today }); // record the check; never auto-overwrite local
      setCloudStatus(
        action === "conflict"
          ? "Both local and cloud changed — press Download to pull, or Upload to overwrite."
          : "Cloud has newer data — press Download to pull it in.",
      );
    }
  } catch (e) {
    dailyCheckedThisSession = false; // transient failure → allow a retry later this session
    setCloudStatus(`Auto-sync skipped: ${(e as Error).message}`);
  } finally {
    syncInFlight = false;
  }
}

// The Cloud Sync panel section: four Drive credential fields + an enable toggle, then the actions.
const CLOUD_SYNC_SCHEMA: SettingCtl[] = [
  { kind: "toggle", field: SYNC_ENABLED_FIELD, label: "Enable daily auto-sync (upload-only) to Google Drive" },
  { kind: "text", field: DRIVE_CLIENT_FIELD, label: "Google OAuth client ID" },
  { kind: "text", field: DRIVE_SECRET_FIELD, label: "Google OAuth client secret" },
  { kind: "text", field: DRIVE_REFRESH_FIELD, label: "Google OAuth refresh token" },
  { kind: "text", field: DRIVE_FOLDER_FIELD, label: "Target Drive folder ID" },
  { kind: "button", label: "Push local lyrics + settings + library to Drive", text: "Upload ↑", onClick: () => void manualUpload() },
  { kind: "button", label: "Back up local, then replace it with the cloud copy", text: "Download ↓", onClick: () => void manualDownload() },
  { kind: "button", label: "Undo the last Download (restore the pre-download backup)", text: "Restore backup", onClick: () => void restoreBackup() },
];

/** Open Google's consent page for the manual re-auth flow (in the system browser). */
function openReauthConsent(): void {
  const creds = driveCreds();
  if (!creds.clientId) return void setCloudStatus("Enter the OAuth client ID first.");
  const url = buildAuthUrl(creds.clientId, DRIVE_REAUTH_REDIRECT);
  const w = window.open(url, "_blank");
  if (!w) setCloudStatus(`Pop-up blocked — open this URL manually, then paste the code:\n${url}`);
  else setCloudStatus("Consent page opened — click Allow, copy the code it redirects to, paste it below.");
}

/** Trade a pasted auth code for a fresh refresh token and save it (the manual re-auth path). */
async function exchangeReauthCode(raw: string): Promise<void> {
  const creds = driveCreds();
  if (!creds.clientId || !creds.clientSecret) return void setCloudStatus("Enter the client ID + secret first.");
  const code = parseAuthCode(raw);
  if (!code) return void setCloudStatus("Paste the code (or the http://localhost/?code=… URL) first.");
  try {
    setCloudStatus("Exchanging the code for a fresh token…");
    const refresh = await exchangeCode(creds, code, DRIVE_REAUTH_REDIRECT, liveFetchForSync);
    settings.setFieldValue(DRIVE_REFRESH_FIELD, refresh);
    setCloudStatus("Re-authorized ✓ — new refresh token saved. Hit Upload ↑.");
    const ch = document.getElementById(CLOUD_HOST_ID);
    if (ch) renderCloudSyncInto(ch); // reflect the new token in the field
  } catch (e) {
    setCloudStatus(`Re-auth failed: ${(e as Error).message}`);
  }
}

/** Render the Cloud Sync section (fields + actions + status + a manual re-auth link) into `host`. */
function renderCloudSyncInto(host: HTMLElement): void {
  host.textContent = "";
  const fields = document.createElement("div");
  renderSettingsInto(fields, CLOUD_SYNC_SCHEMA);
  const status = document.createElement("div");
  status.setAttribute("style", "margin-top:8px; font-size:12px; opacity:.75; min-height:16px; white-space:pre-wrap;");
  const st = readSyncState();
  status.textContent = st.lastCheckDay
    ? `Last sync check: ${st.lastCheckDay}${st.modifiedTime ? ` · cloud updated ${new Date(st.modifiedTime).toLocaleString()}` : ""}`
    : "Not synced yet.";
  setCloudStatus = (msg: string) => {
    status.textContent = msg;
  };

  // Manual re-auth (backup for Testing-mode's 7-day token expiry): link opens consent, user pastes
  // the code back, we exchange it for a fresh refresh token — no terminal needed.
  const reauth = document.createElement("div");
  reauth.setAttribute("style", "margin-top:8px; font-size:12px; opacity:.85;");
  const link = document.createElement("a");
  link.textContent = "⟳ Re-authorize Drive (use if sync says the token expired)";
  link.href = "#";
  link.setAttribute("style", "color: var(--spice-button-active, #1ed760); cursor:pointer; text-decoration:underline;");
  const row = document.createElement("div");
  row.setAttribute("style", "display:none; gap:6px; margin-top:6px; align-items:center;");
  const codeInput = document.createElement("input");
  codeInput.placeholder = "Paste the code (or the http://localhost/?code=… URL)";
  codeInput.setAttribute("style", `${FIELD_STYLE} flex:1 1 auto;`);
  row.append(codeInput, whitelistButton("Save token", () => void exchangeReauthCode(codeInput.value)));
  link.onclick = (e) => {
    e.preventDefault();
    openReauthConsent();
    row.style.display = "flex";
  };
  reauth.append(link, row);

  host.append(fields, status, reauth);
}

/** Load a track's word-by-word detection for editing as a flat word list (each word tagged with
 *  its lyric line) plus the line start times (for the seekable markers). Source: the saved
 *  word-level LRC verbatim, or — for a plain line-synced LRC — the audio-timed pipeline words. */
async function loadEditWords(id: string, lrc: string): Promise<{ words: EditWord[]; lineStarts: number[] }> {
  let lines: { start: number; words: { text: string; start: number; end: number }[] }[];
  if (hasWordTimestamps(lrc)) {
    lines = parseWordLrcLines(lrc).filter((l) => l.words.length);
  } else {
    const spans = parseLrc(lrc);
    if (!spans) return { words: [], lineStarts: [] };
    const analysis = getTrackAnalysis ? await getTrackAnalysis(`spotify:track:${id}`) : null;
    lines = timedLines(spans.map((s) => [s]), analysis?.segments, analysis?.beats)
      .map((l) => ({
        start: l.start,
        words: l.words.map((w) => ({ text: w.text, start: w.start, end: w.end, ...(w.secondary ? { secondary: true } : {}) })),
      }))
      .filter((l) => l.words.length);
  }
  const words: EditWord[] = [];
  lines.forEach((l, li) => l.words.forEach((w) => words.push({ ...w, line: li })));
  words.sort((a, b) => a.start - b.start);
  return { words, lineStarts: lines.map((l) => l.start) };
}

/** Clamp each LANE (primary + secondary) to a valid, non-overlapping, strictly-ascending sequence
 *  in place. The lanes are normalized independently, so background words may overlap the lead. */
function normalizeWords(words: EditWord[]): void {
  words.sort((a, b) => a.start - b.start);
  for (const lane of [false, true]) {
    const lw = words.filter((w) => !!w.secondary === lane); // one lane's words (shared objects)
    for (let i = 0; i < lw.length; i++) {
      if (i > 0 && lw[i].start < lw[i - 1].start + EDIT_MIN_GAP) lw[i].start = lw[i - 1].start + EDIT_MIN_GAP;
      if (lw[i].end < lw[i].start + EDIT_MIN_DUR) lw[i].end = lw[i].start + EDIT_MIN_DUR;
    }
    for (let i = 0; i < lw.length - 1; i++) {
      if (lw[i].overlap) continue; // an overlapping main note: its END may extend PAST following words
      if (lw[i].end > lw[i + 1].start) lw[i].end = Math.max(lw[i].start + 1, lw[i + 1].start);
    }
  }
}

/**
 * The word-by-word timing editor: a wrapped multi-row timeline (100px/sec, each row a slice of
 * the song) with a draggable bar per word. Drag a bar to move it — it takes time only from the
 * one neighbour it meets (shrinking it, no cascade) and WRAPS across rows (a word spanning a row
 * edge is drawn as segments on both rows). Drag the corner nibs to resize; click to fine-tune in
 * a popover. Yellow bars mark lyric lines (click to seek). Every edit AUTOSAVES and updates the
 * live pulse; "Undo all edits" reverts to the snapshot taken when the editor opened.
 */
async function openWordTimingEditor(
  id: string,
  lrc: string,
  host: HTMLElement,
  readOnly = false,
  reloadGen?: number
): Promise<void> {
  // A follow-reload superseded by a newer skip (before we even started) bails without touching state.
  if (reloadGen !== undefined && reloadGen !== editorReloadGen) return;
  const uri = `spotify:track:${id}`;
  // Register as the live editor so a song change can auto-load the next track here (see main()'s
  // songchange handler). A fresh token per open lets teardown deregister only its own instance.
  // `following` = opened for the track that's playing → song changes track playback song-to-song.
  const editorToken = ++editorSeq;
  activeLyricEditor = { host, token: editorToken, following: Spicetify.Player.data?.item?.uri === uri };
  host.dataset.catjamView = "editor"; // so refreshNowPlaying won't re-render the Library over us
  const ov = getOverride(overridesStore, id);
  const name = ov?.name ?? id;
  const { words, lineStarts } = await loadEditWords(id, lrc);
  if (reloadGen !== undefined && reloadGen !== editorReloadGen) return; // a newer skip won during loading
  normalizeWords(words);

  // Fallback felt tempo (from the override) when this isn't the current track — the live clock is
  // read from the controller below so the grid lines up exactly with the cat's bounce.
  const fallbackFelt = ov?.bpm && ov.bpm > 0 ? ov.bpm / (ov.doubleTime ?? 1) : 0;

  // Read-only preview (e.g. a Spicy word-synced source not saved here): locks ALL edits like a
  // starred track, but without the gold paint, and `commit`/`markDirty` are no-ops so nothing is
  // written. `roLock` is folded into every edit guard alongside `starred`.
  const roLock = readOnly;

  // The word — or line-start marker — currently under the mouse cursor (set by their pointerenter/leave),
  // so the "c" hotkey cycles the duet voice without a click: a word cycles just that word; a line marker
  // (the yellow bar) cycles the whole line's active-lane words. Cleared on pointerleave.
  let hoverWord: EditWord | null = null;
  let hoverLine: number | null = null;

  // "w" toggles word labels between the original characters and romanization (from Spicy). Romanized
  // text is lazy-loaded (and matched to words) on the first toggle-on.
  let showRoman = false;
  let romanLoaded = false;
  // Active edit LANE: false = MAIN/lead (green), true = BACKGROUND/secondary (purple). The "t" hotkey
  // flips it so taps, new words, fill/prune/resize all target the background vocals with the same tools
  // as the lead — letting you build + time the two overlapping parts separately.
  let bgLane = false;
  let starred = isStarred(id); // a locked track: no edits, no delete (see the guards below)
  // Signed lyric sync offset (ms): shifts every word/line DISPLAY position (and the live onsets)
  // without changing the stored per-word times. The word model stays in RAW time; the offset is
  // added only when rendering bars/markers/taps and subtracted from the live playback position when
  // recording. Loaded from storage, adjusted by the control in the header.
  let lyricOffset = getLyricOffset(overridesStore, id);

  // Passive tap-to-record: while the editor is open, tapping a record key plots a BLUE bar per word
  // for the line currently playing; when a line's blue taps match its word count, THAT line (only)
  // commits. The "," key plots GREEN bars — a persistent, draggable placement that also commits the
  // line when its count matches. No mode/toggle — it just listens. Built after the timeline.
  const tapsByLine = new Map<number, number[]>(); // BLUE: the live in-progress taps for each line
  const greenByLine = new Map<number, number[]>(); // GREEN: persistent, draggable taps per line
  let markEls: HTMLElement[] = []; // the rendered blue + green line elements
  let recordKeyHandler: ((e: KeyboardEvent) => void) | null = null;
  let doUndo = (): void => {}; // assigned below; also bound to the "z" hotkey
  const VICINITY_MS = 400; // first-word snap-to-line-start window (human error on the first word)
  const GRACE_MS = 100; // a line stays tappable this long past its end; then incomplete taps go green
  const INHERIT_MS = 1000; // a lone green bar this far BEFORE a line's start can be adopted as its first word

  // Bookmark: a purple "where I left off editing" marker at a timeline position. Set via the button
  // / "b" to the white-bar (playhead) position. It is NEVER dropped by edits — only by an express
  // Remove (button / "b") while paused at it; pressing "b" with the white bar elsewhere MOVES it.
  let bookmarkMs: number | null = getBookmark(overridesStore, id);
  let lastPointer: { clientX: number; clientY: number } | null = null; // last pointer over the timeline
  let bookmarkEl: HTMLElement | null = null;

  // Undo stack: each edit pushes the pre-edit snapshot; the Undo button steps back one edit. A
  // snapshot captures both the words AND the lyric line heads (lineStarts), so "Set line start here"
  // is undoable too.
  // A snapshot captures the word timing AND the plot-queue state (the "[" / "]" cursor), so undo/redo
  // rewinds the queue too — undoing a plotted line also steps `plotIndex` / `lastPlottedLine` back, and
  // undoing an upload restores the previous `plotLines`. (plotLines/plotIndex/lastPlottedLine are declared
  // further down with the plotting block; these closures read/write them at call time, never in the TDZ.)
  const cloneWords = (): {
    words: { text: string; start: number; end: number; line: number; secondary?: boolean; singer?: "a" | "b"; overlap?: boolean }[];
    lineStarts: number[];
    plotLines: string[];
    plotIndex: number;
    lastPlottedLine: number | null;
  } => ({
    words: words.map((w) => ({ text: w.text, start: w.start, end: w.end, line: w.line, ...(w.secondary ? { secondary: true } : {}), ...(w.singer ? { singer: w.singer } : {}), ...(w.overlap ? { overlap: true } : {}) })),
    lineStarts: [...lineStarts],
    plotLines: [...plotLines],
    plotIndex,
    lastPlottedLine,
  });
  const undoStack: ReturnType<typeof cloneWords>[] = [];
  const redoStack: ReturnType<typeof cloneWords>[] = []; // states popped by undo; replayed by "y" redo
  const pushUndo = (before: ReturnType<typeof cloneWords>): void => {
    undoStack.push(before);
    if (undoStack.length > 200) undoStack.shift();
    redoStack.length = 0; // a fresh edit invalidates the redo history
  };

  host.textContent = "";

  // Header: title + Back + Undo + status.
  const titleRow = document.createElement("div");
  titleRow.setAttribute("style", "display:flex; align-items:center; gap:10px; flex-wrap:wrap; margin-bottom:6px;");
  const title = document.createElement("h2");
  title.className = "TypeElement-cello-textBase-type";
  title.textContent = `${roLock ? "View" : "Edit"} timing — ${name}`;
  const status = document.createElement("span");
  status.setAttribute("style", "opacity:.7; font-size:12px; margin-left:auto;");
  const back = whitelistButton("← Back", () => {
    teardown(); // flushes any unsaved edits, then clears timers/listeners
    void renderLyricCacheInto(host);
  });
  // Manual save: force-persist the current timing, drop the regenerable generated-LRC cache for this
  // track so the saved file is authoritative everywhere ("clean cache"), then exit to the list.
  const saveBtn = whitelistButton("Save & close", () => {
    commit(); // write now (even if the 30s timer hasn't fired)
    invalidateOwnLrc?.(id); // clean the cached generated LRC → next read uses the saved file
    teardown();
    void renderLyricCacheInto(host);
  });

  // Persist the words as word-level LRC + onset map and reload the live pulse. Regroups words under
  // their lyric line so the seekable line markers survive. Clears the dirty flag.
  let dirty = false;
  const commit = (): void => {
    if (roLock) return; // read-only preview: never write
    if (!dirty) return; // nothing changed since the last write — skip the whole save (LRC + onset
    // map re-serialize + refreshOnsets + refreshWordDebug). This is what makes repeated Save / autosave
    // / undo-at-rest cheap. Callers that MUST force a write (undo) set `dirty = true` first.
    const byLine = new Map<number, LrcWord[]>();
    for (const w of words) {
      const arr = byLine.get(w.line) ?? [];
      arr.push({ text: w.text, start: w.start, end: w.end, ...(w.secondary ? { secondary: true } : {}), ...(w.singer ? { singer: w.singer } : {}), ...(w.overlap ? { overlap: true } : {}) });
      byLine.set(w.line, arr);
    }
    const outLines = lineStarts.map((start, li) => ({ start, words: byLine.get(li) ?? [] })).filter((l) => l.words.length);
    void writeLrcCache(id, serializeWordLrcLines(outLines));
    writeOnsetCache(overridesStore, id, wordOnsets(words));
    invalidateOwnLrc?.(id); // next generation picks up the edited version
    if (Spicetify.Player.data?.item?.uri === uri) {
      catController?.refreshOnsets(); // reflect the edit in the cat's pops
      refreshWordDebug(uri); // reload the debug word-overlay so it follows the edited timing too
    }
    dirty = false;
  };
  // Edits don't write on every change — they mark the editor dirty and a 30s timer flushes ONE
  // write, so a long drag/tap session doesn't hammer storage (and the derived onset cache). Manual
  // Save and Back both flush on demand (see `teardown`), so nothing is ever lost on exit.
  const markDirty = (): void => {
    if (roLock) return; // read-only preview: no edits, nothing to flag
    dirty = true;
    // The bookmark is NO LONGER retired by edits — it only clears when you expressly remove it (the
    // Bookmark button / "b" while paused at it), so a stray click can never silently drop it.
    status.textContent = "Unsaved edits — autosaves within 30s";
  };
  const autosaveTimer = setInterval(() => {
    if (dirty && rowsWrap.isConnected) {
      commit();
      status.textContent = "Autosaved ✓";
    }
  }, 30_000);

  // Flush any pending edits and tear down every timer/listener. Assigned fully once the timers and
  // follow button exist (below); referenced earlier by Back/Save and the teardown-on-navigate path.
  let teardown: () => void = () => {};

  const undo = whitelistButton("Undo", () => doUndo());
  // Bookmark toggle (also the "b" hotkey): marks where you left off editing (see toggleBookmark).
  const bookmarkBtn = whitelistButton("🔖 Bookmark", () => toggleBookmark());

  // Starred toggle: locks the track (no edit/delete) and glows the button + words gold.
  let star: HTMLButtonElement;
  const paintStar = (): void => {
    star.textContent = starred ? "★ Starred" : "☆ Star";
    star.style.background = starred ? "#ffd700" : "";
    star.style.color = starred ? "#000" : "";
    star.style.boxShadow = starred ? "0 0 10px rgba(255,215,0,.85)" : "";
    title.style.color = starred ? "#ffd700" : "";
    title.style.textShadow = starred ? "0 0 10px rgba(255,215,0,.5)" : "";
  };
  // Keep Spicy Lyrics' local library in step with the star: starring pushes the finalized lyrics as
  // TTML (so they show in Spicy); unstarring removes that entry again.
  const syncStarToSpicy = (on: boolean): void => {
    if (on) {
      const byLine = new Map<number, LrcWord[]>();
      for (const w of words) {
        const arr = byLine.get(w.line) ?? [];
        arr.push({ text: w.text, start: w.start, end: w.end, ...(w.secondary ? { secondary: true } : {}), ...(w.singer ? { singer: w.singer } : {}) });
        byLine.set(w.line, arr);
      }
      const lrcLines = lineStarts.map((start, li) => ({ start, words: byLine.get(li) ?? [] })).filter((l) => l.words.length);
      const ttml = wordLrcToTtml(lrcLines, getSingerNames(overridesStore, id));
      if (!ttml) return;
      void writeSpicyLocalLyric(uri, ttml).then(
        () => Spicetify.showNotification?.("Lyricat: synced to Spicy Lyrics (reopen the song there)"),
        (e: unknown) => Spicetify.showNotification?.(`Lyricat: Spicy sync failed — ${(e as Error).message}`, true)
      );
    } else {
      void removeSpicyLocalLyric(uri).then(
        () => Spicetify.showNotification?.("Lyricat: removed from Spicy Lyrics"),
        () => {} // best-effort: nothing there / DB unavailable → ignore
      );
    }
  };
  const toggleStar = (): void => {
    if (roLock) return; // read-only preview — nothing to lock/star
    starred = !starred;
    setStarred(id, starred);
    if (starred) {
      commit(); // starring finalizes the track → persist the current timing to disk
      if (bookmarkMs !== null) {
        bookmarkMs = null; // a locked track is done — drop the "left off editing" bookmark
        clearBookmark(overridesStore, id);
        updateBookmarkUI(); // button + caret; the build() below removes the marker
      }
    }
    syncStarToSpicy(starred); // auto-sync: star → push to Spicy, unstar → remove from Spicy
    paintStar();
    build(); // repaint the word bars/labels gold (or back to green)
    status.textContent = starred ? "★ Starred — locked, saved & synced" : "Unstarred — editable";
  };
  star = whitelistButton("☆ Star", toggleStar);
  paintStar();

  // Read-only preview hides every write/edit control; a plain "Read-only" chip replaces them.
  if (roLock) {
    const ro = document.createElement("span");
    ro.textContent = "📖 Read-only preview";
    ro.setAttribute("style", "font-size:12px; font-weight:700; color:#4ad0c0;");
    titleRow.append(title, back, ro, status);
  } else {
    titleRow.append(title, back, saveBtn, undo, bookmarkBtn, star, status);
  }
  host.append(titleRow);

  // ── Romanization language helpers (defined before the render that uses them) ──
  // Auto-detected language from the lyric text (kana→ja, Hangul→ko, Han-only→zh).
  const detectedSongLang = (): SongLang => detectSongLanguage(words.map((w) => w.text).join(""));
  // Effective language for romanization: the per-track override, else auto-detection.
  const resolveSongLang = (): SongLang => {
    const stored = getTrackLanguage(overridesStore, id);
    return stored === "auto" ? detectedSongLang() : (stored as SongLang);
  };
  // A per-track language <select> (Auto-detect shows the detected language); persists the choice.
  const buildLangSelect = (): HTMLSelectElement => {
    const sel = document.createElement("select");
    const detected = detectedSongLang();
    (
      [
        ["auto", `Auto-detect (→ ${LANG_LABEL[detected]})`],
        ["ko", "Korean"],
        ["ja", "Japanese"],
        ["zh", "Chinese"],
        ["other", "Other"],
      ] as const
    ).forEach(([v, lbl]) => {
      const o = document.createElement("option");
      o.value = v;
      o.textContent = lbl;
      sel.append(o);
    });
    sel.value = getTrackLanguage(overridesStore, id);
    sel.addEventListener("change", () => setTrackLanguage(overridesStore, id, sel.value));
    return sel;
  };
  // Set once the Japanese dictionary has loaded this session, so the "loading…" note only shows the first time.
  let jaWarmed = false;

  // Romanize every word in the song (whole-song sync): fill each word's `roman` from the engine, leaving
  // text/timing/grouping untouched. Never runs automatically — only from the "Romanize all" button.
  const romanizeAllWords = async (): Promise<void> => {
    if (roLock || starred) {
      status.textContent = roLock ? "Read-only preview" : "★ Starred — unstar to edit";
      return;
    }
    const lang = resolveSongLang();
    if (!canRomanize(lang)) {
      status.textContent = `No romanizer for ${LANG_LABEL[lang]}`;
      return;
    }
    const targets = [...words]; // stable snapshot (the async JA path yields to the event loop)
    status.textContent =
      lang === "ja" && !jaWarmed ? "Romanizing… (loading Japanese dictionary — one-time, ~10MB)" : `Romanizing ${LANG_LABEL[lang]}…`;
    let romas: string[];
    try {
      romas = await romanizeWordsAsync(
        targets.map((w) => w.text),
        lang
      );
      if (lang === "ja") jaWarmed = true;
    } catch (e) {
      status.textContent = `Romanize failed — ${(e as Error).message || "dictionary unavailable"}`;
      return;
    }
    const before = cloneWords();
    let n = 0;
    targets.forEach((w, i) => {
      const r = romas[i];
      if (r && r !== w.roman) {
        w.roman = r;
        n++;
      }
    });
    if (!n) {
      status.textContent = "Romanization already up to date";
      return;
    }
    pushUndo(before);
    markDirty();
    if (showRoman) relayout(); // repaint labels if romanization is currently shown
    status.textContent = `Romanized ${n} word${n === 1 ? "" : "s"} (${LANG_LABEL[lang]}) — toggle "w" to view`;
  };

  // Settings that belong ABOVE the timeline (voices / legend / offset) — collected here and placed INSIDE
  // the timeline's scroll pane (not the fixed header), so they scroll away with the content and only the
  // advanced pane competes for the timeline's height.
  const headerSettings: HTMLElement[] = [];

  // Voices row: rename the two duet voices (canonical "a"/"b"; defaults Mittens/Biscuit). Pure per-track
  // UI aliases — they drive the popover/hotkey labels + the exported TTML <ttm:name>, never the pops.
  if (!roLock) {
    const voicesRow = document.createElement("div");
    voicesRow.setAttribute("style", "display:flex; align-items:center; gap:12px; flex-wrap:wrap; margin:0 0 6px; font-size:12px;");
    const names = getSingerNames(overridesStore, id);
    const mkVoice = (which: "a" | "b", color: string, initial: string): HTMLElement => {
      const cell = document.createElement("div");
      cell.setAttribute("style", "display:flex; align-items:center; gap:5px;");
      const dot = document.createElement("span");
      dot.setAttribute("style", `width:11px; height:11px; border-radius:50%; background:${color}; flex:0 0 auto;`);
      const inp = document.createElement("input");
      inp.type = "text";
      inp.value = initial;
      inp.maxLength = 24;
      inp.placeholder = which === "a" ? DEFAULT_SINGER_NAMES.a : DEFAULT_SINGER_NAMES.b;
      inp.title = which === "a" ? "Nickname for voice A — sung by the MIRROR cat" : "Nickname for voice B — sung by the MAIN cat";
      inp.setAttribute(
        "style",
        "width:120px; padding:2px 6px; border-radius:6px; border:1px solid var(--spice-button-disabled,#555); background:var(--spice-main,#111); color:var(--spice-text,#fff); font-size:12px;"
      );
      const persist = (): void => setSingerName(overridesStore, id, which, inp.value);
      inp.addEventListener("change", persist);
      inp.addEventListener("blur", persist);
      cell.append(dot, inp);
      return cell;
    };
    const voicesLabel = document.createElement("span");
    voicesLabel.textContent = "Voices:";
    voicesLabel.setAttribute("style", "opacity:.7;");
    voicesRow.append(voicesLabel, mkVoice("a", "#7ed957", names.a), mkVoice("b", "#0f7a3d", names.b));

    // Song-level romanization: language dropdown (overrides auto-detect, persisted per track) + a
    // whole-song Romanize button. Never runs automatically.
    const spacer = document.createElement("span");
    spacer.setAttribute("style", "width:1px; align-self:stretch; background:rgba(255,255,255,.12); margin:0 2px;");
    const langLabel = document.createElement("span");
    langLabel.textContent = "Language:";
    langLabel.setAttribute("style", "opacity:.7;");
    const langSel = buildLangSelect();
    langSel.setAttribute(
      "style",
      "padding:2px 6px; border-radius:6px; border:1px solid var(--spice-button-disabled,#555); background:var(--spice-main,#111); color:var(--spice-text,#fff); font-size:12px;"
    );
    const romanizeAllBtn = whitelistButton("Romanize all", () => void romanizeAllWords());
    romanizeAllBtn.style.fontSize = "12px";
    romanizeAllBtn.title = "Fill every word's romanization from the detected/selected language (hand-tune after)";
    voicesRow.append(spacer, langLabel, langSel, romanizeAllBtn);
    headerSettings.push(voicesRow);
  }

  // Hotkey/how-to legend — collapsed by default so it doesn't eat the timeline's vertical space.
  const help = document.createElement("details");
  help.setAttribute("style", "margin:2px 0 6px; font-size:12px;");
  const helpSummary = document.createElement("summary");
  helpSummary.textContent = "⌨ Shortcuts & how-to";
  helpSummary.setAttribute("style", "cursor:pointer; opacity:.6; user-select:none; list-style:revert;");
  const helpBody = document.createElement("div");
  helpBody.setAttribute("style", "margin-top:6px; line-height:1.5; opacity:.7;");
  helpBody.textContent =
    `Drag a word to move it; drag the corner nibs to resize; click to fine-tune. Yellow = lines (click to play just before + clear blue), ` +
    `grey = beat (bpm ÷ time-cut). Record (passive): play the song and tap ${[...recordKeys()].map((k) => `"${k}"`).join("/")} ` +
    `per word as a line plays to plot BLUE bars (auto-applies when the count matches the words). "," plots a GREEN bar ` +
    `at the pointer (no playback needed) — drag them to arrange, and a line applies when its green count matches too. ←/→ = jump line · ↑/↓ = jump word · "a" = add word · "+"/"=" = add an empty line divider at the pointer (fill it with "a") · "d" = prune (cut active word's end to the bar) · "f" = fill (extend the bar's word to the next) · "\\" = snap the closest line's start to the bar + redistribute its words · 1/2/3/4 = stretch/squash the bar word's nibs (hold to grow) · "r" = follow · "w" = characters⇄romanization · "8" = star · "c" = cycle the hovered word's DUET VOICE (Both → Mittens → Biscuit); hover the yellow LINE marker to cycle the whole line · "l" = text-edit a line (hover its yellow marker, or the playing line): words + romanization, + Delete line + flag an OVERLAPPING main line (its last word's tail stretches past the following lines; resize that tail in the background lane) · "⬆ Upload lyrics" (top) → queue newline-separated lyrics, then "]" = plot the next line at the white bar, "[" = re-sync the last plotted line to the bar · "x" = clear bars · "b" = bookmark · ` +
    `"s" = save · "z" = undo · "y" = redo · "t" = track toggle: switch all edits between MAIN (green) and BACKGROUND (thin purple lane) vocals — build + time the two overlapping parts with the same tools (or toggle a single word's "Background" in its popover) · the two duet voices (default "Mittens"/"Biscuit") sing on separate cats — rename them in the Voices row · autosaves every 30s ("Save & close" to exit) · 200px = 1 second.`;
  help.append(helpSummary, helpBody);
  headerSettings.push(help);

  // NOTE: a word-less editor is intentional now — it's the blank canvas for the "⬆ Upload lyrics" +
  // "[" / "]" plotting workflow (and what a no-LRC track opens into). So we DON'T early-return here; the
  // full editor (split + upload button + empty timeline) renders below.

  // Lyric sync offset control: nudges ALL words/lines earlier (−) or later (+) in one shot, without
  // editing their individual timing. Persists immediately, redraws the timeline, and refreshes the
  // live pulse when this is the current track.
  const offsetRow = document.createElement("div");
  offsetRow.setAttribute(
    "style",
    "display:flex; align-items:center; gap:6px; flex-wrap:wrap; margin:6px 0 2px; font-size:12px;"
  );
  const offsetLabel = document.createElement("span");
  offsetLabel.textContent = "Lyric sync offset (ms) — ± shifts every line/word:";
  offsetLabel.style.opacity = ".8";
  const offsetInput = document.createElement("input");
  offsetInput.type = "number";
  offsetInput.step = "10";
  offsetInput.min = String(-MAX_LYRIC_OFFSET_MS);
  offsetInput.max = String(MAX_LYRIC_OFFSET_MS);
  offsetInput.setAttribute(
    "style",
    "width:84px; padding:4px 6px; border-radius:6px; border:1px solid var(--spice-button-disabled,#444); " +
      "background:var(--spice-main,#121212); color:var(--spice-text,#fff); font-size:13px;"
  );
  const paintOffset = (): void => {
    offsetInput.value = String(lyricOffset);
  };
  const applyOffset = (v: number): void => {
    if (starred) {
      status.textContent = "★ Starred — unstar to adjust the offset";
      paintOffset();
      return;
    }
    lyricOffset = clampLyricOffset(v);
    setLyricOffset(overridesStore, id, lyricOffset);
    paintOffset();
    build(); // redraw bars/markers/taps at the new offset (beat grid + playhead stay on true time)
    if (Spicetify.Player.data?.item?.uri === uri) catController?.refreshOnsets(); // reflect live
    status.textContent = lyricOffset
      ? `Lyric offset ${lyricOffset > 0 ? "+" : ""}${lyricOffset} ms (later ⇢)`
      : "Lyric offset cleared";
  };
  const nudge = (d: number): HTMLButtonElement =>
    whitelistButton(d > 0 ? `+${d}` : String(d), () => applyOffset(lyricOffset + d));
  offsetInput.addEventListener("change", () => {
    const v = parseInt(offsetInput.value, 10);
    applyOffset(Number.isFinite(v) ? v : 0);
  });
  paintOffset();
  offsetRow.append(
    offsetLabel,
    nudge(-100),
    nudge(-10),
    offsetInput,
    nudge(10),
    nudge(100),
    whitelistButton("Reset", () => applyOffset(0))
  );
  if (!roLock) headerSettings.push(offsetRow); // no sync-offset control in a read-only preview

  // ── Timeline + advanced split (VSCode editor/terminal style) ──
  // The timeline gets its OWN bounded scroll pane so the advanced panel can sit BELOW it as a real split
  // rather than overlapping. A draggable divider resizes the two; the split fills from its top down to the
  // viewport bottom. The advanced pane hosts (one at a time) the plotting view, per-word settings
  // (replacing the popover), and the line editor (replacing the centered overlay).
  const rowsWrap = document.createElement("div");
  rowsWrap.setAttribute("style", "position:relative;");
  const timelineScroller = document.createElement("div");
  timelineScroller.setAttribute("style", "flex:1 1 auto; overflow:auto; min-height:120px;");
  for (const el of headerSettings) timelineScroller.append(el); // settings scroll with the timeline
  timelineScroller.append(rowsWrap);

  type AdvMode = "plotting" | "word" | "line" | "hint";
  let advMode: AdvMode | null = null;
  const advDivider = document.createElement("div");
  advDivider.setAttribute(
    "style",
    "flex:0 0 8px; display:none; cursor:row-resize; background:rgba(255,255,255,.07); " +
      "border-top:1px solid rgba(255,255,255,.12); border-bottom:1px solid rgba(255,255,255,.12);"
  );
  advDivider.title = "Drag to resize";
  const advPane = document.createElement("div");
  advPane.className = "catjam-adv-panel";
  advPane.setAttribute(
    "style",
    "flex:0 0 260px; display:none; flex-direction:column; overflow:hidden; background:var(--spice-card,#282828); color:var(--spice-text,#fff);"
  );
  const splitWrap = document.createElement("div");
  splitWrap.setAttribute("style", "display:flex; flex-direction:column; margin-top:10px; min-height:300px;");
  splitWrap.append(timelineScroller, advDivider, advPane);
  host.append(splitWrap);

  // Set later (where the follow geometry lives) to force a re-measure — the timeline pane's height
  // changes whenever the split resizes or the advanced pane opens/closes, so follow must re-anchor.
  let invalidateFollowGeom: () => void = () => {};
  let repositionFollowBtn: () => void = () => {}; // set where followBtn exists; anchors it to the pane bottom
  let panelScroller: HTMLElement | null = null; // the OUTER scrolling panel (Settings/Cloud Sync/editor)
  // Size the split to a FULL editor-panel VIEWPORT (clientHeight), not merely the gap below the title row.
  // That makes the title row + Save/Undo/Star/Advanced/Upload controls above it genuine SCROLL-AWAY
  // overflow: on open we pin the split's top to the panel top (anchorOnOpen) so the controls sit above the
  // fold and the timeline owns the whole visible height — scroll up to reach the controls. Measuring the
  // panel's own viewport keeps the height stable no matter where it's scrolled. (Was `bottom - top`, which
  // left the controls permanently stuck on-screen because title + split exactly filled the viewport.)
  const sizeSplit = (): void => {
    if (!splitWrap.isConnected) return;
    if (!panelScroller || !panelScroller.isConnected) panelScroller = scrollParent(splitWrap);
    const viewport = panelScroller ? panelScroller.clientHeight : window.innerHeight;
    splitWrap.style.height = `${Math.max(360, viewport - 8)}px`;
    invalidateFollowGeom();
    repositionFollowBtn();
  };

  const advTitleText = document.createElement("span");
  advTitleText.setAttribute("style", "font-weight:700; font-size:13px; margin-right:auto;");
  const advBody = document.createElement("div");
  advBody.setAttribute("style", "flex:1 1 auto; overflow:auto; padding:12px 14px;");
  const advHeader = document.createElement("div");
  advHeader.setAttribute(
    "style",
    "display:flex; align-items:center; gap:8px; padding:8px 12px; border-bottom:1px solid rgba(255,255,255,.08); flex:0 0 auto;"
  );
  const advClose = whitelistButton("✕", () => closeAdvanced());
  advClose.style.padding = "2px 10px";
  advClose.title = "Close the advanced editor";
  advHeader.append(advTitleText, advClose);
  advPane.append(advHeader, advBody);

  const advOpen = (): boolean => advPane.style.display === "flex";
  const openAdvanced = (mode: AdvMode, title: string, render: (body: HTMLElement) => void): void => {
    advMode = mode;
    advTitleText.textContent = title;
    advBody.textContent = "";
    render(advBody);
    advPane.style.display = "flex";
    advDivider.style.display = "block";
    sizeSplit();
  };
  const closeAdvanced = (): void => {
    advPane.style.display = "none";
    advDivider.style.display = "none";
    advMode = null;
    advBody.textContent = "";
    invalidateFollowGeom(); // timeline pane reclaimed the space → re-anchor follow
    repositionFollowBtn();
  };

  // Drag the divider to resize the advanced pane (clamped so the timeline keeps room).
  advDivider.addEventListener("pointerdown", (e: PointerEvent) => {
    e.preventDefault();
    advDivider.setPointerCapture(e.pointerId);
    const startY = e.clientY;
    const startH = advPane.offsetHeight;
    const splitH = splitWrap.offsetHeight;
    const move = (ev: PointerEvent): void => {
      advPane.style.flexBasis = `${Math.max(120, Math.min(splitH - 160, startH - (ev.clientY - startY)))}px`;
      invalidateFollowGeom();
      repositionFollowBtn();
    };
    const up = (ev: PointerEvent): void => {
      advDivider.releasePointerCapture(ev.pointerId);
      advDivider.removeEventListener("pointermove", move);
      advDivider.removeEventListener("pointerup", up);
    };
    advDivider.addEventListener("pointermove", move);
    advDivider.addEventListener("pointerup", up);
  });

  const onWinResize = (): void => sizeSplit();
  window.addEventListener("resize", onWinResize);
  help.addEventListener("toggle", () => sizeSplit()); // expanding the legend shifts the split's top
  requestAnimationFrame(sizeSplit);

  // Discoverability toggle in the header row (the actions below also open the panel).
  if (!roLock) {
    const advToggle = whitelistButton("⚙ Advanced", () =>
      advOpen()
        ? closeAdvanced()
        : openAdvanced("hint", "Advanced editor", (b) => {
            b.setAttribute("style", "opacity:.8; font-size:13px; line-height:1.5;");
            b.textContent =
              'Click a word to edit it here · press "l" for the line editor · "[" / "]" to plot uploaded raw lyrics onto the playhead.';
          })
    );
    advToggle.title = "Show/hide the advanced editor (word settings, line editor, plotting)";
    titleRow.insertBefore(advToggle, status);
  }

  // Song length (ms): prefer the analysis coverage, else the last word + tail.
  const lastEnd = words.reduce((m, w) => Math.max(m, w.end), 0);
  const analysis = getTrackAnalysis ? await getTrackAnalysis(uri) : null;
  const segEnd = analysis?.segments.length
    ? Math.round((analysis.segments[analysis.segments.length - 1].start + analysis.segments[analysis.segments.length - 1].duration) * 1000)
    : 0;
  const timelineMs = Math.max(segEnd, lastEnd + 3000, 1000);

  // Beat gridline times (ms): the SAME clock the cat bounces on — the pulse's felt tempo and sync
  // delay, so the lines sit exactly where `beatPhase((ms - delay)/1000, felt)` hits zero. Read live
  // from the controller when this is the current track (authoritative), else the override fallback.
  const live = Spicetify.Player.data?.item?.uri === uri ? catController?.currentBeat?.() : null;
  const gridFelt = live ? live.feltBpm : fallbackFelt;
  const gridDelay = live ? live.delayMs : ov?.delayMs ?? 0;
  // Pop Cat bounces every OTHER felt beat (its squash runs at felt/2), so match THAT cadence —
  // a line per bounce — when Pop Cat is the source; one line per felt beat otherwise (Bongo).
  const beatsPerLine = perPulseSource() ? 2 : 1;
  const gridBeats: number[] = [];
  if (gridFelt > 0) {
    const step = (60000 / gridFelt) * beatsPerLine;
    for (let t = (((gridDelay % step) + step) % step); t <= timelineMs; t += step) gridBeats.push(t);
  }

  let rowDivs: HTMLElement[] = [];
  let rowWidthPx = 760;
  let rowWidthMs = rowWidthPx / PX_PER_MS;
  let builtWidth = -1; // the rowsWrap.clientWidth the last build() used; lets the resize observer skip no-op rebuilds

  const fmtClock = (ms: number): string => {
    const s = Math.floor(ms / 1000);
    return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
  };

  // Seek playback to ~LINE_SEEK_LEAD_MS before `ms` (so the lead-in plays), starting playback if it's
  // paused. No-op unless this editor's track is the one loaded. Used by the yellow line markers and
  // the purple bookmark.
  const seekWithLead = (ms: number): void => {
    if (Spicetify.Player.data?.item?.uri !== uri) return;
    Spicetify.Player.seek?.(Math.max(0, ms - LINE_SEEK_LEAD_MS));
    if (!Spicetify.Player.isPlaying()) Spicetify.Player.play();
  };

  // Jump the playhead to the yellow line marker before (-1) or after (+1) the current position, then
  // play from ~0.5s before it. For "back": normally restart the line we're in, BUT if we only just
  // crossed into it (within BACK_GRACE_MS), go to the PREVIOUS line — so a quick back-press returns
  // to the line that was just playing rather than the head of the one we just entered. RAPID "next"
  // presses buffer forward one line each, stepping from the last jumped line instead of the lead-
  // shifted playhead (the ~0.5s seek lead would otherwise re-select the line we just jumped to).
  let lastLineMs = -1;
  let lastLineStart = -1;
  const LINE_RAPID_MS = 700;
  const snapToLine = (dir: -1 | 1): void => {
    if (Spicetify.Player.data?.item?.uri !== uri) return;
    const pos = Spicetify.Player.getProgress?.() ?? 0;
    const marks = lineStarts.map((t) => t + lyricOffset).sort((a, b) => a - b); // effective (displayed) starts
    if (!marks.length) return;
    const BACK_GRACE_MS = 500;
    if (dir > 0) {
      const now = Date.now();
      const rapid = now - lastLineMs < LINE_RAPID_MS && lastLineStart >= 0;
      const t = rapid ? marks.find((m) => m > lastLineStart + 1) : marks.find((m) => m > pos + 120);
      if (t === undefined) return;
      lastLineMs = now;
      lastLineStart = t;
      seekWithLead(t);
      return;
    }
    lastLineMs = -1; // a back press ends any forward buffer
    // Back: the current line's start (largest mark ≤ now), stepping to the previous line when we just
    // entered the current one.
    let cur = -1;
    for (let i = 0; i < marks.length; i++) {
      if (marks[i] <= pos + 120) cur = i;
      else break;
    }
    if (cur < 0) return; // before the first line
    const targetIdx = pos - marks[cur] < BACK_GRACE_MS && cur > 0 ? cur - 1 : cur;
    seekWithLead(marks[targetIdx]);
  };

  // Snap the playhead to the HEAD (start) of a word, exactly (no lead — word-level precision). "next"
  // = the first word after the bar. "prev" = the current word's head; RAPID ↑ presses pan backward
  // one word at a time, ignoring the slight playback drift since the last press (otherwise a brief
  // moment of playback re-selects the current word's head instead of the one before). Words sorted.
  let lastUpMs = -1;
  let lastUpStart = -1;
  const RAPID_PAN_MS = 500;
  const snapToWord = (which: "prev" | "next"): void => {
    if (Spicetify.Player.data?.item?.uri !== uri) return;
    const rawPos = (Spicetify.Player.getProgress?.() ?? 0) - lyricOffset; // raw time (strip the offset)
    let target: number | null = null;
    if (which === "next") {
      for (const w of words) if (w.start > rawPos + 60) { target = w.start; break; }
      lastUpMs = -1; // forward press ends any backward pan
    } else {
      const now = Date.now();
      if (now - lastUpMs < RAPID_PAN_MS && lastUpStart >= 0) {
        // Rapid pan: step back one word from where we last landed (ignore playback drift).
        for (const w of words) if (w.start < lastUpStart - 1) target = w.start; else break;
        if (target === null) target = lastUpStart; // clamp at the first word
      } else {
        for (const w of words) if (w.start <= rawPos) target = w.start; else break; // current word's head
      }
      if (target === null) return;
      lastUpMs = now;
      lastUpStart = target;
    }
    if (target === null) return;
    Spicetify.Player.seek?.(Math.max(0, target + lyricOffset)); // effective time; seek only — don't auto-play
  };

  // Map a pointer event to an absolute song time (which row by Y, where across it by X).
  const pointerToMs = (e: PointerEvent): number => {
    // Rows are uniform (EDITOR_ROW_H + gap) and full-width, so the row + x map arithmetically from a
    // SINGLE rect read of the container. (The old per-row getBoundingClientRect loop forced one
    // layout reflow per row on every pointermove — the main source of drag jitter on long songs.)
    const wrap = rowsWrap.getBoundingClientRect();
    const stride = EDITOR_ROW_H + EDITOR_ROW_GAP;
    const row = Math.max(0, Math.min(rowDivs.length - 1, Math.floor((e.clientY - wrap.top) / stride)));
    const xInRow = Math.max(0, Math.min(e.clientX - wrap.left, rowWidthPx));
    return row * rowWidthMs + xInRow / PX_PER_MS;
  };

  // (Editor element styling is class-based — see ensureEditorCss. Lead nibs sit on opposite corners
  // so they don't overlap the body grab on a narrow bar; background vocals use a thin 5px lane.)

  const idxOf = (w: EditWord): number => words.indexOf(w);
  // Nearest word in the SAME lane (lead vs background) before/after `w` — resize/cascade only affect
  // their own lane, so background words can overlap the lead freely.
  const prevInLane = (w: EditWord): EditWord | undefined => {
    let best: EditWord | undefined;
    for (const x of words) if (!!x.secondary === !!w.secondary && x.start < w.start && (!best || x.start > best.start)) best = x;
    return best;
  };
  const nextInLane = (w: EditWord): EditWord | undefined => {
    let best: EditWord | undefined;
    for (const x of words) if (!!x.secondary === !!w.secondary && x.start > w.start && (!best || x.start < best.start)) best = x;
    return best;
  };

  // A word is "prominent" (tall editable bar) when it's in the ACTIVE edit lane; the other lane renders
  // as the thin top strip. The "t" toggle flips which lane is active, swapping the two lanes' roles.
  // Prominent = fully-drawn/editable bar (vs the thin dimmed strip of the inactive lane). A word is
  // prominent when its own lane is the active one — EXCEPT an overlapping main note, which is prominent
  // in BOTH lanes (it's a lead word you set the START/position of in the main lane and the DURATION of in
  // the background lane). The "t" toggle flips which lane is active.
  const isProminent = (w: EditWord): boolean => !!w.secondary === bgLane || !!w.overlap;
  // A line is "overlapping" when one of its LEAD words carries the overlap flag (the trailing sustain) —
  // its gold line marker gets a 1px purple accent (see .cj-line-overlap).
  const lineIsOverlapping = (L: number): boolean => words.some((w) => w.line === L && !w.secondary && !!w.overlap);

  const makeSegment = (w: EditWord): SegEl => {
    // Class-only styling. Position/prominence (cj-prom/cj-minor) tracks the ACTIVE lane; colour
    // (cj-c-<voice>-<lane>) is independent; the gold/blue recolour is a cj-starred/cj-ro container class.
    const el = document.createElement("div") as SegEl;
    const prom = isProminent(w);
    el.className = `cj-bar ${prom ? "cj-prom" : "cj-minor"} cj-c-${w.singer ?? "both"}-${w.secondary ? "bg" : "lead"}`;
    const leftNib = document.createElement("div");
    leftNib.className = prom ? "cj-nib-l" : "cj-nib-sec-l";
    const rightNib = document.createElement("div");
    rightNib.className = prom ? "cj-nib-r" : "cj-nib-sec-r";
    el.append(leftNib, rightNib);
    el._leftNib = leftNib;
    el._rightNib = rightNib;
    // Track the hovered word so the "c" hotkey can cycle the voice of whatever's under the cursor.
    el.addEventListener("pointerenter", () => void (hoverWord = w));
    el.addEventListener("pointerleave", () => void (hoverWord === w && (hoverWord = null)));
    attachDrag(w, el);
    attachResize(w, leftNib, "start");
    attachResize(w, rightNib, "end");
    return el;
  };

  // Lay a word out as one bar segment PER ROW it spans, so a word crossing a row edge continues
  // onto the next row instead of being clipped. The left nib shows on the first segment, the right
  // on the last; the label sits under the first segment. `nextPrimaryStartRaw` (the raw start of the
  // next lead word, used only to cap the label width) can be passed in precomputed by a full relayout
  // to avoid an O(n) scan per word; omitted callers (single-word drags) fall back to a live lookup.
  const layoutWord = (w: EditWord, nextPrimaryStartRaw?: number): void => {
    const prominent = isProminent(w); // tall bar + label when in the active lane; thin strip otherwise
    // Draw at the OFFSET-applied position (raw time + the lyric offset); the stored model stays raw.
    const start = Math.max(0, w.start + lyricOffset);
    const end = Math.max(start + 1, w.end + lyricOffset);
    const segs: { row: number; x: number; width: number }[] = [];
    let s = start;
    while (s < end && segs.length < 64) {
      const row = Math.floor(s / rowWidthMs);
      if (row >= rowDivs.length) break;
      const rowEndMs = (row + 1) * rowWidthMs;
      const segEnd = Math.min(end, rowEndMs);
      segs.push({ row, x: (s - row * rowWidthMs) * PX_PER_MS, width: Math.max(4, (segEnd - s) * PX_PER_MS) });
      s = rowEndMs;
    }
    if (!segs.length) segs.push({ row: 0, x: 0, width: 4 });
    const els = (w.els ??= []);
    while (els.length < segs.length) els.push(makeSegment(w));
    while (els.length > segs.length) els.pop()!.remove();
    segs.forEach((seg, i) => {
      const el = els[i];
      if (el.parentElement !== rowDivs[seg.row]) rowDivs[seg.row].appendChild(el);
      // Only write a style/attribute when its value actually changed — a relayout that lands a
      // segment on the same spot then skips the write (and the recalc it would trigger).
      if (el._x !== seg.x) {
        el.style.left = `${seg.x}px`;
        el._x = seg.x;
      }
      if (el._w !== seg.width) {
        el.style.width = `${seg.width}px`;
        el._w = seg.width;
      }
      const title = `${w.text} · ${fmtClock(start)}–${fmtClock(end)}`; // effective (offset-applied) times
      if (el._title !== title) {
        el.title = title;
        el._title = title;
      }
      if (prominent) {
        const firstR = i === 0 ? "5px" : "0";
        const lastR = i === segs.length - 1 ? "5px" : "0";
        el.style.borderRadius = `${firstR} ${lastR} ${lastR} ${firstR}`;
      }
      el._leftNib!.style.display = i === 0 ? "block" : "none";
      // An overlapping main note hides its trailing nib in the MAIN lane (its end can't be dragged there,
      // so it can't push the following lines) — the end is resized from the background lane instead.
      const endLocked = !!w.overlap && !bgLane;
      el._rightNib!.style.display = i === segs.length - 1 && !endLocked ? "block" : "none";
    });
    // The INACTIVE lane (thin strip) carries no text label — the strip + tooltip is enough, and a label
    // would collide with the active lane's word below it.
    if (!prominent) {
      w.label?.remove();
      w.label = undefined;
      return;
    }
    const label = (w.label ??= (() => {
      const l = document.createElement("span");
      l.className = "cj-label"; // gold-when-locked handled by the cj-starred container class
      return l;
    })());
    const f = segs[0];
    if (label.parentElement !== rowDivs[f.row]) rowDivs[f.row].appendChild(label);
    label.style.left = `${f.x}px`;
    // Cap the label to its slot — the space until the NEXT PRIMARY word's start (or the row edge) — so
    // neighbouring labels ellipsis-truncate instead of overlapping each other.
    const npRaw = nextPrimaryStartRaw ?? words.find((x) => isProminent(x) && x.start > w.start)?.start ?? Infinity;
    const nextStart = Number.isFinite(npRaw) ? Math.max(0, npRaw + lyricOffset) : Infinity;
    const limitMs = Math.min(nextStart, (f.row + 1) * rowWidthMs); // next word, or the row's right edge
    const availPx = (limitMs - start) * PX_PER_MS - 3; // 3px breathing gap
    label.style.maxWidth = `${Math.max(14, Math.min(160, availPx))}px`;
    const lbl = showRoman && w.roman ? w.roman : w.text; // romanization when toggled on (else characters)
    if (label.textContent !== lbl) label.textContent = lbl;
  };
  // Raw start of the next PROMINENT (active-lane) word after each `words[i]` (Infinity if none) — one
  // backward pass over the start-sorted list, replacing layoutWord's per-word O(n) scan during a full
  // (re)layout. Only prominent words carry labels, and the active lane's starts stay start-sorted.
  const nextPrimaryStarts = (): number[] => {
    const out = new Array<number>(words.length);
    let np = Infinity;
    for (let i = words.length - 1; i >= 0; i--) {
      out[i] = np;
      if (isProminent(words[i])) np = words[i].start;
    }
    return out;
  };
  const relayout = (): void => {
    const nps = nextPrimaryStarts();
    words.forEach((w, i) => layoutWord(w, nps[i]));
  };

  // Move word `i`'s start, BUMPING neighbours out of the way (cascades down a whole row if needed)
  // so dragging past a neighbour shoves it along rather than stopping. Preserves each word's
  // duration.
  // Returns the inclusive [lo, hi] index range it actually moved (the word + any neighbours it
  // bumped), so a caller can relay out just those instead of every word.
  const moveWord = (i: number, newStart: number): [number, number] => {
    if (i < 0) return [0, -1];
    const sec = !!words[i].secondary; // cascade only bumps SAME-lane words (lead vs background)
    const dur = words[i].end - words[i].start;
    const start = Math.max(0, Math.min(newStart, timelineMs - dur));
    words[i].start = start;
    words[i].end = start + dur;
    let hi = i;
    let prevEnd = words[i].end;
    for (let j = i + 1; j < words.length; j++) {
      if (!!words[j].secondary !== sec) continue; // skip the other lane
      if (words[j].start >= prevEnd) break;
      const d = words[j].end - words[j].start;
      words[j].start = prevEnd;
      words[j].end = prevEnd + d;
      prevEnd = words[j].end;
      hi = j;
    }
    let lo = i;
    let nextStart = words[i].start;
    for (let j = i - 1; j >= 0; j--) {
      if (!!words[j].secondary !== sec) continue;
      if (words[j].end <= nextStart) break;
      const d = words[j].end - words[j].start;
      words[j].end = nextStart;
      words[j].start = Math.max(0, nextStart - d);
      nextStart = words[j].start;
      lo = j;
    }
    return [lo, hi];
  };

  // Click a word → a small popover to fine-tune start / duration / text. `focusText` selects the
  // text field immediately (used when a freshly-added word wants a name typed).
  // Render a word's settings into the advanced split panel (replacing the old floating popover). The
  // `anchor` arg is unused now (the panel is fixed) but kept so call sites are unchanged.
  const openPopover = (w: EditWord, _anchor: HTMLElement, focusText = false): void => {
    const field = (label: string, input: HTMLElement): HTMLElement => {
      const wrap = document.createElement("label");
      wrap.setAttribute("style", "display:flex; flex-direction:column; gap:3px; font-size:11px; opacity:.85; min-width:0;");
      const t = document.createElement("span");
      t.textContent = label;
      wrap.append(t, input);
      return wrap;
    };
    const inputStyle =
      "padding:6px 8px; border-radius:6px; border:1px solid var(--spice-button-disabled,#444); " +
      "background:var(--spice-main,#121212); color:var(--spice-text,#fff); font-size:13px;";
    const textIn = document.createElement("input");
    textIn.type = "text";
    textIn.value = w.text;
    textIn.setAttribute("style", inputStyle + " min-width:160px;");
    const startIn = document.createElement("input");
    startIn.type = "number";
    startIn.step = "0.01";
    startIn.value = (w.start / 1000).toFixed(2);
    startIn.setAttribute("style", inputStyle + " width:120px;");
    const durIn = document.createElement("input");
    durIn.type = "number";
    durIn.step = "10";
    durIn.min = String(EDIT_MIN_DUR);
    durIn.value = String(Math.round(w.end - w.start));
    durIn.setAttribute("style", inputStyle + " width:120px;");

    // Background (secondary) toggle — reclassify a mis-detected overlapping word between the lead
    // lane and the thin background lane.
    const bgIn = document.createElement("input");
    bgIn.type = "checkbox";
    bgIn.checked = !!w.secondary;
    bgIn.style.cssText = "width:16px; height:16px; cursor:pointer;";

    // Voice cycler — ‹ ● label › steps this word through the three voices: Both (unison, both cats) →
    // "a" (mirror cat, nickname Mittens) → "b" (main cat, nickname Biscuit). Orthogonal to the
    // background lane above. Labels read the per-track nicknames; renaming lives in the editor header.
    const VOICE_ORDER: (undefined | "a" | "b")[] = [undefined, "a", "b"];
    let singerSel: "a" | "b" | undefined = w.singer;
    const voiceColorOf = (s: "a" | "b" | undefined): string => (s === "a" ? "#7ed957" : s === "b" ? "#0f7a3d" : "#1db954");
    const voiceLabelOf = (s: "a" | "b" | undefined): string => {
      if (!s) return "Both (unison)";
      const nm = getSingerNames(overridesStore, id);
      return s === "a" ? `${nm.a} (mirror)` : `${nm.b} (main)`;
    };
    const voiceRow = document.createElement("div");
    voiceRow.setAttribute("style", "display:flex; align-items:center; gap:6px; min-width:200px;");
    const voiceDot = document.createElement("span");
    voiceDot.setAttribute("style", "width:11px; height:11px; border-radius:50%; flex:0 0 auto;");
    const voiceText = document.createElement("span");
    voiceText.setAttribute("style", "flex:1; min-width:0; text-align:center; opacity:.9;");
    const renderVoice = (): void => {
      voiceDot.style.background = voiceColorOf(singerSel);
      voiceText.textContent = voiceLabelOf(singerSel);
    };
    const cycleVoice = (dir: number): void => {
      singerSel = VOICE_ORDER[(VOICE_ORDER.indexOf(singerSel) + dir + VOICE_ORDER.length) % VOICE_ORDER.length];
      renderVoice();
    };
    const voicePrev = whitelistButton("‹", () => cycleVoice(-1));
    const voiceNext = whitelistButton("›", () => cycleVoice(1));
    voicePrev.style.padding = voiceNext.style.padding = "2px 10px";
    voiceRow.append(voicePrev, voiceDot, voiceText, voiceNext);
    renderVoice();

    const btns = document.createElement("div");
    btns.setAttribute("style", "display:flex; gap:8px; align-items:flex-end;");
    const apply = whitelistButton("Apply", () => {
      const before = cloneWords();
      let start = Math.round(parseFloat(startIn.value) * 1000);
      if (!Number.isFinite(start)) start = w.start;
      let dur = Math.round(parseFloat(durIn.value));
      if (!Number.isFinite(dur) || dur < EDIT_MIN_DUR) dur = EDIT_MIN_DUR;
      w.text = textIn.value.trim() || w.text;
      if (bgIn.checked !== !!w.secondary || singerSel !== w.singer) {
        w.secondary = bgIn.checked || undefined; // switched lane / voice → recreate the bar with the new style
        w.singer = singerSel;
        w.els?.forEach((e) => e.remove());
        w.els = [];
      }
      moveWord(idxOf(w), start);
      const next = nextInLane(w); // clamp the end against the SAME lane's next word
      w.end = Math.min(w.start + dur, next ? next.start : timelineMs);
      relayout();
      pushUndo(before);
      markDirty();
      closeAdvanced();
    });
    const del = whitelistButton("Delete word", () => {
      const before = cloneWords();
      const i = idxOf(w);
      if (i >= 0) words.splice(i, 1);
      w.els?.forEach((e) => e.remove());
      w.label?.remove();
      pushUndo(before);
      markDirty();
      closeAdvanced();
    });
    const cancel = whitelistButton("Cancel", () => closeAdvanced());
    btns.append(apply, cancel, del);

    // Line head: only the FIRST (earliest) lead word of a lyric line can move that line's head — the
    // yellow marker / LRC line timestamp — to its own start. Fixes lines whose detected head drifted
    // off the real first word (e.g. the marker sits before "Say" instead of on it).
    const isLineHead = !w.secondary && !roLock && !words.some((x) => !x.secondary && x.line === w.line && x.start < w.start);
    const resyncRow = document.createElement("div");
    if (isLineHead) {
      const resync = whitelistButton("⟲ Set line start here", () => {
        const before = cloneWords();
        const L = w.line;
        const loB = L > 0 ? lineStarts[L - 1] + 1 : 0; // keep lineStarts strictly ascending
        const hiB = L + 1 < lineStarts.length ? lineStarts[L + 1] - 1 : timelineMs;
        lineStarts[L] = Math.max(loB, Math.min(w.start, hiB));
        build(); // redraw the yellow line markers at the new head
        pushUndo(before);
        markDirty();
        status.textContent = `Line start → ${fmtClock(lineStarts[L])}`;
        closeAdvanced();
      });
      resync.title = "Move this lyric line's start (the yellow marker) to this word";
      resync.style.background = "#ffd23f";
      resync.style.color = "#000";
      resyncRow.setAttribute("style", "display:flex; align-items:flex-end;");
      resyncRow.append(resync);
    }

    openAdvanced("word", `Edit word — "${w.text}"`, (body) => {
      const grid = document.createElement("div");
      grid.setAttribute("style", "display:flex; flex-wrap:wrap; align-items:flex-end; gap:12px;");
      grid.append(
        field("Word", textIn),
        field("Start (seconds)", startIn),
        field("Duration (ms)", durIn),
        field("Background (secondary)", bgIn),
        field("Voice", voiceRow),
        ...(isLineHead ? [resyncRow] : []),
        btns
      );
      body.append(grid);
    });
    centerRowInView(w.start); // keep the clicked word visible above the panel that just opened
    if (focusText) {
      textIn.focus();
      textIn.select();
    }
  };

  // Build the rows + markers + bars for the current width.
  const build = (): void => {
    ensureEditorCss();
    followGeomReady = false; // row geometry/width changed → re-measure the follow cache once (next tick)
    builtWidth = rowsWrap.clientWidth;
    rowWidthPx = Math.max(240, rowsWrap.clientWidth || 760);
    rowWidthMs = rowWidthPx / PX_PER_MS;
    // Lock/read-only recolour of every bar+label is one container-class toggle (CSS does the rest).
    rowsWrap.classList.toggle("cj-starred", starred);
    rowsWrap.classList.toggle("cj-ro", roLock);
    // Leave room for a positive offset pushing the last words past the raw song end.
    const rowCount = Math.max(1, Math.ceil((timelineMs + Math.max(0, lyricOffset)) / rowWidthMs));
    rowsWrap.textContent = "";
    rowDivs = [];
    // Assemble the whole timeline OFF-DOM in a fragment, then insert once — so the thousands of
    // appendChilds a rebuild does never touch the live tree (no interim layout work per node).
    const frag = document.createDocumentFragment();
    for (let i = 0; i < rowCount; i++) {
      const row = document.createElement("div");
      row.className = "cj-row";
      const label = document.createElement("span");
      label.className = "cj-rowlabel";
      label.textContent = fmtClock(i * rowWidthMs);
      row.appendChild(label);
      frag.appendChild(row);
      rowDivs.push(row);
    }
    // Dull grey beat gridlines at the actual detected beats (felt tempo) — something to align
    // words to. Appended first so bars/markers paint over them.
    for (const t of gridBeats) {
      if (t > timelineMs) break;
      const row = Math.floor(t / rowWidthMs);
      if (row >= rowDivs.length) continue;
      const gl = document.createElement("div");
      gl.className = "cj-grid";
      gl.style.left = `${(t - row * rowWidthMs) * PX_PER_MS}px`;
      rowDivs[row].appendChild(gl);
    }
    // Yellow line markers (seekable) at each lyric line's start — drawn/seeked at the OFFSET-applied
    // (effective) time, so they track the words as the offset changes.
    lineStarts.forEach((t, L) => {
      const dt = Math.max(0, t + lyricOffset);
      const row = Math.min(rowDivs.length - 1, Math.floor(dt / rowWidthMs));
      const marker = document.createElement("div");
      marker.className = lineIsOverlapping(L) ? "cj-line cj-line-overlap" : "cj-line";
      marker.style.left = `${(dt - row * rowWidthMs) * PX_PER_MS}px`;
      marker.title = `Line · play from ~${LINE_SEEK_LEAD_MS / 1000}s before ${fmtClock(dt)} · "c" = cycle this line's voice`;
      // Hovering the yellow line marker lets "c" cycle the WHOLE line's voice (see cycleVoiceOfHover).
      marker.addEventListener("pointerenter", () => void (hoverLine = L));
      marker.addEventListener("pointerleave", () => void (hoverLine === L && (hoverLine = null)));
      marker.addEventListener("click", () => {
        // Clear the live BLUE taps (only) — a fresh start for re-recording from this line. Green stays.
        if (tapsByLine.size) {
          tapsByLine.clear();
          renderMarks();
        }
        seekWithLead(dt);
      });
      rowDivs[row].appendChild(marker);
    });
    const nps = nextPrimaryStarts(); // precomputed once (kills the per-word O(n) label-cap scan)
    words.forEach((w, i) => {
      w.els = [];
      w.label = undefined;
      layoutWord(w, nps[i]);
    });
    frag.appendChild(playhead); // re-add after the rebuild cleared the rows
    rowsWrap.appendChild(frag); // single live insertion
    renderMarks(); // re-draw any in-progress (blue) / persistent (green) record taps after the rebuild
    renderBookmark(); // re-draw the purple bookmark marker
    updateBookmarkCaret(); // the mark's pixel position may have shifted → refresh the out-of-frame caret
  };

  // The pointer is captured on the STABLE `rowsWrap`, not the per-word segment element — because a
  // drag/resize re-lays the word out (adding/removing segments as it wraps), which would otherwise
  // destroy the captured element mid-gesture and strand the capture (frozen mouse). One gesture at
  // a time, so a single set of handlers is fine.
  let gesture: { move: (e: PointerEvent) => void; up: (e: PointerEvent) => void } | null = null;
  const beginGesture = (
    e: PointerEvent,
    move: (e: PointerEvent) => void,
    up: (e: PointerEvent) => void
  ): void => {
    flushResizeUndo(); // a pointer edit commits a pending resize-burst as one undo step first
    endGesture(e); // clear any stray prior gesture
    gesture = { move, up };
    rowsWrap.setPointerCapture(e.pointerId);
    rowsWrap.addEventListener("pointermove", move);
    rowsWrap.addEventListener("pointerup", up);
    rowsWrap.addEventListener("pointercancel", up);
  };
  function endGesture(e: PointerEvent): void {
    if (!gesture) return;
    rowsWrap.removeEventListener("pointermove", gesture.move);
    rowsWrap.removeEventListener("pointerup", gesture.up);
    rowsWrap.removeEventListener("pointercancel", gesture.up);
    try {
      rowsWrap.releasePointerCapture(e.pointerId);
    } catch {
      /* already released */
    }
    gesture = null;
  }

  // Body drag = move the word (taking time from the neighbour it meets); a click (no move) opens
  // the popover; a real drag autosaves on release.
  function attachDrag(w: EditWord, el: SegEl): void {
    let downX = 0;
    let downY = 0;
    let moved = false;
    let grabOffset = 0;
    let before: ReturnType<typeof cloneWords> = { words: [], lineStarts: [], plotLines: [], plotIndex: 0, lastPlottedLine: null };
    const onMove = (e: PointerEvent): void => {
      if (Math.abs(e.clientX - downX) > 4 || Math.abs(e.clientY - downY) > 4) moved = true;
      // Relay out only the word + the neighbours it bumped, not the whole timeline.
      const [lo, hi] = moveWord(idxOf(w), pointerToMs(e) + grabOffset);
      for (let k = lo; k <= hi; k++) layoutWord(words[k]);
    };
    const onUp = (e: PointerEvent): void => {
      endGesture(e);
      if (moved) {
        pushUndo(before);
        markDirty();
      } else openPopover(w, el);
    };
    el.addEventListener("pointerdown", (e: PointerEvent) => {
      if (starred || roLock) return; // locked — no moving/editing
      e.preventDefault();
      downX = e.clientX;
      downY = e.clientY;
      moved = false;
      before = cloneWords(); // snapshot before this drag (discarded if it turns out to be a click)
      grabOffset = w.start - pointerToMs(e);
      beginGesture(e, onMove, onUp);
    });
  }

  // Corner nib drag = resize one edge (start or end). Dragging PAST the adjacent word's facing edge
  // pushes it (taking time from that one neighbour only, down to its minimum) AND conjoins the two
  // for the rest of this gesture: once pushed, pulling back drags the neighbour's edge with it (the
  // neighbour grows as this word shrinks), so the boundary stays shared. Pulling a word in WITHOUT
  // first pushing only moves this word's edge — the neighbour (and any gap) is left alone. Driven by
  // horizontal travel (wrap-continuous); holding near a panel edge auto-advances + scrolls so a
  // word can be stretched further than one screen. Autosaves on release.
  function attachResize(w: EditWord, nib: HTMLElement, edge: "start" | "end"): void {
    let moved = false;
    let before: ReturnType<typeof cloneWords> = { words: [], lineStarts: [], plotLines: [], plotIndex: 0, lastPlottedLine: null };
    let anchorX = 0; // pointer X when the resize began — the baseline
    let anchorMs = 0; // the edge's time at that baseline
    let lockedNeighbor: EditWord | null = null; // neighbour pushed this gesture → boundary stays shared
    let neighborEdge0 = 0; // that neighbour's facing edge at gesture start — the push threshold

    // 1:1 horizontal: the edge sits at its baseline time plus the pointer's horizontal travel from
    // the grab point. Recomputed from the baseline each move (not accumulated), so clamping at a
    // neighbour never "sticks" — pull back and it tracks straight away. Purely horizontal, so a
    // wrapped word (whose edge is on another row) still moves left/right with the pointer.
    const apply = (clientX: number): void => {
      const target = anchorMs + (clientX - anchorX) / PX_PER_MS;
      if (edge === "start") {
        const prev = prevInLane(w);
        const lo = prev ? prev.start + EDIT_MIN_DUR : 0;
        w.start = Math.max(lo, Math.min(target, w.end - EDIT_MIN_DUR));
        if (prev && target < neighborEdge0) lockedNeighbor = prev; // pushed past prev's end → conjoin
        if (prev && lockedNeighbor === prev) {
          prev.end = w.start; // shared boundary: pushing shrinks prev, pulling back grows it again
          layoutWord(prev);
        }
      } else {
        // Overlapping main note → its end is FREE (bounded only by the song), never the next word: it is
        // meant to stretch past following lines without pushing them, so there is no neighbour to conjoin.
        const next = w.overlap ? null : nextInLane(w);
        const hi = next ? next.end - EDIT_MIN_DUR : timelineMs;
        w.end = Math.min(hi, Math.max(target, w.start + EDIT_MIN_DUR));
        if (next && target > neighborEdge0) lockedNeighbor = next; // pushed past next's start → conjoin
        if (next && lockedNeighbor === next) {
          next.start = w.end; // shared boundary: pushing shrinks next, pulling back grows it again
          layoutWord(next);
        }
      }
      layoutWord(w);
      // Keep the edge visible as it wraps onto lower/upper rows (cosmetic — doesn't affect the
      // horizontal mapping, which is clientX-only).
      if (!scroller) scroller = scrollParent(rowsWrap);
      const seg = edge === "end" ? w.els?.[w.els.length - 1] : w.els?.[0];
      if (scroller && seg) {
        const sr = seg.getBoundingClientRect();
        const cr = scroller.getBoundingClientRect();
        if (sr.bottom > cr.bottom) scroller.scrollTop += sr.bottom - cr.bottom + 24;
        else if (sr.top < cr.top) scroller.scrollTop -= cr.top - sr.top + 24;
      }
    };

    const onMove = (e: PointerEvent): void => {
      moved = true;
      apply(e.clientX);
    };
    const onUp = (e: PointerEvent): void => {
      endGesture(e);
      if (moved) {
        pushUndo(before);
        markDirty();
      }
    };
    nib.addEventListener("pointerdown", (e: PointerEvent) => {
      if (starred || roLock) return; // locked — no resizing
      if (edge === "end" && w.overlap && !bgLane) return; // overlapping note: trailing edge locked in main view
      e.preventDefault();
      e.stopPropagation(); // don't start a body drag
      following = false; // a resize takes over from auto-follow (stopPropagation skips breakFollow)
      moved = false;
      before = cloneWords();
      anchorX = e.clientX;
      anchorMs = edge === "start" ? w.start : w.end;
      // Capture the neighbour's facing edge now — crossing it later in this gesture conjoins them.
      lockedNeighbor = null;
      const nb = edge === "start" ? prevInLane(w) : w.overlap ? null : nextInLane(w);
      neighborEdge0 = nb ? (edge === "start" ? nb.end : nb.start) : anchorMs;
      beginGesture(e, onMove, onUp);
    });
  }

  // A live white playhead that follows playback when this is the current track; self-cleans when
  // the editor is torn down (its element leaves the DOM).
  const playhead = document.createElement("div");
  playhead.setAttribute(
    "style",
    "position:absolute; width:2px; background:#fff; opacity:.8; pointer-events:none; display:none; z-index:6;"
  );

  // Auto-follow: keep the scroll anchored to the playhead while it plays. Any edit or manual
  // scroll BREAKS follow (so it never fights you); a "Follow playback" button appears at the
  // bottom-centre to snap back and re-enable it.
  const scrollParent = (el: HTMLElement): HTMLElement | null => {
    let p = el.parentElement;
    while (p) {
      const oy = getComputedStyle(p).overflowY;
      if ((oy === "auto" || oy === "scroll") && p.scrollHeight > p.clientHeight) return p;
      p = p.parentElement;
    }
    return null;
  };
  let scroller: HTMLElement | null = timelineScroller; // the timeline's OWN bounded pane — not resolved
  // via scrollParent (which ambiguously found the page scroller until a resize made this pane scrollable).
  let following = true;
  let settleUntil = 0; // brief cooldown after a programmatic scroll so it doesn't re-fire mid-glide

  // Cached scroll geometry so the per-tick follow check is pure arithmetic — no getBoundingClientRect
  // (which, against the rAF playhead's constant style writes, forced a synchronous reflow every tick).
  // scrollTop is refreshed on the scroller's scroll event (free there); clientHeight + the rowsWrap
  // content-top are stable between rebuilds, so they're measured once via measureFollowGeom (one-shot
  // reflow) after the scroller resolves and after each build().
  let followScrollTop = 0;
  let followClientH = 0;
  let followWrapTop = 0; // rowsWrap's content-top within the scroller's scroll content
  let followScrollerLeft = 0; // the scroller viewport's on-screen top-left (stable while scrolling) —
  let followScrollerTop = 0; // …lets the fixed bookmark caret be placed without a per-scroll rect read
  let followGeomReady = false;
  invalidateFollowGeom = (): void => void (followGeomReady = false); // re-measure after the split resizes
  const measureFollowGeom = (): void => {
    if (!scroller) return;
    const wr = rowsWrap.getBoundingClientRect();
    const sr = scroller.getBoundingClientRect();
    followScrollTop = scroller.scrollTop;
    followClientH = scroller.clientHeight;
    followWrapTop = followScrollTop + (wr.top - sr.top);
    followScrollerLeft = sr.left;
    followScrollerTop = sr.top;
    followGeomReady = true;
  };
  // Scroll the timeline so the row containing `startMs` sits CENTERED in the currently-visible timeline
  // pane — used when a word/line is clicked so it isn't hidden behind the advanced panel that just opened.
  // Breaks auto-follow (a deliberate focus), mirroring how any edit does.
  const centerRowInView = (startMs: number): void => {
    if (!scroller) return;
    followGeomReady = false;
    measureFollowGeom(); // fresh geometry (the pane just shrank to share space with the panel)
    const row = Math.max(0, Math.floor(Math.max(0, startMs + lyricOffset) / rowWidthMs));
    const rowTop = followWrapTop + row * (EDITOR_ROW_H + EDITOR_ROW_GAP);
    following = false;
    scroller.scrollTo({ top: Math.max(0, rowTop - followClientH / 2 + EDITOR_ROW_H / 2), behavior: "smooth" });
    settleUntil = Date.now() + 600;
  };

  const followBtn = document.createElement("button");
  followBtn.textContent = "↓ Follow playback";
  followBtn.setAttribute(
    "style",
    "position:fixed; left:50%; bottom:104px; transform:translateX(-50%); z-index:1000; display:none; " +
      "padding:8px 16px; border:none; border-radius:999px; cursor:pointer; font-size:13px; font-weight:700; " +
      "background:var(--spice-button,#1db954); color:var(--spice-main,#000); box-shadow:0 4px 16px rgba(0,0,0,.5);"
  );
  // Anchor to the bottom-centre of the TIMELINE pane (not the viewport), so it sits above the advanced
  // panel instead of overlapping it. Updated on every sizeSplit (panel open/close, resize, divider drag).
  repositionFollowBtn = (): void => {
    const r = timelineScroller.getBoundingClientRect();
    if (!r.width) return;
    followBtn.style.left = `${Math.round(r.left + r.width / 2)}px`;
    followBtn.style.bottom = `${Math.round(Math.max(12, window.innerHeight - r.bottom + 12))}px`;
  };
  const enableFollow = (): void => {
    following = true;
    followBtn.style.display = "none";
    // Jump to the playhead right now (don't wait for it to drift out of view), so pressing follow
    // visibly re-centres on playback.
    if (!scroller) scroller = scrollParent(rowsWrap);
    if (scroller && Spicetify.Player.data?.item?.uri === uri) {
      const pr = playhead.getBoundingClientRect();
      const cr = scroller.getBoundingClientRect();
      scroller.scrollTo({ top: scroller.scrollTop + (pr.top - cr.top) - cr.height * 0.3, behavior: "smooth" });
      settleUntil = Date.now() + 600;
    } else {
      settleUntil = 0;
    }
  };
  followBtn.addEventListener("click", enableFollow);
  document.body.appendChild(followBtn);

  // Out-of-frame bookmark indicator: a single purple caret (no background) pinned to the editor's
  // top-left while the bookmark is scrolled off-screen. Points up/down toward it; click pans back.
  // Positioned/shown live by updateBookmarkCaret(); self-cleans on teardown.
  const bookmarkCaret = document.createElement("button");
  bookmarkCaret.setAttribute(
    "style",
    "position:fixed; z-index:1000; display:none; border:none; background:transparent; cursor:pointer; " +
      "padding:2px 8px; line-height:1; font-size:26px; font-weight:900; color:#b36bff; " +
      "text-shadow:0 0 8px rgba(179,107,255,.9);"
  );
  bookmarkCaret.addEventListener("click", () => panToBookmark("smooth"));
  document.body.appendChild(bookmarkCaret);

  const breakFollow = (): void => {
    following = false; // an edit / manual scroll takes over
  };
  rowsWrap.addEventListener("wheel", breakFollow, { passive: true });
  rowsWrap.addEventListener("pointerdown", breakFollow);
  // Remember the last pointer position over the timeline (cheap — just coords) so "," (green tap) /
  // "a" (add word) can map it to a time on demand, without a getBoundingClientRect on every move.
  rowsWrap.addEventListener("pointermove", (e: PointerEvent) => {
    lastPointer = { clientX: e.clientX, clientY: e.clientY };
  });

  // Pan the scroll so the bookmark sits 30% down the panel (70% of what follows visible below it) —
  // the same anchor auto-follow uses. Breaks follow so it doesn't immediately snap back to the
  // playhead. Shared by the on-open jump and the out-of-frame caret's click.
  const panToBookmark = (behavior: ScrollBehavior): void => {
    if (!scroller) scroller = scrollParent(rowsWrap);
    if (!scroller || !bookmarkEl) return;
    following = false;
    const br = bookmarkEl.getBoundingClientRect();
    const cr = scroller.getBoundingClientRect();
    scroller.scrollTo({ top: scroller.scrollTop + (br.top - cr.top) - cr.height * 0.3, behavior });
    settleUntil = Date.now() + 600;
  };
  // Jump to the bookmark on open, so you land where you left off. Deferred a frame so the marker
  // exists after build(). Instant (no smooth glide) since nothing is on screen yet to follow.
  const jumpToBookmark = (): void => {
    if (bookmarkMs === null) return;
    following = false;
    requestAnimationFrame(() => panToBookmark("auto"));
  };

  // Smooth playhead: a rAF loop that ONLY moves the white bar — no layout reads, writes memoized —
  // so it tracks at the display refresh rate while the heavy work (expire + follow-scroll, which
  // forces layout) lives on a slower interval below. This is both smoother AND cheaper than the old
  // 50ms full-tick that did getBoundingClientRect 20×/sec.
  let rafId = 0;
  let phHeightSet = false;
  const paintPlayhead = (): void => {
    if (!rowsWrap.isConnected) {
      rafId = 0;
      return; // stop; teardown is handled by the interval
    }
    rafId = requestAnimationFrame(paintPlayhead);
    if (Spicetify.Player.data?.item?.uri !== uri || !rowDivs.length) {
      if (playhead.style.display !== "none") playhead.style.display = "none";
      return;
    }
    const pos = Spicetify.Player.getProgress?.() ?? 0;
    const row = Math.min(rowDivs.length - 1, Math.floor(pos / rowWidthMs));
    const left = `${(pos - row * rowWidthMs) * PX_PER_MS}px`;
    const top = `${row * (EDITOR_ROW_H + EDITOR_ROW_GAP)}px`;
    if (playhead.style.display !== "block") playhead.style.display = "block";
    if (!phHeightSet) {
      playhead.style.height = `${EDITOR_ROW_H}px`;
      phHeightSet = true;
    }
    if (playhead.style.left !== left) playhead.style.left = left;
    if (playhead.style.top !== top) playhead.style.top = top;
  };

  const tick = (): void => {
    if (!rowsWrap.isConnected) {
      teardown(); // editor torn down (navigated away) — flush unsaved edits + clear timers/listeners
      return;
    }
    refreshBookmarkButton(); // button label (set/update/remove) — caret updates on scroll, not here
    if (!scroller) scroller = scrollParent(rowsWrap);
    bindCaretScroll(); // start the scroll→caret listener as soon as the scroller exists
    if (Spicetify.Player.data?.item?.uri !== uri || !rowDivs.length) {
      followBtn.style.display = "none"; // nothing to follow on a different/absent track
      return;
    }
    const pos = Spicetify.Player.getProgress?.() ?? 0;
    expireLines(pos - lyricOffset); // raw time; retain-as-green any line whose window passed incomplete
    if (!scroller) scroller = scrollParent(rowsWrap); // resolves once the rows make it scrollable
    if (!scroller) return; // not scrollable yet → nothing to follow or snap
    if (following && Date.now() >= settleUntil) {
      if (!followGeomReady) measureFollowGeom(); // one-shot after a build cleared the cache
      // Playhead position computed arithmetically (same row math as paintPlayhead), compared against
      // the cached viewport — equivalent to the old getBoundingClientRect test but reflow-free.
      const row = Math.min(rowDivs.length - 1, Math.floor(pos / rowWidthMs));
      const phTop = followWrapTop + row * (EDITOR_ROW_H + EDITOR_ROW_GAP);
      const phBottom = phTop + EDITOR_ROW_H;
      // Re-anchor as soon as the playhead enters the BOTTOM 20% of the panel (or scrolls above the
      // top) — keeps the cursor out of the bottom strip, with a comfortable lead of what's coming.
      if (followGeomReady && (phTop < followScrollTop || phBottom > followScrollTop + followClientH * 0.8)) {
        // Anchor the playhead 30% down the panel, leaving 70% of what's coming visible below it.
        const target = Math.max(0, phTop - followClientH * 0.3);
        scroller.scrollTo({ top: target, behavior: "smooth" });
        followScrollTop = target; // optimistic; the scroll event confirms it as the glide settles
        settleUntil = Date.now() + 600; // let the smooth scroll settle before re-checking
      }
    }
    followBtn.style.display = following ? "none" : "block"; // show the snap-back button when broken out
  };
  const timer = setInterval(tick, 120); // heavy work (expire + follow) throttled to keep CPU low
  requestAnimationFrame(paintPlayhead); // playhead runs smooth on its own rAF loop

  // ---- Record mode ----------------------------------------------------------------------------
  // Record taps retime the LEAD lane only — background words aren't tapped, so they're excluded here.
  const wordsOfLine = (L: number): EditWord[] => words.filter((w) => w.line === L && !!w.secondary === bgLane);
  const lineEndOf = (L: number): number => {
    if (L + 1 < lineStarts.length) return lineStarts[L + 1];
    const wl = wordsOfLine(L);
    const maxEnd = wl.reduce((m, w) => Math.max(m, w.end), 0);
    return Math.max(maxEnd, (tapsByLine.get(L)?.slice(-1)[0] ?? 0) + 500, timelineMs > 0 ? 0 : 0);
  };

  // (Re)draw the tap markers: GREEN (persistent, draggable) underneath, BLUE (live) on top. Each
  // green mark gets a narrow draggable column so its position can be nudged; blue is inert.
  const renderMarks = (): void => {
    for (const el of markEls) el.remove();
    markEls = [];
    const drawBlue = (raw: number): void => {
      const t = Math.max(0, raw + lyricOffset); // stored raw; shown offset-applied
      const row = Math.floor(t / rowWidthMs);
      if (row < 0 || row >= rowDivs.length) return;
      const el = document.createElement("div");
      el.setAttribute(
        "style",
        `position:absolute; left:${(t - row * rowWidthMs) * PX_PER_MS}px; top:0; width:2px; height:${EDITOR_ROW_H}px; ` +
          "background:#4aa3ff; box-shadow:0 0 6px rgba(74,163,255,.9); pointer-events:none; z-index:5;"
      );
      rowDivs[row].appendChild(el);
      markEls.push(el);
    };
    const drawGreen = (raw: number, L: number, i: number): void => {
      const t = Math.max(0, raw + lyricOffset);
      const row = Math.floor(t / rowWidthMs);
      if (row < 0 || row >= rowDivs.length) return;
      const leftPx = (t - row * rowWidthMs) * PX_PER_MS;
      const el = document.createElement("div"); // narrow grab column centred on the mark
      el.setAttribute(
        "style",
        `position:absolute; left:${leftPx - 3}px; top:0; width:8px; height:${EDITOR_ROW_H}px; z-index:6; ` +
          (starred || roLock ? "" : "cursor:ew-resize;")
      );
      const line = document.createElement("div");
      line.setAttribute(
        "style",
        `position:absolute; left:3px; top:0; width:2px; height:${EDITOR_ROW_H}px; background:#49d16a; ` +
          "box-shadow:0 0 6px rgba(73,209,106,.7); pointer-events:none;"
      );
      el.appendChild(line);
      if (!starred && !roLock) {
        el.addEventListener("pointerdown", (e: PointerEvent) => {
          e.preventDefault();
          e.stopPropagation(); // don't also start a word/body drag
          following = false; // a green drag takes over from auto-follow
          const move = (ev: PointerEvent): void => {
            const arr = greenByLine.get(L);
            if (!arr) return;
            // Clamp into this line's window and between its neighbours, so a green mark can't be
            // dragged into another line / past the next mark (which produced the tangled overlaps).
            const lineStart = lineStarts[L] ?? 0;
            const lineEnd = lineEndOf(L);
            const lo = Math.max(lineStart, (arr[i - 1] ?? lineStart) + EDIT_MIN_GAP);
            const hi = Math.min(lineEnd, (arr[i + 1] ?? lineEnd) - EDIT_MIN_GAP);
            const raw = pointerToMs(ev) - lyricOffset; // strip the display offset → raw time
            arr[i] = Math.max(0, Math.max(lo, Math.min(raw, Math.max(lo, hi))));
            renderMarks();
          };
          beginGesture(e, move, (ev: PointerEvent) => endGesture(ev));
        });
      }
      rowDivs[row].appendChild(el);
      markEls.push(el);
    };
    for (const [L, taps] of greenByLine) taps.forEach((t, i) => drawGreen(t, L, i));
    for (const taps of tapsByLine.values()) for (const t of taps) drawBlue(t);
  };

  // A lone green bar in the PREVIOUS line, sitting just before THIS line's start, is most likely this
  // line's first word tapped a hair early (so it fell into the previous line and expired to green).
  // Return it so blue counting/commit can ADOPT it as this line's first word. Only when the previous
  // line has EXACTLY one green bar and it's within INHERIT_MS before the start (and not already past it).
  const inheritedGreen = (L: number): number | null => {
    if (L <= 0) return null;
    const prev = greenByLine.get(L - 1);
    if (!prev || prev.length !== 1) return null;
    const g = prev[0];
    const lineStart = lineStarts[L] ?? 0;
    return g >= lineStart - INHERIT_MS && g < lineStart + VICINITY_MS ? g : null;
  };

  // Turn a line's taps (blue or green) into its words' start/end times (THIS line ONLY). Snapshots
  // for undo; the first word snaps to the line start (always for green, else within VICINITY_MS);
  // the last word's end pins to the line end; starts stay monotonic inside [lineStart, lineEnd].
  const commitTaps = (L: number, rawTaps: number[], snapFirst: boolean): boolean => {
    const taps = rawTaps.slice().sort((a, b) => a - b);
    const wl = wordsOfLine(L);
    if (!wl.length || taps.length !== wl.length) return false;
    pushUndo(cloneWords()); // this line's commit is one undo step
    const lineStart = lineStarts[L] ?? taps[0];
    const lineEnd = lineEndOf(L);
    if (snapFirst || Math.abs(taps[0] - lineStart) < VICINITY_MS) taps[0] = lineStart; // first → line start
    for (let i = 0; i < wl.length; i++) {
      const floor = i > 0 ? wl[i - 1].start + EDIT_MIN_GAP : 0;
      const ceil = lineEnd - (wl.length - i) * EDIT_MIN_DUR; // leave room for the rest + the end
      wl[i].start = Math.max(floor, Math.min(taps[i], Math.max(floor, ceil)));
    }
    for (let i = 0; i < wl.length; i++) wl[i].end = i + 1 < wl.length ? wl[i + 1].start : lineEnd;
    relayout();
    markDirty();
    return true;
  };
  const commitLine = (L: number): void => {
    // Adopt a lone, close-by green from the previous line as this line's first word (see inheritedGreen).
    const inh = inheritedGreen(L);
    const blue = tapsByLine.get(L) ?? [];
    const taps = inh !== null ? [inh, ...blue] : blue;
    if (!commitTaps(L, taps, inh !== null)) return; // snap the adopted word to the line start
    tapsByLine.delete(L);
    greenByLine.delete(L); // this line is now recorded → drop any green reference
    if (inh !== null) greenByLine.delete(L - 1); // the stray green was consumed as our first word
    renderMarks();
    status.textContent = inh !== null ? "Line recorded (adopted 1) ✓" : "Line recorded ✓";
  };
  const commitGreen = (L: number): void => {
    if (!commitTaps(L, greenByLine.get(L) ?? [], true)) return; // green: always snap first → line start
    greenByLine.delete(L);
    tapsByLine.delete(L);
    renderMarks();
    status.textContent = "Line recorded (green) ✓";
  };

  // Called from the tick: a line whose window (line + grace) passed without completing saves its
  // blue taps AS the line's green — REPLACING any previous green (green is the latest saved attempt,
  // so re-recording a line overwrites the earlier save).
  const expireLines = (now: number): void => {
    let changed = false;
    for (const [L, taps] of [...tapsByLine]) {
      if (now <= lineEndOf(L) + GRACE_MS) continue; // still within the line's tappable window
      if (taps.length > 0 && taps.length < wordsOfLine(L).length) {
        greenByLine.set(L, taps.slice()); // newest incomplete attempt replaces the previous green
        tapsByLine.delete(L);
        changed = true;
        // A lone stray green may actually be the NEXT line's first word (tapped early) — if that line
        // already has the rest of its blue taps, complete it now by adoption.
        const M = L + 1;
        if (inheritedGreen(M) !== null && (tapsByLine.get(M)?.length ?? 0) + 1 === wordsOfLine(M).length) {
          commitLine(M); // consumes the stray green + M's blue taps
        }
        continue;
      }
      tapsByLine.delete(L);
      changed = true;
    }
    if (changed) renderMarks();
  };

  // Manual save to file ("s"): persist now + clean the regenerable cache, but STAY in the editor
  // (unlike "Save & close", which also exits).
  const saveNow = (): void => {
    commit();
    invalidateOwnLrc?.(id);
    status.textContent = "Saved to file ✓";
  };

  // Bookmark: a purple "left off here" marker at a timeline position, set to the white bar (playhead).
  // What the button / "b" does depends on where the white bar is RIGHT NOW (see bookmarkMode):
  //   • no bookmark            → "Bookmark"        : drop one at the white bar
  //   • white bar away from it → "Update Bookmark" : MOVE it to the white bar (never a silent loss)
  //   • paused at the bookmark → "Remove Bookmark" : clear it (the only way to delete one)
  // The white bar only exists when THIS track is the one loaded.
  const BOOKMARK_NEAR_MS = LINE_SEEK_LEAD_MS * 2; // white bar within this of the mark counts as "at" it
  const playheadNow = (): number | null =>
    Spicetify.Player.data?.item?.uri === uri ? Math.max(0, Math.round(Spicetify.Player.getProgress?.() ?? 0)) : null;
  type BookmarkMode = "set" | "set-blocked" | "update" | "remove";
  const bookmarkMode = (): BookmarkMode => {
    const ph = playheadNow();
    if (bookmarkMs === null) return ph === null ? "set-blocked" : "set";
    const paused = !Spicetify.Player.isPlaying?.();
    if (ph !== null && paused && Math.abs(ph - bookmarkMs) <= BOOKMARK_NEAR_MS) return "remove";
    if (ph !== null) return "update"; // white bar is elsewhere (or playing) → b moves the mark here
    return "remove"; // track not loaded: no white bar to move to, so an express b removes the mark
  };
  // Button label/glow reflects the live mode. Called every tick (play state + white bar move), so it
  // writes the DOM ONLY when the mode actually changes — otherwise it's a pure no-op (no style recalc).
  let lastBookmarkMode: BookmarkMode | null = null;
  const refreshBookmarkButton = (): void => {
    const mode = bookmarkMode();
    if (mode === lastBookmarkMode) return;
    lastBookmarkMode = mode;
    const label = mode === "update" ? "🔖 Update Bookmark" : mode === "remove" ? "🔖 Remove Bookmark" : "🔖 Bookmark";
    const on = mode === "update" || mode === "remove";
    bookmarkBtn.textContent = label;
    bookmarkBtn.style.background = on ? "#b36bff" : "";
    bookmarkBtn.style.color = on ? "#fff" : "";
    bookmarkBtn.style.boxShadow = on ? "0 0 10px rgba(179,107,255,.85)" : "";
  };
  // The out-of-frame caret only needs recomputing when the viewport scrolls or the bookmark moves —
  // NOT every tick. It reads layout (getBoundingClientRect), so keeping it off the steady-state tick
  // avoids a forced reflow 8×/sec. Bound to the scroller's scroll event (rAF-coalesced) the first
  // time it runs with a resolved scroller; also called directly after any bookmark change.
  let caretScroller: HTMLElement | null = null;
  let caretRaf = 0;
  // Scroll listener: refresh the follow cache's scrollTop immediately (cheap, no rect) and, on the
  // next frame, repaint the out-of-frame caret. It does NOT re-measure the rest of the follow geometry
  // (wrapTop/clientHeight) — those don't change when you scroll, only when the layout rebuilds, so
  // measuring them here just burned a reflow or two on EVERY scroll frame (the panning lag).
  const onCaretScroll = (): void => {
    if (scroller) followScrollTop = scroller.scrollTop;
    if (caretRaf) return;
    caretRaf = requestAnimationFrame(() => {
      caretRaf = 0;
      updateBookmarkCaret(); // only reads rects when a bookmark actually exists (else early-returns)
    });
  };
  const bindCaretScroll = (): void => {
    if (caretScroller || !scroller) return; // bind once the scroller resolves (idempotent)
    caretScroller = scroller;
    caretScroller.addEventListener("scroll", onCaretScroll, { passive: true });
    measureFollowGeom(); // seed the follow cache now that the scroller exists
  };
  const updateBookmarkCaret = (): void => {
    if (bookmarkMs === null || !rowDivs.length) {
      bookmarkCaret.style.display = "none";
      return;
    }
    if (!scroller) scroller = scrollParent(rowsWrap);
    if (!scroller) {
      bookmarkCaret.style.display = "none";
      return;
    }
    bindCaretScroll();
    if (!followGeomReady) measureFollowGeom(); // one-shot after a rebuild — then purely arithmetic
    // The bookmark's position in the scroll content (same row math as the playhead) vs the cached
    // viewport — so this is reflow-free on every scroll frame, not a getBoundingClientRect per frame.
    const bRow = Math.min(rowDivs.length - 1, Math.floor(Math.max(0, bookmarkMs) / rowWidthMs));
    const bTop = followWrapTop + bRow * (EDITOR_ROW_H + EDITOR_ROW_GAP);
    const bBottom = bTop + EDITOR_ROW_H;
    const dir = bBottom < followScrollTop ? "up" : bTop > followScrollTop + followClientH ? "down" : null;
    if (!dir) {
      bookmarkCaret.style.display = "none";
      return;
    }
    bookmarkCaret.textContent = dir === "up" ? "⌃" : "⌄";
    bookmarkCaret.title = `Bookmark is ${dir === "up" ? "above" : "below"} — click to jump back`;
    bookmarkCaret.style.left = `${Math.round(followScrollerLeft + 8)}px`;
    bookmarkCaret.style.top = `${Math.round(followScrollerTop + 8)}px`;
    bookmarkCaret.style.display = "block";
  };
  // After a bookmark change (set/move/remove, or a rebuild): refresh both the button and the caret.
  const updateBookmarkUI = (): void => {
    refreshBookmarkButton();
    updateBookmarkCaret();
  };
  const renderBookmark = (): void => {
    bookmarkEl?.remove();
    bookmarkEl = null;
    if (bookmarkMs === null || !rowDivs.length) return;
    const t = Math.max(0, bookmarkMs);
    const row = Math.min(rowDivs.length - 1, Math.floor(t / rowWidthMs));
    const leftPx = (t - row * rowWidthMs) * PX_PER_MS;
    const el = document.createElement("div"); // clickable column centred on the mark (2px alone is too thin to hit)
    el.title = `Bookmark · click to play from ~${LINE_SEEK_LEAD_MS / 1000}s before ${fmtClock(t)}`;
    el.setAttribute(
      "style",
      `position:absolute; left:${leftPx - 3}px; top:0; width:8px; height:${EDITOR_ROW_H}px; z-index:7; cursor:pointer;`
    );
    const line = document.createElement("div");
    line.setAttribute(
      "style",
      `position:absolute; left:3px; top:0; width:2px; height:${EDITOR_ROW_H}px; background:#b36bff; ` +
        "box-shadow:0 0 8px rgba(179,107,255,.9); pointer-events:none;"
    );
    el.appendChild(line);
    el.addEventListener("click", () => seekWithLead(t));
    rowDivs[row].appendChild(el);
    bookmarkEl = el;
  };
  const toggleBookmark = (): void => {
    const mode = bookmarkMode();
    if (mode === "set-blocked") {
      status.textContent = "Bookmark: play this track to position the white bar";
      return;
    }
    if (mode === "remove") {
      bookmarkMs = null;
      clearBookmark(overridesStore, id);
      status.textContent = "Bookmark removed";
    } else {
      // "set" or "update": drop / move the mark to the white bar (playheadNow is non-null for both).
      bookmarkMs = playheadNow() ?? 0;
      setBookmark(overridesStore, id, bookmarkMs);
      status.textContent = `${mode === "update" ? "Bookmark moved to" : "Bookmarked at"} ${fmtClock(bookmarkMs)}`;
    }
    renderBookmark();
    updateBookmarkUI();
  };
  updateBookmarkUI(); // reflect a loaded bookmark on open

  // Shared tap handler. BLUE taps along to playback (raw time under the playhead, only for THIS
  // track); GREEN is plotted at the MOUSE position over the timeline (no playback needed). The tap
  // joins the line under that position; the line commits when its count matches its word count.
  const tapRecord = (kind: "blue" | "green"): void => {
    if (starred || roLock) return;
    let now: number;
    if (kind === "blue") {
      if (Spicetify.Player.data?.item?.uri !== uri) return; // blue taps along to THIS track's playback
      now = (Spicetify.Player.getProgress?.() ?? 0) - lyricOffset; // raw time under the playhead
    } else {
      if (!lastPointer || !rowDivs.length) return; // green needs a pointer over the timeline
      now = pointerToMs(lastPointer as PointerEvent) - lyricOffset; // raw time under the pointer
    }
    let L = -1;
    for (let i = 0; i < lineStarts.length; i++) {
      if (lineStarts[i] <= now) L = i;
      else break;
    }
    if (L < 0) return;
    const map = kind === "blue" ? tapsByLine : greenByLine;
    if (kind === "blue" && L > 0 && now - lineStarts[L] < GRACE_MS) {
      const prev = map.get(L - 1) ?? [];
      if (prev.length > 0 && prev.length < wordsOfLine(L - 1).length) L = L - 1; // finish the previous line
    }
    if (kind === "blue" && now > lineEndOf(L) + GRACE_MS) return; // blue only applies within the window
    const wl = wordsOfLine(L);
    if (!wl.length) return;
    const taps = map.get(L) ?? [];
    // Blue can adopt one green from the previous line as its first word, so it needs one fewer tap.
    const need = kind === "blue" && inheritedGreen(L) !== null ? wl.length - 1 : wl.length;
    if (taps.length >= need) return; // enough taps already (the adopted green supplies the rest)
    taps.push(Math.max(0, kind === "blue" ? Math.min(now, lineEndOf(L)) : now));
    if (kind === "green") taps.sort((a, b) => a - b); // mouse-placed → keep ascending (word order)
    map.set(L, taps);
    renderMarks();
    if (taps.length >= need) (kind === "blue" ? commitLine : commitGreen)(L);
  };

  // Clear tap bars. If a line is actively playing (this track) and has BLUE taps, reset just THAT
  // line's blue — so you can re-tap the current line without losing everything. Otherwise clear ALL
  // bars (blue + green). Non-destructive to the committed words, so it doesn't mark the editor dirty.
  const clearBars = (): void => {
    if (Spicetify.Player.data?.item?.uri === uri) {
      const nowRaw = (Spicetify.Player.getProgress?.() ?? 0) - lyricOffset;
      let L = -1;
      for (let i = 0; i < lineStarts.length; i++) {
        if (lineStarts[i] <= nowRaw) L = i;
        else break;
      }
      if (L >= 0 && (tapsByLine.get(L)?.length ?? 0) > 0) {
        tapsByLine.delete(L); // reset the active line's blue only
        renderMarks();
        status.textContent = "Active line blue cleared";
        return;
      }
    }
    if (!greenByLine.size && !tapsByLine.size) {
      status.textContent = "No tap bars to clear";
      return;
    }
    greenByLine.clear();
    tapsByLine.clear();
    renderMarks();
    status.textContent = "Tap bars cleared";
  };

  // "c" hotkey: cycle the duet VOICE (Both → Mittens/"a" → Biscuit/"b" → Both) of whatever's under the
  // cursor — no click needed. Hovering the yellow LINE-START marker cycles that whole line's active-lane
  // words together (one voice per line); hovering a single word cycles just that word.
  const cycleVoiceOfHover = (): void => {
    if (starred || roLock) {
      status.textContent = roLock ? "Read-only preview" : "★ Starred — unstar to edit";
      return;
    }
    const order: (undefined | "a" | "b")[] = [undefined, "a", "b"];
    let targets: EditWord[];
    let scope: string;
    if (hoverLine !== null) {
      targets = words.filter((x) => x.line === hoverLine && isProminent(x)); // the line's active-lane words
      scope = `Line ${hoverLine + 1}`;
    } else if (hoverWord) {
      targets = [hoverWord];
      scope = `"${hoverWord.text}"`;
    } else {
      status.textContent = 'Hover a word (or the yellow line marker), then press "c"';
      return;
    }
    if (!targets.length) {
      status.textContent = "No words here to change";
      return;
    }
    // `words` is start-sorted, so targets[0] is the scope's earliest word — base the cycle off it so the
    // whole line steps together from a single, visible starting voice.
    const next = order[(order.indexOf(targets[0].singer) + 1) % order.length];
    const before = cloneWords();
    for (const t of targets) {
      t.singer = next;
      t.els?.forEach((e) => e.remove()); // class/colour changed → rebuild this word's segment(s)
      t.els = [];
    }
    relayout();
    pushUndo(before);
    markDirty();
    const nm = getSingerNames(overridesStore, id);
    const label = next === "a" ? `${nm.a} (mirror)` : next === "b" ? `${nm.b} (main)` : "Both (unison)";
    status.textContent =
      hoverLine !== null ? `${scope} — ${targets.length} word${targets.length === 1 ? "" : "s"} → ${label}` : `${scope} → ${label}`;
  };

  // "l" hotkey: a fast text editor for a whole line. Shows the line's active-lane words as one editable
  // string (words split by space / "/" / "-") plus an aligned romanization row. On Apply, reconcileLine
  // diffs the text against the existing words — pure add/remove keeps the others' timing, anything else
  // rebalances the line (see lineedit.ts). Romaja is assigned per word; the group counts must match.
  const openLineEditor = (): void => {
    if (roLock) {
      status.textContent = "Read-only preview";
      return;
    }
    if (starred) {
      status.textContent = "★ Starred — unstar to edit";
      return;
    }
    // Target line: ONLY the hovered yellow line-start marker; otherwise the line under the playhead.
    // (Hovering a plain word does not target it — that keeps "l" predictable vs the per-word "c".)
    let L: number | null = hoverLine;
    if (L === null && Spicetify.Player.data?.item?.uri === uri) {
      const nowRaw = (Spicetify.Player.getProgress?.() ?? 0) - lyricOffset;
      for (let i = 0; i < lineStarts.length; i++) {
        if (lineStarts[i] <= nowRaw) L = i;
        else break;
      }
    }
    if (L === null) {
      status.textContent = 'Hover a line marker (the yellow bar), or play a line, then press "l"';
      return;
    }
    const lineIdx = L;
    // Edit the ACTIVE lane's words for this line (what "t" is focused on); fall back to the other lane
    // if the active one is empty here.
    let laneSecondary = bgLane;
    const inLane = (sec: boolean): EditWord[] =>
      words.filter((w) => w.line === lineIdx && !!w.secondary === sec).sort((a, b) => a.start - b.start);
    let oldActive = inLane(laneSecondary);
    if (!oldActive.length) {
      laneSecondary = !laneSecondary;
      oldActive = inLane(laneSecondary);
    }
    if (!oldActive.length) {
      status.textContent = `Line ${lineIdx + 1} has no words to edit`;
      return;
    }

    const inputStyle =
      "width:100%; padding:7px 9px; border-radius:6px; border:1px solid var(--spice-button-disabled,#555); " +
      "background:var(--spice-main,#111); color:var(--spice-text,#fff); font-size:15px; box-sizing:border-box;";
    const labeled = (text: string, el: HTMLElement): HTMLElement => {
      const wrap = document.createElement("label");
      wrap.setAttribute("style", "display:flex; flex-direction:column; gap:3px; font-size:11px; opacity:.75;");
      const t = document.createElement("span");
      t.textContent = text;
      wrap.append(t, el);
      return wrap;
    };
    const detected = detectedSongLang();
    const langSel = buildLangSelect();
    langSel.setAttribute("style", inputStyle.replace("width:100%;", "") + " width:auto; padding:4px 6px; font-size:12px;");

    const origIn = document.createElement("input");
    origIn.type = "text";
    origIn.value = oldActive.map((w) => w.text).join(" ");
    origIn.setAttribute("style", inputStyle);
    const romaIn = document.createElement("input");
    romaIn.type = "text";
    romaIn.value = oldActive.every((w) => w.roman) ? oldActive.map((w) => w.roman).join(" ") : "";
    romaIn.placeholder = "romanization — one per word (Romanize fills this)";
    romaIn.setAttribute("style", inputStyle);

    const msg = document.createElement("div");
    msg.setAttribute("style", "font-size:12px; min-height:16px; opacity:.85;");
    msg.textContent = `delimiters: space  /  -  ·  ${oldActive.length} word${oldActive.length === 1 ? "" : "s"}`;

    const btns = document.createElement("div");
    btns.setAttribute("style", "display:flex; gap:8px; align-items:center;");
    // Romanize this line: romanize each ORIGINAL token → fill the romanization row (1:1, so Apply won't
    // trip the group-count check). Non-destructive — you tune either row before Apply. Async (JA loads a
    // dictionary on first use).
    const romanizeLine = async (): Promise<void> => {
      const lang = langSel.value === "auto" ? detected : (langSel.value as SongLang);
      if (!canRomanize(lang)) {
        msg.style.color = "#ffcf8a";
        msg.textContent = `No romanizer for ${LANG_LABEL[lang]} — type it manually.`;
        return;
      }
      const toks = tokenizeLine(origIn.value);
      if (!toks.length) {
        msg.textContent = "Nothing to romanize.";
        return;
      }
      msg.style.color = "";
      msg.textContent = lang === "ja" && !jaWarmed ? "Romanizing… (loading Japanese dictionary — one-time)" : `Romanizing ${LANG_LABEL[lang]}…`;
      romanizeBtn.disabled = true;
      try {
        const romas = await romanizeWordsAsync(toks, lang);
        if (lang === "ja") jaWarmed = true;
        romaIn.value = romas.join(" ");
        msg.textContent = `Romanized ${toks.length} word${toks.length === 1 ? "" : "s"} (${LANG_LABEL[lang]}) — edit if needed, then Apply.`;
      } catch (e) {
        msg.style.color = "#ff8a8a";
        msg.textContent = `Romanize failed — ${(e as Error).message || "dictionary unavailable"}`;
      } finally {
        romanizeBtn.disabled = false;
      }
    };
    const romanizeBtn = whitelistButton("Romanize", () => void romanizeLine());
    const applyLine = (): void => {
      const origTokens = tokenizeLine(origIn.value);
      if (!origTokens.length) {
        msg.textContent = "Line can't be empty.";
        return;
      }
      const romaTokens = romaIn.value.trim() ? tokenizeLine(romaIn.value) : [];
      if (romaTokens.length && romaTokens.length !== origTokens.length) {
        msg.style.color = "#ff8a8a";
        msg.textContent = `${origTokens.length} word${origTokens.length === 1 ? "" : "s"} vs ${romaTokens.length} romaja — match the groups (use "/" to split).`;
        return;
      }
      const before = cloneWords();
      const lineStartMs = oldActive[0].start;
      const lineEndMs = oldActive[oldActive.length - 1].end;
      const rec = reconcileLine(
        oldActive.map((w) => ({ text: w.text, start: w.start, end: w.end })),
        origTokens,
        lineStartMs,
        lineEndMs,
        EDIT_MIN_DUR
      );
      // Drop the line's old active-lane words (DOM + model), then splice in the reconciled set.
      const oldSet = new Set<EditWord>(oldActive);
      for (const w of oldActive) {
        w.els?.forEach((e) => e.remove());
        w.label?.remove();
      }
      for (let i = words.length - 1; i >= 0; i--) if (oldSet.has(words[i])) words.splice(i, 1);
      rec.words.forEach((rw, i) => {
        const src = rw.from !== null ? oldActive[rw.from] : null;
        const nw: EditWord = {
          text: rw.text,
          start: rw.start,
          end: rw.end,
          line: lineIdx,
          ...(laneSecondary ? { secondary: true } : {}),
          ...(src?.singer ? { singer: src.singer } : {}),
          ...(src?.overlap ? { overlap: true } : {}), // keep the overlapping-note flag across a text edit
        };
        const roman = romaTokens.length ? romaTokens[i] : src?.roman;
        if (roman) nw.roman = roman;
        words.push(nw);
      });
      words.sort((a, b) => a.start - b.start);
      build();
      pushUndo(before);
      markDirty();
      status.textContent = `Line ${lineIdx + 1} updated (${rec.mode}) — ${rec.words.length} word${rec.words.length === 1 ? "" : "s"}`;
      closeAdvanced();
    };
    // This line's LEAD words (the overlap flag is a lead-only concept — it lives on the trailing note).
    const leadOfLine = (): EditWord[] =>
      words.filter((w) => w.line === lineIdx && !w.secondary).sort((a, b) => a.start - b.start);
    // Overlapping-main toggle: marks the line's LAST lead word so its end can stretch past the following
    // lines (set its length from the background lane). Applies immediately (undoable), independent of Apply.
    const overlapChk = document.createElement("input");
    overlapChk.type = "checkbox";
    const leadNow = leadOfLine();
    overlapChk.checked = leadNow.length ? !!leadNow[leadNow.length - 1].overlap : false;
    overlapChk.disabled = !leadNow.length;
    overlapChk.addEventListener("change", () => {
      const lead = leadOfLine();
      if (!lead.length) return;
      const before = cloneWords();
      for (const w of lead) w.overlap = undefined; // only the trailing note carries the flag
      if (overlapChk.checked) lead[lead.length - 1].overlap = true;
      normalizeWords(words); // freeing/relocking an end may need a re-clamp of this lane
      build();
      pushUndo(before);
      markDirty();
      status.textContent = overlapChk.checked
        ? `Line ${lineIdx + 1}: trailing note overlaps — drag its end in the background lane ("t")`
        : `Line ${lineIdx + 1}: overlap cleared`;
    });
    const overlapRow = document.createElement("label");
    overlapRow.setAttribute("style", "display:flex; align-items:center; gap:8px; font-size:12px; opacity:.9; cursor:pointer;");
    const overlapTxt = document.createElement("span");
    overlapTxt.textContent = "Overlapping main line — the last word's tail may stretch past following lines (resize its end in the background lane)";
    overlapRow.append(overlapChk, overlapTxt);

    // Delete the WHOLE line (both lanes) + its line-start marker, then re-index the lines after it.
    const deleteLine = (): void => {
      const before = cloneWords();
      for (let i = words.length - 1; i >= 0; i--) {
        if (words[i].line === lineIdx) {
          words[i].els?.forEach((e) => e.remove());
          words[i].label?.remove();
          words.splice(i, 1);
        }
      }
      lineStarts.splice(lineIdx, 1);
      for (const w of words) if (w.line > lineIdx) w.line--;
      if (lastPlottedLine !== null) {
        if (lastPlottedLine === lineIdx) lastPlottedLine = null;
        else if (lastPlottedLine > lineIdx) lastPlottedLine--; // keep the plot cursor pointing at the same line
      }
      build();
      pushUndo(before);
      markDirty();
      closeAdvanced();
      status.textContent = `Deleted line ${lineIdx + 1}`;
    };
    const deleteBtn = whitelistButton("🗑 Delete line", deleteLine);
    deleteBtn.style.marginLeft = "auto"; // push it to the far right, away from Apply/Cancel

    const applyBtn = whitelistButton("Apply", applyLine);
    const cancelBtn = whitelistButton("Cancel", () => closeAdvanced());
    btns.append(romanizeBtn, applyBtn, cancelBtn, deleteBtn);

    // Enter in a field applies; Escape closes. Listeners live on the inputs, so they're GC'd when the
    // panel body is cleared — no document-level cleanup needed.
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === "Escape") {
        e.preventDefault();
        closeAdvanced();
      } else if (e.key === "Enter") {
        e.preventDefault();
        applyLine();
      }
    };
    origIn.addEventListener("keydown", onKey);
    romaIn.addEventListener("keydown", onKey);

    openAdvanced("line", `Edit line ${lineIdx + 1}${laneSecondary ? " · background" : ""}`, (body) => {
      const wrap = document.createElement("div");
      wrap.setAttribute("style", "display:flex; flex-direction:column; gap:9px; max-width:760px;");
      wrap.append(labeled("Language", langSel), labeled("Original (words)", origIn), labeled("Romanization", romaIn), overlapRow, msg, btns);
      body.append(wrap);
    });
    centerRowInView(oldActive[0].start); // keep the edited line visible above the panel
    origIn.focus();
    origIn.select();
  };

  // ── Raw-lyrics upload + plotting ──────────────────────────────────────────────────────────────
  // Upload newline-separated lyrics → a queue. Then, playing the song: "]" drops the NEXT queued line at
  // the white bar (playhead); "[" re-syncs the LAST plotted line's start to the bar (shifting its whole
  // line — head + words — with no rescale). No tail to redistribute against (lines are plotted at the end),
  // so each line's words are laid sequentially with a default duration, refined later with the per-word
  // tools. The upload (Replace) and each plot are undoable. The panel shows last-plotted / next-to-plot.
  // Plotted words take the MINIMUM window (EDIT_MIN_DUR) each — a line should occupy as little time as
  // possible so it never stretches past where it belongs and a later "]" can't drop the next line in the
  // MIDDLE of this one's words. Real durations come from the per-word tools / "[" re-sync afterward.
  const PLOT_WORD_MS = EDIT_MIN_DUR;
  let plotLines: string[] = [];
  let plotIndex = 0;
  let lastPlottedLine: number | null = null;

  // Playhead in RAW time (minus the lyric offset), or null when this isn't the playing track.
  const playheadRaw = (): number | null => {
    if (Spicetify.Player.data?.item?.uri !== uri) return null;
    return Math.max(0, (Spicetify.Player.getProgress?.() ?? 0) - lyricOffset);
  };

  const renderPlotting = (body: HTMLElement): void => {
    const wrap = document.createElement("div");
    wrap.setAttribute("style", "display:flex; flex-direction:column; gap:10px; max-width:820px;");
    const hint = document.createElement("div");
    hint.setAttribute("style", "font-size:12px; opacity:.7; line-height:1.5;");
    hint.textContent = plotLines.length
      ? `${plotIndex}/${plotLines.length} plotted · play the song and press "]" to drop the next line at the white bar · "[" re-syncs the last plotted line to the bar.`
      : 'No lyrics queued — press "⬆ Upload lyrics" above to paste newline-separated lyrics, then plot them here.';
    const row = (label: string, text: string, color: string): HTMLElement => {
      const d = document.createElement("div");
      d.setAttribute("style", "display:flex; gap:12px; align-items:baseline;");
      const l = document.createElement("span");
      l.textContent = label;
      l.setAttribute("style", `flex:0 0 110px; font-size:11px; font-weight:700; letter-spacing:.04em; color:${color};`);
      const t = document.createElement("span");
      t.textContent = text;
      t.setAttribute("style", "font-size:15px; opacity:.95;");
      d.append(l, t);
      return d;
    };
    wrap.append(
      hint,
      row("LAST PLOTTED", plotIndex > 0 ? plotLines[plotIndex - 1] : "— none yet", "#1db954"),
      row("NEXT TO PLOT", plotIndex < plotLines.length ? plotLines[plotIndex] : "— queue empty", "#ffd23f")
    );
    body.append(wrap);
  };
  const openPlotting = (): void => openAdvanced("plotting", `Plotting — ${plotIndex}/${plotLines.length} lines`, renderPlotting);

  // Insert a plotted line's head at time `t` (kept sorted) + its words laid sequentially from `t`. Returns
  // the new line index. Words go in the ACTIVE lane ("t" toggle). No redistribution (no tail bound).
  const plotLineAt = (text: string, t: number): number => {
    const tokens = tokenizeLine(text);
    let L = 0;
    while (L < lineStarts.length && lineStarts[L] <= t) L++;
    lineStarts.splice(L, 0, t);
    for (const w of words) if (w.line >= L) w.line++; // re-index after the insert
    if (lastPlottedLine !== null && L <= lastPlottedLine) lastPlottedLine++; // keep the tracked line valid
    tokens.forEach((tok, i) =>
      words.push({ text: tok, start: t + i * PLOT_WORD_MS, end: t + (i + 1) * PLOT_WORD_MS, line: L, ...(bgLane ? { secondary: true } : {}) })
    );
    words.sort((a, b) => a.start - b.start);
    return L;
  };

  const plotNextLine = (): void => {
    if (starred || roLock) {
      status.textContent = roLock ? "Read-only preview" : "★ Starred — unstar to edit";
      return;
    }
    if (advMode !== "plotting") {
      openPlotting(); // closed/other mode → reopen the plotting view first (spec), don't plot yet
      return;
    }
    if (plotIndex >= plotLines.length) {
      status.textContent = plotLines.length ? "All lines plotted" : "Upload raw lyrics first";
      return;
    }
    const t = playheadRaw();
    if (t === null) {
      status.textContent = "Play this track to plot at the white bar";
      return;
    }
    const before = cloneWords();
    lastPlottedLine = plotLineAt(plotLines[plotIndex], t);
    plotIndex++;
    build();
    pushUndo(before);
    markDirty();
    openPlotting();
    centerRowInView(t);
    status.textContent = `Plotted ${plotIndex}/${plotLines.length} — "${plotLines[plotIndex - 1]}"`;
  };

  const syncPrevLine = (): void => {
    if (starred || roLock) {
      status.textContent = roLock ? "Read-only preview" : "★ Starred — unstar to edit";
      return;
    }
    if (advMode !== "plotting") {
      openPlotting();
      return;
    }
    if (lastPlottedLine === null || lastPlottedLine >= lineStarts.length) {
      plotNextLine(); // nothing plotted yet → plot the first line
      return;
    }
    const t = playheadRaw();
    if (t === null) {
      status.textContent = "Play this track to re-sync at the white bar";
      return;
    }
    const L = lastPlottedLine;
    const lo = L > 0 ? lineStarts[L - 1] + 1 : 0; // keep lineStarts strictly ascending
    const hi = L + 1 < lineStarts.length ? lineStarts[L + 1] - 1 : timelineMs;
    const clamped = Math.max(lo, Math.min(t, hi));
    const delta = clamped - lineStarts[L];
    if (!delta) return;
    const before = cloneWords();
    lineStarts[L] = clamped;
    for (const w of words)
      if (w.line === L) {
        w.start += delta;
        w.end += delta;
      }
    build();
    pushUndo(before);
    markDirty();
    openPlotting();
    centerRowInView(clamped);
    status.textContent = `Line ${L + 1} start → ${fmtClock(clamped)}`;
  };

  // Upload modal: paste newline-separated lyrics. "Replace & queue" clears the current timing (undoable)
  // and loads the lines as the plotting queue, then opens the plotting view.
  // Best-effort PLAIN-TEXT lyric pull for the upload field — one line per lyric line, no timing. We
  // deliberately accept ANY source (word-synced, line-synced, or plain): the text is for editable
  // review before the user plots it, so mappings don't matter. Priority: what's already on screen →
  // Spotify-native (Spicy) cache → LRCLIB. Returns "" when nothing is found.
  const currentLinesText = (): string => {
    if (!words.length || !lineStarts.length) return "";
    const byLine: string[][] = lineStarts.map(() => []);
    for (const w of words) if (!w.secondary && byLine[w.line]) byLine[w.line].push(w.text);
    return byLine
      .map((ws) => ws.join(" ").replace(/\s+/g, " ").trim())
      .filter(Boolean)
      .join("\n");
  };
  // `base:true` forces the external BASE pull (Spicy/LRCLIB) and ignores whatever is already on screen —
  // used by the manual "⟳ Pull lyrics" button so it always RESETS the field to the clean source lyrics.
  const fetchBestEffortLyricText = async (opts?: { base?: boolean }): Promise<string> => {
    if (!opts?.base) {
      const cur = currentLinesText(); // whatever is already plotted — lets a re-upload start from on-screen text
      if (cur) return cur;
    }
    try {
      const parsed = await readSpicyLyricsCache(id).catch(() => null); // Spotify-native, instant, matches the card
      // plainLyricLines accepts UNSYNCED/static lyrics too (what's visible in Spicy's panel with no timing).
      const lines = parsed ? plainLyricLines(parsed) : null;
      if (lines?.length) {
        const txt = lines.join("\n").trim();
        if (txt) return txt;
      }
    } catch {
      /* fall through to LRCLIB */
    }
    try {
      const track = lrcTrackFor(uri);
      const synced = track ? await fetchLrclibSynced((u: string, init?: RequestInit) => fetch(u, init), track) : null;
      const lines = synced ? parseLrc(synced) : null;
      if (lines?.length) {
        const txt = lines
          .map((s) => s.text.trim())
          .filter(Boolean)
          .join("\n");
        if (txt.trim()) return txt;
      }
    } catch {
      /* no lyrics anywhere */
    }
    return "";
  };

  const openUploadDialog = (): void => {
    if (starred || roLock) {
      status.textContent = roLock ? "Read-only preview" : "★ Starred — unstar to edit";
      return;
    }
    const modal = document.createElement("div");
    modal.setAttribute(
      "style",
      "position:fixed; inset:0; z-index:10000; display:flex; align-items:center; justify-content:center; background:rgba(0,0,0,.55);"
    );
    const box = document.createElement("div");
    box.setAttribute(
      "style",
      "width:min(640px,92vw); display:flex; flex-direction:column; gap:10px; background:var(--spice-card,#282828); " +
        "color:var(--spice-text,#fff); padding:18px 20px; border-radius:12px; box-shadow:0 14px 44px rgba(0,0,0,.6);"
    );
    const title = document.createElement("div");
    title.textContent = "Upload raw lyrics";
    title.setAttribute("style", "font-weight:800; font-size:16px;");
    const sub = document.createElement("div");
    sub.textContent =
      'One line per lyric line. "Replace & queue" clears the current timing (undo with "z"); then play the song and press "]" to drop each line at the white bar, "[" to re-sync the last one.';
    sub.setAttribute("style", "font-size:12px; opacity:.7; line-height:1.45;");
    const ta = document.createElement("textarea");
    ta.setAttribute(
      "style",
      "width:100%; min-height:240px; resize:vertical; padding:10px; border-radius:8px; border:1px solid var(--spice-button-disabled,#555); " +
        "background:var(--spice-main,#111); color:var(--spice-text,#fff); font-size:14px; line-height:1.5; box-sizing:border-box; font-family:inherit;"
    );
    ta.placeholder = "Paste lyrics here — one line per row…";
    const close = (): void => modal.remove();
    const btnRow = document.createElement("div");
    btnRow.setAttribute("style", "display:flex; gap:8px; align-items:center;");
    // Best-effort auto-pull: fill the field with any lyrics we can find, left editable for review. We
    // only overwrite while the field is untouched, so a pull in flight never clobbers typed/pasted text.
    const pullStatus = document.createElement("div");
    pullStatus.setAttribute("style", "font-size:12px; opacity:.7; flex:1 1 auto;");
    let userTouched = false;
    ta.addEventListener("input", () => (userTouched = true));
    const doPull = async (manual: boolean): Promise<void> => {
      if (userTouched && !manual) return;
      pullStatus.textContent = "Pulling lyrics…";
      const txt = await fetchBestEffortLyricText({ base: manual }); // manual = reset to the clean base pull
      if (!modal.isConnected) return;
      if (txt && (manual || !userTouched)) {
        ta.value = txt;
        userTouched = false;
        pullStatus.textContent = `Pulled ${txt.split("\n").length} lines — review, then Replace & queue`;
      } else if (txt) {
        pullStatus.textContent = "";
      } else {
        pullStatus.textContent = "No lyrics found online — paste them manually";
      }
    };
    const pull = whitelistButton("⟳ Pull lyrics", () => void doPull(true));
    const upload = whitelistButton("Replace & queue", () => {
      const lines = ta.value
        .split(/\r?\n/)
        .map((s) => s.trim())
        .filter(Boolean);
      if (!lines.length) {
        ta.focus();
        return;
      }
      const before = cloneWords();
      words.length = 0;
      lineStarts.length = 0;
      plotLines = lines;
      plotIndex = 0;
      lastPlottedLine = null;
      build();
      pushUndo(before);
      markDirty();
      close();
      openPlotting();
      status.textContent = `Queued ${lines.length} lines — play + press "]" to plot`;
    });
    const cancel = whitelistButton("Cancel", close);
    btnRow.append(pull, pullStatus, upload, cancel);
    box.append(title, sub, ta, btnRow);
    modal.append(box);
    modal.addEventListener("mousedown", (e) => {
      if (e.target === modal) close();
    });
    document.body.append(modal);
    ta.focus();
    void doPull(false); // auto-fill from the best available source; stays editable for review
  };
  if (!roLock) {
    const uploadBtn = whitelistButton("⬆ Upload lyrics", openUploadDialog);
    uploadBtn.title = "Paste newline-separated lyrics to plot onto the timeline";
    titleRow.insertBefore(uploadBtn, status);
  }

  // Insert a new word at the pointer over the timeline (else the playhead, else 0), joining the line
  // under that position, and open its popover so the text can be typed right away.
  // "+" / "=" — drop a NEW empty line divider (just a lineStart marker) at the mouse position. Words are
  // added to it later with "a" (or plotting). Re-indexes the words of every line after the insertion.
  const addLineAtPointer = (): void => {
    if (starred || roLock) {
      status.textContent = roLock ? "Read-only preview" : "★ Starred — unstar to edit";
      return;
    }
    const ptr = lastPointer && rowDivs.length ? pointerToMs(lastPointer as PointerEvent) - lyricOffset : null;
    const play =
      Spicetify.Player.data?.item?.uri === uri ? (Spicetify.Player.getProgress?.() ?? 0) - lyricOffset : 0;
    const pos = Math.max(0, Math.min(ptr ?? play, timelineMs - 1));
    let L = 0;
    while (L < lineStarts.length && lineStarts[L] <= pos) L++; // keep lineStarts sorted
    const before = cloneWords();
    lineStarts.splice(L, 0, pos);
    for (const w of words) if (w.line >= L) w.line++; // the insert shifts every following line down
    if (lastPlottedLine !== null && L <= lastPlottedLine) lastPlottedLine++;
    build();
    pushUndo(before);
    markDirty();
    status.textContent = `New line ${L + 1} at ${fmtClock(pos)} — add words with "a"`;
  };

  const addWord = (): void => {
    if (starred || roLock) {
      status.textContent = roLock ? "Read-only preview" : "★ Starred — unstar to edit";
      return;
    }
    const ptr = lastPointer && rowDivs.length ? pointerToMs(lastPointer as PointerEvent) - lyricOffset : null;
    const play =
      Spicetify.Player.data?.item?.uri === uri ? (Spicetify.Player.getProgress?.() ?? 0) - lyricOffset : 0;
    const pos = Math.max(0, Math.min(ptr ?? play, timelineMs - 1));
    let L = 0;
    for (let i = 0; i < lineStarts.length; i++) if (lineStarts[i] <= pos) L = i; // line under the position
    pushUndo(cloneWords());
    const nw: EditWord = { text: "word", start: pos, end: pos + 300, line: L, ...(bgLane ? { secondary: true } : {}) };
    words.push(nw);
    normalizeWords(words); // sort + clamp so it doesn't overlap neighbours
    build();
    markDirty();
    status.textContent = bgLane ? "Background word added — type its text" : "Word added — type its text";
    if (nw.els?.[0]) openPopover(nw, nw.els[0], true); // focus the text field for an immediate rename
  };

  // Lazy-load Spicy's romanization for this track and attach it to each word. A per-syllable
  // romanization (word-synced lyrics) matches each word by its time window. A per-LINE romanization
  // (line-synced lyrics, which we split into words BY that romaji) is dealt out word-by-word across
  // the line's words in order — so each native word shows its own romaji, not the whole line on the
  // first word. Returns whether any word got a romanization.
  const loadRomanization = async (): Promise<boolean> => {
    const parsed = await readSpicyLyricsCache(id).catch(() => null);
    const spans = parsed ? romanizationSpans(parsed) : [];
    if (!spans.length) return false;
    const windowRoman = (w: EditWord): string =>
      spans.filter((s) => s.start >= w.start - 150 && s.start < w.end).map((s) => s.roman).join("");
    const byLine = new Map<number, EditWord[]>();
    for (const w of words) {
      if (w.secondary) {
        const r = windowRoman(w); // background words: per-window (they carry their own timing)
        if (r) w.roman = r;
        continue;
      }
      const arr = byLine.get(w.line);
      if (arr) arr.push(w);
      else byLine.set(w.line, [w]);
    }
    for (const lw of byLine.values()) {
      lw.sort((a, b) => a.start - b.start);
      const inLine = spans.filter((s) => s.start >= lw[0].start - 200 && s.start < lw[lw.length - 1].end);
      if (!inLine.length) continue;
      if (inLine.length >= lw.length) {
        for (const w of lw) {
          const r = windowRoman(w); // a roman unit per word → word-synced, match by window
          if (r) w.roman = r;
        }
      } else {
        const rw = splitRomanWords(inLine.map((s) => s.roman).join(" ")); // one line romaji → split 1:1
        lw.forEach((w, i) => {
          if (rw[i]) w.roman = rw[i];
        });
      }
    }
    return words.some((w) => !!w.roman);
  };
  // "w": switch word labels between the original characters and romanization (loaded on first use).
  // "t": flip the active edit lane between MAIN (lead/green) and BACKGROUND (secondary/purple). Taps,
  // new words, and fill/prune/resize then target that lane, so the two overlapping parts are built with
  // the same tools. The status tints purple while the background lane is active (a persistent reminder).
  const toggleTrackLane = (): void => {
    bgLane = !bgLane;
    status.style.color = bgLane ? "#c79bff" : "";
    status.textContent = bgLane
      ? "Editing BACKGROUND vocals — now the tall bars; main drops to the thin top strip · t for main"
      : "Editing MAIN vocals — now the tall bars; background drops to the thin top strip · t for background";
    // Swap the lanes' roles everywhere: rebuild every bar so the ACTIVE lane renders prominent and the
    // other as the thin strip. Classes are assigned in makeSegment, so drop els to force a fresh build.
    for (const w of words) {
      w.els?.forEach((e) => e.remove());
      w.els = [];
    }
    relayout();
  };

  const toggleRoman = (): void => {
    showRoman = !showRoman;
    if (showRoman && !romanLoaded) {
      romanLoaded = true;
      status.textContent = "Loading romanization…";
      void loadRomanization().then((ok) => {
        status.textContent = ok ? "Romanization — on" : "No romanization available from Spicy Lyrics";
        if (ok) relayout(); // repaint labels with the romanized text
      });
      return;
    }
    relayout(); // repaint labels (characters ↔ romanization)
    status.textContent = showRoman ? "Romanization — on" : "Characters — on";
  };

  // The raw-time playhead for this track, or null when it isn't the one playing / is locked.
  const editPlayheadRaw = (): number | null => {
    if (starred || roLock) {
      status.textContent = roLock ? "Read-only preview" : "★ Starred — unstar to edit";
      return null;
    }
    if (Spicetify.Player.data?.item?.uri !== uri) {
      status.textContent = "Play this track to position the bar";
      return null;
    }
    return (Spicetify.Player.getProgress?.() ?? 0) - lyricOffset;
  };

  // Prune ("d"): trim the ACTIVELY PLAYING word's TRAILING end — pull its end back to the white bar,
  // cutting off [bar, wordEnd]. The freed span becomes empty space; the word's start is unchanged.
  const pruneWord = (): void => {
    const rawPos = editPlayheadRaw();
    if (rawPos === null) return;
    const at = (sec: boolean): EditWord | undefined => words.find((x) => !!x.secondary === sec && rawPos >= x.start && rawPos < x.end);
    const w = at(bgLane) ?? at(!bgLane); // prefer the ACTIVE lane's word under the bar
    if (!w) {
      status.textContent = "Prune: no word playing at the bar";
      return;
    }
    const hi = nextInLane(w)?.start ?? timelineMs;
    const newEnd = Math.min(hi, Math.max(rawPos, w.start + EDIT_MIN_DUR));
    if (newEnd >= w.end - 1) {
      status.textContent = "Prune: nothing to cut";
      return;
    }
    pushUndo(cloneWords());
    w.end = newEnd;
    layoutWord(w);
    markDirty();
    status.textContent = `Pruned "${w.text}" end`;
  };

  // Fill ("f"): stretch a word's end to the NEXT word's start, filling the trailing space. If the bar
  // is INSIDE a word, THAT word fills its trailing space; on empty space, the PREVIOUS word does.
  const fillGap = (): void => {
    const rawPos = editPlayheadRaw();
    if (rawPos === null) return;
    // The word to extend — prefer the LEAD lane: the lead word under the bar, else the nearest lead
    // word ending before it (falls back to a background word only if there's no lead candidate).
    const inside = (sec: boolean): EditWord | undefined => words.find((x) => !!x.secondary === sec && rawPos >= x.start && rawPos < x.end);
    const before = (sec: boolean): EditWord | undefined => {
      let b: EditWord | undefined;
      for (const x of words) if (!!x.secondary === sec && x.end <= rawPos && (!b || x.end > b.end)) b = x;
      return b;
    };
    const w = inside(bgLane) ?? before(bgLane) ?? inside(!bgLane) ?? before(!bgLane);
    if (!w) {
      status.textContent = "Fill: no word to extend";
      return;
    }
    const next = nextInLane(w); // the next word in the SAME lane
    const target = next ? next.start : timelineMs;
    if (target <= w.end + 1) {
      status.textContent = "Fill: no trailing space to fill";
      return;
    }
    pushUndo(cloneWords());
    w.end = target;
    layoutWord(w);
    markDirty();
    status.textContent = `Filled "${w.text}" to next word`;
  };

  // Proportionally rescale every word of a line (both lanes) from its current lead span into the
  // window [winStart, winEnd], preserving each word's relative position + duration ratio.
  const rebalanceLine = (lineIdx: number, winStart: number, winEnd: number): void => {
    const lw = words.filter((w) => w.line === lineIdx);
    const lead = lw.filter((w) => !w.secondary).sort((a, b) => a.start - b.start);
    if (!lead.length) return;
    const oldStart = lead[0].start;
    const oldSpan = Math.max(1, lead[lead.length - 1].end - oldStart);
    const newSpan = Math.max(1, winEnd - winStart);
    for (const w of lw) {
      w.start = Math.round(winStart + ((w.start - oldStart) / oldSpan) * newSpan);
      w.end = Math.round(winStart + ((w.end - oldStart) / oldSpan) * newSpan);
    }
  };

  // Backslash ("\"): snap the CLOSEST lyric line's head to the white bar, then proportionally
  // redistribute that whole line's words to fit the line's new window. Use it live — when a line's
  // detected start has drifted off the vocal, play to the real downbeat and press "\": the line head
  // jumps to the bar and the line's words rescale to span from there to where the line used to end,
  // keeping their relative rhythm. Both lanes (lead + background) move together. When the new head
  // lands INSIDE the previous line, how much it overran decides the fix-up: cutting only the prev
  // line's last word → just chop that word's tail to the bar; cutting two+ words → rebalance the
  // whole previous line into the space before the bar and take the bar as this line's head.
  const redistributeLineToPlayhead = (): void => {
    const rawPos = editPlayheadRaw();
    if (rawPos === null) return; // locked / not the playing track (editPlayheadRaw set the status)
    if (!lineStarts.length) return;
    const pos = Math.max(0, Math.round(rawPos));
    // The line whose START is nearest the white bar.
    let L = 0;
    let best = Infinity;
    for (let i = 0; i < lineStarts.length; i++) {
      const d = Math.abs(lineStarts[i] - pos);
      if (d < best) {
        best = d;
        L = i;
      }
    }
    const before = cloneWords();
    const lead = words.filter((w) => w.line === L && !w.secondary).sort((a, b) => a.start - b.start);
    const nextStart = L + 1 < lineStarts.length ? lineStarts[L + 1] : timelineMs;
    const minSpan = Math.max(EDIT_MIN_DUR, (lead.length || 1) * EDIT_MIN_DUR);
    const second = lead[1];
    // CURRENT line: when the bar only reaches the STARTING word (never the 2nd word), just move that
    // first word's start to the bar — the previous-word-chop, applied to this line's own head —
    // leaving the rest of the line as-is. Only when the bar lands on the 2nd word or beyond is the
    // whole line rescaled into its new window.
    const chopFirst = lead.length > 0 && (!second || pos < second.start);
    // Previous line's lead words the bar cuts into — those whose END runs past it (always a trailing
    // run, since words are ordered). 1 → trim that word; ≥2 → rebalance the whole previous line.
    const prevLead = L > 0 ? words.filter((w) => w.line === L - 1 && !w.secondary).sort((a, b) => a.start - b.start) : [];
    const cut = prevLead.filter((w) => w.end > pos);
    let loBound = L > 0 ? lineStarts[L - 1] + EDIT_MIN_GAP : 0; // keep lineStarts ascending
    if (cut.length >= 2) loBound = Math.max(loBound, lineStarts[L - 1] + prevLead.length * EDIT_MIN_DUR);
    else if (cut.length === 1) loBound = Math.max(loBound, cut[0].start + EDIT_MIN_DUR); // keep ≥ min width
    // Chop mode only needs room for the first word before the 2nd; rebalance needs room for them all.
    const hiBound = (chopFirst ? (second ? second.start : nextStart) : nextStart) - (chopFirst ? EDIT_MIN_DUR : minSpan);
    const newStart = Math.round(Math.max(loBound, Math.min(pos, hiBound)));

    if (cut.length === 1) cut[0].end = newStart; // chop the one overrun prev-line word's tail to the bar
    else if (cut.length >= 2) rebalanceLine(L - 1, lineStarts[L - 1], newStart); // squeeze prev line in

    let currentNote = "";
    if (chopFirst) {
      const w1 = lead[0];
      w1.start = newStart; // move JUST the starting word; keep the rest of the line
      w1.end = Math.min(second ? second.start : nextStart, Math.max(w1.end, newStart + EDIT_MIN_DUR));
      currentNote = " · first word moved";
    } else if (lead.length) {
      // The line still ends where it did (its last word's end), never past the next line; its words
      // proportionally fill the new window.
      const newEnd = Math.max(newStart + minSpan, Math.min(lead[lead.length - 1].end, nextStart));
      rebalanceLine(L, newStart, newEnd);
      currentNote = " · redistributed";
    }
    lineStarts[L] = newStart;
    normalizeWords(words); // re-clamp each lane to a valid ascending, non-overlapping sequence
    build();
    tapRecord("blue"); // also drop a blue tap at the bar (a blue line marking the snap / first word)
    pushUndo(before);
    markDirty();
    const prevNote = cut.length === 1 ? " · prev word trimmed" : cut.length >= 2 ? " · prev line rebalanced" : "";
    status.textContent = `Line ${L + 1} start → ${fmtClock(newStart)}${currentNote}${prevNote}`;
  };

  // A burst of nib nudges (keys 1/2/3/4 held or rapidly tapped) coalesces into ONE undo step: we
  // snapshot before the first and commit it once the burst goes idle (or any other edit/undo flushes
  // it). `flushResizeUndo` is called at the start of every other edit action + doUndo + teardown.
  const RESIZE_STEP_MS = 3;
  let resizeSnapshot: ReturnType<typeof cloneWords> | null = null;
  let resizeUndoTimer: ReturnType<typeof setTimeout> | null = null;
  const flushResizeUndo = (): void => {
    if (resizeUndoTimer) {
      clearTimeout(resizeUndoTimer);
      resizeUndoTimer = null;
    }
    if (resizeSnapshot) {
      pushUndo(resizeSnapshot);
      resizeSnapshot = null;
    }
  };

  // Nudge one edge of the word at the bar by `step` ms (keys 1/2/3/4 — stretch/squash). Like the
  // corner nibs, pushing an edge past a neighbour SHRINKS that neighbour (down to its min duration).
  // "start"/-1 = left nib out, "start"/+1 = left nib in, "end"/+1 = right nib out, "end"/-1 = in.
  const resizeNib = (side: "start" | "end", dir: -1 | 1, step: number): void => {
    const rawPos = editPlayheadRaw();
    if (rawPos === null) return;
    // The word at the bar — prefer the ACTIVE lane's word, else the other lane's, else the nearest.
    const at = (sec: boolean): EditWord | undefined => words.find((x) => !!x.secondary === sec && rawPos >= x.start && rawPos < x.end);
    let w = at(bgLane) ?? at(!bgLane) ?? null;
    if (!w) {
      let best = Infinity;
      for (const x of words) {
        const d = rawPos < x.start ? x.start - rawPos : rawPos - x.end;
        if (d < best) {
          best = d;
          w = x;
        }
      }
    }
    if (!w) return;
    if (resizeSnapshot === null) resizeSnapshot = cloneWords(); // snapshot before the burst's first edit
    if (resizeUndoTimer) clearTimeout(resizeUndoTimer);
    resizeUndoTimer = setTimeout(flushResizeUndo, 500); // commit one undo step once the burst stops
    if (side === "start") {
      const prev = prevInLane(w);
      const lo = prev ? prev.start + EDIT_MIN_DUR : 0; // push prev's end back, down to its min
      w.start = Math.max(lo, Math.min(w.end - EDIT_MIN_DUR, w.start + dir * step));
      if (prev && prev.end > w.start) {
        prev.end = w.start;
        layoutWord(prev);
      }
    } else {
      const next = nextInLane(w);
      const hi = next ? next.end - EDIT_MIN_DUR : timelineMs; // push next's start forward, down to its min
      w.end = Math.max(w.start + EDIT_MIN_DUR, Math.min(hi, w.end + dir * step));
      if (next && next.start < w.end) {
        next.start = w.end;
        layoutWord(next);
      }
    }
    layoutWord(w);
    markDirty();
  };

  // Replace the live words + line heads with a snapshot (shared by undo + redo), then persist/redraw.
  const restoreSnapshot = (snap: ReturnType<typeof cloneWords>): void => {
    words.length = 0;
    for (const w of snap.words)
      words.push({ text: w.text, start: w.start, end: w.end, line: w.line, ...(w.secondary ? { secondary: true } : {}), ...(w.singer ? { singer: w.singer } : {}), ...(w.overlap ? { overlap: true } : {}) });
    lineStarts.length = 0;
    lineStarts.push(...snap.lineStarts); // restore the lyric line heads too (undoes "Set line start here")
    plotLines = [...snap.plotLines]; // rewind the plot queue in lock-step: undoing a plot steps the
    plotIndex = snap.plotIndex; //       cursor back to NEXT-TO-PLOT, undoing an upload restores the queue
    lastPlottedLine = snap.lastPlottedLine;
    build();
    dirty = true; // an undo/redo IS a change vs disk — force commit() past its no-op-when-clean guard
    commit();
    if (advMode === "plotting") openPlotting(); // reflect the rewound LAST PLOTTED / NEXT TO PLOT
  };
  doUndo = (): void => {
    if (starred || roLock) {
      status.textContent = roLock ? "Read-only preview" : "★ Starred — unstar to edit";
      return;
    }
    flushResizeUndo(); // commit any pending resize-burst first, so Undo reverts it
    const prev = undoStack.pop();
    if (!prev) {
      status.textContent = "Nothing to undo";
      return;
    }
    redoStack.push(cloneWords()); // current state → redo
    restoreSnapshot(prev);
    status.textContent = undoStack.length ? `Undid — ${undoStack.length} more` : "Undid";
  };
  // "y": redo — replay a state that undo rolled back (cleared by any fresh edit).
  const doRedo = (): void => {
    if (starred || roLock) {
      status.textContent = roLock ? "Read-only preview" : "★ Starred — unstar to edit";
      return;
    }
    const next = redoStack.pop();
    if (!next) {
      status.textContent = "Nothing to redo";
      return;
    }
    undoStack.push(cloneWords()); // current state → undo (so you can undo the redo)
    restoreSnapshot(next);
    status.textContent = redoStack.length ? `Redid — ${redoStack.length} more` : "Redid";
  };

  // Passive key handling while the editor is open. Fixed keys: "z" undo, "s" save, "b" bookmark,
  // "t" track-lane toggle (main⇄background), "," green bar. The configurable record keys (default
  // "." "/") plot blue bars. Ignored while typing in a field. Fixed keys win over the record keys.
  const onEditorKey = (e: KeyboardEvent): void => {
    if (e.ctrlKey || e.metaKey || e.altKey) return;
    const tgt = e.target as HTMLElement | null;
    if (tgt && (tgt.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(tgt.tagName))) return; // don't hijack typing
    const key = e.key.toLowerCase();
    const isResize = /^[1234]$/.test(key);
    if (e.repeat && !isResize) return; // only the resize nudges (1-4) auto-repeat on hold
    if (!isResize) flushResizeUndo(); // any other action commits a pending resize-burst as one undo step
    const step = e.repeat ? RESIZE_STEP_MS * 2 : RESIZE_STEP_MS; // hold moves at double speed
    if (key === "1") {
      e.preventDefault();
      resizeNib("start", -1, step); // left nib outward (stretch)
    } else if (key === "2") {
      e.preventDefault();
      resizeNib("start", 1, step); // left nib inward (squash)
    } else if (key === "3") {
      e.preventDefault();
      resizeNib("end", -1, step); // right nib inward (squash)
    } else if (key === "4") {
      e.preventDefault();
      resizeNib("end", 1, step); // right nib outward (stretch)
    } else if (key === "8") {
      e.preventDefault();
      toggleStar();
    } else if (key === "w") {
      e.preventDefault();
      toggleRoman();
    } else if (key === "z") {
      e.preventDefault();
      doUndo();
    } else if (key === "y") {
      e.preventDefault();
      doRedo();
    } else if (key === "s") {
      e.preventDefault();
      saveNow();
    } else if (key === "b") {
      e.preventDefault();
      toggleBookmark();
    } else if (key === "t") {
      e.preventDefault();
      toggleTrackLane(); // swap the edit lane between MAIN (green) and BACKGROUND (purple) vocals
    } else if (key === ",") {
      e.preventDefault();
      tapRecord("green");
    } else if (key === "c") {
      e.preventDefault();
      cycleVoiceOfHover(); // cycle the hovered word's duet voice: both → Mittens → Biscuit
    } else if (key === "l") {
      e.preventDefault();
      openLineEditor(); // text-edit the hovered/playing line's words (+ romanization)
    } else if (key === "]") {
      e.preventDefault();
      plotNextLine(); // plot the next uploaded line at the white bar
    } else if (key === "[") {
      e.preventDefault();
      syncPrevLine(); // re-sync the last plotted line's start to the white bar (or plot the first)
    } else if (key === "x") {
      e.preventDefault();
      clearBars();
    } else if (key === "a") {
      e.preventDefault();
      addWord();
    } else if (key === "=" || key === "+") {
      e.preventDefault();
      addLineAtPointer(); // insert a new (empty) line divider at the mouse position
    } else if (key === "d") {
      e.preventDefault();
      pruneWord();
    } else if (key === "f") {
      e.preventDefault();
      fillGap(); // fill gap (prune's complement)
    } else if (key === "\\") {
      e.preventDefault();
      redistributeLineToPlayhead(); // snap closest line head to the bar + rescale its words
    } else if (key === "r") {
      e.preventDefault();
      enableFollow(); // follow playback: re-arm auto-follow + jump to the playhead
    } else if (key === "arrowleft") {
      e.preventDefault();
      e.stopPropagation(); // don't let Spotify's own ±seek fire too
      snapToLine(-1);
    } else if (key === "arrowright") {
      e.preventDefault();
      e.stopPropagation();
      snapToLine(1);
    } else if (key === "arrowup") {
      e.preventDefault();
      e.stopPropagation(); // don't let Spotify change the volume
      snapToWord("prev");
    } else if (key === "arrowdown") {
      e.preventDefault();
      e.stopPropagation();
      snapToWord("next");
    } else if (recordKeys().has(key)) {
      e.preventDefault();
      tapRecord("blue");
    }
  };
  recordKeyHandler = onEditorKey;
  document.addEventListener("keydown", onEditorKey, true);

  build();
  // Anchor the view once the split is sized (a frame after open): scroll the header settings OUT of frame
  // and land on the bookmark / current-playing line, so no manual scroll is ever needed on open.
  const anchorOnOpen = (): void => {
    if (!splitWrap.isConnected) return;
    // Scroll the OUTER panel so the TIMELINE's top (the head of the editing portion) pins to the panel's
    // top — the title/buttons/Advanced scroll above the fold (scroll up to reach them). Done before
    // sizeSplit so the split then grows downward from that aligned top, filling the panel.
    panelScroller = scrollParent(splitWrap);
    if (panelScroller) {
      panelScroller.scrollTop += splitWrap.getBoundingClientRect().top - panelScroller.getBoundingClientRect().top;
    }
    sizeSplit();
    followGeomReady = false;
    measureFollowGeom(); // seed geometry against the now-sized pane
    if (bookmarkMs !== null) {
      panToBookmark("auto"); // land where you left off editing
      return;
    }
    // No bookmark → scroll past the settings and onto the current-playing row (or the first row).
    const playing = Spicetify.Player.data?.item?.uri === uri;
    const pos = playing ? Spicetify.Player.getProgress?.() ?? 0 : 0;
    const row = Math.min(Math.max(0, rowDivs.length - 1), Math.floor(pos / rowWidthMs));
    const phTop = followWrapTop + row * (EDITOR_ROW_H + EDITOR_ROW_GAP);
    timelineScroller.scrollTop = Math.max(followWrapTop, phTop - followClientH * 0.3); // settings always out
    following = playing; // keep auto-following if we're on the current track
  };
  jumpToBookmark(); // (also handled by anchorOnOpen; kept so the caret/state updates immediately)
  setTimeout(anchorOnOpen, 150);
  // Re-layout on container resize (panel/sidebar width change). Coalesce a burst of observer
  // callbacks into one rebuild on the next frame, and skip entirely when the width didn't actually
  // change (height-only changes, or the initial fire that matches what build() just used).
  let roRaf = 0;
  const ro = new ResizeObserver(() => {
    if (!rowsWrap.isConnected) {
      ro.disconnect();
      return;
    }
    if (roRaf) return; // a rebuild is already queued for the next frame
    roRaf = requestAnimationFrame(() => {
      roRaf = 0;
      if (!rowsWrap.isConnected || rowsWrap.clientWidth === builtWidth) return;
      build();
    });
  });
  ro.observe(rowsWrap);

  // Full teardown: flush any pending edits, then stop every timer/observer/listener this editor
  // created. Idempotent — Back, Save, and the navigate-away path in `tick` all route through here.
  teardown = (): void => {
    flushResizeUndo(); // commit a pending resize-burst to the undo stack before leaving
    if (dirty) commit(); // never lose edits made in the last <30s
    clearInterval(timer);
    clearInterval(autosaveTimer);
    if (roRaf) cancelAnimationFrame(roRaf);
    if (rafId) cancelAnimationFrame(rafId); // stop the playhead rAF loop
    ro.disconnect();
    if (caretScroller) caretScroller.removeEventListener("scroll", onCaretScroll);
    if (caretRaf) cancelAnimationFrame(caretRaf);
    followBtn.remove();
    bookmarkCaret.remove();
    window.removeEventListener("resize", onWinResize);
    if (recordKeyHandler) document.removeEventListener("keydown", recordKeyHandler, true);
    if (activeLyricEditor?.token === editorToken) activeLyricEditor = null; // deregister (if still us)
  };
}

/**
 * A word-level LRC string built from a track's Spicy Lyrics cache, but ONLY when Spicy has
 * WORD-synced (per-word) lyrics for it — the detected form we don't otherwise store. Null for
 * line-synced / unsynced / absent. Used to surface those songs read-only in the lyric cache so a
 * copy can be saved for editing.
 */
async function spicyWordLevelLrc(id: string): Promise<string | null> {
  const parsed = await readSpicyLyricsCache(id).catch(() => null);
  if (!parsed) return null;
  const info = lyricSpans(parsed);
  if (!info || info.lineLevel) return null; // only genuine word-synced lyrics
  const grouped = lyricLines(parsed);
  if (!grouped || !grouped.length) return null;
  const timed = grouped
    .map((line) => ({
      start: line[0]?.start ?? 0,
      words: line
        .filter((s) => (s.text ?? "").trim())
        .map((s) => ({ text: s.text ?? "", start: s.start, end: s.end ?? s.start + 300, ...(s.secondary ? { secondary: true } : {}) })),
    }))
    .filter((l) => l.words.length);
  if (!timed.length) return null;
  return serializeWordLrcLines(timed);
}

/**
 * Render the LRC cache browser into `host`. Shows our saved (editable) `lyric/<version>/<id>.lrc`
 * entries — each with **Edit** and a confirm **Delete** — plus READ-ONLY entries for songs whose
 * Spicy Lyrics are word-synced but not yet saved here; those offer **Save a copy to edit**, which
 * materialises an editable override. Reads live, so it reflects the current saved set.
 */
async function renderLyricCacheInto(host: HTMLElement): Promise<void> {
  host.dataset.catjamView = "cache"; // not the Library → refreshNowPlaying won't re-render over it
  host.textContent = "";
  const heading = document.createElement("h2");
  heading.className = "TypeElement-cello-textBase-type";
  heading.textContent = "Lyric Cache";

  const back = whitelistButton("← Back to Library", () => renderWhitelistInto(host));
  host.append(heading, back);
  host.append(sectionLabel(`Saved in localStorage → catjam-lyric:${LRC_VERSION}:<id> · 📖 read-only = Spicy word-synced (not yet saved here)`));

  type Item = { id: string; lrc: string; readonly: boolean };
  const own = await listLrcCache();
  const ownIds = new Set(own.map((e) => e.id));
  // Read-only entries: Spicy word-synced songs not already saved as our own editable LRC.
  const spicyResolved = await Promise.all(
    (await listSpicyLyricsCache())
      .filter((id) => !ownIds.has(id))
      .map(async (id) => ({ id, lrc: await spicyWordLevelLrc(id) }))
  );
  const items: Item[] = [
    ...own.map((e) => ({ id: e.id, lrc: e.lrc, readonly: false })),
    ...spicyResolved.filter((r): r is { id: string; lrc: string } => !!r.lrc).map((r) => ({ ...r, readonly: true })),
  ];

  // "Spicy Sync": push STARRED songs' word-level lyrics into Spicy Lyrics' own local library (as
  // TTML) so they show in its panel. The all-at-once button is missing-only (never overwrites); the
  // per-card "Spicy Sync" on each starred entry overwrites that one track to the latest.
  const syncable = own.filter((e) => hasWordTimestamps(e.lrc) && isStarred(e.id));
  if (syncable.length) {
    const label = () => `★ Spicy Sync (${syncable.length})`;
    const syncRow = document.createElement("div");
    syncRow.setAttribute("style", "margin:6px 0 2px;");
    const syncAll = whitelistButton(label(), () => {
      void (async () => {
        const entries = syncable
          .map((e) => ({ uri: `spotify:track:${e.id}`, ttml: wordLrcToTtml(parseWordLrcLines(e.lrc), getSingerNames(overridesStore, e.id)) }))
          .filter((e): e is { uri: string; ttml: string } => !!e.ttml);
        if (!entries.length) {
          syncAll.textContent = "Nothing to sync";
          return;
        }
        syncAll.disabled = true;
        syncAll.textContent = "Syncing…";
        try {
          const { written, skipped } = await syncSpicyLocalLyrics(entries, { missingOnly: true });
          syncAll.textContent = `✓ ${written} synced to Spicy${skipped ? ` · ${skipped} already there` : ""}`;
        } catch (e) {
          syncAll.textContent = `✗ ${(e as Error).message}`;
        } finally {
          syncAll.disabled = false;
          setTimeout(() => (syncAll.textContent = label()), 5000);
        }
      })();
    });
    syncAll.title = "Add every STARRED song's word-level lyrics MISSING from Spicy Lyrics' local library (won't overwrite existing). Reopen the song in Spicy to see it.";
    syncRow.append(syncAll);
    host.append(syncRow);
  }

  if (!items.length) {
    const empty = document.createElement("div");
    empty.textContent =
      "No cached LRC files yet. They're saved when a track with no word-synced Spicy Lyrics resolves (LRCLIB or detection), or when you save a copy of a read-only Spicy entry here.";
    empty.setAttribute("style", "opacity:.7; padding:12px; line-height:1.5;");
    host.append(empty);
    return;
  }

  // Search by track id or name.
  const search = document.createElement("input");
  search.type = "search";
  search.placeholder = "Search cached lyrics by name or id…";
  search.setAttribute(
    "style",
    "width:100%; box-sizing:border-box; margin:4px 0 10px; padding:8px 10px; border-radius:8px; " +
      "border:1px solid var(--spice-button-disabled,#444); background:var(--spice-main,#121212); " +
      "color:var(--spice-text,#fff); font-size:13px;"
  );
  const list = document.createElement("div");
  host.append(search, list);

  const currentId = spotifyIdFromUri(Spicetify.Player.data?.item?.uri ?? "");
  const buildCard = (entry: Item, name?: string, isCurrent = false): HTMLElement => {
    const readonly = entry.readonly;
    const locked = !readonly && isStarred(entry.id);
    const bookmarked = !readonly && getBookmark(overridesStore, entry.id) !== null;
    const card = document.createElement("div");
    card.setAttribute(
      "style",
      "margin:6px 0; background:var(--spice-main,rgba(0,0,0,.25)); border-radius:8px; padding:10px 12px;" +
        (locked
          ? " box-shadow:inset 0 0 0 1px #ffd700;"
          : isCurrent
          ? " box-shadow:inset 0 0 0 1px var(--spice-button,#1db954);"
          : readonly
          ? " box-shadow:inset 0 0 0 1px #4ad0c0;"
          : bookmarked
          ? " box-shadow:inset 0 0 0 1px #b36bff;"
          : "")
    );
    const headerRow = document.createElement("div");
    headerRow.setAttribute("style", "display:flex; align-items:center; gap:10px; flex-wrap:wrap;");
    if (readonly) {
      const ro = document.createElement("span");
      ro.textContent = "📖 Spicy · read-only";
      ro.title = "Word-synced from Spicy Lyrics — save a copy to edit it";
      ro.setAttribute("style", "font-size:11px; font-weight:700; color:#4ad0c0; white-space:nowrap;");
      headerRow.append(ro);
    }
    if (bookmarked) {
      const bm = document.createElement("span");
      bm.textContent = "🔖";
      bm.title = "Bookmarked — editing in progress";
      bm.setAttribute("style", "filter:drop-shadow(0 0 6px rgba(179,107,255,.8));");
      headerRow.append(bm);
    }
    if (locked) {
      const starBadge = document.createElement("span");
      starBadge.textContent = "★";
      starBadge.title = "Starred (locked)";
      starBadge.setAttribute("style", "color:#ffd700; font-weight:700; text-shadow:0 0 8px rgba(255,215,0,.6);");
      headerRow.append(starBadge);
    }
    if (isCurrent) {
      const badge = document.createElement("span");
      badge.textContent = "♪ Now playing";
      badge.setAttribute(
        "style",
        "font-size:11px; font-weight:700; color:var(--spice-button,#1db954); white-space:nowrap;"
      );
      headerRow.append(badge);
    }
    const file = document.createElement("span");
    file.setAttribute(
      "style",
      `font-family:var(--font-mono,monospace); font-weight:600;${locked ? " color:#ffd700;" : readonly ? " color:#8ee6db;" : bookmarked ? " color:#c79bff;" : ""}`
    );
    file.textContent = `${entry.id}.lrc`;
    const sub = document.createElement("span");
    sub.setAttribute("style", "opacity:.6; font-size:12px;");
    sub.textContent = `${name ? name + " · " : ""}${lrcEntryCount(entry.lrc)} ${hasWordTimestamps(entry.lrc) ? "words" : "lines"}`;
    const spacer = document.createElement("span");
    spacer.style.flex = "1";

    if (readonly) {
      // No file exists yet — show the track name (or bare id), not "<id>.lrc".
      file.textContent = name || entry.id;
      sub.textContent = `${lrcEntryCount(entry.lrc)} ${hasWordTimestamps(entry.lrc) ? "words" : "lines"}`;
      // Open = read-only preview in the editor; Save = materialise an editable override, then edit it.
      const open = whitelistButton("Open", () => void openWordTimingEditor(entry.id, entry.lrc, host, true));
      const save = whitelistButton("Save", () => {
        void (async () => {
          await writeLrcCache(entry.id, entry.lrc);
          writeOnsetCache(overridesStore, entry.id, wordOnsets(parseWordLrc(entry.lrc)));
          if (Spicetify.Player.data?.item?.uri === `spotify:track:${entry.id}`) catController?.refreshOnsets();
          void openWordTimingEditor(entry.id, entry.lrc, host);
        })();
      });
      headerRow.append(file, sub, spacer, open, save);
      card.append(headerRow);
      return card;
    }

    const edit = whitelistButton(locked ? "View" : "Edit", () => void openWordTimingEditor(entry.id, entry.lrc, host));
    const del = whitelistButton("Delete", () => {}); // wired below (toggles a confirm row)
    headerRow.append(file, sub, spacer);
    // Per-entry "Spicy Sync": STARRED songs only — write THIS track's latest lyrics into Spicy's
    // local library (overwrites/updates to latest).
    if (locked && hasWordTimestamps(entry.lrc)) {
      const sync = whitelistButton("★ Spicy Sync", () => {
        const ttml = wordLrcToTtml(parseWordLrcLines(entry.lrc), getSingerNames(overridesStore, entry.id));
        if (!ttml) {
          Spicetify.showNotification?.("Lyricat: nothing to sync", true);
          return;
        }
        void writeSpicyLocalLyric(`spotify:track:${entry.id}`, ttml).then(
          () => Spicetify.showNotification?.(`Lyricat: synced ${name ?? entry.id} to Spicy Lyrics (reopen the song there)`),
          (e: unknown) => Spicetify.showNotification?.(`Lyricat: sync failed — ${(e as Error).message}`, true)
        );
      });
      sync.title = "Write this starred track's latest lyrics into Spicy Lyrics' local library (updates/overwrites)";
      headerRow.append(sync);
    }
    headerRow.append(edit, del);
    const confirmRow = document.createElement("div");
    confirmRow.setAttribute("style", "display:none; align-items:center; gap:10px; margin-top:8px;");
    const msg = document.createElement("span");
    msg.textContent = `Delete ${entry.id}.lrc?`;
    const doDelete = async (): Promise<void> => {
      await deleteLrcCache(entry.id);
      forgetLrc?.(entry.id); // clear memo + onset cache so a new LRC regenerates instead of the stale one
      if (Spicetify.Player.data?.item?.uri === `spotify:track:${entry.id}`) catController?.refreshOnsets(); // rebuild live
      void renderLyricCacheInto(host);
    };
    confirmRow.append(
      msg,
      whitelistButton("Yes, delete", () => void doDelete()),
      whitelistButton("Cancel", () => (confirmRow.style.display = "none"))
    );
    del.onclick = () => {
      if (locked) {
        // Starred = locked: block delete until unstarred (in the editor's ☆/★ toggle).
        Spicetify.showNotification?.("Lyricat: ★ starred — open it and unstar to delete", true);
        return;
      }
      confirmRow.style.display = confirmRow.style.display === "none" ? "flex" : "none";
    };
    card.append(headerRow, confirmRow);
    return card;
  };

  const named = items.map((e) => ({ entry: e, name: getOverride(overridesStore, e.id)?.name }));
  const renderList = (): void => {
    const q = search.value.trim().toLowerCase();
    const filtered = q
      ? named.filter((n) => n.entry.id.toLowerCase().includes(q) || (n.name ?? "").toLowerCase().includes(q))
      : named;
    // Pin the currently-playing track to the very top when it's in the (filtered) list.
    const shown = [...filtered].sort((a, b) => (a.entry.id === currentId ? -1 : b.entry.id === currentId ? 1 : 0));
    list.textContent = "";
    if (!shown.length) {
      const none = document.createElement("div");
      none.textContent = "No cached lyrics match your search.";
      none.setAttribute("style", "opacity:.6; padding:12px;");
      list.append(none);
      return;
    }
    for (const n of shown) list.append(buildCard(n.entry, n.name, n.entry.id === currentId));
  };
  search.addEventListener("input", renderList);
  renderList();
}

function renderWhitelistInto(host: HTMLElement): void {
  host.dataset.catjamView = "library"; // so refreshNowPlaying knows it owns the host (vs cache/editor)
  host.textContent = "";

  const heading = document.createElement("h2");
  heading.className = "TypeElement-cello-textBase-type";
  heading.textContent = "Lyricat Library";

  const removal = buildRemovalWidget(host);

  const toggle = whitelistButton(
    whitelistShowFull ? "Show current song" : "Show full list",
    () => {
      whitelistShowFull = !whitelistShowFull;
      renderWhitelistInto(host);
    }
  );
  const refresh = whitelistButton("Refresh", () => renderWhitelistInto(host));
  // Bulk-upgrade every rough "preview" BPM to a real provider value, spending the
  // remaining daily API budget across the rate-limited providers.
  const sync = whitelistButton("Sync BPM via API", () => {
    if (!backfillPreview) return;
    sync.disabled = true;
    sync.textContent = "Syncing…";
    void backfillPreview((doneN, total) => {
      sync.textContent = `Syncing… ${doneN}/${total}`;
    })
      .then((r) => {
        let msg: string;
        if (r.noKey) msg = "Lyricat: add a RapidAPI key in settings first";
        else if (r.candidates === 0) msg = "Lyricat: nothing to sync — no preview or unsourced BPMs";
        else {
          msg = `Lyricat: synced ${r.updated}/${r.candidates} entries (${r.spent} API calls used)`;
          if (r.budgetExhausted) msg += " — daily API budget reached; run again tomorrow for the rest";
        }
        Spicetify.showNotification(msg, r.noKey);
      })
      .finally(() => renderWhitelistInto(host)); // redraw with upgraded values + reset the button
  });
  // Probe: does Spotify's internal audio-analysis endpoint still return data in THIS
  // client? (It's deprecated/blocked for many setups.) Reports segment count or failure
  // so we know whether the visualizer-driven pulse features are viable before building them.
  const probe = whitelistButton("Test audio analysis", () => {
    const pid = spotifyIdFromUri(Spicetify.Player.data?.item?.uri);
    if (!pid) {
      Spicetify.showNotification("Lyricat: play a track first", true);
      return;
    }
    const cosmos = (Spicetify as unknown as { CosmosAsync?: { get(u: string): Promise<unknown> } }).CosmosAsync;
    if (!cosmos?.get) {
      Spicetify.showNotification("Lyricat: CosmosAsync unavailable in this client", true);
      return;
    }
    probe.disabled = true;
    probe.textContent = "Testing…";
    void fetchAudioAnalysis(pid, (u: string) => cosmos.get(u))
      .then((a) => {
        Spicetify.showNotification(
          a
            ? `Lyricat: audio analysis OK — ${a.segments.length} segments, ${a.beats.length} beats (visualizer pulse is viable)`
            : "Lyricat: audio analysis unavailable — endpoint deprecated/blocked for this client",
          !a
        );
      })
      .finally(() => {
        probe.disabled = false;
        probe.textContent = "Test audio analysis";
      });
  });
  // Open the LRC cache browser (replaces the library view; its Back button returns here).
  const lyricCache = whitelistButton("Lyric cache", () => void renderLyricCacheInto(host));
  const toggleRow = document.createElement("div");
  toggleRow.append(toggle, refresh, sync, probe, lyricCache);
  // In full-list view, offer a filter/sort by BPM source (the list is always grouped by
  // source; the dropdown narrows it to one). Sits next to the "Show current song" button.
  if (whitelistShowFull) toggleRow.append(buildSourceFilter(host));

  host.append(heading, removal, toggleRow);

  if (whitelistShowFull) {
    host.append(sectionLabel("Song Library"));
    const pre = document.createElement("pre");
    pre.textContent = fullListText(whitelistSourceFilter);
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

  const credit = buildGetSongBpmCredit(); // mandatory GetSongBPM attribution, when used
  if (credit) host.append(credit);
}

/** Resolve the current track's bpm and refresh the preview to show it. */
async function refreshNowPlaying(): Promise<void> {
  const uri = Spicetify.Player.data?.item?.uri;
  const id = spotifyIdFromUri(uri);
  nowPlayingBpm = { id: id ?? "" };
  // Only re-render the host when the LIBRARY owns it — not when the lyric cache or the editor is
  // showing there (those share this host; re-rendering would clobber them, e.g. the auto-loaded
  // editor on a song skip).
  const ownsLibrary = (h: HTMLElement | null): h is HTMLElement => !!h && h.dataset.catjamView !== "cache" && h.dataset.catjamView !== "editor";
  let host = document.getElementById(WHITELIST_VIEW_ID);
  if (ownsLibrary(host)) renderWhitelistInto(host); // reflect the new track (may show "detecting…")
  mountNpvControls(); // reflect the new track in the compact sidebar panel
  if (!id || !analyze) return;
  const a = await analyze(uri!);
  if (spotifyIdFromUri(Spicetify.Player.data?.item?.uri) !== id) return; // track changed
  nowPlayingBpm = { id, bpm: a?.tempoBpm ?? undefined };
  host = document.getElementById(WHITELIST_VIEW_ID);
  if (ownsLibrary(host)) renderWhitelistInto(host);
  mountNpvControls(); // update the compact panel once BPM resolves
}

/** Inject the preview as a sibling right after the Lyricat settings section. */
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
      patchGetSongBpmKeyLabel(); // make the "(getsongbpm.com/api)" label fragment a real link
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

// Auto-anchor the Lyricat MINIPLAYER in the right now-playing sidebar (we no longer scroll to the
// Spicy Lyrics card, whose position Spicy moves around). Canvas (the looping video above) may scroll
// out of view — that's fine — but we must NOT scroll while it's still loading or it gets torn down
// and never rendered. So we wait for it to settle, then snap once, instantly (no smooth-scroll churn).
const SPICY_LYRICS_CARD_ID = "SpicyLyricsNPVCard";
const NPV_CONTROLS_ID = "catjam-npv-controls";
// False during boot → the NPV panel renders the loading animation; flipped true once the extension
// has finished booting (end of main), after which the panel renders the real per-song controls.
let lyricatReady = false;
let npvAnchorObserver: MutationObserver | null = null;
let npvAnchorTimer: ReturnType<typeof setTimeout> | null = null;

/** Nearest actually-scrolling ancestor of `el` (the sidebar's scroll viewport). Spotify 1.3.5 wraps
 *  the now-playing view in an OverlayScrollbars viewport (`data-overlayscrollbars-viewport` / `.os-viewport`)
 *  whose computed overflow is `hidden` yet still scrolls via scrollTop — so accept ANY non-`visible`
 *  overflow with overflowing content, and treat a tagged OS viewport as scrollable regardless. */
function scrollableAncestor(el: HTMLElement): HTMLElement | null {
  let node = el.parentElement;
  while (node) {
    const overflowing = node.scrollHeight > node.clientHeight + 1;
    const isOsViewport = node.hasAttribute("data-overlayscrollbars-viewport") || node.classList.contains("os-viewport");
    if (overflowing && (isOsViewport || getComputedStyle(node).overflowY !== "visible")) return node;
    node = node.parentElement;
  }
  return null;
}

/** Snap the sidebar so the Lyricat miniplayer's BOTTOM lines up with the bottom of the scroll
 *  viewport — a stable anchor we own (independent of the lyrics card). Bails until it's mounted. */
function anchorNpvPanel(): void {
  const panel = document.getElementById(NPV_CONTROLS_ID);
  if (!panel) return;
  const scroller = scrollableAncestor(panel);
  if (!scroller) return;
  const p = panel.getBoundingClientRect();
  const s = scroller.getBoundingClientRect();
  if (!s.height || !p.height) return;
  const MARGIN = 8; // a small gap below the panel
  const target = scroller.scrollTop + (p.bottom - s.bottom) + MARGIN; // panel bottom → viewport bottom
  scroller.scrollTo({ top: Math.max(0, target), behavior: "auto" }); // instant snap
}

/**
 * Anchor as soon as our (always-present) panel is in the DOM — no Canvas-ready buffer. The old
 * multi-second Canvas-wait cap delayed the scroll by ~3s whenever Canvas was off; we just wait for
 * our own element, with a short safety ceiling. Debounced so overlapping song-changes don't stack.
 */
function anchorNpvSoon(): void {
  if (npvAnchorTimer !== null) clearTimeout(npvAnchorTimer);
  const start = Date.now();
  const poll = (): void => {
    if (document.getElementById(NPV_CONTROLS_ID) || Date.now() - start > 1500) {
      npvAnchorTimer = null;
      anchorNpvPanel();
    } else {
      npvAnchorTimer = setTimeout(poll, 60);
    }
  };
  // Short debounce (NOT the old multi-second Canvas gate): while lyrics load, Spicy removes/re-adds its
  // card rapidly, so anchorNpvSoon gets called in bursts — coalesce them into ONE snap once things go
  // quiet for ~180ms, instead of scrolling on every flicker (which blinked between lyrics and player).
  npvAnchorTimer = setTimeout(poll, 180);
}

/**
 * Mount the miniplayer + anchor the sidebar when the now-playing view first opens. The lyrics card's
 * presence is a cheap "sidebar is open" signal (the scroll TARGET is the miniplayer, not the card);
 * the observer only acts on that presence flipping, so the callback stays cheap.
 */
// Debounced re-anchor: mount the panel if missing and relocate it above "Related music videos" once
// that section loads (it loads lazily, after the initial mount). Coalesces the DOM-mutation burst.
let npvRelocateTimer: ReturnType<typeof setTimeout> | null = null;
function scheduleNpvRelocate(): void {
  if (npvRelocateTimer !== null) return;
  npvRelocateTimer = setTimeout(() => {
    npvRelocateTimer = null;
    mountNpvControls(false); // reposition only; don't re-render content on every DOM tick
  }, 200);
}

function setupNpvAnchor(): void {
  let present = !!document.getElementById(SPICY_LYRICS_CARD_ID);
  if (present) {
    mountNpvControls();
    anchorNpvSoon();
  }
  npvAnchorObserver?.disconnect();
  npvAnchorObserver = new MutationObserver(() => {
    const card = document.getElementById(SPICY_LYRICS_CARD_ID);
    if (card) scheduleNpvRelocate(); // mount if missing + relocate above Related videos when it appears
    if (card && !present) anchorNpvSoon(); // sidebar just opened → anchor the miniplayer
    present = !!card;
  });
  npvAnchorObserver.observe(document.body, { childList: true, subtree: true });
}

// Spotify's "Related music videos" now-playing section — a STABLE anchor for the compact panel,
// unlike the Spicy Lyrics card whose position Spicy moves around (it recently started rendering
// above the lyrics line). Finds the NPV section header with that title and returns its section.
function relatedVideosSection(): HTMLElement | null {
  const inNpv = (el: Element): boolean =>
    !!el.closest("[class*='nowPlayingView'], [class*='NowPlayingView'], aside");
  const heads = document.querySelectorAll<HTMLElement>(
    "[class*='ectionHeader'], [role='heading'], h1, h2, h3"
  );
  for (const h of heads) {
    if (/^\s*related music videos/i.test(h.textContent ?? "") && inNpv(h)) {
      // The SPECIFIC section wrapper — NOT the whole NowPlayingView container. Matching `NowPlayingView`
      // grabbed the entire sidebar after a Spotify update, dropping the panel at the very top. If the
      // candidate swallows the lyrics card, it's too broad → fall back to the heading's own block.
      let section = h.closest<HTMLElement>("[class*='nowPlayingView-section'], section") ?? h.parentElement;
      if (section?.querySelector?.(`#${SPICY_LYRICS_CARD_ID}`)) section = h.parentElement;
      if (section?.parentElement) return section;
    }
  }
  return null;
}

// A compact per-song Lyricat panel: BPM (with arrows), meter, and sync delay — for quick edits
// without opening full settings. Anchored ABOVE "Related music videos" (stable), falling back to
// under the Spicy Lyrics card when that section isn't present.
function mountNpvControls(forceRender = true): void {
  const section = relatedVideosSection();
  let panel = document.getElementById(NPV_CONTROLS_ID) as HTMLElement | null;

  if (panel) {
    // Already mounted. Only ever UPGRADE its spot to just-above "Related music videos" — NEVER move it
    // back to the lyrics-card fallback when that section momentarily vanishes during lyric loading.
    // (Moving it both ways on every flicker is what blinked the panel between the lyrics and player.)
    if (section?.parentElement && panel.nextSibling !== section) {
      section.parentElement.insertBefore(panel, section);
    }
    if (forceRender) renderNpvControls(panel); // refresh content only when asked (song change / BPM resolve)
    return;
  }

  // Fresh mount: above Related videos if present, else under the lyrics card until it loads.
  let parent: HTMLElement | null = null;
  let before: Node | null = null;
  if (section?.parentElement) {
    parent = section.parentElement;
    before = section;
  } else {
    const card = document.getElementById(SPICY_LYRICS_CARD_ID);
    if (card?.parentElement) {
      parent = card.parentElement;
      before = card.nextSibling;
    }
  }
  if (!parent) return;
  panel = document.createElement("div");
  panel.id = NPV_CONTROLS_ID;
  panel.setAttribute(
    "style",
    "box-sizing: border-box; overflow: hidden; margin: 6px 16px; padding: 8px 14px; border-radius: 8px; " +
      "background: var(--spice-card, rgba(255,255,255,.06)); color: var(--spice-text, #fff); font-size: 12px;"
  );
  parent.insertBefore(panel, before);
  renderNpvControls(panel);
}

// A self-rendered Lyricat panel (global settings + the full Library), opened from the
// sidebar link. It does NOT use spcr-settings, so it works even when Spotify's settings
// page can't be injected into (e.g. a Spotify build newer than Spicetify supports).
const CATJAM_OVERLAY_ID = "catjam-overlay";
let showCatJamPanel: (() => void) | undefined; // set in main()
let showLyricEditorForCurrent: (() => void) | undefined; // open the panel + jump to the current track's editor; set in main()

/** One global-settings control, declared so both the panel and (native) spcr-settings
 *  can drive the same stored field. */
type SettingCtl =
  | { kind: "dropdown"; field: string; label: string; options: readonly string[]; onChange?: () => void }
  | { kind: "text"; field: string; label: string }
  | { kind: "number"; field: string; label: string; min?: string; max?: string; step?: string }
  | { kind: "toggle"; field: string; label: string; onChange?: () => void }
  | { kind: "button"; label: string; text: string; onClick: () => void };

/** Render the global settings controls into `host`, wired to the same stored fields
 *  (via settings.get/setFieldValue) the native settings would use. */
function renderSettingsInto(host: HTMLElement, schema: readonly SettingCtl[]): void {
  host.textContent = "";
  const rowStyle =
    "display:flex; align-items:center; justify-content:space-between; gap:12px; padding:7px 0; " +
    "border-bottom:1px solid var(--spice-card,rgba(255,255,255,.07));";
  for (const c of schema) {
    const row = document.createElement("div");
    row.setAttribute("style", rowStyle);
    if (c.kind === "button") {
      const lbl = document.createElement("span");
      lbl.textContent = c.label;
      lbl.setAttribute("style", "opacity:.8; font-size:13px; flex:1 1 auto;");
      row.append(lbl, whitelistButton(c.text, c.onClick));
      host.append(row);
      continue;
    }
    const lbl = document.createElement("label");
    lbl.textContent = c.label;
    lbl.setAttribute("style", "opacity:.85; font-size:13px; flex:1 1 auto;");
    row.append(lbl);
    if (c.kind === "toggle") {
      const cb = document.createElement("input");
      cb.type = "checkbox";
      cb.checked = settings.getFieldValue(c.field) === true;
      cb.setAttribute("style", "width:18px; height:18px; cursor:pointer; flex:0 0 auto;");
      cb.onchange = () => {
        settings.setFieldValue(c.field, cb.checked);
        c.onChange?.();
      };
      row.append(cb);
    } else if (c.kind === "dropdown") {
      const sel = document.createElement("select");
      sel.setAttribute("style", `${FIELD_STYLE} cursor:pointer; flex:0 0 auto; max-width:55%;`);
      const cur = String(settings.getFieldValue(c.field) ?? c.options[0]);
      for (const o of c.options) {
        const opt = document.createElement("option");
        opt.value = o;
        opt.textContent = o;
        if (o === cur) opt.selected = true;
        sel.append(opt);
      }
      sel.onchange = () => {
        settings.setFieldValue(c.field, sel.value);
        c.onChange?.();
      };
      row.append(sel);
    } else {
      const inp = document.createElement("input");
      inp.type = c.kind === "number" ? "number" : "text";
      if (c.kind === "number") {
        if (c.min) inp.min = c.min;
        if (c.max) inp.max = c.max;
        if (c.step) inp.step = c.step;
      }
      inp.value = String(settings.getFieldValue(c.field) ?? "");
      inp.setAttribute("style", `${FIELD_STYLE} flex:0 0 auto; width:${c.kind === "number" ? "90px" : "230px"}; max-width:55%;`);
      inp.onchange = () => settings.setFieldValue(c.field, inp.value);
      row.append(inp);
    }
    host.append(row);
  }
}

/** Render the compact per-song controls (BPM ± / meter / delay / source subtext). */
function renderNpvControls(panel: HTMLElement): void {
  if (!lyricatReady) {
    renderNpvLoading(panel); // still booting → show the loading animation in place of the controls
    return;
  }
  const uri = Spicetify.Player.data?.item?.uri;
  const id = spotifyIdFromUri(uri);
  panel.textContent = "";
  if (!id) {
    panel.style.display = "none";
    return;
  }
  panel.style.display = "block";
  const o = getOverride(overridesStore, id);
  // "BPM" here is the *felt* tempo the cat bounces at = raw ÷ meter, so it matches the
  // card and the meter row. Edits set the felt; the raw stored value is felt × meter.
  const rawBpm = o?.bpm ?? o?.detectedBpm ?? (nowPlayingBpm.id === id ? nowPlayingBpm.bpm : undefined);
  const divisor = o?.doubleTime ?? 1;
  const feltBpm = rawBpm != null ? round1(rawBpm / divisor) : undefined;
  const apply = () => catController?.onSongChange(uri!, playerState());
  const rerender = () => {
    apply();
    void refreshNowPlaying();
    renderNpvControls(panel);
  };

  const mk = (tag: string, style: string, text?: string): HTMLElement => {
    const e = document.createElement(tag);
    if (style) e.setAttribute("style", style);
    if (text != null) e.textContent = text;
    return e;
  };
  const btn = "min-width:22px; height:21px; padding:0 7px; border-radius:6px; cursor:pointer; " +
    "border:1px solid var(--spice-button-disabled,#555); background:transparent; color:var(--spice-text,#fff); font-size:14px; line-height:1;";
  const field = "padding:2px 6px; border-radius:6px; border:1px solid var(--spice-button-disabled,#555); " +
    "background:var(--spice-main,rgba(0,0,0,.3)); color:var(--spice-text,#fff);";
  const rowStyle = "display:flex; align-items:center; gap:6px; margin-bottom:5px;";
  const lblStyle = "opacity:.7; width:42px; flex:0 0 auto;";

  // Header: the "Lyricat" label plus a link that opens the full settings + Library.
  const header = mk("div", "display:flex; align-items:center; justify-content:space-between; margin-bottom:5px;");
  header.append(mk("div", "font-weight:700; font-size:11px; letter-spacing:.05em; text-transform:uppercase; opacity:.65;", "Lyricat"));
  const link = mk(
    "button",
    "background:transparent; border:none; cursor:pointer; color:var(--spice-text,#fff); opacity:.55; padding:2px; line-height:0;"
  ) as HTMLButtonElement;
  link.title = "Open Lyricat settings + Library";
  link.setAttribute("aria-label", "Open Lyricat settings and Library");
  link.innerHTML =
    '<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" ' +
    'stroke-linecap="round" stroke-linejoin="round"><path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"/>' +
    '<polyline points="15 3 21 3 21 9"/><line x1="10" y1="14" x2="21" y2="3"/></svg>';
  link.onmouseenter = () => (link.style.opacity = "1");
  link.onmouseleave = () => (link.style.opacity = ".55");
  link.onclick = () => showCatJamPanel?.();
  // A "lyric editor" link next to the settings link: jumps straight to this song's editor.
  const lyricLink = mk(
    "button",
    "background:transparent; border:none; cursor:pointer; color:var(--spice-text,#fff); opacity:.55; padding:2px; line-height:0;"
  ) as HTMLButtonElement;
  lyricLink.title = "Open the lyric editor for this song";
  lyricLink.setAttribute("aria-label", "Open lyric editor");
  lyricLink.innerHTML =
    '<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" ' +
    'stroke-linecap="round" stroke-linejoin="round"><line x1="4" y1="7" x2="20" y2="7"/>' +
    '<line x1="4" y1="12" x2="14" y2="12"/><line x1="4" y1="17" x2="18" y2="17"/></svg>';
  lyricLink.onmouseenter = () => (lyricLink.style.opacity = "1");
  lyricLink.onmouseleave = () => (lyricLink.style.opacity = ".55");
  lyricLink.onclick = () => showLyricEditorForCurrent?.();
  const links = mk("div", "display:flex; align-items:center; gap:10px;");
  links.append(lyricLink, link);
  header.append(links);
  panel.append(header);

  // BPM (felt): −/+ arrows around an editable value.
  const bpmRow = mk("div", rowStyle);
  bpmRow.append(mk("span", lblStyle, "BPM"));
  if (feltBpm == null) {
    bpmRow.append(mk("span", "opacity:.6;", "detecting…"));
  } else {
    const setFelt = (felt: number): void => {
      if (felt > 0 && Number.isFinite(felt)) {
        if (o?.detectedBpm === undefined && nowPlayingBpm.id === id && nowPlayingBpm.bpm) {
          setDetectedBpm(overridesStore, id, nowPlayingBpm.bpm); // preserve the auto value
        }
        setStoredBpm(overridesStore, id, round1(felt * divisor)); // store the raw; meter re-divides
        recordName(uri, id);
      } else {
        clearStoredBpm(overridesStore, id);
      }
      rerender();
    };
    const dec = mk("button", btn, "–") as HTMLButtonElement;
    const inc = mk("button", btn, "+") as HTMLButtonElement;
    const input = mk("input", `width:64px; text-align:center; ${field}`) as HTMLInputElement;
    input.type = "number";
    input.step = "0.1";
    input.min = "0";
    input.value = String(feltBpm);
    dec.onclick = () => setFelt(round1(feltBpm - 1));
    inc.onclick = () => setFelt(round1(feltBpm + 1));
    input.onchange = () => setFelt(Number(input.value));
    bpmRow.append(dec, input, inc);
  }
  panel.append(bpmRow);

  // Meter selection (Auto / Detect / manual cuts), with a reset when detected.
  const meterRow = mk("div", rowStyle);
  meterRow.append(mk("span", lblStyle, "Meter"));
  const meterSelect = mk(
    "select",
    `flex:1 1 0; min-width:0; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; cursor:pointer; ${field}`
  ) as HTMLSelectElement;
  // Show the concrete meter in use: "Detected ÷N" only for a real (non-4/4) detected
  // meter; a manual cut selects its divisor; common time / undetected reads as raw 1×.
  const currentMeter = o?.meterDetected
    ? "detected"
    : o?.doubleTime !== undefined
      ? String(o.doubleTime)
      : "1";
  for (const m of METER_OPTIONS) {
    const opt = document.createElement("option");
    opt.value = m.value;
    opt.textContent = m.label;
    if (m.value === currentMeter) opt.selected = true;
    meterSelect.appendChild(opt);
  }
  if (o?.meterDetected) {
    (meterSelect.children[0] as HTMLOptionElement).textContent =
      `Meter: Detected ÷${o.doubleTime}${o.timeSignature ? ` (${o.timeSignature}/4)` : ""}`;
  }
  meterSelect.onchange = () => {
    const choice = meterSelect.value;
    if (choice === "detected") {
      if (!detectMeter) return;
      setMeterForTrack(id, uri, "detected"); // clear any manual cut first
      meterSelect.disabled = true;
      void detectMeter(uri!).then((divisor) => {
        Spicetify.showNotification(
          divisor && divisor > 1
            ? `Lyricat: meter detected — ÷${divisor}`
            : "Lyricat: no cut needed — bouncing per beat"
        );
        rerender();
      });
      return;
    }
    setMeterForTrack(id, uri, choice);
    rerender();
  };
  meterRow.append(meterSelect);
  panel.append(meterRow);

  // Sync delay slider (0–500ms).
  const delayRow = mk("div", rowStyle);
  delayRow.append(mk("span", lblStyle, "Delay"));
  const slider = mk("input", "flex:1 1 0; min-width:0;") as HTMLInputElement;
  slider.type = "range";
  slider.min = "0";
  slider.max = String(MAX_DELAY_MS);
  slider.step = "10";
  slider.value = String(o?.delayMs ?? 0);
  const dval = mk("span", "opacity:.7; width:46px; text-align:right; flex:0 0 auto;", `${o?.delayMs ?? 0}ms`);
  slider.oninput = () => {
    const c = clampDelay(Number(slider.value) || 0);
    dval.textContent = `${c}ms`;
    setDelayMs(overridesStore, id, c);
    recordName(uri, id);
    apply(); // live-apply during the drag; full rerender on release
  };
  slider.onchange = () => rerender();
  delayRow.append(slider, dval);
  panel.append(delayRow);

  // Source subtext (terse — wraps rather than overflowing the narrow column).
  panel.append(
    mk("div", "opacity:.55; font-size:10px; line-height:1.3; margin-top:1px; white-space:normal; overflow-wrap:anywhere;", bpmSourceShort(o))
  );
}

/** Common cat-element setup. A 2-frame image source (Pop Cat) mounts an <img>
 *  whose frame the pulse swaps; every other source mounts a looping <video>.
 *  Style is set by the caller. */
function makeCatVideo(id: string): CatMedia {
  // Click the cat (or its mirror) to cycle the source. Wrappers are pointer-events:
  // none; the style strings re-enable pointer-events on the element itself.
  const onClick = (e: Event) => {
    e.preventDefault();
    e.stopPropagation();
    cycleVideoSource?.();
  };
  const cfg = getConfig();
  if (cfg.frames) {
    const img = document.createElement("img");
    img.id = id;
    img.src = cfg.frames.closed;
    img.setAttribute("aria-hidden", "true");
    img.title = "Lyricat: click to change the cat";
    img.addEventListener("click", onClick);
    return img;
  }
  const video = document.createElement("video");
  video.id = id;
  video.loop = true;
  video.muted = true;
  video.playsInline = true;
  video.preload = "auto";
  video.setAttribute("aria-hidden", "true");
  video.src = cfg.videoUrl;
  video.title = "Lyricat: click to change the cat";
  video.addEventListener("click", onClick);
  return video;
}

/** Per-source render scale (Pop Cat renders smaller than the shared size). */
function catSizeScale(): number {
  return currentSource() === VIDEO_SOURCES.POP ? POP_SIZE_SCALE : 1;
}

/** The bottom-player cat's pixel size for the current source. */
function catPx(): number {
  return Math.round(CAT_PX * catSizeScale());
}

/** The main cat's own style inside the wrapper (size + rest transform offset). */
function mainCatStyle(isBottomPlayer: boolean): string {
  const offset = positionTransform();
  const t = offset ? ` transform: ${offset};` : "";
  // pointer-events:auto re-enables clicking the cat (the wrapper is none) to cycle sources.
  const clickable = " pointer-events: auto; cursor: pointer;";
  // Preserve aspect ratio: <video> defaults to contain, but <img> defaults to fill
  // (which stretched the non-square Bongo frames into the square box).
  const fit = " object-fit: contain;";
  const scale = catSizeScale();
  return isBottomPlayer
    ? `width: ${Math.round(CAT_PX * scale)}px; height: ${Math.round(CAT_PX * scale)}px; display: block;${t}${clickable}${fit}`
    : `width: ${Math.round(100 * scale)}%; height: auto; display: block;${t}${clickable}${fit}`;
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
function mountMirror(main: CatMedia): CatMedia | null {
  document.getElementById(MIRROR_ID)?.remove();
  reanchorMirror = null;
  if (!mirrorEnabled()) return null;
  const mirror = makeCatVideo(MIRROR_ID);

  if (isBottomPlayerPosition()) {
    // Its own top-level overlay, mirrored across the play button from the main —
    // fully dynamic (tracks the transport, flexes with the window), no fixed gap.
    mirror.setAttribute(
      "style",
      `position: fixed; pointer-events: auto; cursor: pointer; z-index: 9999; width: ${catPx()}px; height: ${catPx()}px; display: block; object-fit: contain; transform: ${mirrorBaseTransform()};`
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
      `width: ${Math.round(100 * catSizeScale())}%; height: auto; object-fit: contain; ${mirrorPlacement()} transform: ${mirrorBaseTransform()}; pointer-events: auto; cursor: pointer;`
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
  console.log("[LYRICAT] Waiting for player UI via observer...");
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
  return Math.round(r.top + r.height / 2 - catPx() / 2);
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
    console.warn("[LYRICAT] mirror: transport not found; can't anchor");
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
async function mountVideo(): Promise<CatMedia | null> {
  document.getElementById(WRAP_ID)?.remove();
  document.getElementById(VIDEO_ID)?.remove(); // stray (older builds inserted the bare video)
  document.getElementById(MIRROR_ID)?.remove();
  reanchorOverlay = null;

  const isBottomPlayer = isBottomPlayerPosition();
  const container = await waitForElement(
    isBottomPlayer ? BOTTOM_PLAYER_SELECTOR : LEFT_LIBRARY_SELECTOR
  );
  if (!container) {
    console.warn("[LYRICAT] Player container not found; cat-jam disabled cleanly.");
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

// The Lyricat NPV panel's LOADING state (shown until `lyricatReady`): a geometric cat that assembles.
// Each shape = a .slot (horizontal glide) wrapping a .bob (vertical SEPARATION + ^v wave). ENTRY: the
// shapes glide in from the LEFT, separated (ears lifted, base dropped) and riding a ^v wave, the
// separation closing to 0 as they CONVERGE and TOUCH into the logo. HOLD ~1s. EXIT: the exact reverse
// of the entry — they glide back out to the LEFT while the separation simply re-opens (they SEPARATE),
// with NO wave. Separation-closes-to-0-at-hold guarantees they touch without ever overlapping.
function injectLyricatLoaderStyle(): void {
  if (document.getElementById("lyricat-loader-style")) return;
  // sepSign: +1 drops (base), −1 lifts (ears). weSign: entry wave phase (+1 = down first). Exit: no wave.
  const wave = (name: string, amp: number, sep: number, arrive: number, sepSign: number, weSign: number): string => {
    const cyc = 1.5;
    const N = 15;
    const pt = (i: number, a: number, b: number, entry: boolean): string => {
      const f = i / N;
      const grow = entry ? 1 - f : f; // separation: max off-frame, 0 at the hold (touch)
      const y = sepSign * sep * grow + (entry ? weSign * amp * grow * Math.sin(2 * Math.PI * cyc * f) : 0);
      return `${(a + (b - a) * f).toFixed(1)}%{transform:translateY(${y.toFixed(2)}px)}`;
    };
    let s = `@keyframes ${name}{`;
    for (let i = 0; i <= N; i++) s += pt(i, 0, arrive, true); // entry: converge in (sep closes + wave)
    s += `${arrive}.01%{transform:translateY(0)}66%{transform:translateY(0)}`; // hold (touch)
    for (let i = 0; i <= N; i++) s += pt(i, 66, 100, false); // exit: separate (sep re-opens, no wave)
    return s + `}`; // loops seamlessly: 100% (off-left, separated) == 0% (off-left, separated)
  };
  const DUR = 2.6;
  const style = document.createElement("style");
  style.id = "lyricat-loader-style";
  style.textContent =
    `.lyricat-load{position:relative;overflow:hidden;height:72px;color:var(--spice-text,#fff)}` +
    `.lyricat-load .slot{position:absolute;left:50%}.lyricat-load .bob,.lyricat-load svg{display:block}` +
    // locked (hold) geometry: ears' base sits exactly on the face's top edge → they TOUCH
    `.lyricat-load .face{margin-left:-24px;top:22px;animation:lyricat-x-face ${DUR}s infinite}` +
    `.lyricat-load .ear-l{margin-left:-20px;top:13px;animation:lyricat-x-ear-l ${DUR}s infinite}` +
    `.lyricat-load .ear-r{margin-left:2px;top:13px;animation:lyricat-x-ear-r ${DUR}s infinite}` +
    `.lyricat-load .face .bob{animation:lyricat-y-face ${DUR}s linear infinite}` +
    `.lyricat-load .ear-l .bob{animation:lyricat-y-ear-l ${DUR}s linear infinite}` +
    `.lyricat-load .ear-r .bob{animation:lyricat-y-ear-r ${DUR}s linear infinite}` +
    // glide IN from the left (ease-out), hold, then OUT back to the left (ease-in) — exit reverses entry
    `@keyframes lyricat-x-face{0%{transform:translateX(-234px);animation-timing-function:cubic-bezier(.16,.72,.3,1)}36%{transform:translateX(0);animation-timing-function:linear}66%{transform:translateX(0);animation-timing-function:cubic-bezier(.62,.04,.78,.35)}100%{transform:translateX(-234px)}}` +
    `@keyframes lyricat-x-ear-l{0%{transform:translateX(-214px);animation-timing-function:cubic-bezier(.2,.78,.3,1)}34%{transform:translateX(0);animation-timing-function:linear}66%{transform:translateX(0);animation-timing-function:cubic-bezier(.55,.05,.78,.4)}100%{transform:translateX(-214px)}}` +
    `@keyframes lyricat-x-ear-r{0%{transform:translateX(-242px);animation-timing-function:cubic-bezier(.24,.82,.3,1)}33%{transform:translateX(0);animation-timing-function:linear}66%{transform:translateX(0);animation-timing-function:cubic-bezier(.5,.06,.78,.45)}100%{transform:translateX(-242px)}}` +
    //                          amp  sep  arrive  sepSign  weSign(entry)
    wave("lyricat-y-face", /**/ 4, /*  */ 5, /* */ 36, /*  */ 1, /*  */ -1) + // base: drops; ^v^ on entry
    wave("lyricat-y-ear-l", /* */ 2.5, /**/ 9, /* */ 34, /* */ -1, /*  */ 1) + // inner ear: lifts; v^v on entry
    wave("lyricat-y-ear-r", /* */ 3, /*  */ 9, /* */ 33, /* */ -1, /*  */ 1) + // far ear: lifts a touch more
    `@media (prefers-reduced-motion:reduce){.lyricat-load .slot,.lyricat-load .bob{animation:none;transform:none}}`;
  document.head.appendChild(style);
}

// Hollow outline shapes: a reference-style pentagon face + two slightly out-leaning ears.
const LYRICAT_SHAPE_SVG: Record<string, string> = {
  face: '<svg width="48" height="42" viewBox="0 0 48 42"><polygon points="13,6 35,6 46,19 24,39 2,19" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linejoin="round"/></svg>',
  earL: '<svg width="18" height="17" viewBox="0 0 18 17"><polygon points="5,2 15,15 1,15" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linejoin="round"/></svg>',
  earR: '<svg width="18" height="17" viewBox="0 0 18 17"><polygon points="13,2 17,15 3,15" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linejoin="round"/></svg>',
};

/** Render the Lyricat panel's loading animation (clipped to its own stage) in place of the controls. */
function renderNpvLoading(panel: HTMLElement): void {
  injectLyricatLoaderStyle();
  panel.textContent = "";
  panel.style.display = "block";
  const header = document.createElement("div");
  header.setAttribute("style", "font-weight:700; font-size:11px; letter-spacing:.05em; text-transform:uppercase; opacity:.55; margin-bottom:6px;");
  header.textContent = "Lyricat";
  const stage = document.createElement("div");
  stage.className = "lyricat-load"; // its own clipping rectangle — shapes never leave the panel
  stage.setAttribute("style", "position:relative; overflow:hidden; height:72px; color:var(--spice-text,#fff);");
  stage.innerHTML =
    `<div class="slot ear-r"><div class="bob">${LYRICAT_SHAPE_SVG.earR}</div></div>` +
    `<div class="slot ear-l"><div class="bob">${LYRICAT_SHAPE_SVG.earL}</div></div>` +
    `<div class="slot face"><div class="bob">${LYRICAT_SHAPE_SVG.face}</div></div>`;
  const sub = document.createElement("div");
  sub.setAttribute("style", "font-size:10px; opacity:.4; text-align:center; letter-spacing:.14em; text-transform:uppercase; margin-top:2px;");
  sub.textContent = "loading";
  panel.append(header, stage, sub);
}

async function main() {
  while (!Spicetify?.Player?.addEventListener) {
    await sleep(100);
  }
  console.log("[LYRICAT] Extension loaded.");

  // Mount the NPV panel early (loader state) now that Spicetify + the DOM are confirmed ready, so it
  // shows while the rest of the extension boots. Guarded so a transient DOM hiccup can't abort main().
  try {
    setupNpvAnchor();
  } catch (e) {
    console.warn("[LYRICAT] early panel mount skipped:", e);
  }
  setTimeout(() => {
    if (lyricatReady) return;
    lyricatReady = true; // safety: never leave the panel stuck on "loading" if boot stalls
    const p = document.getElementById(NPV_CONTROLS_ID);
    if (p) renderNpvControls(p);
  }, 15000);

  // Spotify removed its own audio-analysis endpoint (Nov 2024); tempo now comes
  // from ReccoBeats. The id lookup covers most tracks; anything it misses falls
  // back to a stored value (from the preview analysis run via the buttons).
  const liveFetch = createAnalysisFetcher((url) => fetch(url), sleep);
  // The ReccoBeats features endpoint accepts a Spotify id *or* an ISRC; this is a
  // non-cached fetch by either (the caller persists the result).
  const featuresFetch = (ids: string) => fetchAnalysisByIsrc((url) => fetch(url), sleep, ids);

  /**
   * Persist a detected value (bpm + provenance + name), so replays skip the APIs.
   * Real-provider results are promoted to the authoritative `bpm` (legitimate);
   * only `preview` scans stay detected-only. See recordDetection.
   */
  const cacheDetected = (id: string, bpm: number, source: BpmSource, uri: string): void => {
    recordDetection(overridesStore, id, bpm, source);
    const label = labelFor(uri);
    if (label) setTrackName(overridesStore, id, label);
  };

  /**
   * Store a track's ISRC *and* its title+artist together, so a track whose BPM never
   * resolves still gets at least a name in the library (no more isrc-only entries).
   * recordName no-ops when the uri isn't the current track (name isn't resolvable then).
   */
  const noteIsrc = (id: string, isrc: string, uri: string): void => {
    setIsrc(overridesStore, id, isrc);
    recordName(uri, id);
  };

  const fetchLike = (url: string, init?: RequestInit) => fetch(url, init);

  /** Optional GetSongBPM lookup (title/artist search) — null without a key or on a miss. */
  const runGetSongBpm = async (
    hint: { title: string; artist?: string } | null
  ): Promise<{ bpm: number; source: BpmSource } | null> => {
    const gs = hint?.title ? providerKey(GETSONGBPM_KEY_FIELD) : "";
    if (!gs) return null;
    const b = await fetchGetSongBpm(fetchLike, gs, hint!.title, hint!.artist);
    return b ? { bpm: b, source: "getsongbpm" } : null;
  };

  // Ids we've already spent a rate-limited call on this session — so a track that
  // isn't in a provider (or has no preview to cache) doesn't re-burn the daily
  // budget every replay. Cleared on reload; the persistent daily cap is the real
  // ceiling. Keyed "<source>:<id>".
  const rateLimitedTried = new Set<string>();

  /**
   * Try one rate-limited provider for a track, honouring its daily budget. Skips
   * (returns null) without a key, when the budget is exhausted, or when already
   * tried this session. Consumes a budget slot only when the request actually
   * reached the provider, so throttling can't sneak past the cap.
   */
  // Low-level: make one budget-guarded provider call and return its raw result
  // (bpm + timeSignature), or null when skipped (no key / budget spent / already
  // tried this session). A slot is consumed only when the request reached the API.
  const callRateLimited = async (
    p: RateLimitedProvider,
    id: string,
    force = false
  ): Promise<ProviderResult | null> => {
    const key = providerKey(RAPIDAPI_KEY_FIELD);
    if (!key) return null;
    const marker = `${p.source}:${id}`;
    if (!force && rateLimitedTried.has(marker)) return null;
    const today = utcDay(new Date());
    if (rateRemaining(overridesStore, p.source, p.dailyLimit, today) <= 0) return null; // budget spent
    const res = await p.fetch(key, id);
    if (res.responded) {
      rateConsume(overridesStore, p.source, today);
      rateLimitedTried.add(marker); // don't re-spend on this track this session
    }
    return res;
  };

  const runRateLimited = async (
    p: RateLimitedProvider,
    id: string,
    force = false // manual re-detect: bypass the session guard, still honour the daily cap
  ): Promise<{ bpm: number; source: BpmSource } | null> => {
    const res = await callRateLimited(p, id, force);
    return res?.bpm ? { bpm: res.bpm, source: p.source } : null;
  };

  /**
   * Keyed BPM providers, last resort before the preview scan: GetSongBPM first
   * (unmetered), then each rate-limited provider in order. Stops at the first hit
   * — once a tempo is derived we don't call the remaining providers.
   */
  const runProviders = async (
    id: string | null,
    hint: { title: string; artist?: string } | null
  ): Promise<{ bpm: number; source: BpmSource } | null> => {
    const gs = await runGetSongBpm(hint);
    if (gs) return gs;
    if (id) {
      for (const p of RATE_LIMITED_PROVIDERS) {
        const hit = await runRateLimited(p, id);
        if (hit) return hit;
      }
    }
    return null;
  };

  // Resolve a track's time signature (beats per bar) for meter detection: ReccoBeats
  // by id, then by ISRC (both free), then the rate-limited providers (Musicae) which
  // also carry it. Also opportunistically caches a BPM if a Musicae call returns one
  // and the track has none yet (one call, both facts). Returns the numerator or null.
  const resolveTimeSignature = async (id: string, uri: string, freeOnly = false): Promise<number | null> => {
    const live = await liveFetch(uri); // ReccoBeats by id (cached)
    if (id && live?.isrc) noteIsrc(id, live.isrc, uri);
    if (live?.timeSignature) return live.timeSignature;
    const hint = nameArtistFor(uri);
    let isrc = getOverride(overridesStore, id)?.isrc ?? live?.isrc ?? null;
    if (!isrc) {
      const resolved = await getIsrc(id, hint);
      if (resolved) {
        isrc = resolved.isrc;
        noteIsrc(id, isrc, uri);
      }
    }
    if (isrc) {
      const byIsrc = await featuresFetch(isrc); // ReccoBeats by ISRC
      if (byIsrc?.timeSignature) return byIsrc.timeSignature;
    }
    if (freeOnly) return null; // auto-default: never burn the rate-limited budget
    for (const p of RATE_LIMITED_PROVIDERS) {
      const res = await callRateLimited(p, id);
      if (res?.bpm && !getOverride(overridesStore, id)?.bpm && !getOverride(overridesStore, id)?.detectedBpm) {
        cacheDetected(id, res.bpm, p.source, uri); // bonus: this call also gave a real BPM
      }
      if (res?.timeSignature) return res.timeSignature;
    }
    return null;
  };

  const resolveAnalysis = async (uri: string): Promise<AnalysisResult | null> => {
    const id = spotifyIdFromUri(uri);
    const o = id ? getOverride(overridesStore, id) : undefined;
    // Backfill a name onto an existing but nameless entry (e.g. legacy isrc-only
    // rows) as it plays — the minimum title+artist, even if nothing else resolves.
    if (id && o && o.name === undefined) recordName(uri, id);
    // 1) Manual override wins; else a cached detected value (any prior detection).
    const effective = o?.bpm ?? o?.detectedBpm;
    if (effective) return { tempoBpm: effective };
    // 2) ReccoBeats id lookup (Spotify's tempo) covers most tracks. Persist it now
    //    (tagged), so subsequent plays reuse it instead of re-hitting ReccoBeats.
    const live = await liveFetch(uri);
    if (id && live?.isrc) noteIsrc(id, live.isrc, uri); // primes the ISRC fallback
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
        noteIsrc(id, isrc, uri);
      }
    }
    if (isrc) {
      const byIsrc = await featuresFetch(isrc);
      if (byIsrc?.tempoBpm) {
        cacheDetected(id, byIsrc.tempoBpm, isrcSource(isrcVia), uri);
        return byIsrc;
      }
    }

    // 4) Keyed providers (last resort before preview): GetSongBPM, then the
    //    rate-limited RapidAPI providers in order. Each is gated on its own key /
    //    daily budget and stops at the first hit.
    const prov = await runProviders(id, hint);
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

  // Detect the current track's meter divisor — an odd time signature, else an octave
  // fold for a double-time tempo — and store it (marks meterDetected for the UI).
  // Returns the applied divisor (1 = raw), or null for a non-track.
  const trackBpm = (id: string): number | undefined => {
    const o = getOverride(overridesStore, id);
    return o?.bpm ?? o?.detectedBpm ?? (nowPlayingBpm.id === id ? nowPlayingBpm.bpm : undefined);
  };
  detectMeter = async (uri) => {
    const id = spotifyIdFromUri(uri);
    if (!id) return null;
    const ts = await resolveTimeSignature(id, uri);
    const divisor = autoMeterDivisor(trackBpm(id), ts);
    if (divisor > 1) {
      setDetectedMeter(overridesStore, id, divisor, isMeterfulTimeSignature(ts) ? ts : undefined);
      const label = labelFor(uri);
      if (label) setTrackName(overridesStore, id, label);
    } else {
      clearDoubleTime(overridesStore, id); // nothing to fold → raw (÷1)
    }
    return divisor;
  };

  // Default-meter driver: for a track with no meter set yet, resolve its felt-tempo
  // divisor — an odd time signature from the *free* providers, else an octave fold for
  // a double-time tempo — and apply it as the Detected meter so the cat bounces at the
  // felt tempo. Common time at a normal tempo stays raw (÷1). Silent, budget-safe,
  // idempotent; a manual override (including 1×) or an already-detected meter is left
  // untouched. The session set stops a raw-resolved track re-hitting the providers.
  const meterAutoTried = new Set<string>();
  autoDetectMeter = async (uri) => {
    const id = spotifyIdFromUri(uri);
    if (!id) return;
    const o = getOverride(overridesStore, id);
    if (o?.doubleTime !== undefined || o?.meterDetected) return; // manual / already detected
    if (meterAutoTried.has(id)) return; // resolved to raw earlier this session
    meterAutoTried.add(id);
    const ts = await resolveTimeSignature(id, uri, true); // free-only
    // Ensure the BPM is resolved (the octave fold needs it); analyze is deduped/cached.
    let bpm = trackBpm(id);
    if (bpm === undefined && analyze) bpm = (await analyze(uri))?.tempoBpm ?? undefined;
    const divisor = autoMeterDivisor(bpm, ts);
    if (divisor <= 1) return; // common time at a normal tempo → raw default (÷1)
    // Re-check: the user may have set a meter, or the track changed, while we waited.
    const now = getOverride(overridesStore, id);
    if (now?.doubleTime !== undefined || now?.meterDetected) return;
    setDetectedMeter(overridesStore, id, divisor, isMeterfulTimeSignature(ts) ? ts : undefined);
    const label = labelFor(uri);
    if (label) setTrackName(overridesStore, id, label);
    // Re-apply to the cat + panels if this is still the playing track.
    if (spotifyIdFromUri(Spicetify.Player.data?.item?.uri) === id) {
      catController?.onSongChange(uri, playerState());
      void refreshNowPlaying();
    }
  };

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
      if (a?.isrc) noteIsrc(id, a.isrc, uri);
      if (a?.tempoBpm) found = { bpm: a.tempoBpm, source: "reccobeats" };
    }
    if (!found && wants("reccobeats-isrc")) {
      let isrc = getOverride(overridesStore, id)?.isrc ?? null;
      let via: IsrcResult["via"] = "spotify";
      if (!isrc) {
        const resolved = await getIsrc(id, hint); // may fall through to MusicBrainz
        if (resolved) ({ isrc, via } = resolved);
      }
      if (isrc) noteIsrc(id, isrc, uri);
      const a = isrc ? await featuresFetch(isrc) : null;
      if (a?.tempoBpm) found = { bpm: a.tempoBpm, source: isrcSource(via) };
    }
    if (!found && wants("getsongbpm")) {
      const prov = await runGetSongBpm(hint);
      if (prov) found = prov;
    }
    for (const p of RATE_LIMITED_PROVIDERS) {
      if (!found && wants(p.source)) {
        const hit = await runRateLimited(p, id, true); // manual: force past the session guard
        if (hit) found = hit;
      }
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

  // Free-provider + rate-limited resolve for the sync, WITHOUT the preview re-scan:
  // ReccoBeats id → ReccoBeats ISRC → GetSongBPM → the rate-limited providers (which
  // no-op once their budget is spent). Returns the first real hit, or null when only
  // a preview-tier value is possible. Mirrors resolveAnalysis' cascade minus preview.
  const resolveForBackfill = async (
    id: string,
    uri: string
  ): Promise<{ bpm: number; source: BpmSource } | null> => {
    const hint = nameArtistFor(uri);
    const live = await liveFetch(uri); // ReccoBeats by id (cached)
    if (live?.isrc) noteIsrc(id, live.isrc, uri);
    if (live?.tempoBpm) return { bpm: live.tempoBpm, source: "reccobeats" };
    let isrc = getOverride(overridesStore, id)?.isrc ?? live?.isrc ?? null;
    let via: IsrcResult["via"] = "spotify";
    if (!isrc) {
      const resolved = await getIsrc(id, hint);
      if (resolved) {
        ({ isrc, via } = resolved);
        noteIsrc(id, isrc, uri);
      }
    }
    if (isrc) {
      const byIsrc = await featuresFetch(isrc); // ReccoBeats by ISRC
      if (byIsrc?.tempoBpm) return { bpm: byIsrc.tempoBpm, source: isrcSource(via) };
    }
    const gs = await runGetSongBpm(hint); // GetSongBPM (free, key-gated)
    if (gs) return gs;
    for (const p of RATE_LIMITED_PROVIDERS) {
      const hit = await runRateLimited(p, id); // budget-respecting; no-op at 0
      if (hit) return hit;
    }
    return null;
  };

  // Sync BPM via API. Upgrades whitelist entries that lack a real provider value —
  // both rough "preview" scans and legacy entries with no recorded source — to a
  // real BPM, spending the remaining rate-limited budget. `preview` entries go
  // straight to the rate-limited providers (their free lookups already missed);
  // unsourced legacy entries first get the free cascade to classify them, and only
  // fall to the API when no real source has them. Stops spending once every
  // provider's daily budget is gone, flagging `budgetExhausted` so the caller can
  // say so. Busts each updated track's dedup entry so it applies without a replay.
  backfillPreview = async (onProgress) => {
    if (!providerKey(RAPIDAPI_KEY_FIELD)) return { candidates: 0, updated: 0, spent: 0, budgetExhausted: false, noKey: true };
    const unsourced = unsourcedBackfillCandidates(overridesStore);
    const preview = previewBackfillCandidates(overridesStore);
    const total = unsourced.length + preview.length;
    const totalRemaining = () =>
      RATE_LIMITED_PROVIDERS.reduce(
        (n, p) => n + rateRemaining(overridesStore, p.source, p.dailyLimit, utcDay(new Date())),
        0
      );
    const remainingBefore = totalRemaining();
    let updated = 0;
    let done = 0;
    let budgetExhausted = false;

    // 1) Legacy unsourced entries: classify via the free cascade; spend API budget
    //    only when no real source has them (resolveForBackfill's rate-limited step).
    for (const id of unsourced) {
      const uri = `spotify:track:${id}`;
      const hadBudget = totalRemaining() > 0;
      const res = await resolveForBackfill(id, uri);
      if (res) {
        cacheDetected(id, res.bpm, res.source, uri); // real source → promoted to authoritative bpm
        inFlight.delete(uri);
        updated++;
      } else {
        const existing = getOverride(overridesStore, id)?.detectedBpm;
        if (existing !== undefined) setDetectedBpm(overridesStore, id, existing, "preview"); // record its origin (detected-only)
        if (!hadBudget) budgetExhausted = true; // couldn't give the API a shot
      }
      onProgress?.(++done, total);
    }

    // 2) Preview entries: spend the remaining budget on the rate-limited providers.
    for (const id of preview) {
      if (totalRemaining() <= 0) {
        budgetExhausted = true;
        onProgress?.(++done, total);
        continue;
      }
      for (const p of RATE_LIMITED_PROVIDERS) {
        const hit = await runRateLimited(p, id); // session-guarded: won't re-hit a track tried this run
        if (hit) {
          cacheDetected(id, hit.bpm, hit.source, `spotify:track:${id}`); // API → authoritative bpm
          inFlight.delete(`spotify:track:${id}`);
          updated++;
          break; // one real value per track; don't spend a second provider's slot
        }
      }
      onProgress?.(++done, total);
    }
    return { candidates: total, updated, spent: remainingBefore - totalRemaining(), budgetExhausted };
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
    catController?.refreshOnsets(); // re-fetch onsets for the current track + reconcile frame mode
  };

  // Best-effort lyric-synced onsets, read from the Spicy Lyrics extension's
  // per-origin lyrics CacheStorage when the user opts in. Returns null (→ beat
  // fallback) when it's off, Spicy Lyrics is absent, or the track isn't cached.
  // Fetch onsets when the lyric-brightness pulse is on, or the source animates its
  // frame off syllables (Pop Cat) — both are driven by the same syllable spans.
  // Spotify's internal audio-analysis segments for the current track (visualizer
  // features). Cached per track; fetched only when a visualizer feature asks for it.
  const cosmosGet = (url: string): Promise<unknown> => {
    const c = (Spicetify as unknown as { CosmosAsync?: { get(u: string): Promise<unknown> } }).CosmosAsync;
    return c?.get ? c.get(url) : Promise.reject(new Error("no CosmosAsync"));
  };
  // Small LRU of parsed analysis, keyed by track id — holds the current track plus a couple
  // prefetched neighbours so a skip to the next track has its segments/beats already warm.
  const analysisCache = new Map<string, AudioAnalysis | null>();
  const ANALYSIS_CACHE_MAX = 4;
  const ensureAnalysis = async (uri: string): Promise<AudioAnalysis | null> => {
    const id = spotifyIdFromUri(uri);
    if (!id) return null;
    if (analysisCache.has(id)) return analysisCache.get(id) ?? null;
    const analysis = await fetchAudioAnalysis(id, cosmosGet);
    analysisCache.set(id, analysis);
    while (analysisCache.size > ANALYSIS_CACHE_MAX) {
      const oldest = analysisCache.keys().next().value as string | undefined;
      if (oldest === undefined) break;
      analysisCache.delete(oldest);
    }
    return analysis;
  };
  getTrackAnalysis = ensureAnalysis; // expose to the word-timing debug overlay

  // Turn parsed Spicy Lyrics into onsets. Word-synced → verbatim; line-synced → our own
  // word-by-word (ownLrcOnsets, built from its lines) so Pop Cat pops per word, not per line.
  const buildOnsets = async (parsed: unknown, uri: string): Promise<PulseOnset[] | null> => {
    const info = lyricSpans(parsed);
    if (!info) return null;
    if (!info.lineLevel) return spansToOnsets(info.lines); // Spicy WORD-synced → verbatim
    return ownLrcOnsets(uri); // Spicy LINE-synced → our OWN word-by-word (from its lines), persisted
  };

  // Our-own-LRC state. `ownLrcMemo` holds the in-flight/last generation per track id, so the
  // several callers (reader, onset path, overlay) share one result instead of regenerating — and
  // a null (nothing produced) is dropped so a later call can retry. `lrclibMissing` stops us
  // re-hitting LRCLIB for a track it has no synced lyrics for.
  const ownLrcMemo = new Map<string, Promise<string | null>>();
  const lrclibMissing = new Set<string>();

  /**
   * Our OWN word-by-word detection for a track Spicy does NOT word-sync, persisted as a word-level
   * LRC. Spicy WORD-synced lyrics are the preceding detector → we use them directly and make no
   * LRC (null). Otherwise we build per-word timing — from Spicy's own LINE-synced lyrics, else an
   * LRCLIB match — via the same path the debug overlay uses, and serialize it. The detection is
   * built from the WHOLE song's lyrics (available upfront), so it's complete the moment it's
   * generated — we commit it to the disk cache immediately (no playthrough gate). Returns the
   * committed/edited LRC when one already exists (user edits are authoritative).
   */
  const buildOwnWordLrc = async (uri: string, id: string): Promise<string | null> => {
    const saved = await readLrcCache(id);
    if (saved) return saved;
    if (lrclibMissing.has(id)) return null;
    const parsed = await readSpicyLyricsCache(id).catch(() => null);
    const info = parsed ? lyricSpans(parsed) : null;
    if (info && !info.lineLevel) return null; // Spicy WORD-synced → preceding detection, no own LRC
    // Line lyrics to build our word-by-word from: Spicy's own lines, else an LRCLIB match.
    let grouped: LyricSpan[][] | null = null;
    if (info && info.lineLevel) {
      grouped = parsed ? lyricLines(parsed) : null;
    } else if (!info) {
      const track = lrcTrackFor(uri);
      const synced = track ? await fetchLrclibSynced(fetchLike, track) : null;
      if (!synced) {
        if (track) lrclibMissing.add(id); // only give up when we actually asked LRCLIB
        return null;
      }
      const lines = parseLrc(synced);
      grouped = lines ? lines.map((s) => [s]) : null;
    }
    if (!grouped || !grouped.length) return null;
    const analysis = audioWordTiming() && getTrackAnalysis ? await getTrackAnalysis(uri) : null;
    const timed = timedLines(grouped, analysis?.segments, analysis?.beats)
      .map((l) => ({ start: l.start, words: l.words.map((w) => ({ text: w.text, start: w.start, end: w.end })) }))
      .filter((l) => l.words.length);
    if (!timed.length) return null;
    const lrc = serializeWordLrcLines(timed);
    await writeLrcCache(id, lrc); // complete as soon as detected → commit now
    return lrc;
  };

  // Memoized per track, so the reader / onset path / overlay share one generation; a null result
  // is dropped so a later call (e.g. once the track is current, or Spicy warms) can retry.
  const ownWordLrc = (uri: string): Promise<string | null> => {
    const id = spotifyIdFromUri(uri);
    if (!id) return Promise.resolve(null);
    let p = ownLrcMemo.get(id);
    if (!p) {
      p = buildOwnWordLrc(uri, id);
      ownLrcMemo.set(id, p);
      void p.then((lrc) => {
        if (!lrc) ownLrcMemo.delete(id);
      });
    }
    return p;
  };
  invalidateOwnLrc = (tid: string): void => void ownLrcMemo.delete(tid); // editor saves → re-read
  // Delete dropped the LRC file: clear the memo, the LRCLIB-miss flag, AND the cached onsets so the
  // next resolve regenerates a fresh LRC (the memo + onset cache would otherwise serve the old one).
  forgetLrc = (tid: string): void => {
    ownLrcMemo.delete(tid);
    lrclibMissing.delete(tid);
    removeOnsetCache(overridesStore, tid);
  };

  // Open the editor for a track with its BEST available lyrics: a saved/edited LRC → our generated
  // word-by-word → a read-only Spicy word-synced copy → (nothing) the cache list. Used to auto-load
  // the next song's lyrics into an open editor on a song change.
  resolveAndOpenEditor = (trackId: string, host: HTMLElement, gen?: number): void => {
    void (async () => {
      const stale = (): boolean => gen !== undefined && gen !== editorReloadGen; // a newer skip superseded us
      const saved = await readLrcCache(trackId);
      if (stale()) return;
      if (saved && hasWordTimestamps(saved)) return void openWordTimingEditor(trackId, saved, host, false, gen);
      const own = await ownWordLrc(`spotify:track:${trackId}`);
      if (stale()) return;
      if (own && hasWordTimestamps(own)) return void openWordTimingEditor(trackId, own, host, false, gen);
      const ro = await spicyWordLevelLrc(trackId);
      if (stale()) return;
      if (ro) return void openWordTimingEditor(trackId, ro, host, true, gen); // read-only preview
      // No lyrics for this track → open a BLANK editable editor (empty LRC) so you can upload + plot +
      // save a new one. This is what lets the editor auto-jump onto a fresh song at the end of another.
      void openWordTimingEditor(trackId, "", host, false, gen);
    })();
  };

  // Onsets from our own word-level LRC — its per-word windows ARE the detection (verbatim).
  const ownLrcOnsets = async (uri: string): Promise<PulseOnset[] | null> => {
    const lrc = await ownWordLrc(uri);
    if (!lrc) return null;
    const onsets = wordOnsets(parseWordLrc(lrc));
    return onsets.length ? onsets : null;
  };

  // Lyric LINES for the debug overlay. Priority MATCHES the onset pipeline so the overlay shows
  // exactly what the cat uses: a saved/edited word-level LRC (authoritative) → Spicy's own structure
  // → our generated word-by-word. `timedLines` uses word-level lines verbatim, so the overlay honours
  // the LRC's exact per-word timing. (`[lineStart]` tags preserve the real line grouping.)
  const linesFromLrc = (lrc: string): LyricSpan[][] | null => {
    // The overlay follows the LEAD vocal (like the cat) — drop background/secondary words so the
    // line reads cleanly rather than interleaving overlapping vocals.
    const lines = parseWordLrcLines(lrc)
      .map((l) => ({ ...l, words: l.words.filter((w) => !w.secondary) }))
      .filter((l) => l.words.length);
    if (!lines.length) return null;
    return lines.map((l) => l.words.map((w) => ({ start: w.start, end: w.end, text: w.text })));
  };
  getTrackLyricLines = async (uri: string): Promise<LyricSpan[][] | null> => {
    const id = spotifyIdFromUri(uri);
    if (id) {
      const saved = await readLrcCache(id); // a saved/edited LRC wins even over Spicy (matches onsets)
      if (saved && hasWordTimestamps(saved)) {
        const lines = linesFromLrc(saved);
        if (lines) return lines;
      }
    }
    const parsed = id ? await readSpicyLyricsCache(id).catch(() => null) : null;
    const grouped = parsed ? lyricLines(parsed) : null;
    if (grouped) return grouped;
    const lrc = await ownWordLrc(uri);
    return lrc ? linesFromLrc(lrc) : null;
  };

  const spicyOnsets = createSpicyOnsetReader(() => lyricSyncEnabled() || perPulseSource(), {
    buildOnsets,
    // Give Spicy Lyrics a short grace to warm its cache, then fall through to LRCLIB — don't
    // block the fallback (and the pulse, and the pending LRC) for the default 90s on a track
    // Spicy will never cache, which would also push the commit past a short song's end.
    retries: [0, 500, 1000, 2000, 3500],
    maxWaitMs: 8000,
  });
  // Resolve a track's onsets through the lyric chain: Spicy Lyrics (word-synced, top choice) →
  // LRCLIB (line-synced fallback) → null (beat/heuristic). The computed onsets are persisted in
  // the bop-map cache, so a replay comes straight from LocalStorage (instant — no cache read /
  // poll / network / estimation). Gated by the same opt-in, so turning lyric sync off also stops
  // using the cache. `onsetsFor` skips the persistent-cache layer (used by the prefetcher).
  // Onset resolution: poll Spicy Lyrics for warm-up (word-synced → verbatim; line-synced → our
  // own word-by-word, via buildOnsets) → else our own word-by-word from LRCLIB. The reader waits
  // for a cold Spicy cache so we don't prematurely fall through on a track Spicy will cover.
  const onsetsFor = async (uri: string): Promise<PulseOnset[] | null> => {
    return (await spicyOnsets(uri)) ?? (await ownLrcOnsets(uri));
  };

  const readSpicyOnsets = async (uri: string): Promise<PulseOnset[] | null> => {
    if (!(lyricSyncEnabled() || perPulseSource())) return null;
    const id = spotifyIdFromUri(uri);
    if (id) {
      const cached = readOnsetCache(overridesStore, id);
      if (cached) {
        void ownWordLrc(uri); // keep the first-full-play commit possible on a cache hit
        return cached;
      }
      // Our committed word-level LRC (generated earlier, user-edited, or saved from a read-only
      // Spicy entry) is authoritative — it wins even over Spicy's own WORD-synced lyrics, so a saved
      // override actually takes effect (and edits survive an onset-logic version bump).
      const saved = await readLrcCache(id);
      if (saved && hasWordTimestamps(saved)) {
        const o = wordOnsets(parseWordLrc(saved));
        if (o.length) {
          writeOnsetCache(overridesStore, id, o);
          return o;
        }
      }
    }
    const fresh = await onsetsFor(uri);
    if (id && fresh && fresh.length) writeOnsetCache(overridesStore, id, fresh);
    void ownWordLrc(uri); // generate our own word-by-word LRC when appropriate (pending → commit)
    return fresh;
  };

  // Shift a track's onsets by its manual lyric offset (signed ms). Applied at the END — the bop-map
  // cache + the per-word LRC stay in RAW (offset-independent) time, so changing the offset never
  // rewrites them; a `refreshOnsets()` re-applies the current value. Starts are clamped to ≥0.
  const applyLyricOffset = (onsets: PulseOnset[] | null, id: string): PulseOnset[] | null => {
    if (!onsets || !onsets.length) return onsets;
    const off = getLyricOffset(overridesStore, id);
    if (!off) return onsets;
    const shifted = onsets.map((o) => {
      const start = Math.max(0, o.start + off);
      return o.end !== undefined ? { start, end: Math.max(start, o.end + off) } : { start };
    });
    return shifted;
  };
  const fetchOnsetsSynced = async (uri: string): Promise<PulseOnset[] | null> => {
    const id = spotifyIdFromUri(uri);
    const onsets = await readSpicyOnsets(uri);
    return id ? applyLyricOffset(onsets, id) : onsets;
  };
  // Experimental: the mirror Pop Cat's onsets = the BACKGROUND + DUET words of our saved LRC (the
  // second voice). Only active for Pop Cat with the mirror + the toggle on; otherwise null → the mirror
  // follows the main cat. Offset-shifted like the lead so both cats stay in sync with the track.
  const fetchSecondaryOnsetsSynced = async (uri: string): Promise<PulseOnset[] | null> => {
    if (!(mirrorBackgroundVocals() && mirrorEnabled() && currentSource() === VIDEO_SOURCES.POP)) return null;
    const id = spotifyIdFromUri(uri);
    if (!id) return null;
    const saved = await readLrcCache(id); // background/duet words only live in a saved/edited word-level LRC
    if (!saved || !hasWordTimestamps(saved)) return null;
    const onsets = mirrorWordOnsets(parseWordLrc(saved));
    return onsets.length ? applyLyricOffset(onsets, id) : null;
  };

  /** The next queued track's uri, if the queue exposes one. */
  const nextTrackUri = (): string | undefined => {
    const q = (Spicetify as unknown as {
      Queue?: { nextTracks?: Array<{ uri?: string; contextTrack?: { uri?: string } }> };
    }).Queue;
    const n = q?.nextTracks?.find((t) => t?.uri || t?.contextTrack?.uri);
    return n?.uri ?? n?.contextTrack?.uri;
  };

  // Prefetch the next queued track so a skip engages instantly instead of cold-fetching: warm
  // its audio analysis (into the LRU), and — if Spicy Lyrics already has it cached — precompute
  // and persist its onsets now. Best-effort and single-flight; a one-shot lyric read (no poll,
  // no LRCLIB network) so it never competes with the current track's own resolution.
  const prefetchNext = singleFlight(async () => {
    const next = nextTrackUri();
    if (!next) return;
    const id = spotifyIdFromUri(next);
    if (!id) return;
    await ensureAnalysis(next);
    if (!(lyricSyncEnabled() || perPulseSource())) return;
    if (readOnsetCache(overridesStore, id)) return; // already have onsets for it
    const parsed = await readSpicyLyricsCache(id).catch(() => null);
    const onsets = parsed ? await buildOnsets(parsed, next) : null;
    if (onsets && onsets.length) writeOnsetCache(overridesStore, id, onsets);
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
    fetchOnsets: fetchOnsetsSynced,
    fetchSecondaryOnsets: fetchSecondaryOnsetsSynced,
  });
  catController = controller; // used by the injected panel's per-song controls

  // Single-flight: startup mount, songchange remounts and the settings
  // reload button can overlap while waiting for the player UI; without
  // this, two videos get inserted.
  const ensureMounted = singleFlight(async () => {
    const video = await mountVideo();
    pulse.setFrames(getConfig().frames ?? null); // Pop Cat: the two swap-frames (else null)
    controller.setVideo(video);
    pulse.attach(video);
    pulse.setMirror(video ? mountMirror(video) : null);
    // Pop Cat's MOUTH is driven by lyric onsets (syllableFrames) — so every mount/source-change must
    // (re)fetch them or Pop stays mouth-shut. This used to live only on the cat-click cycle, so switching
    // to Pop via the settings dropdown (or any remount) left it un-popping until the next song change.
    controller.refreshOnsets();
    applyLoudnessMode();
  });

  // Bongo "follow the audio fluctuations" (#3): when the toggle is on and Bongo is the
  // source, feed the pulse a live loudness sampler from the track's analysis segments;
  // otherwise clear it (normal beat/lyric behaviour). Re-run on song/source/toggle change.
  function applyLoudnessMode(): void {
    const uri = Spicetify.Player.data?.item?.uri;
    if (!uri || !bongoFollowsFluctuations() || currentSource() !== VIDEO_SOURCES.BONGO) {
      pulse.setLoudness(null);
      return;
    }
    void ensureAnalysis(uri).then((a) => {
      const stillValid =
        a && bongoFollowsFluctuations() && currentSource() === VIDEO_SOURCES.BONGO &&
        Spicetify.Player.data?.item?.uri === uri;
      pulse.setLoudness(stillValid ? (ms) => loudnessAt(a!.segments, ms) : null);
    });
  }

  // Clicking the cat (or its mirror) advances to the next video source and remounts.
  const SOURCE_CYCLE: readonly string[] = [
    VIDEO_SOURCES.BONGO,
    VIDEO_SOURCES.POP,
    VIDEO_SOURCES.DEFAULT,
    VIDEO_SOURCES.CUSTOM,
  ];
  cycleVideoSource = () => {
    const idx = SOURCE_CYCLE.indexOf(currentSource());
    const next = SOURCE_CYCLE[(idx + 1) % SOURCE_CYCLE.length];
    settings.setFieldValue(VIDEO_SOURCE_FIELD, next);
    settings.rerender(); // reflect the change in the settings dropdown if it's open
    const customEmpty =
      next === VIDEO_SOURCES.CUSTOM && !String(settings.getFieldValue("catjam-webm-link") || "").trim();
    Spicetify.showNotification?.(`Lyricat: ${next}${customEmpty ? " (empty → Bongo Cat)" : ""}`);
    void ensureMounted(); // (ensureMounted now refreshes onsets itself, so Pop's mouth has syllables)
  };

  // Only the general video settings live in the native list; the per-song
  // controls (delay / BPM / double-time) are rendered in the injected Lyricat
  // Library panel, under the Currently Playing card.
  settings.addDropDown(
    VIDEO_SOURCE_FIELD,
    "Which video to show",
    [VIDEO_SOURCES.BONGO, VIDEO_SOURCES.POP, VIDEO_SOURCES.DEFAULT, VIDEO_SOURCES.CUSTOM],
    0, // Bongo Cat is the default
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
  settings.addToggle(
    MIRROR_BG_VOCALS_FIELD,
    "   ↳ ⚠ experimental: the mirror Pop Cat sings the BACKGROUND vocals (main cat sings the lead)",
    false,
    () => catController?.refreshOnsets(),
  );
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
  // Visualizer-driven features (need Spotify's internal audio-analysis endpoint — use
  // "Test audio analysis" in the Library to confirm it works for your client).
  settings.addToggle(
    AUDIO_WORD_TIMING_FIELD,
    "Pulse — ⚠ experimental: time line-synced syllable pops to the audio analysis " +
      "(segment boundaries) instead of even spacing — best-effort, beat-contaminated",
    false,
    () => {
      analysisCache.clear();
      clearOnsetCache(overridesStore);
      catController?.refreshOnsets();
    }
  );
  settings.addToggle(
    BONGO_FLUX_FIELD,
    "Pulse — ⚠ experimental: Bongo Cat follows the exact audio loudness fluctuations " +
      "(visualizer-style) instead of the beat",
    false,
    () => applyLoudnessMode()
  );
  settings.addToggle(
    WORD_DEBUG_FIELD,
    "Debug — show a live word-timing overlay (words turn white as the mechanism marks " +
      "them played) to eyeball the word detection",
    false,
    () => refreshWordDebug(Spicetify.Player.data?.item?.uri)
  );
  // Optional GetSongBPM lookup — leave blank to skip. Tried only when ReccoBeats
  // can't resolve a tempo, before the preview scan. Also in the Re-detect menu.
  settings.addInput(GETSONGBPM_KEY_FIELD, "GetSongBPM API key (getsongbpm.com/api) — real BPM lookup", "");
  // One RapidAPI key shared by the Musicae providers (Spotify Extended Audio
  // Features + DJ Track Audio Analysis). Free tier is ~10 lookups/day each, so
  // they're tried only as a last resort before the preview scan and capped locally.
  settings.addInput(
    RAPIDAPI_KEY_FIELD,
    "RapidAPI key (rapidapi.com) — Musicae audio-features + DJ analysis, ~10 lookups/day each, tried before the preview scan",
    ""
  );
  settings.addInput(RECORD_KEY_FIELD, "Lyric editor — Record tap keys for word bars (e.g. \"./\")", "./");
  // The stored value shadows the addInput default, so existing installs keep the OLD default ("as").
  // Migrate that one legacy value to the new default ("./") — the settings page may be unavailable to
  // change it by hand. A user's own custom value is left alone.
  if (settings.getFieldValue(RECORD_KEY_FIELD) === "as") settings.setFieldValue(RECORD_KEY_FIELD, "./");
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

  // Self-rendered Lyricat panel (global settings + full Library), opened from the
  // sidebar link. Mirrors the native settings above but with our own DOM, so it works
  // on Spotify builds where spcr-settings can't inject into the preferences page.
  const SETTINGS_SCHEMA: SettingCtl[] = [
    { kind: "dropdown", field: VIDEO_SOURCE_FIELD, label: "Which cat / video to show",
      options: [VIDEO_SOURCES.BONGO, VIDEO_SOURCES.POP, VIDEO_SOURCES.DEFAULT, VIDEO_SOURCES.CUSTOM],
      onChange: () => void ensureMounted() },
    { kind: "text", field: "catjam-webm-link", label: `Custom webM video URL (source "${VIDEO_SOURCES.CUSTOM}")` },
    { kind: "text", field: "catjam-webm-bpm", label: "Custom webM default BPM (e.g. 135.48)" },
    { kind: "dropdown", field: "catjam-webm-position", label: "Where to render the video",
      options: ["Bottom (Player)", "Left (Library)"] },
    { kind: "text", field: "catjam-webm-position-left-size", label: "Left-library video size (default 100)" },
    { kind: "text", field: RECORD_KEY_FIELD, label: "Lyric editor — Record tap keys for word bars (e.g. \"./\")" },
    { kind: "number", field: POSITION_X_FIELD, label: "Position offset X (px, − left / + right)", step: "1" },
    { kind: "number", field: POSITION_Y_FIELD, label: "Position offset Y (px, − up / + down)", step: "1" },
    { kind: "toggle", field: MIRROR_ENABLED_FIELD, label: "Mirror cat (flipped duplicate across the play button)",
      onChange: () => void ensureMounted() },
    { kind: "toggle", field: MIRROR_BG_VOCALS_FIELD,
      label: "↳ ⚠ experimental: mirror Pop Cat sings BACKGROUND vocals (main sings lead)",
      onChange: () => catController?.refreshOnsets() },
    { kind: "toggle", field: PULSE_BRIGHTNESS_FIELD, label: "Pulse — brighten on the beat" },
    { kind: "number", field: PULSE_BRIGHTNESS_INTENSITY_FIELD, label: "↳ brightness intensity (0-100)", min: "0", max: "100", step: "5" },
    { kind: "toggle", field: PULSE_SCALE_FIELD, label: "Pulse — bounce on the beat" },
    { kind: "number", field: PULSE_SCALE_INTENSITY_FIELD, label: "↳ bounce intensity (0-100)", min: "0", max: "100", step: "5" },
    { kind: "toggle", field: PULSE_LYRIC_FIELD, label: "Pulse on lyrics instead of the beat (⚠ needs Spicy Lyrics)" },
    { kind: "toggle", field: AUDIO_WORD_TIMING_FIELD,
      label: "⚠ experimental: time line syllables to audio analysis (beat-contaminated; best-effort)",
      onChange: () => {
        analysisCache.clear();
        clearOnsetCache(overridesStore);
        catController?.refreshOnsets();
      } },
    { kind: "toggle", field: BONGO_FLUX_FIELD,
      label: "⚠ experimental: Bongo follows the exact audio loudness (visualizer)",
      onChange: () => applyLoudnessMode() },
    { kind: "toggle", field: WORD_DEBUG_FIELD,
      label: "Debug: live word-timing overlay (words turn white as they're marked played)",
      onChange: () => refreshWordDebug(Spicetify.Player.data?.item?.uri) },
    { kind: "text", field: GETSONGBPM_KEY_FIELD, label: "GetSongBPM API key (getsongbpm.com/api)" },
    { kind: "text", field: RAPIDAPI_KEY_FIELD, label: "RapidAPI key (Musicae providers, ~10/day each)" },
    { kind: "button", label: "Apply pulse + position to the current song now", text: "Apply now", onClick: applyPulseSettings },
    { kind: "button", label: "Save & reload the cat overlay", text: "Reload", onClick: () => void ensureMounted() },
  ];

  // The main-content container (where Spotify's own pages render). We inject the panel
  // as a child of THIS rather than a body-level overlay, so it's just main-view content:
  // Spotify's chrome, notifications and modals all live in sibling/portal layers that
  // naturally stack above it — no z-index fighting with the notification layer.
  const mainViewContainer = (): HTMLElement | null => {
    for (const s of [".main-view-container", "[data-testid='main-view-container']", ".Root__main-view"]) {
      const el = document.querySelector(s);
      if (el instanceof HTMLElement) return el;
    }
    return null;
  };

  const closeCatJamPanel = (): void => document.getElementById(CATJAM_OVERLAY_ID)?.remove();

  showCatJamPanel = (): void => {
    if (document.getElementById(CATJAM_OVERLAY_ID)) {
      closeCatJamPanel(); // the link/button toggles the panel
      return;
    }
    const panel = document.createElement("div");
    panel.id = CATJAM_OVERLAY_ID;

    const headRow = document.createElement("div");
    headRow.setAttribute("style", "display:flex; align-items:center; justify-content:space-between; margin-bottom:10px;");
    const title = document.createElement("h2");
    title.textContent = "Lyricat";
    title.setAttribute("style", "margin:0; font-size:22px; font-weight:800;");
    headRow.append(title, whitelistButton("Close", closeCatJamPanel));

    const settingsHost = document.createElement("div");
    settingsHost.id = SETTINGS_HOST_ID; // so a post-download refresh can re-render it in place
    renderSettingsInto(settingsHost, SETTINGS_SCHEMA);

    const cloudHost = document.createElement("div");
    cloudHost.id = CLOUD_HOST_ID;
    renderCloudSyncInto(cloudHost);

    const libHost = document.createElement("div");
    libHost.id = WHITELIST_VIEW_ID; // refreshNowPlaying finds + live-updates it by id
    libHost.setAttribute("style", "margin-top:18px;");
    renderWhitelistInto(libHost);

    panel.append(headRow, sectionLabel("Settings"), settingsHost, sectionLabel("Cloud Sync"), cloudHost, libHost);

    const container = mainViewContainer();
    if (container) {
      // Overlay the main view's content, confined to that region. z-index stays low —
      // it only needs to beat the page content *inside* this same container.
      if (getComputedStyle(container).position === "static") container.style.position = "relative";
      panel.style.cssText =
        "position:absolute; inset:0; z-index:2; overflow:auto; box-sizing:border-box; padding:20px 28px 32px; " +
        "background:var(--spice-main,#121212); color:var(--spice-text,#fff);";
      container.appendChild(panel);
    } else {
      // Fallback: a plain fixed overlay (kept below the notification layer at 1000+).
      panel.style.cssText =
        "position:fixed; z-index:900; top:64px; left:72px; right:360px; bottom:88px; overflow:auto; " +
        "box-sizing:border-box; padding:20px 28px 32px; background:var(--spice-main,#121212); color:var(--spice-text,#fff); border-radius:8px;";
      document.body.appendChild(panel);
    }
  };

  // Open the Lyricat panel (if not already) and jump straight to the current track's lyric editor.
  showLyricEditorForCurrent = (): void => {
    if (!document.getElementById(CATJAM_OVERLAY_ID)) showCatJamPanel?.(); // open without toggling it shut
    const host = document.getElementById(WHITELIST_VIEW_ID);
    if (!host) return;
    const id = spotifyIdFromUri(Spicetify.Player.data?.item?.uri ?? "");
    if (id) resolveAndOpenEditor?.(id, host);
    else void renderLyricCacheInto(host); // no current track → show the cache browser instead
  };

  // The panel overlays the main view; when the user navigates away (Home, search, a
  // playlist…) Spotify renders the new page *under* it, so dismiss the panel on any route
  // change rather than letting it linger on top of unrelated content. Best-effort.
  try {
    Spicetify.Platform?.History?.listen?.(() => closeCatJamPanel());
  } catch {
    /* History API absent on this client — the Close button still dismisses the panel */
  }
  // History.listen only fires on route CHANGES, so pressing Home while already on Home (or clicking the
  // current playlist) wouldn't dismiss the overlay. Treat Lyricat as its own unit: any click on a Spotify
  // navigation control (outside the panel) also closes it, so navigation always "escapes" Lyricat.
  document.addEventListener(
    "click",
    (e) => {
      const panel = document.getElementById(CATJAM_OVERLAY_ID);
      if (!panel) return;
      const t = e.target as HTMLElement | null;
      if (!t || panel.contains(t)) return; // clicks inside Lyricat are its own
      const nav = t.closest(
        'a[href^="/"], [data-testid="home-button"], [data-testid="top-bar-back-button"], ' +
          '[data-testid="top-bar-forward-button"], [aria-label="Home"], nav a, aside a'
      );
      if (nav) closeCatJamPanel();
    },
    true
  );

  // A persistent top-bar button is a reliable entry point to the panel that doesn't
  // depend on the lyrics card being open (the sidebar link needs it). Best-effort.
  try {
    const TopbarButton = (Spicetify as unknown as {
      Topbar?: { Button: new (label: string, icon: string, onClick: () => void) => unknown };
    }).Topbar?.Button;
    if (TopbarButton) {
      const catIcon =
        '<svg role="img" height="16" width="16" viewBox="0 0 24 24" fill="currentColor">' +
        '<path d="M4 3l3 4h10l3-4v10a5 5 0 0 1-5 5H9a5 5 0 0 1-5-5V3zm5 9a1 1 0 100-2 1 1 0 000 2zm6 0a1 1 0 100-2 1 1 0 000 2z"/></svg>';
      new TopbarButton("Lyricat", catIcon, () => showCatJamPanel?.());
    }
  } catch {
    /* topbar API absent on this client — the sidebar link still opens the panel */
  }

  await ensureMounted();
  lyricatReady = true; // booted → the NPV panel can now show the real controls instead of the loader
  mountNpvControls(); // swap the loading animation for the controls (if the panel is mounted)

  // When we LEAVE a Spicy word-synced track that we don't own a saved LRC for, drop its cached
  // onsets. It's "read-only" (Spicy is the source), so nothing Spicy-derived should persist — the
  // next play re-derives from Spicy's (warm) cache instantly. Tracks with our own saved LRC keep it.
  const forgetSpicyReadOnlyOnsets = async (id: string | null): Promise<void> => {
    if (!id || !readOnsetCache(overridesStore, id)) return; // nothing cached → nothing to drop
    if (await readLrcCache(id)) return; // we own a saved LRC for it → keep (not read-only)
    const parsed = await readSpicyLyricsCache(id).catch(() => null);
    const info = parsed ? lyricSpans(parsed) : null;
    if (info && !info.lineLevel) removeOnsetCache(overridesStore, id); // Spicy word-synced → drop its onsets
  };

  // Initialise rate + pulse for the track already playing (the songchange event
  // only fires on the next track otherwise).
  const startUri = Spicetify.Player.data?.item?.uri;
  let lastPlayedId: string | null = spotifyIdFromUri(startUri ?? "") || null; // the track we're leaving on a change
  pulse.setConfig(getPulseConfig()); // read settings once at startup
  pulse.setPlaying(Spicetify.Player.isPlaying());
  if (startUri) {
    controller.onSongChange(startUri, playerState());
    void autoDetectMeter?.(startUri); // apply the default Detected meter (once per bar)
    refreshWordDebug(startUri); // restore the word-timing overlay if it was left on
  }
  void refreshNowPlaying(); // populate detected bpm for the track already playing
  void prefetchNext(); // warm the next queued track so the first skip is instant
  setupSpicyLyricsRelocation(); // swap in the Spicy Lyrics button when it's installed
  setupNpvAnchor(); // center the lyrics panel in the sidebar (only when Canvas is off)

  // After a cloud Download/Restore applies new data, refresh whatever's on screen so it reflects
  // the pulled settings/library/lyrics without a full reload.
  onBundleApplied = () => {
    catController?.refreshOnsets();
    refreshWordDebug(Spicetify.Player.data?.item?.uri);
    const sh = document.getElementById(SETTINGS_HOST_ID);
    if (sh) renderSettingsInto(sh, SETTINGS_SCHEMA);
    const lh = document.getElementById(WHITELIST_VIEW_ID);
    if (lh) renderWhitelistInto(lh);
  };
  // Daily upload-only auto-sync: try once at startup, then re-check every 6h (so a long-running
  // session still catches the UTC-day rollover). Each call is internally day-gated + credential-gated.
  void runDailyCheck();
  setInterval(() => void runDailyCheck(), 6 * 60 * 60 * 1000);

  Spicetify.Player.addEventListener("songchange", () => {
    const newId = spotifyIdFromUri(Spicetify.Player.data?.item?.uri ?? "") || null;
    const prevId = lastPlayedId;
    if (prevId && prevId !== newId) void forgetSpicyReadOnlyOnsets(prevId); // left a track → clean up if Spicy read-only
    lastPlayedId = newId;
    // If an editor is open FOLLOWING playback, auto-load the next track's lyrics into the same panel
    // (editable or read-only), so it tracks playback song-to-song. A fresh generation guards against
    // rapid skips rendering a stale editor (the `following` flag survives the async lag the old
    // `uri === prevId` check couldn't).
    if (newId && newId !== prevId && activeLyricEditor?.following && activeLyricEditor.host.isConnected) {
      resolveAndOpenEditor?.(newId, activeLyricEditor.host, ++editorReloadGen);
    }
    if (!document.getElementById(VIDEO_ID)?.isConnected) {
      void ensureMounted(); // Spotify rebuilt its DOM; remount lazily
    }
    pulse.setConfig(getPulseConfig()); // re-read the pulse settings for the new song
    pulse.setPlaying(Spicetify.Player.isPlaying());
    controller.onSongChange(Spicetify.Player.data?.item?.uri, playerState());
    void autoDetectMeter?.(Spicetify.Player.data?.item?.uri); // default Detected meter
    applyLoudnessMode(); // refresh Bongo's audio-fluctuation sampler for the new track
    refreshWordDebug(Spicetify.Player.data?.item?.uri); // reload the word-timing overlay
    void refreshNowPlaying(); // move the panel + its controls to the now-playing song
    reanchorOverlay?.(); // the bar may have reflowed; keep the overlay aligned
    reanchorMirror?.();
    setupSpicyLyricsRelocation(); // re-apply the lyrics-button swap after any rebuild
    anchorNpvSoon(); // re-center the lyrics panel (skipped when Canvas is on)
    void prefetchNext(); // warm the next queued track's analysis + onsets for an instant skip
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
