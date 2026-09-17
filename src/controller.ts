import { computePlaybackRate, effectiveTempo } from "./tempo";
import { nextBeatDelaySeconds, Beat } from "./beats";
import { VideoPulse, depthFromStats } from "./pulse";

export interface AnalysisResult {
  tempoBpm?: number;
  beats?: Beat[];
  /** Danceability [0,1] — scales how hard the cat pulses/bounces. */
  danceability?: number;
  /** Energy [0,1] — secondary pulse-intensity signal. */
  energy?: number;
}

export interface CatJamConfig {
  videoUrl: string;
  defaultBpm: number;
  /** Per-source playback-rate clamp; defaults to the cat's [0.5, 2] when omitted. */
  minRate?: number;
  maxRate?: number;
}

/** Player snapshot at the time of an event. */
export interface PlaybackState {
  progressMs: number;
  isPlaying: boolean;
}

interface Deps {
  getConfig(): CatJamConfig;
  fetchAnalysis(uri: string): Promise<AnalysisResult | null>;
  /** Manual double-time override for a track, or undefined to use auto detection. */
  getDoubleTime?(uri: string): boolean | undefined;
  /** Manual sync delay (ms) for a track; the cat holds the first frame this long. */
  getDelayMs?(uri: string): number;
  /** Optional beat-synced brightness/scale pulse driven off the felt tempo + danceability. */
  pulse?: VideoPulse;
  /** Optional onset source (e.g. lyric syllables) that drives the pulse instead of the beat. */
  fetchOnsets?(uri: string): Promise<number[] | null>;
}

const SEEK_THRESHOLD_MS = 500;

export function safePlay(video: HTMLVideoElement): void {
  // Autoplay denial or load failure: stay paused, never throw unhandled.
  const p = video.play();
  if (p && typeof p.catch === "function") p.catch(() => {});
}

/** Collapses concurrent calls into one in-flight invocation. */
export function singleFlight<T>(fn: () => Promise<T>): () => Promise<T> {
  let inFlight: Promise<T> | null = null;
  return () => {
    if (!inFlight) {
      inFlight = fn().finally(() => {
        inFlight = null;
      });
    }
    return inFlight;
  };
}

/**
 * Single owner of synchronization state: current track identity, analysis,
 * beat timers and the video element. All async results are guarded by a
 * generation counter plus uri check so late responses can never overwrite
 * a newer track.
 */
export class CatJamController {
  private video: HTMLVideoElement | null = null;
  private generation = 0;
  private currentUri: string | undefined;
  private tempoBpm: number | undefined;
  private beats: Beat[] | undefined;
  private danceability: number | undefined;
  private energy: number | undefined;
  private beatTimer: ReturnType<typeof setTimeout> | null = null;
  private lastProgressMs = 0;

  constructor(private deps: Deps) {}

  setVideo(video: HTMLVideoElement | null): void {
    this.video = video;
    this.deps.pulse?.attach(video);
    this.applyRate();
    this.updatePulseTrack();
  }

  onSongChange(uri: string | undefined, state: PlaybackState): void {
    this.generation++;
    this.currentUri = uri;
    this.clearBeatTimer();
    this.tempoBpm = undefined;
    this.beats = undefined;
    this.danceability = undefined;
    this.energy = undefined;
    this.lastProgressMs = state.progressMs;
    this.updatePulseTrack(); // reset the pulse (default tempo / off for non-tracks)
    this.deps.pulse?.setOnsets(null); // drop stale onsets; a driver may supply fresh ones

    if (!uri) return;
    if (this.video && state.isPlaying) safePlay(this.video);

    const gen = this.generation;
    void this.deps.fetchAnalysis(uri).then((result) => {
      if (gen !== this.generation || uri !== this.currentUri) return; // stale
      this.tempoBpm = result?.tempoBpm;
      this.beats = Array.isArray(result?.beats) ? result!.beats : undefined;
      this.danceability = result?.danceability;
      this.energy = result?.energy;
      this.applyRate();
      this.updatePulseTrack();
      this.resync(state.progressMs, state.isPlaying);
    });

    // Best-effort onset driver (e.g. lyric syllables). Guarded like analysis so a
    // late result can't apply to a newer track; null leaves the beat clock in charge.
    if (this.deps.fetchOnsets && this.deps.pulse) {
      void this.deps.fetchOnsets(uri).then((onsets) => {
        if (gen !== this.generation || uri !== this.currentUri) return; // stale
        this.deps.pulse!.setOnsets(onsets);
      });
    }
  }

  onPlayPause(state: PlaybackState): void {
    this.clearBeatTimer();
    if (!state.isPlaying) {
      this.video?.pause();
      return;
    }
    this.resync(state.progressMs, true);
  }

  onProgress(state: PlaybackState): void {
    const jumped =
      Math.abs(state.progressMs - this.lastProgressMs) >= SEEK_THRESHOLD_MS;
    this.lastProgressMs = state.progressMs;
    if (jumped) {
      this.clearBeatTimer();
      this.resync(state.progressMs, state.isPlaying);
    }
  }

  private applyRate(): void {
    if (!this.video) return;
    const doubleTime = this.currentUri
      ? this.deps.getDoubleTime?.(this.currentUri)
      : undefined;
    const cfg = this.deps.getConfig();
    this.video.playbackRate = computePlaybackRate(
      this.tempoBpm,
      cfg.defaultBpm,
      doubleTime,
      cfg.minRate,
      cfg.maxRate
    );
  }

  /** The tempo the cat is felt to dance at (after the double-time fold), or undefined. */
  private feltBpm(): number | undefined {
    if (this.tempoBpm === undefined) return undefined;
    const doubleTime = this.currentUri ? this.deps.getDoubleTime?.(this.currentUri) : undefined;
    return effectiveTempo(this.tempoBpm, doubleTime);
  }

  /** Push the current track's felt tempo + pulse depth to the pulse animator. */
  private updatePulseTrack(): void {
    if (!this.deps.pulse) return;
    // Non-track (podcast/local/none): depth 0 → the pulse rests at normal.
    const depth = this.currentUri ? depthFromStats(this.danceability, this.energy) : 0;
    this.deps.pulse.setTrack(this.feltBpm(), depth);
  }

  private resync(progressMs: number, isPlaying: boolean): void {
    const video = this.video;
    if (!video || !isPlaying) return;
    const delaySeconds = nextBeatDelaySeconds(this.beats ?? null, progressMs / 1000);
    this.clearBeatTimer();
    // Re-align the loop with the track position regardless of beats.
    video.currentTime = 0;

    if (delaySeconds !== null) {
      // Beat-phase alignment: restart on the next beat (used when beats exist).
      this.beatTimer = setTimeout(() => {
        this.beatTimer = null;
        video.currentTime = 0;
        safePlay(video);
      }, Math.max(0, delaySeconds * 1000));
      return;
    }

    const manualDelayMs = this.currentUri ? this.deps.getDelayMs?.(this.currentUri) ?? 0 : 0;
    if (manualDelayMs <= 0) {
      safePlay(video);
      return;
    }
    // Manual sync offset: hold the first frame, then start after the delay.
    video.pause();
    this.beatTimer = setTimeout(() => {
      this.beatTimer = null;
      video.currentTime = 0;
      safePlay(video);
    }, manualDelayMs);
  }

  private clearBeatTimer(): void {
    if (this.beatTimer !== null) {
      clearTimeout(this.beatTimer);
      this.beatTimer = null;
    }
  }
}
