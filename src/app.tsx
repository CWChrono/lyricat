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
  getOverride,
  setStoredBpm,
  setDelayMs,
  flipDoubleTime,
  clampDelay,
  MAX_DELAY_MS,
} from "./overrides";
import { BONGOCAT_VIDEO_URL } from "./resources/bongocat";

// Per-track overrides (bpm / double-time / delay) live in Spicetify LocalStorage.
const overridesStore: KeyValueStore = {
  get: (key) => Spicetify.LocalStorage.get(key),
  set: (key, value) => Spicetify.LocalStorage.set(key, value),
};

// Transports for the preview-analysis fallback. The embed page has no CORS, so
// its HTML goes through CosmosAsync; the preview CDN and ReccoBeats allow CORS,
// so plain fetch handles the audio download and the multipart upload. The audio
// is streamed straight into the upload and never stored.
const previewDeps: PreviewDeps = {
  fetchText: async (url) => {
    const body = await Spicetify.CosmosAsync.get(url);
    return typeof body === "string" ? body : JSON.stringify(body ?? "");
  },
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
const DELAY_FIELD = "catjam-delay";

const settings = new SettingsSection("Cat-Jam Settings", "catjam-settings");

const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

const VIDEO_SOURCES = {
  DEFAULT: "Cat Jam (default)",
  BONGO: "Bongo Cat",
  CUSTOM: "Custom webM URL",
} as const;
const VIDEO_SOURCE_FIELD = "catjam-video-source";

/** Which video to show, based on the source dropdown. */
function selectedVideoUrl(): string {
  const source = String(settings.getFieldValue(VIDEO_SOURCE_FIELD) || "");
  if (source === VIDEO_SOURCES.BONGO) return BONGOCAT_VIDEO_URL;
  if (source === VIDEO_SOURCES.CUSTOM) {
    return String(settings.getFieldValue("catjam-webm-link") || "") || DEFAULT_VIDEO_URL;
  }
  return DEFAULT_VIDEO_URL;
}

function getConfig(): CatJamConfig {
  return {
    videoUrl: selectedVideoUrl(),
    defaultBpm: Number(settings.getFieldValue("catjam-webm-bpm")) || DEFAULT_VIDEO_BPM,
  };
}

function playerState(): PlaybackState {
  return {
    progressMs: Spicetify.Player.getProgress(),
    isPlaying: Spicetify.Player.isPlaying(),
  };
}

/**
 * Resolve a track's tempo: live ReccoBeats id lookup (or a previously stored
 * value) first, then — only if that is empty — the preview analysis, whose
 * result is persisted so it is never re-fetched. Returns undefined if unknown.
 */
async function resolveTempo(
  uri: string,
  fetchAnalysis: (uri: string) => Promise<AnalysisResult | null>
): Promise<number | undefined> {
  const known = await fetchAnalysis(uri);
  if (known?.tempoBpm) return known.tempoBpm;
  const id = spotifyIdFromUri(uri);
  if (!id) return undefined;
  const bpm = await fetchTempoViaPreview(id, previewDeps);
  if (bpm) setStoredBpm(overridesStore, id, bpm);
  return bpm ?? undefined;
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
  const bpm = await resolveTempo(uri!, fetchAnalysis);
  if (!bpm) {
    Spicetify.showNotification("Cat-Jam: BPM unavailable for this track", true);
    return;
  }
  controller.onSongChange(uri!, playerState()); // reflect any newly-stored bpm on the cat

  const doubleTime = getOverride(overridesStore, id)?.doubleTime;
  const felt = effectiveTempo(bpm, doubleTime);
  const rate = computePlaybackRate(bpm, getConfig().defaultBpm, doubleTime);
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
  const bpm = await resolveTempo(uri!, fetchAnalysis);
  if (!bpm) {
    Spicetify.showNotification("Cat-Jam: BPM unavailable — can't set double-time", true);
    return;
  }
  const next = flipDoubleTime(overridesStore, id, normalizeTempo(bpm) < bpm);
  controller.onSongChange(uri!, playerState());
  const rate = computePlaybackRate(bpm, getConfig().defaultBpm, next);
  Spicetify.showNotification(
    `Cat-Jam: ${item?.name ?? "Track"} — double-time ${next ? "ON" : "OFF"} ` +
      `(cat ${rate.toFixed(2)}×)`
  );
}

/** Point the delay slider at the current song's stored value (0 if none). */
function syncDelaySlider(): void {
  const id = spotifyIdFromUri(Spicetify.Player.data?.item?.uri);
  const stored = id ? getOverride(overridesStore, id)?.delayMs ?? 0 : 0;
  settings.setFieldValue(DELAY_FIELD, String(stored));
  settings.rerender();
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
  const style = isBottomPlayer
    ? "width: 65px; height: 65px;"
    : `width: ${leftSize}%; max-width: 300px; height: auto; max-height: 100%; position: absolute; bottom: 0; pointer-events: none; z-index: 1;`;

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
    const stored = id ? getOverride(overridesStore, id)?.bpm : undefined;
    return stored ? { tempoBpm: stored } : live;
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
  settings.addInput(
    DELAY_FIELD,
    `Manual sync delay for the current song (ms, max ${MAX_DELAY_MS})`,
    "0",
    () => {
      // spcr-settings persists the field value before this fires; read it back.
      const uri = Spicetify.Player.data?.item?.uri;
      const id = spotifyIdFromUri(uri);
      if (!id) return;
      setDelayMs(overridesStore, id, clampDelay(Number(settings.getFieldValue(DELAY_FIELD)) || 0));
      controller.onSongChange(uri!, playerState());
    },
    "range",
    { min: "0", max: String(MAX_DELAY_MS), step: "10" }
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

  await ensureMounted();

  Spicetify.Player.addEventListener("songchange", () => {
    if (!document.getElementById(VIDEO_ID)?.isConnected) {
      void ensureMounted(); // Spotify rebuilt its DOM; remount lazily
    }
    controller.onSongChange(Spicetify.Player.data?.item?.uri, playerState());
    syncDelaySlider(); // show the new song's stored delay in the slider
  });

  Spicetify.Player.addEventListener("onplaypause", () => {
    controller.onPlayPause(playerState());
  });

  Spicetify.Player.addEventListener("onprogress", () => {
    controller.onProgress(playerState());
  });
}

export default main;
