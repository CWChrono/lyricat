export const DEFAULT_VIDEO_BPM = 135.48;

const MIN_RATE = 0.5;
const MAX_RATE = 2;

// Beat detectors report double the felt tempo for slow, sparse songs (an octave
// error) — e.g. keshi's "War" (~85 felt) comes back as ~170. Tempos at/above
// this ceiling are treated as double-time and halved toward the felt pulse.
// It sits just above the fastest tracks that read correctly at 1:1 (~148) and
// below the mis-detected slow ones (~170). Raise it if a genuinely fast song
// gets wrongly halved; lower it to fold more aggressively.
const HALVE_ABOVE_BPM = 150;

function validBpm(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value > 0;
}

/** Fold an octave-doubled tempo back down into the felt range. */
export function normalizeTempo(bpm: number): number {
  if (!validBpm(bpm)) return bpm;
  let felt = bpm;
  while (felt >= HALVE_ABOVE_BPM) felt /= 2;
  return felt;
}

/**
 * The tempo the cat actually dances to. A manual `doubleTime` override wins:
 * true forces a half (the song is double-time), false trusts the raw value.
 * Without an override the automatic octave fold decides.
 */
export function effectiveTempo(bpm: number, doubleTime?: boolean): number {
  if (doubleTime === true) return bpm / 2;
  if (doubleTime === false) return bpm;
  return normalizeTempo(bpm);
}

export function computePlaybackRate(
  trackTempoBpm: number | null | undefined,
  videoDefaultBpm: number,
  doubleTime?: boolean,
  minRate: number = MIN_RATE,
  maxRate: number = MAX_RATE
): number {
  const video = validBpm(videoDefaultBpm) ? videoDefaultBpm : DEFAULT_VIDEO_BPM;
  const clamp = (rate: number) => Math.min(maxRate, Math.max(minRate, rate));
  // No tempo: fall back to the video's native rate, clamped into the source's
  // range (1 for the cat; the ceiling keeps fast-looping videos like bongo sane).
  if (!validBpm(trackTempoBpm)) return clamp(1);
  return clamp(effectiveTempo(trackTempoBpm, doubleTime) / video);
}
