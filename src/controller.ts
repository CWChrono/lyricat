import { computePlaybackRate, effectiveTempo } from "./tempo";
import { nextBeatDelaySeconds, Beat } from "./beats";
import { VideoPulse, PulseOnset, depthFromStats, CatMedia } from "./pulse";

export interface AnalysisResult {
  tempoBpm?: number;
  beats?: Beat[];
  /** Danceability [0,1] — scales how hard the cat pulses/bounces. */
  danceability?: number;
  /** Energy [0,1] — secondary pulse-intensity signal. */
  energy?: number;
  /** Recording ISRC when the source exposes it; used to retry other releases. */
  isrc?: string;
  /** Beats per bar (time-signature numerator) when the source reports it; feeds meter detection. */
  timeSignature?: number;
}

export interface CatJamConfig {
  videoUrl: string;
  defaultBpm: number;
  /** Per-source playback-rate clamp; defaults to the cat's [0.5, 2] when omitted. */
  minRate?: number;
  maxRate?: number;
  /**
   * "Animate per pulse": for a 2-frame clip, the pulse drives the frame off lyric
   * syllables instead of the beat. The controller then leaves the video paused so
   * the pulse owns its frame (bounce/brightness still follow the beat).
   */
  syllableFrames?: boolean;
  /** Two-frame image source (Pop Cat): the cat is an <img> and the pulse swaps
   *  these per syllable instead of seeking a <video>. */
  frames?: { closed: string; open: string };
}

/** Player snapshot at the time of an event. */
export interface PlaybackState {
  progressMs: number;
  isPlaying: boolean;
}

interface Deps {
  getConfig(): CatJamConfig;
  fetchAnalysis(uri: string): Promise<AnalysisResult | null>;
  /** Manual meter divisor for a track (2 = half-time), or undefined for auto detection. */
  getDoubleTime?(uri: string): number | undefined;
  /** Manual sync delay (ms) for a track; the cat holds the first frame this long. */
  getDelayMs?(uri: string): number;
  /** Optional beat-synced brightness/scale pulse driven off the felt tempo + danceability. */
  pulse?: VideoPulse;
  /** Optional onset source (e.g. lyric syllables) that drives the pulse instead of the beat. */
  fetchOnsets?(uri: string): Promise<PulseOnset[] | null>;
  /** Optional BACKGROUND-vocal onset source → drives the MIRROR cat (experimental), so it can sing a
   *  different part than the main cat. Null/absent → the mirror just mirrors the main cat's frame. */
  fetchSecondaryOnsets?(uri: string): Promise<PulseOnset[] | null>;
}

const SEEK_THRESHOLD_MS = 500;

export function safePlay(video: CatMedia): void {
  // Autoplay denial or load failure: stay paused, never throw unhandled. An <img>
  // source (Pop Cat) has no play() — nothing to start.
  const v = video as HTMLVideoElement;
  if (typeof v.play !== "function") return;
  const p = v.play();
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
  private video: CatMedia | null = null;
  private generation = 0;
  private currentUri: string | undefined;
  private tempoBpm: number | undefined;
  private beats: Beat[] | undefined;
  private danceability: number | undefined;
  private energy: number | undefined;
  private beatTimer: ReturnType<typeof setTimeout> | null = null;
  private lastProgressMs = 0;
  private playing = false;
  private onsets: PulseOnset[] | null = null;

  constructor(private deps: Deps) {}

  /**
   * True for a 2-frame image source (Bongo / Pop): the pulse owns the frame, so the
   * clip is kept paused. The pulse itself picks the frame *driver* — beat for Bongo,
   * syllables for Pop (config.syllableFrames) — independently of this.
   */
  private isImageSource(): boolean {
    return !!this.deps.getConfig().frames;
  }

  /** Pause the clip if it's a <video>; an <img> source (Pop Cat) has no pause(). */
  private pauseClip(): void {
    const v = this.video as HTMLVideoElement | null;
    if (v && typeof v.pause === "function") v.pause();
  }

  setVideo(video: CatMedia | null): void {
    this.video = video;
    // The pulse's DOM (wrapper + overlays) is attached by app.tsx, which owns it.
    this.applyRate();
    this.updatePulseTrack();
    this.applyFrameMode();
  }

  /**
   * Reconcile the video with the current frame-animation mode. When active the pulse
   * owns the frame, so the clip is paused; otherwise the normal beat loop is
   * (re)started. Called on setVideo, song change, when onsets arrive, and on cycle.
   */
  applyFrameMode(): void {
    this.deps.pulse?.setSyllableFrames(!!this.deps.getConfig().syllableFrames);
    if (this.isImageSource()) {
      this.clearBeatTimer();
      this.pauseClip(); // the pulse owns the frame
    } else if (this.playing) {
      this.resync(this.lastProgressMs, true); // restore the video beat loop
    }
  }

  /**
   * Re-fetch the current track's onsets (e.g. after switching to Pop Cat, or on
   * "Apply"), then reconcile the frame mode. No-op without an onset source / track.
   */
  refreshOnsets(): void {
    if (!this.deps.fetchOnsets || !this.currentUri) {
      this.applyFrameMode();
      return;
    }
    const gen = this.generation;
    const uri = this.currentUri;
    void this.deps.fetchOnsets(uri).then((onsets) => {
      if (gen !== this.generation || uri !== this.currentUri) return; // stale
      this.onsets = onsets;
      this.deps.pulse?.setOnsets(onsets);
      this.applyFrameMode();
    });
    this.refreshMirrorOnsets(uri, gen);
  }

  /** Re-fetch the current track's BACKGROUND onsets → the mirror cat (guarded like the main fetch). */
  private refreshMirrorOnsets(uri: string, gen: number): void {
    if (!this.deps.fetchSecondaryOnsets || !this.deps.pulse) return;
    void this.deps.fetchSecondaryOnsets(uri).then((onsets) => {
      if (gen !== this.generation || uri !== this.currentUri) return; // stale
      this.deps.pulse!.setMirrorOnsets(onsets);
    });
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
    this.playing = state.isPlaying;
    this.onsets = null; // new track: no onsets until the driver supplies them
    this.updatePulseTrack(); // reset the pulse (default tempo / off for non-tracks)
    this.deps.pulse?.setOnsets(null); // drop stale onsets; a driver may supply fresh ones
    this.deps.pulse?.setMirrorOnsets(null); // drop stale background onsets too
    this.deps.pulse?.setSyllableFrames(!!this.deps.getConfig().syllableFrames);

    if (!uri) return;
    // Image source (Bongo / Pop): the pulse owns the frame, so keep the clip paused.
    // A looping <video> source plays as normal.
    if (this.isImageSource()) this.pauseClip();
    else if (this.video && state.isPlaying) safePlay(this.video);

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
    // late result can't apply to a newer track. When they land, applyFrameMode
    // switches a per-pulse source (Pop Cat) from the beat loop to frame-per-syllable.
    if (this.deps.fetchOnsets && this.deps.pulse) {
      void this.deps.fetchOnsets(uri).then((onsets) => {
        if (gen !== this.generation || uri !== this.currentUri) return; // stale
        this.onsets = onsets;
        this.deps.pulse!.setOnsets(onsets);
        this.applyFrameMode();
      });
    }
    this.refreshMirrorOnsets(uri, gen); // background vocals → mirror cat (experimental)
  }

  onPlayPause(state: PlaybackState): void {
    this.playing = state.isPlaying;
    this.clearBeatTimer();
    if (!state.isPlaying) {
      this.pauseClip();
      return;
    }
    this.resync(state.progressMs, true);
  }

  onProgress(state: PlaybackState): void {
    this.playing = state.isPlaying;
    const jumped =
      Math.abs(state.progressMs - this.lastProgressMs) >= SEEK_THRESHOLD_MS;
    this.lastProgressMs = state.progressMs;
    if (jumped) {
      this.clearBeatTimer();
      this.resync(state.progressMs, state.isPlaying);
    }
  }

  /**
   * The meter divisor the cat dances to: the track's manual/detected value, or 1
   * (raw — a bounce per beat) when none is set. There is no automatic octave fold;
   * the default meter is the detected time signature, falling back to raw.
   */
  private divisor(): number {
    const d = this.currentUri ? this.deps.getDoubleTime?.(this.currentUri) : undefined;
    return typeof d === "number" && Number.isFinite(d) && d >= 1 ? d : 1;
  }

  private applyRate(): void {
    const v = this.video as HTMLVideoElement | null;
    if (!v || typeof v.play !== "function") return; // no playbackRate on an <img> source
    const cfg = this.deps.getConfig();
    v.playbackRate = computePlaybackRate(
      this.tempoBpm,
      cfg.defaultBpm,
      this.divisor(),
      cfg.minRate,
      cfg.maxRate
    );
  }

  /** The tempo the cat is felt to dance at (after the meter divisor), or undefined. */
  private feltBpm(): number | undefined {
    if (this.tempoBpm === undefined) return undefined;
    return effectiveTempo(this.tempoBpm, this.divisor());
  }

  /** The felt tempo + manual delay the pulse is CURRENTLY using — the same clock the cat bounces
   *  on (`beatPhase((ms - delay)/1000, felt)`), so callers (e.g. the editor's beat grid) can line
   *  up exactly. Null when no tempo is known for the current track. */
  public currentBeat(): { feltBpm: number; delayMs: number } | null {
    const f = this.feltBpm();
    if (f === undefined || !(f > 0)) return null;
    const delayMs = this.currentUri ? this.deps.getDelayMs?.(this.currentUri) ?? 0 : 0;
    return { feltBpm: f, delayMs };
  }

  /** Push the current track's felt tempo, pulse depth, and manual delay to the animator. */
  private updatePulseTrack(): void {
    if (!this.deps.pulse) return;
    // Non-track (podcast/local/none): depth 0 → the pulse rests at normal.
    const depth = this.currentUri ? depthFromStats(this.danceability, this.energy) : 0;
    const delayMs = this.currentUri ? this.deps.getDelayMs?.(this.currentUri) ?? 0 : 0;
    this.deps.pulse.setTrack(this.feltBpm(), depth, delayMs);
  }

  private resync(progressMs: number, isPlaying: boolean): void {
    if (!this.video || !isPlaying) return;
    if (this.isImageSource()) {
      // Image source: the pulse owns the frame on a paused clip — don't loop/play it.
      this.clearBeatTimer();
      this.pauseClip();
      return;
    }
    // Past the per-pulse return this is always a looping <video> source.
    const video = this.video as HTMLVideoElement;
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
