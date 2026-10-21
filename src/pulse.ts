// Beat-synced "pulse" for the cat video: a light-up (brightness) and a slight
// bounce (scale). Both effects toggle independently and have their own
// intensity. Their magnitude also scales per track by how danceable/energetic
// the song is — dance/house/rave tracks pulse hard, dreamy/chill tracks barely.
//
// Timing comes from a free-running beat clock at the track's felt tempo (folded
// for double-time) and offset by the track's manual sync delay, so the pulse is
// timed to the same beat the cat dances to. The pulse is led so it *peaks on*
// the beat rather than starting on it. ReccoBeats gives a scalar tempo (no beat
// timestamps), so the clock free-runs from playback position.
//
// The animator can instead be handed explicit onset spans (e.g. lyric
// syllables, each {start,end} ms) via `setOnsets`. Those drive the pulse: it
// ramps up at a syllable's start, holds at max for the note's length, then eases
// back — held notes stay lit/large longer. It falls back to the beat whenever no
// onsets are available.
//
// The playback clock is read each frame and extrapolated with wall-time between
// samples (the technique spicy-lyrics uses) so the pulse stays smooth at 60fps.

/** User-facing switches, read live each frame. Each effect has its own intensity. */
export interface PulseConfig {
  /** Brighten on the beat. */
  brightness: boolean;
  /** Bounce (grow slightly) on the beat. */
  scale: boolean;
  /** 0..1 multiplier over the brightness light-up. */
  brightnessIntensity: number;
  /** 0..1 multiplier over the bounce. */
  scaleIntensity: number;
}

/** A sung unit: onset `start` (ms) and optional `end` (ms) so held notes hold. */
export interface PulseOnset {
  start: number;
  end?: number;
}

/** The bit of Spicetify.Player the clock needs (injected so it stays testable). */
export interface PlayerClock {
  /** Milliseconds into the current track. (Play/pause is pushed via setPlaying.) */
  getProgress(): number;
}

/** The cat element the pulse animates: a looping <video>, or an <img> for the
 *  2-frame image sources (Pop Cat) whose frame is swapped instead of seeked. */
export type CatMedia = HTMLVideoElement | HTMLImageElement;

/** What the controller drives: attach a video/img, push per-track + play state. */
export interface VideoPulse {
  /** Point the pulse at a (freshly mounted) cat element, or null to detach. */
  attach(video: CatMedia | null): void;
  /** New track: felt bpm (undefined = unknown), pulse depth [0,1], manual sync delay (ms). */
  setTrack(feltBpm: number | undefined, depth: number, delayMs?: number): void;
  /** Explicit onset spans for the current track, or null for beat-driven. */
  setOnsets(onsets: PulseOnset[] | null): void;
  /** Separate onset spans the MIRROR cat pops on (background/secondary vocals), so it can "sing" a
   *  different part than the main cat. Null → the mirror mirrors the main cat's frame (default). */
  setMirrorOnsets(onsets: PulseOnset[] | null): void;
  /**
   * "Animate per pulse": for a 2-frame cat (Pop/Bongo), drive the *frame* off the
   * syllable onsets (frame 1 at rest, frame 2 while a syllable sounds) instead of
   * looping the clip on the beat. The bounce/brightness keep following the beat.
   * The controller pauses the video so the pulse owns its frame; false restores
   * the normal beat loop.
   */
  setSyllableFrames(on: boolean): void;
  /** Frame images for a 2-frame image source (Pop Cat), or null for a <video> source.
   *  When set, per-pulse mode swaps these instead of seeking the clip. */
  setFrames(frames: { closed: string; open: string } | null): void;
  /** Bongo "follow the audio fluctuations": a sampler returning the normalized [0,1]
   *  loudness at a playback position (ms), from Spotify's analysis. When set, Bongo's
   *  brightness + bounce track this value directly instead of the beat/onset envelope.
   *  Null restores the normal behaviour. */
  setLoudness(sampler: ((ms: number) => number) | null): void;
  /** Push the settings (toggles + intensities). Read once per song / on "Apply", never per frame. */
  setConfig(config: PulseConfig): void;
  /** Update the video's rest transform (e.g. a position offset). The pulse composes
   *  its scale on top of this, so it survives the bounce. Applies live on "Apply". */
  setPosition(transform: string): void;
  /** Attach/detach a mirror video driven in lock-step (same brightness + bounce,
   *  playback frame-locked to the main). Its rest transform (flip/gap) is captured
   *  from the element's style; pass null to stop driving it. */
  setMirror(mirror: HTMLVideoElement | null): void;
  /** Push play/pause (event-driven, so the loop needn't poll it every frame). */
  setPlaying(playing: boolean): void;
  /** Detach and restore the video to rest. */
  stop(): void;
}

const PULSE_DEFAULT_BPM = 120; // used until a track's tempo resolves
const DEFAULT_STAT = 0.5; // danceability/energy stand-in when unknown
// Brightness is a DIM-AND-RELEASE, not a synthetic over-brighten: the peak is
// exactly brightness(1) — the untouched, full-detail webm (which is already the
// natural white cat) — so detail is never blown out. Between pulses it dips to a
// dark base; the dip depth = MAX_DIM × song strength × intensity (× a smaller
// scale in beat mode). At intensity 0 there's no dip (constant 1).
const MAX_DIM = 1.4; // deepest dip below natural (clamps to 1 → base can reach full dark)
// Brightness snaps harder than the bounce so it fully undulates dark→natural→dark
// each burst (returns to the base between beats) instead of hovering.
const BRIGHTNESS_SHARPNESS = 2;
// Beat-by-beat (no lyrics) brightness dips less than word-synced pulsing (mellower).
const BEAT_DIM_SCALE = 0.5;
// Onsets whose median gap exceeds this are line-level (not word-level): they hold
// too long with no variance, so we overlay a subtle beat throb.
const SPARSE_ONSET_GAP_MS = 1200; // onsetsAreSparse threshold (line- vs word-level)
const MAX_SCALE_BOOST = 0.18; // peak added scale (+18%) at full strength+intensity
// Song strength drives the pulse amplitude with an exponential (power) response,
// so low-danceability tracks stay barely-there and high ones pop hard.
const STRENGTH_EXP = 2;
const ATTACK = 0.12; // fraction of a beat spent rising to the peak
const DECAY_EXP = 1.8; // how sharply the pulse falls after the peak
// The bounce (scale) uses a sharper envelope than the brightness glow: it snaps
// up and settles in the first 1/SCALE_SHARPNESS of the beat, then rests flat.
const SCALE_SHARPNESS = 2;
// The bounce pivots on the bottom-left corner and grows mostly upward with a
// slight rightward lean (~12° clockwise from vertical), so the bottom cutoff
// line stays put. Horizontal growth is this fraction of the vertical growth.
const SCALE_ANGLE_RATIO = 0.2;
// Pop Cat's beat bounce is a squash & stretch: on the beat it STRETCHES (taller +
// thinner), then on the way down it SQUASHES (shorter + wider), settling to rest. The
// vertical change drives an inverse horizontal change (volume-preserving feel). Bigger
// than the normal bounce ("more bounce"), with a shallower brightness dip ("less pulse").
const POP_STRETCH = 0.21; // peak vertical stretch on the beat (max, −50% from first pass)
const POP_SQUASH = 0.11; // peak vertical squash just after
const POP_SQUASH_DELAY = 0.18; // phase lag (of the half-beat) before the landing squash
const POP_VOLUME = 0.55; // how strongly width counter-moves vs height
const POP_DIM_SCALE = 0.25; // brightness dip depth (half the beat path) — less flicker
// Only re-anchor the smooth clock when the reported position jumps more than
// this (a real seek) — ignoring Spotify's coarse per-tick samples keeps the
// pulse from stuttering as it eases back to rest.
const RESYNC_MS = 250;
// Throttle the pulse to ~30fps: rAF still fires at the display rate, but we only
// recompute/redraw on this cadence, halving the per-frame cost on a 60Hz screen.
const TARGET_FPS = 30;
const FRAME_INTERVAL_MS = 1000 / TARGET_FPS - 4; // small margin so 60→30 halves reliably
// Mirror cat: re-seat its currentTime only when it drifts past this from the main,
// so the two cats stay on the same flap without a seek every frame.
const MIRROR_DRIFT_S = 0.06;
// …and at most this often. A currentTime write is a decode/seek; doing it every
// frame (the main resets on each beat, so drift is near-constant) was the lag.
const MIRROR_SEEK_INTERVAL_MS = 400;
// Onset (syllable) envelope: quick ramp up, hold for the note, ease back down.
const ONSET_ATTACK_MS = 55;
const ONSET_RELEASE_MS = 190;
const ONSET_HOLD_MS = 200; // default hold when a syllable carries no EndTime
const ONSET_FLASH_MAX_MS = 500; // brightness flash window per word (caps the decay span)
// Syllable brightness = stay lit while singing, dip lightly at each onset. The
// articulation is a brief dip window per onset; ARTIC_DEPTH is how deep it notches.
const ONSET_ARTIC_MS = 75;
const ARTIC_DEPTH = 0.45;

export function clamp01(x: number): number {
  if (!Number.isFinite(x)) return 0;
  return Math.min(1, Math.max(0, x));
}

/** Smooth 0→1 ease (cubic), for gentle onset attack/release tweens. */
export function smoothstep(t: number): number {
  const x = clamp01(t);
  return x * x * (3 - 2 * x);
}

/**
 * Exponential response of pulse amplitude to song strength (depth): low-strength
 * tracks are pushed much lower (mellow, barely-there), high-strength tracks stay
 * high (intense). Both brightness and bounce use it.
 */
export function strengthCurve(depth: number): number {
  return Math.pow(clamp01(depth), STRENGTH_EXP);
}

/**
 * True when onsets are line-level rather than word-level: their median start-to-
 * start gap is large, so they hold too long to give per-word variance and want a
 * beat throb layered on top.
 */
export function onsetsAreSparse(onsets: readonly PulseOnset[]): boolean {
  if (onsets.length < 2) return false;
  const gaps: number[] = [];
  for (let i = 1; i < onsets.length; i++) gaps.push(onsets[i].start - onsets[i - 1].start);
  gaps.sort((a, b) => a - b);
  return gaps[gaps.length >> 1] > SPARSE_ONSET_GAP_MS;
}

/** Fold any real into [0,1). */
function wrap01(x: number): number {
  const r = x % 1;
  return r < 0 ? r + 1 : r;
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
 * Base pulse shape over a window: a quick rise to a peak, then an eased decay
 * back to rest. `sharpness` > 1 compresses the whole pulse into the first
 * 1/sharpness of the window (a more abrupt snap), resting flat for the rest.
 */
export function pulseEnvelope(phase: number, sharpness = 1): number {
  const p = clamp01(phase * (sharpness > 0 ? sharpness : 1));
  if (p < ATTACK) return p / ATTACK; // 0 → 1 rise
  const fall = (1 - p) / (1 - ATTACK); // 1 → 0 across the rest of the window
  return Math.pow(clamp01(fall), DECAY_EXP);
}

/**
 * The beat pulse, led so it *peaks on* the beat (rises just before it) instead
 * of starting on it. The lead equals the shape's peak location for the given
 * sharpness, so both the glow and the (sharper) bounce top out on the downbeat.
 */
export function beatEnvelope(phase: number, sharpness = 1): number {
  const s = sharpness > 0 ? sharpness : 1;
  return pulseEnvelope(wrap01(phase + ATTACK / s), s);
}

/**
 * Envelope driven by explicit onset spans (sorted by start, ms). Ramps up at the
 * active syllable's start, holds at max across the note (start→end, cut short by
 * the next onset), then eases back down. Held notes stay at max longer. Empty /
 * before the first onset → rest (0).
 */
/** Index of the most recent onset whose start is at/before `progressMs`, or -1. */
function lastOnsetIndex(onsets: readonly PulseOnset[], progressMs: number): number {
  let lo = 0;
  let hi = onsets.length - 1;
  let idx = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (onsets[mid].start <= progressMs) {
      idx = mid;
      lo = mid + 1;
    } else {
      hi = mid - 1;
    }
  }
  return idx;
}

export function onsetEnvelope(progressMs: number, onsets: readonly PulseOnset[]): number {
  if (!onsets || onsets.length === 0) return 0;
  const idx = lastOnsetIndex(onsets, progressMs);
  if (idx < 0) return 0;
  const cur = onsets[idx];
  const nextStart = idx + 1 < onsets.length ? onsets[idx + 1].start : Infinity;
  const noteEnd =
    typeof cur.end === "number" && cur.end > cur.start ? cur.end : cur.start + ONSET_HOLD_MS;
  const holdEnd = Math.min(noteEnd, nextStart); // the next syllable cuts the hold short
  const attack = Math.min(ONSET_ATTACK_MS, Math.max(1, (holdEnd - cur.start) * 0.5));
  if (progressMs < cur.start + attack) return smoothstep((progressMs - cur.start) / attack);
  if (progressMs <= holdEnd) return 1; // hold at max for the note's length
  const rel = (progressMs - holdEnd) / ONSET_RELEASE_MS;
  return rel >= 1 ? 0 : smoothstep(1 - rel); // ease back down
}

/**
 * A per-onset "flash" for brightness: bright at the onset, then a smooth lerp
 * back down to rest that spans the gap to the *next* onset (capped). Because the
 * decay window is the gap itself, even a few-frame gap still lerps fully from
 * bright to semi-dark — so brightness undulates on every word instead of holding.
 */
export function onsetFlashEnvelope(progressMs: number, onsets: readonly PulseOnset[]): number {
  if (!onsets || onsets.length === 0) return 0;
  const idx = lastOnsetIndex(onsets, progressMs);
  if (idx < 0) return 0;
  const start = onsets[idx].start;
  const next = idx + 1 < onsets.length ? onsets[idx + 1].start : start + ONSET_FLASH_MAX_MS;
  const window = Math.max(1, Math.min(next - start, ONSET_FLASH_MAX_MS));
  const t = clamp01((progressMs - start) / window);
  // Fast rise, then eased decay to 0 by the next onset (so it fully returns to base).
  const rise = 0.15;
  return t < rise ? smoothstep(t / rise) : smoothstep(1 - (t - rise) / (1 - rise));
}

/**
 * "Is a syllable sounding right now" — 1 while inside any note, decaying to 0 only
 * in real gaps between phrases. Unlike onsetEnvelope it does NOT reset at each
 * onset, so back-to-back syllables read as one held-lit stretch (no strobe).
 */
export function sustainEnvelope(progressMs: number, onsets: readonly PulseOnset[]): number {
  if (!onsets || onsets.length === 0) return 0;
  const idx = lastOnsetIndex(onsets, progressMs);
  if (idx < 0) return 0;
  const cur = onsets[idx];
  const noteEnd =
    typeof cur.end === "number" && cur.end > cur.start ? cur.end : cur.start + ONSET_HOLD_MS;
  if (progressMs <= noteEnd) return 1; // inside a note → fully lit
  const rel = (progressMs - noteEnd) / ONSET_RELEASE_MS; // real gap → ease down
  return rel >= 1 ? 0 : smoothstep(1 - rel);
}

/**
 * A brief 0→1→0 pulse right at each onset (over `windowMs`), used to *lightly dim*
 * the sustained brightness as each syllable is articulated — so dense singing
 * holds mostly lit but undulates per syllable rather than strobing.
 */
export function onsetArticulation(
  progressMs: number,
  onsets: readonly PulseOnset[],
  windowMs: number = ONSET_ARTIC_MS
): number {
  if (!onsets || onsets.length === 0) return 0;
  const idx = lastOnsetIndex(onsets, progressMs);
  if (idx < 0) return 0;
  const since = progressMs - onsets[idx].start;
  if (since < 0 || since >= windowMs) return 0;
  return pulseEnvelope(since / windowMs);
}

/**
 * brightness() multiplier — a dim-and-release. The peak is always exactly 1
 * (the untouched, full-detail webm), so the pulse never blows out to a synthetic
 * white blob. Between pulses it dips to `1 - dim`, where the dip depth scales with
 * song strength × intensity (× `dimScale`, smaller in beat mode). Disabled or
 * intensity 0 → constant 1 (no dip).
 */
export function brightnessFor(
  envelope: number,
  depth: number,
  intensity: number,
  enabled: boolean,
  dimScale: number = 1
): number {
  if (!enabled) return 1;
  const dim = clamp01(MAX_DIM * strengthCurve(depth) * clamp01(intensity) * dimScale);
  return 1 - dim * (1 - clamp01(envelope)); // env 1 → 1 (natural); env 0 → 1 - dim (dark)
}

/** scale() multiplier for the current envelope. Rests at 1 (normal size). */
export function scaleFor(
  envelope: number,
  depth: number,
  intensity: number,
  enabled: boolean
): number {
  if (!enabled) return 1;
  return 1 + MAX_SCALE_BOOST * strengthCurve(depth) * clamp01(intensity) * clamp01(envelope);
}

/**
 * Frame decision for "animate per pulse": true → show the open frame (a syllable
 * is sounding), false → the resting frame. Uses the sustain envelope so back-to-
 * back syllables stay open and it only closes in real gaps. No onsets → closed.
 */
// The mouth pops open at each note's onset and holds open through the body of the
// note, then *closes for the tail* — a release that lands the articulation on the
// note's end (the word boundary). Consecutive notes therefore read as distinct pops
// (open → hold → close → open …) rather than one long hold. The close window is a
// fraction of the note, clamped so it's always visible yet never swallows the hold.
const FRAME_CLOSE_MIN_MS = 70; // shortest (still visible) release
const FRAME_CLOSE_MAX_MS = 200; // longest — keeps a long note mostly open
const FRAME_CLOSE_FRACTION = 0.3; // close roughly the last third of a note

export function syllableFrameOpen(progressMs: number, onsets: readonly PulseOnset[] | null): boolean {
  if (!onsets || onsets.length === 0) return false;
  const idx = lastOnsetIndex(onsets, progressMs);
  if (idx < 0) return false; // before the first syllable → closed
  const cur = onsets[idx];
  const nextStart = idx + 1 < onsets.length ? onsets[idx + 1].start : Infinity;
  const noteEnd = typeof cur.end === "number" && cur.end > cur.start ? cur.end : cur.start + ONSET_HOLD_MS;
  // Hold open for the note's length (bounded by the next syllable). No hard cap — a
  // sustained note keeps the mouth open — but the tail closes to articulate the pop.
  const playingEnd = Math.min(noteEnd, nextStart);
  if (progressMs >= playingEnd) return false; // note ended → rest → closed
  const noteLen = playingEnd - cur.start;
  const close = Math.min(FRAME_CLOSE_MAX_MS, Math.max(FRAME_CLOSE_MIN_MS, noteLen * FRAME_CLOSE_FRACTION));
  return progressMs < playingEnd - close; // open through the body; closed for the tail
}

/**
 * Frame decision for a beat-driven 2-frame cat (Bongo): swap the two frames once
 * per beat (alternating by beat parity), matching the original looping bongo (one
 * paw flap per beat). Runs off the beat *clock*, which has no playback-rate floor,
 * so very slow BPMs animate correctly instead of hitting a minimum.
 */
export function beatFrameOpen(progressSec: number, feltBpm: number): boolean {
  const bpm = feltBpm > 0 ? feltBpm : PULSE_DEFAULT_BPM;
  const beatDur = 60 / bpm;
  return beatDur > 0 && Math.floor(progressSec / beatDur) % 2 === 1;
}

const now = (): number =>
  typeof performance !== "undefined" && performance.now ? performance.now() : Date.now();

const OFF_CONFIG: PulseConfig = {
  brightness: false,
  scale: false,
  brightnessIntensity: 0,
  scaleIntensity: 0,
};

/**
 * The rAF-driven animator. Reads the (stair-stepped) playback clock each frame,
 * extrapolates with wall-time between samples for smoothness, then writes
 * `filter: brightness()` (which respects the cat's alpha — shape-correct, no box)
 * and `transform: <base> scale()` on the video. Config + play state are pushed in
 * (never polled in the loop), DOM writes are dirty-checked, and the loop is
 * throttled to ~30fps.
 */
export function createVideoPulse(player: PlayerClock): VideoPulse {
  let video: CatMedia | null = null;
  let baseTransform = "";
  // Optional mirror cat: a second element driven in lock-step — same brightness, the
  // same bounce composed onto its own (flipped/offset) rest transform, and its
  // playback frame-locked to the main so the two cats stay on the same frame.
  let mirror: CatMedia | null = null;
  let mirrorBase = "";
  let lastMirrorFilter = "";
  let lastMirrorTransform = "";
  let lastMirrorSeekAt = -Infinity; // throttles the mirror's currentTime re-seat (a seek)
  let feltBpm: number | undefined;
  let depth = DEFAULT_STAT;
  let delayMs = 0;
  let onsets: PulseOnset[] | null = null;
  // Separate onsets the mirror cat pops on (background vocals). Null → mirror follows the main frame.
  let mirrorOnsets: PulseOnset[] | null = null;
  let loudnessSampler: ((ms: number) => number) | null = null; // Bongo "follow fluctuations"
  let playing = false; // pushed via setPlaying (event-driven, not polled)
  let raf: number | null = null;
  // "Animate per pulse": drive the 2-frame clip's frame off syllables, not the beat.
  let syllableFrames = false;
  let lastFrameKind = -1; // 0 = resting frame, 1 = open frame; -1 forces the first swap
  let lastMirrorFrameKind = -1; // the mirror's own frame state (so it can diverge from the main)
  let frames: { closed: string; open: string } | null = null; // set for an <img> source (Pop Cat)

  // Extrapolated clock: anchor once, then advance with wall-time, re-anchoring
  // only on a seek. Between Spotify's coarse progress ticks the pulse runs off
  // performance.now(), so it eases back to rest without stutter.
  let anchorMs = 0;
  let anchorWall = now();
  let clockPlaying = false; // false → next playing frame re-anchors (fresh/after pause)
  let idle = false; // true once we've reset to rest, to skip rework

  // Config is pushed via setConfig (once per song / on Apply) — never read in the
  // frame loop. Last-written strings let us skip DOM writes on unchanged frames.
  let config: PulseConfig = OFF_CONFIG;
  let lastFrameAt = 0; // for the fps throttle
  let lastFilter = "";
  let lastTransform = "";

  function reset(): void {
    if (video) {
      video.style.filter = "";
      video.style.transform = baseTransform;
      lastFilter = "";
      lastTransform = baseTransform;
    }
    if (mirror) {
      mirror.style.filter = "";
      mirror.style.transform = mirrorBase;
      lastMirrorFilter = "";
      lastMirrorTransform = mirrorBase;
    }
  }

  // Keep the mirror's playback locked to the main: same rate + play state (both
  // cheap, every frame), and a drift-corrected currentTime (a seek — throttled).
  function syncMirrorPlayback(t: number): void {
    // Only reached in <video> (looping) mode — the image source never calls this.
    const m = mirror as HTMLVideoElement | null;
    const v = video as HTMLVideoElement | null;
    if (!m || !v) return;
    if (m.playbackRate !== v.playbackRate) m.playbackRate = v.playbackRate;
    if (v.paused) {
      if (!m.paused) m.pause();
    } else if (m.paused) {
      const p = m.play();
      if (p && typeof p.catch === "function") p.catch(() => {});
    }
    // The currentTime write is the expensive part (decode/seek) — only correct real
    // drift, and no more than once per interval, so it can't churn the decoder.
    if (t - lastMirrorSeekAt >= MIRROR_SEEK_INTERVAL_MS) {
      lastMirrorSeekAt = t;
      if (Math.abs(m.currentTime - v.currentTime) > MIRROR_DRIFT_S) {
        m.currentTime = v.currentTime;
      }
    }
  }

  // Mirror the main's brightness + bounce onto the mirror's own rest transform.
  function applyMirror(filterStr: string, sx: number, sy: number, scaleOn: boolean): void {
    const m = mirror;
    if (!m) return;
    if (filterStr !== lastMirrorFilter) {
      m.style.filter = filterStr;
      lastMirrorFilter = filterStr;
    }
    const mt = scaleOn
      ? `${mirrorBase} scale(${sx.toFixed(4)}, ${sy.toFixed(4)})`.trim()
      : mirrorBase;
    if (mt !== lastMirrorTransform) {
      m.style.transform = mt;
      lastMirrorTransform = mt;
    }
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

  // Write the brightness filter + bounce transform (and mirror) for the given
  // envelopes. Shared by the beat/onset path and the per-pulse frame path.
  function paint(
    cfg: PulseConfig,
    brightnessEnv: number,
    scaleEnv: number,
    brightnessDimScale: number,
    scaleOverride?: { sx: number; sy: number }
  ): void {
    if (!video) return;
    const filterStr = cfg.brightness
      ? `brightness(${brightnessFor(brightnessEnv, depth, cfg.brightnessIntensity, true, brightnessDimScale).toFixed(3)})`
      : "";
    if (filterStr !== lastFilter) {
      video.style.filter = filterStr;
      lastFilter = filterStr;
    }
    // scaleOverride lets a caller supply its own sx/sy (e.g. Pop Cat's squash & stretch);
    // otherwise the standard upward bounce (sy from scaleFor, slight sx lean).
    const sy = scaleOverride ? scaleOverride.sy : scaleFor(scaleEnv, depth, cfg.scaleIntensity, true);
    const sx = scaleOverride ? scaleOverride.sx : 1 + (sy - 1) * SCALE_ANGLE_RATIO;
    const transformStr = cfg.scale
      ? `${baseTransform} scale(${sx.toFixed(4)}, ${sy.toFixed(4)})`.trim()
      : baseTransform;
    if (transformStr !== lastTransform) {
      video.style.transform = transformStr;
      lastTransform = transformStr;
    }
    applyMirror(filterStr, sx, sy, cfg.scale);
  }

  // Show a specific frame of a paused clip. A paused <video> in Spotify's Chromium
  // won't repaint on a programmatic currentTime change, so we seek then micro-play
  // for one animation frame (playing always paints) and re-pause — landing on, and
  // holding, the target frame. Seeks to the middle of the frame's window so an edge
  // seek can't round to the neighbour, and the ~1-frame play can't cross into it.
  function showFrame(el: HTMLVideoElement, target: number): void {
    try {
      el.currentTime = target;
    } catch {
      return; // metadata not ready — the next state change retries
    }
    const p = el.play();
    if (p && typeof p.then === "function") p.catch(() => {});
    requestAnimationFrame(() => {
      try {
        el.pause();
      } catch {
        /* ignore */
      }
    });
  }

  // Per-pulse frame driver: resting frame between syllables, open frame while one
  // sounds. Only acts on a state change. For an image source (Pop Cat) it swaps the
  // <img> src (instant, reliable); a <video> source falls back to the seek path.
  // Put one element on frame `kind` (1 = open/singing, 0 = resting): an <img> src swap for Pop/Bongo,
  // else a seek to the middle of the clip's frame for a <video> source.
  function setFrameOn(el: CatMedia, kind: number): void {
    if (frames) {
      const src = kind === 1 ? frames.open : frames.closed;
      const img = el as HTMLImageElement;
      if (img.src !== src) img.src = src;
      return;
    }
    const v = el as HTMLVideoElement;
    const dur = Number.isFinite(v.duration) && v.duration > 0 ? v.duration : 0.4;
    showFrame(v, kind === 1 ? dur * 0.75 : dur * 0.25); // middle of frame 2 / frame 1
  }

  function driveMainFrame(open: boolean): void {
    if (!video) return;
    const kind = open ? 1 : 0;
    if (kind === lastFrameKind) return;
    lastFrameKind = kind;
    setFrameOn(video, kind);
  }

  // The mirror has its OWN frame state so it can sing a different part (background vocals) than the
  // main cat; when `mirrorOnsets` is null the caller passes the main's open-state, so it mirrors.
  function driveMirrorFrame(open: boolean): void {
    if (!mirror) return;
    const kind = open ? 1 : 0;
    if (kind === lastMirrorFrameKind) return;
    lastMirrorFrameKind = kind;
    setFrameOn(mirror, kind);
  }

  function frame(): void {
    raf = requestAnimationFrame(frame);
    if (!video) return;
    const t = now();
    if (t - lastFrameAt < FRAME_INTERVAL_MS) return; // fps throttle
    lastFrameAt = t;
    const cfg = config; // pushed via setConfig — no localStorage in the loop
    // Image sources drive the mirror's frame themselves (via the image swap); the
    // video play-state sync only applies to the looping <video> sources.
    if (!frames) syncMirrorPlayback(t);

    // Image sources (2-frame cats): the frame is driven off the pulse — by syllables
    // for Pop Cat (syllableFrames), else by the beat for Bongo. The bounce/brightness
    // still follow the beat. Freezes the current frame when paused / on a non-track.
    if (frames) {
      if (!playing || depth <= 0) {
        clockPlaying = false;
        if (!idle) {
          reset(); // rest the brightness/bounce; the paused frame stays put
          idle = true;
        }
        return;
      }
      idle = false;
      const ms = estProgressMs();
      const felt = feltBpm ?? PULSE_DEFAULT_BPM;
      const phase = beatPhase((ms - delayMs) / 1000, felt);
      const beatOpen = beatFrameOpen((ms - delayMs) / 1000, felt);
      // Pop Cat → mouth follows the sung syllable; Bongo → one paw-flap per beat (parity). When Pop has
      // NO lyric onsets at all (an un-timed / lyric-less track), its mouth falls back to the beat so it
      // still pops instead of sitting shut — but once onsets exist it tracks them (resting through the
      // instrumental gaps, as designed), never the beat.
      const haveOnsets = !!(onsets && onsets.length);
      const mainOpen = syllableFrames ? (haveOnsets ? syllableFrameOpen(ms, onsets) : beatOpen) : beatOpen;
      driveMainFrame(mainOpen);
      // The mirror pops on its OWN (background-vocal) onsets when set — so it can sing a different
      // part than the main cat — otherwise it follows the main cat's frame.
      driveMirrorFrame(mirrorOnsets && mirrorOnsets.length ? syllableFrameOpen(ms, mirrorOnsets) : mainOpen);
      // Brightness/bounce for a 2-frame cat:
      //   • Pop Cat rests at natural brightness and *dips* on the beat (darken-bop).
      //   • Bongo follows the live audio loudness when a sampler is set (visualizer mode),
      //     else the lyric syllables when available, else the beat.
      const beatBright = beatEnvelope(phase, BRIGHTNESS_SHARPNESS);
      if (syllableFrames) {
        // Pop Cat follows the BEAT (every other beat, off a half-tempo phase), independent
        // of the lyrics — only the mouth frame tracks the sung words. The bounce is a
        // squash & stretch (stretch on the beat, squash just after), with a shallow
        // brightness dip. Amplitude still respects song strength + the intensity slider.
        const halfPhase = beatPhase((ms - delayMs) / 1000, felt / 2);
        // Min (chill) sits at 0.6 of max rather than dropping with the max cut, so low-
        // danceability still bounces visibly; high-danceability reaches the full (halved) max.
        const amp = clamp01(cfg.scaleIntensity) * (0.6 + 0.4 * strengthCurve(depth));
        const stretch = beatEnvelope(halfPhase, SCALE_SHARPNESS);
        const squash = beatEnvelope(halfPhase - POP_SQUASH_DELAY, SCALE_SHARPNESS);
        const v = cfg.scale ? amp * (POP_STRETCH * stretch - POP_SQUASH * squash) : 0; // signed Δheight
        // Brightness + bounce are the BEAT pulse, SHARED by both cats (paint → applyMirror writes the
        // same transform/filter to the mirror). Only the mouth frame diverges per who's singing — the
        // main pops on `onsets`, the mirror on `mirrorOnsets` (driveMainFrame/driveMirrorFrame above).
        paint(cfg, 1 - beatEnvelope(halfPhase, BRIGHTNESS_SHARPNESS), 0, POP_DIM_SCALE, { sy: 1 + v, sx: 1 - v * POP_VOLUME });
      } else if (loudnessSampler) {
        const l = clamp01(loudnessSampler(ms)); // exact audio fluctuation → pulse strength
        paint(cfg, l, l, 1);
      } else if (onsets && onsets.length) {
        const artic = onsetArticulation(ms, onsets);
        paint(cfg, sustainEnvelope(ms, onsets) * (1 - ARTIC_DEPTH * artic), onsetEnvelope(ms, onsets), 1);
      } else {
        paint(cfg, beatBright, beatEnvelope(phase, SCALE_SHARPNESS), BEAT_DIM_SCALE);
      }
      return;
    }

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
    const phase = beatPhase((ms - delayMs) / 1000, feltBpm ?? PULSE_DEFAULT_BPM);
    let brightnessEnv: number;
    let scaleEnv: number;
    let brightnessDimScale = 1; // lyric modes dip fully to the dark base
    if (onsets && onsets.length) {
      // Syllable brightness: stay lit while singing (sustain), dip lightly at each
      // onset to articulate — so dense syllables hold mostly lit instead of strobing;
      // it dims only in real gaps. The bounce still holds each note.
      const artic = onsetArticulation(ms, onsets);
      brightnessEnv = sustainEnvelope(ms, onsets) * (1 - ARTIC_DEPTH * artic);
      scaleEnv = onsetEnvelope(ms, onsets);
    } else {
      // Beat-driven: peak on the beat, offset by the track's manual sync delay.
      // The env still reaches 1 on the beat (natural); the smaller dimScale makes
      // it dip less between beats — mellower than lyric mode.
      brightnessEnv = beatEnvelope(phase, BRIGHTNESS_SHARPNESS);
      scaleEnv = beatEnvelope(phase, SCALE_SHARPNESS); // snappier bounce
      brightnessDimScale = BEAT_DIM_SCALE;
    }
    // brightness() respects the cat's alpha (shape-correct, no box); peak is 1 (natural).
    paint(cfg, brightnessEnv, scaleEnv, brightnessDimScale);
  }

  return {
    attach(v: CatMedia | null): void {
      if (video && video !== v) reset();
      video = v;
      idle = false;
      clockPlaying = false; // re-anchor against the freshly mounted video
      lastFilter = "";
      lastTransform = "";
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
    setTrack(bpm: number | undefined, d: number, delay = 0): void {
      feltBpm = typeof bpm === "number" && bpm > 0 ? bpm : undefined;
      depth = clamp01(d);
      delayMs = Number.isFinite(delay) ? delay : 0;
      // Onsets are managed separately (setOnsets) so a post-analysis tempo update
      // doesn't wipe a driver's freshly-fetched onsets.
    },
    setOnsets(o: PulseOnset[] | null): void {
      onsets = o && o.length ? [...o].sort((a, b) => a.start - b.start) : null;
    },
    setMirrorOnsets(o: PulseOnset[] | null): void {
      mirrorOnsets = o && o.length ? [...o].sort((a, b) => a.start - b.start) : null;
      lastMirrorFrameKind = -1; // re-assert the mirror's frame against the new (or cleared) stream
    },
    setSyllableFrames(on: boolean): void {
      if (on === syllableFrames) return;
      syllableFrames = on;
      lastFrameKind = -1; // force the next driveFrames to set the correct frame
      idle = false; // re-evaluate on the next frame (may need to paint/swap)
    },
    setFrames(f: { closed: string; open: string } | null): void {
      frames = f;
      lastFrameKind = -1; // re-assert the frame against the new image set
      lastMirrorFrameKind = -1;
    },
    setLoudness(sampler: ((ms: number) => number) | null): void {
      loudnessSampler = sampler;
      idle = false; // re-evaluate on the next frame
    },
    setConfig(c: PulseConfig): void {
      config = c;
    },
    setPosition(transform: string): void {
      baseTransform = transform || "";
      if (!video) return;
      // Force the next active frame to re-compose scale on the new base; if the
      // pulse is resting/idle, apply the new base position right away.
      lastTransform = "";
      if (idle) {
        video.style.transform = baseTransform;
        lastTransform = baseTransform;
      }
    },
    setMirror(m: CatMedia | null): void {
      mirror = m;
      lastMirrorFilter = "";
      lastMirrorTransform = "";
      lastMirrorFrameKind = -1; // force the mirror's frame to re-assert on the next loop
      lastMirrorSeekAt = -Infinity; // sync the freshly-attached mirror on the next frame
      if (m) {
        mirrorBase = m.style.transform || "";
        // center-bottom (not left-bottom): with scaleX(-1) a left origin draws the
        // flipped cat a full width to the *left* of its box; center keeps it in place.
        m.style.transformOrigin = "center bottom";
        m.style.willChange = "transform, filter";
      } else {
        mirrorBase = "";
      }
    },
    setPlaying(p: boolean): void {
      playing = p;
    },
    stop(): void {
      if (raf !== null) {
        cancelAnimationFrame(raf);
        raf = null;
      }
      reset();
      video = null;
      mirror = null;
    },
  };
}
