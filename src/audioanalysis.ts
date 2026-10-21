// Taps Spotify's *internal* audio analysis — the same source Konsl's visualizer uses,
// reached through the desktop client's authenticated Cosmos channel (NOT the deprecated
// public Web API). The `segments` array carries a loudness envelope per moment of the
// track, which drives two things:
//   • Bongo's pulse following the exact audio fluctuations (loudnessAt), and
//   • loudness-onset timing for word/syllable detection inside a lyric line (segmentOnsets).
// Everything here is pure parsing + math over an injected fetch, so it's unit-testable
// and falls back cleanly (null) whenever the endpoint is unavailable.

/** A Spotify analysis segment, loudness in dB, times in seconds. */
export interface Segment {
  start: number;
  duration: number;
  loudnessStart: number; // dB at the segment's start
  loudnessMax: number; // dB peak within the segment
  loudnessMaxTime: number; // seconds into the segment where the peak lands
  loudnessEnd: number; // dB at the segment's end (often 0 → use the next start)
}

export type CosmosGet = (url: string) => Promise<unknown>;

const ANALYSIS_URL = (id: string) =>
  `https://spclient.wg.spotify.com/audio-attributes/v1/audio-analysis/${encodeURIComponent(id)}?format=json`;

// Loudness is in dB (≤ 0). Map a floor…0 window to 0…1 for the pulse. Quiet passages
// sit near 0, peaks near 1.
const DB_FLOOR = -32;

/** Normalize a dB loudness value to [0,1] over [DB_FLOOR, 0]. */
export function normalizeDb(db: number): number {
  if (!Number.isFinite(db)) return 0;
  return Math.min(1, Math.max(0, (db - DB_FLOOR) / -DB_FLOOR));
}

function num(v: unknown, fallback = 0): number {
  return typeof v === "number" && Number.isFinite(v) ? v : fallback;
}

/** Parse the raw analysis JSON into sorted segments, or null if it isn't analysis. */
export function parseSegments(raw: unknown): Segment[] | null {
  const arr = (raw as { segments?: unknown })?.segments;
  if (!Array.isArray(arr) || arr.length < 2) return null;
  const segs: Segment[] = [];
  for (const s of arr) {
    if (!s || typeof s !== "object") continue;
    const r = s as Record<string, unknown>;
    if (typeof r.start !== "number") continue;
    segs.push({
      start: num(r.start),
      duration: num(r.duration),
      loudnessStart: num(r.loudness_start),
      loudnessMax: num(r.loudness_max),
      loudnessMaxTime: num(r.loudness_max_time),
      loudnessEnd: num(r.loudness_end),
    });
  }
  segs.sort((a, b) => a.start - b.start);
  return segs.length >= 2 ? segs : null;
}

/** Beat start times (ms), sorted — the analysis's beat grid. */
export function parseBeats(raw: unknown): number[] {
  const arr = (raw as { beats?: unknown })?.beats;
  if (!Array.isArray(arr)) return [];
  const out: number[] = [];
  for (const b of arr) {
    const s = (b as { start?: unknown })?.start;
    if (typeof s === "number" && Number.isFinite(s)) out.push(Math.round(s * 1000));
  }
  return out.sort((a, b) => a - b);
}

/** Whether `ms` lands within `eps` of any beat — i.e. likely a percussive hit. */
export function nearBeat(ms: number, beats: readonly number[], eps: number): boolean {
  if (beats.length === 0) return false;
  let lo = 0;
  let hi = beats.length - 1;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (beats[mid] < ms) lo = mid + 1;
    else hi = mid;
  }
  const dist = Math.min(Math.abs(beats[lo] - ms), lo > 0 ? Math.abs(beats[lo - 1] - ms) : Infinity);
  return dist <= eps;
}

/** Index of the segment covering `timeSec` (last whose start ≤ time), or -1. */
function segmentIndexAt(segments: readonly Segment[], timeSec: number): number {
  let lo = 0;
  let hi = segments.length - 1;
  let idx = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (segments[mid].start <= timeSec) {
      idx = mid;
      lo = mid + 1;
    } else {
      hi = mid - 1;
    }
  }
  return idx;
}

/**
 * Interpolated loudness (dB) at a time (seconds): rise from loudnessStart to loudnessMax
 * over the first loudnessMaxTime of the segment, then fall to loudnessEnd (or the next
 * segment's start when end is 0/unset) across the remainder — the classic analysis curve.
 */
export function loudnessDbAt(segments: readonly Segment[], timeSec: number): number {
  if (!segments.length) return DB_FLOOR;
  const i = segmentIndexAt(segments, timeSec);
  if (i < 0) return DB_FLOOR;
  const s = segments[i];
  const t = timeSec - s.start;
  const peakAt = s.loudnessMaxTime > 0 ? s.loudnessMaxTime : s.duration * 0.25;
  if (t <= peakAt) {
    const k = peakAt > 0 ? t / peakAt : 1;
    return s.loudnessStart + (s.loudnessMax - s.loudnessStart) * k;
  }
  const nextStart = i + 1 < segments.length ? segments[i + 1].loudnessStart : s.loudnessEnd || s.loudnessMax;
  const tail = s.duration - peakAt;
  const k = tail > 0 ? Math.min(1, (t - peakAt) / tail) : 1;
  return s.loudnessMax + (nextStart - s.loudnessMax) * k;
}

/** Normalized [0,1] instantaneous loudness at a playback position (ms). */
export function loudnessAt(segments: readonly Segment[], ms: number): number {
  return normalizeDb(loudnessDbAt(segments, ms / 1000));
}

// A boundary within this of a beat is treated as percussion (not a new-word trigger).
const BEAT_SUPPRESS_MS = 70;
// Merge onsets closer than this — de-jitters the word pops.
const MIN_ONSET_GAP_MS = 90;
// How far a guessed word onset may move to meet a real (off-beat) audio boundary.
const SNAP_WINDOW_MS = 160;

/**
 * The nearest off-beat segment boundary (ms) to `timeMs`, within the snap window, or
 * null if there isn't one close. This is the per-word "decision": keep the text-derived
 * word count/positions (the guesstimate graph), but nudge each word onto a real vocal-ish
 * boundary — never creating extra onsets. Beat-aligned boundaries (drums) are skipped.
 */
export function snapToSegment(
  segments: readonly Segment[],
  timeMs: number,
  beats?: readonly number[],
  windowMs: number = SNAP_WINDOW_MS
): number | null {
  let best: number | null = null;
  let bestD = windowMs;
  for (const s of segments) {
    const b = Math.round(s.start * 1000);
    if (beats && beats.length && nearBeat(b, beats, BEAT_SUPPRESS_MS)) continue; // skip drums
    const d = Math.abs(b - timeMs);
    if (d <= bestD) {
      bestD = d;
      best = b;
    }
  }
  return best;
}

/**
 * Candidate note/syllable onset times (ms) in [startMs, endMs) — the segment *boundaries*,
 * which Spotify places on timbre/pitch changes (vowel/consonant shifts), not just energy.
 *
 * With `count` given, we do NOT pick the loudest segments — in a mix with drums the loudest
 * boundaries are the kick/snare, so loudness-ranking would sync to the beat, not the words.
 * Instead the syllable `count` (from the text) sets the rhythm, and each syllable's evenly-
 * spaced expected time is snapped to the nearest boundary. When `beats` are supplied, beat-
 * aligned boundaries are *dropped from the snap pool* (they're likely drums, a continuation
 * of the current word rather than a new one), so pops land on off-beat/vocal boundaries —
 * dampening the beat jitter. Onsets closer than MIN_ONSET_GAP_MS are merged. Sorted, deduped.
 */
export function segmentOnsets(
  segments: readonly Segment[],
  startMs: number,
  endMs: number,
  count?: number,
  beats?: readonly number[]
): number[] {
  const startSec = startMs / 1000;
  const endSec = endMs / 1000;
  const starts: number[] = [];
  for (const s of segments) {
    if (s.start >= startSec && s.start < endSec) starts.push(Math.round(s.start * 1000));
  }
  if (starts.length === 0) return [];
  if (count === undefined || count >= starts.length) return starts;
  // Prefer off-beat boundaries; fall back to all if suppression leaves too few.
  const offBeat = beats && beats.length ? starts.filter((s) => !nearBeat(s, beats, BEAT_SUPPRESS_MS)) : starts;
  const pool = offBeat.length >= count ? offBeat : starts;
  const dur = endMs - startMs;
  const picked = new Set<number>();
  for (let j = 0; j < count; j++) {
    const target = startMs + (dur * (j + 0.5)) / count; // the j-th syllable's expected time
    let best = pool[0];
    let bestD = Infinity;
    for (const t of pool) {
      const d = Math.abs(t - target);
      if (d < bestD) {
        bestD = d;
        best = t;
      }
    }
    picked.add(best);
  }
  const out: number[] = [];
  for (const t of [...picked].sort((a, b) => a - b)) {
    if (out.length === 0 || t - out[out.length - 1] >= MIN_ONSET_GAP_MS) out.push(t); // de-jitter
  }
  return out;
}

/** Parsed analysis for a track: the loudness segments + the beat grid. */
export interface AudioAnalysis {
  segments: Segment[];
  beats: number[]; // ms
}

/**
 * Segment boundary times (ms) in [startMs, endMs) that are NOT beat-aligned — i.e. the
 * timbre/pitch-change events that are more likely vocal onsets than percussion. Sorted.
 * These are the real acoustic events a line's words get aligned onto.
 */
export function offBeatBoundaries(
  segments: readonly Segment[],
  startMs: number,
  endMs: number,
  beats?: readonly number[]
): number[] {
  const out: number[] = [];
  const startSec = startMs / 1000;
  const endSec = endMs / 1000;
  for (const s of segments) {
    if (s.start < startSec || s.start >= endSec) continue;
    const b = Math.round(s.start * 1000);
    if (beats && beats.length && nearBeat(b, beats, BEAT_SUPPRESS_MS)) continue;
    out.push(b);
  }
  return out;
}

// A line's nominal end often runs past where the voice actually stops — the rest is the
// beat/instrumental bed. These tune how early we close the mouth by watching the vocal taper:
const TAPER_DROP_DB = 6; // within this of the line's vocal peak still counts as "singing"…
const VOCAL_RELEASE_MS = 150; // …plus a short release so it doesn't snap shut mid-syllable.
const MIN_SUNG_MS = 300; // never clip a line's sung span below this (guards genuinely short lines).

/**
 * Where a line's *vocal* actually ends (ms), judged by the loudness taper with the beat
 * excluded — so a trailing instrumental/drum bed after the singing doesn't hold the mouth open.
 * Reference = the loudest off-beat (vocal-ish) segment in the line; the sung region extends to
 * the last off-beat segment still within TAPER_DROP_DB of that peak, plus a short release.
 * Clamps *harder* toward an early close (better the mouth shuts early than gapes through the
 * backing track). Returns the nominal `endMs` unchanged when there's no beat grid to subtract
 * or no off-beat loudness to judge against.
 */
export function vocalEndMs(
  segments: readonly Segment[],
  beats: readonly number[] | undefined,
  startMs: number,
  endMs: number
): number {
  if (!segments.length || !beats || !beats.length || endMs <= startMs) return endMs;
  const startSec = startMs / 1000;
  const endSec = endMs / 1000;
  let refDb = -Infinity;
  for (const s of segments) {
    if (s.start < startSec || s.start >= endSec) continue;
    if (nearBeat(Math.round(s.start * 1000), beats, BEAT_SUPPRESS_MS)) continue; // ignore the beat
    if (s.loudnessMax > refDb) refDb = s.loudnessMax;
  }
  if (!Number.isFinite(refDb)) return endMs; // no off-beat energy to reason about → don't clamp
  const threshold = refDb - TAPER_DROP_DB;
  let lastVocalMs = startMs;
  for (const s of segments) {
    if (s.start < startSec || s.start >= endSec) continue;
    const b = Math.round(s.start * 1000);
    if (nearBeat(b, beats, BEAT_SUPPRESS_MS)) continue;
    if (s.loudnessMax >= threshold) lastVocalMs = Math.max(lastVocalMs, b + Math.round(s.duration * 1000));
  }
  const close = Math.max(startMs + MIN_SUNG_MS, lastVocalMs + VOCAL_RELEASE_MS);
  return Math.min(endMs, close);
}

/** Fetch + parse the current track's analysis (segments + beats), or null on any failure. */
export async function fetchAudioAnalysis(id: string, get: CosmosGet): Promise<AudioAnalysis | null> {
  if (!id) return null;
  try {
    const raw = await get(ANALYSIS_URL(id));
    const segments = parseSegments(raw);
    return segments ? { segments, beats: parseBeats(raw) } : null;
  } catch {
    return null;
  }
}
