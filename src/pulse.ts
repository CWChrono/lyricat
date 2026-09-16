// Beat-synced "pulse" for the cat video: a light-up (brightness) and a very
// slight bounce (scale). Both effects toggle independently. Their magnitude is
// scaled per track by how danceable/energetic the song is — dancier songs pulse
// harder, dreamy/chill songs barely — times a global user intensity.
//
// Timing comes from a free-running beat clock at the track's felt tempo
// (ReccoBeats gives a scalar tempo, not beat timestamps, so the clock free-runs
// from playback position — rhythmically correct, not downbeat-aligned). The
// animator can also be handed explicit onset times (e.g. lyric syllables) via
// `setOnsets`, which then drive the pulse instead of the metronome — the seam
// for a future spicy-lyrics / LRCLIB driver. It falls back to the beat whenever
// no onsets are available.
//
// The playback clock is read each frame and extrapolated with wall-time between
// samples (the technique spicy-lyrics uses for its syllable sync) so the pulse
// stays smooth at 60fps despite the coarse progress source.

/** User-facing switches, read live each frame. */
export interface PulseConfig {
  /** Brighten on the beat. */
  brightness: boolean;
  /** Grow very slightly on the beat. */
  scale: boolean;
  /** Global 0..1 multiplier over both effects. */
  intensity: number;
}

/** The bits of Spicetify.Player the clock needs (injected so it stays testable). */
export interface PlayerClock {
  /** Milliseconds into the current track. */
  getProgress(): number;
  isPlaying(): boolean;
}

/** What the controller drives: attach a video, push per-track tempo + depth. */
export interface VideoPulse {
  /** Point the pulse at a (freshly mounted) video, or null to detach. */
  attach(video: HTMLVideoElement | null): void;
  /** New track: its felt bpm (undefined = unknown) and pulse depth [0,1]. Clears onsets. */
  setTrack(feltBpm: number | undefined, depth: number): void;
  /** Explicit pulse onset times (ms) for the current track, or null for beat-driven. */
  setOnsets(onsetsMs: number[] | null): void;
  /** Detach and restore the video to rest. */
  stop(): void;
}

const PULSE_DEFAULT_BPM = 120; // used until a track's tempo resolves
const DEFAULT_STAT = 0.5; // danceability/energy stand-in when unknown
const MAX_BRIGHTNESS_BOOST = 0.6; // peak added brightness at full depth+intensity
const MAX_SCALE_BOOST = 0.06; // peak added scale (+6%) — kept "very slight"
const ATTACK = 0.12; // fraction of a beat spent rising to the peak
const DECAY_EXP = 1.8; // how sharply the pulse falls after the peak
const ONSET_DECAY_MS = 380; // fallback decay window for a lone onset (no next one)
// The bounce (scale) uses a sharper envelope than the brightness glow: it snaps
// up and settles in the first 1/SCALE_SHARPNESS of the beat, then rests flat.
const SCALE_SHARPNESS = 2;
// The bounce pivots on the bottom-left corner and grows mostly upward with a
// slight rightward lean (~12° clockwise from vertical), so the bottom cutoff
// line stays put. Horizontal growth is this fraction of the vertical growth.
const SCALE_ANGLE_RATIO = 0.2;
// Only re-anchor the smooth clock when the reported position jumps more than
// this (a real seek) — ignoring Spotify's coarse per-tick samples keeps the
// pulse from stuttering as it eases back to rest.
const RESYNC_MS = 250;

export function clamp01(x: number): number {
  if (!Number.isFinite(x)) return 0;
  return Math.min(1, Math.max(0, x));
}

/**
 * Per-track pulse depth from audio stats: dancier (and more energetic) tracks
 * pulse harder, dreamy/chill tracks barely. Returns [0,1]. Danceability leads;
 * energy nudges. Falls back to a moderate default when a stat is missing.
 */
export function depthFromStats(danceability?: number, energy?: number): number {
  const dance = typeof danceability === "number" ? danceability : DEFAULT_STAT;
  const e = typeof energy === "number" ? energy : dance;
  return clamp01(0.75 * dance + 0.25 * e);
}

/** Beat phase in [0,1): where we are between two beats at the felt tempo. */
export function beatPhase(progressSec: number, feltBpm: number): number {
  const bpm = feltBpm > 0 ? feltBpm : PULSE_DEFAULT_BPM;
  const beatDur = 60 / bpm;
  const t = ((progressSec % beatDur) + beatDur) % beatDur; // guard negatives
  return t / beatDur;
}

/**
 * Pulse envelope over one beat: a quick rise to a peak just after the beat,
 * then an eased decay back to rest. Continuous at the beat boundary (0→…→0),
 * so it reads as a smooth throb rather than a strobe. `sharpness` > 1 compresses
 * the whole pulse into the first 1/sharpness of the beat (a more abrupt snap),
 * resting flat for the remainder.
 */
export function pulseEnvelope(phase: number, sharpness = 1): number {
  const p = clamp01(phase * (sharpness > 0 ? sharpness : 1));
  if (p < ATTACK) return p / ATTACK; // 0 → 1 rise
  const fall = (1 - p) / (1 - ATTACK); // 1 → 0 across the rest of the window
  return Math.pow(clamp01(fall), DECAY_EXP);
}

/**
 * Envelope driven by explicit onset times (sorted, ms). Finds the most recent
 * onset at//before `progressMs` and shapes a pulse across the gap to the next
 * onset (or a default window for the last one). Empty/no-onset → rest (0).
 */
export function onsetEnvelope(
  progressMs: number,
  onsetsMs: readonly number[],
  sharpness = 1
): number {
  if (!onsetsMs || onsetsMs.length === 0) return 0;
  // Most recent onset <= now (binary search on the sorted array).
  let lo = 0;
  let hi = onsetsMs.length - 1;
  let idx = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (onsetsMs[mid] <= progressMs) {
      idx = mid;
      lo = mid + 1;
    } else {
      hi = mid - 1;
    }
  }
  if (idx < 0) return 0; // before the first onset
  const start = onsetsMs[idx];
  const next = idx + 1 < onsetsMs.length ? onsetsMs[idx + 1] : start + ONSET_DECAY_MS;
  const window = Math.max(1, Math.min(next - start, ONSET_DECAY_MS));
  return pulseEnvelope((progressMs - start) / window, sharpness);
}

/** brightness() multiplier for the current envelope. Rests at 1 (normal). */
export function brightnessFor(
  envelope: number,
  depth: number,
  intensity: number,
  enabled: boolean
): number {
  if (!enabled) return 1;
  return 1 + MAX_BRIGHTNESS_BOOST * clamp01(depth) * clamp01(intensity) * clamp01(envelope);
}

/** scale() multiplier for the current envelope. Rests at 1 (normal size). */
export function scaleFor(
  envelope: number,
  depth: number,
  intensity: number,
  enabled: boolean
): number {
  if (!enabled) return 1;
  return 1 + MAX_SCALE_BOOST * clamp01(depth) * clamp01(intensity) * clamp01(envelope);
}

const now = (): number =>
  typeof performance !== "undefined" && performance.now ? performance.now() : Date.now();

/**
 * The rAF-driven animator. Reads the (stair-stepped) playback clock each frame
 * and extrapolates with wall-time between samples for smoothness, then writes
 * `filter: brightness()` and `transform: <base> scale()` on the video. The base
 * transform (e.g. Bongo Cat's translateY) is captured on attach and preserved,
 * so the scale composes with it rather than clobbering it.
 */
export function createVideoPulse(
  getConfig: () => PulseConfig,
  player: PlayerClock
): VideoPulse {
  let video: HTMLVideoElement | null = null;
  let baseTransform = "";
  let feltBpm: number | undefined;
  let depth = DEFAULT_STAT;
  let onsets: number[] | null = null;
  let raf: number | null = null;

  // Extrapolated clock: anchor once, then advance with wall-time, re-anchoring
  // only on a seek. Between Spotify's coarse progress ticks the pulse runs off
  // performance.now(), so it eases back to rest without stutter.
  let anchorMs = 0;
  let anchorWall = now();
  let clockPlaying = false; // false → next playing frame re-anchors (fresh/after pause)
  let idle = false; // true once we've reset the video to rest, to skip rework

  function reset(): void {
    if (!video) return;
    video.style.filter = "";
    video.style.transform = baseTransform;
  }

  function estProgressMs(): number {
    const sample = player.getProgress();
    if (!clockPlaying) {
      anchorMs = sample;
      anchorWall = now();
      clockPlaying = true;
      return sample;
    }
    const est = anchorMs + (now() - anchorWall);
    if (Math.abs(sample - est) > RESYNC_MS) {
      anchorMs = sample; // a real seek — snap to it
      anchorWall = now();
      return sample;
    }
    return est; // ignore the coarse per-tick sample; stay smooth
  }

  function frame(): void {
    raf = requestAnimationFrame(frame);
    if (!video) return;
    const cfg = getConfig();
    const playing = player.isPlaying();
    if ((!cfg.brightness && !cfg.scale) || !playing || depth <= 0) {
      clockPlaying = false; // resume re-anchors instead of jumping the paused gap
      if (!idle) {
        reset();
        idle = true;
      }
      return;
    }
    idle = false;
    const ms = estProgressMs();
    // Brightness glows over the whole beat; the bounce snaps (SCALE_SHARPNESS).
    let brightnessEnv: number;
    let scaleEnv: number;
    if (onsets && onsets.length) {
      brightnessEnv = onsetEnvelope(ms, onsets);
      scaleEnv = onsetEnvelope(ms, onsets, SCALE_SHARPNESS);
    } else {
      const phase = beatPhase(ms / 1000, feltBpm ?? PULSE_DEFAULT_BPM);
      brightnessEnv = pulseEnvelope(phase);
      scaleEnv = pulseEnvelope(phase, SCALE_SHARPNESS);
    }
    video.style.filter = cfg.brightness
      ? `brightness(${brightnessFor(brightnessEnv, depth, cfg.intensity, true).toFixed(4)})`
      : "";
    // Non-uniform scale about the bottom-left pivot: mostly vertical (sy) with a
    // slight rightward lean (sx), so the bottom edge stays fixed.
    const sy = scaleFor(scaleEnv, depth, cfg.intensity, true);
    const sx = 1 + (sy - 1) * SCALE_ANGLE_RATIO;
    video.style.transform = cfg.scale
      ? `${baseTransform} scale(${sx.toFixed(4)}, ${sy.toFixed(4)})`.trim()
      : baseTransform;
  }

  return {
    attach(v: HTMLVideoElement | null): void {
      if (video && video !== v) reset();
      video = v;
      idle = false;
      clockPlaying = false; // (re-set below when a video is present)
      if (v) {
        baseTransform = v.style.transform || "";
        v.style.transformOrigin = "left bottom"; // pivot: pin the bottom-left corner
        v.style.willChange = "transform, filter"; // GPU layer → smooth, jitter-free pulse
        if (raf === null) raf = requestAnimationFrame(frame);
      } else if (raf !== null) {
        cancelAnimationFrame(raf);
        raf = null;
      }
    },
    setTrack(bpm: number | undefined, d: number): void {
      feltBpm = typeof bpm === "number" && bpm > 0 ? bpm : undefined;
      depth = clamp01(d);
      onsets = null; // new track: drop stale onsets until a driver supplies fresh ones
    },
    setOnsets(o: number[] | null): void {
      onsets = o && o.length ? [...o].sort((a, b) => a - b) : null;
    },
    stop(): void {
      if (raf !== null) {
        cancelAnimationFrame(raf);
        raf = null;
      }
      reset();
      video = null;
    },
  };
}
