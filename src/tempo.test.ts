import { describe, it, expect } from "vitest";
import { computePlaybackRate, normalizeTempo, DEFAULT_VIDEO_BPM } from "./tempo";

describe("normalizeTempo", () => {
  it("leaves felt-range tempos untouched", () => {
    expect(normalizeTempo(95)).toBeCloseTo(95); // venus
    expect(normalizeTempo(148)).toBeCloseTo(148); // Mr. Brightside, genuinely fast
    expect(normalizeTempo(120)).toBeCloseTo(120);
  });

  it("halves octave-doubled slow songs", () => {
    expect(normalizeTempo(169.9)).toBeCloseTo(84.95); // War
    expect(normalizeTempo(170)).toBeCloseTo(85); // Heavenmade
    expect(normalizeTempo(150)).toBeCloseTo(75); // at the ceiling, folds
  });

  it("folds repeatedly for extreme values", () => {
    expect(normalizeTempo(340)).toBeCloseTo(85);
  });

  it("passes non-positive / invalid input through unchanged", () => {
    expect(normalizeTempo(0)).toBe(0);
    expect(normalizeTempo(-120)).toBe(-120);
  });
});

describe("computePlaybackRate", () => {
  it("returns 1 when track tempo is null, undefined or invalid", () => {
    expect(computePlaybackRate(null, 135.48)).toBe(1);
    expect(computePlaybackRate(undefined, 135.48)).toBe(1);
    expect(computePlaybackRate(NaN, 135.48)).toBe(1);
    expect(computePlaybackRate(0, 135.48)).toBe(1);
    expect(computePlaybackRate(-120, 135.48)).toBe(1);
    expect(computePlaybackRate(Infinity, 135.48)).toBe(1);
  });

  it("syncs felt-range tempos 1:1 against the video bpm", () => {
    expect(computePlaybackRate(DEFAULT_VIDEO_BPM, DEFAULT_VIDEO_BPM)).toBeCloseTo(1);
    expect(computePlaybackRate(95, DEFAULT_VIDEO_BPM)).toBeCloseTo(0.701); // venus
    expect(computePlaybackRate(148, DEFAULT_VIDEO_BPM)).toBeCloseTo(1.092); // Mr. Brightside
  });

  it("halves octave-doubled tempos before computing the rate", () => {
    // War: 170 -> 85 felt -> 85 / 135.48
    expect(computePlaybackRate(170, DEFAULT_VIDEO_BPM)).toBeCloseTo(0.627);
  });

  it("clamps extreme ratios into [0.5, 2]", () => {
    expect(computePlaybackRate(20, 135.48)).toBeCloseTo(0.5); // far too slow
    expect(computePlaybackRate(140, 60)).toBeCloseTo(2); // 140 < 150, 140/60 -> clamp
  });

  it("falls back to default video bpm when video bpm is invalid", () => {
    expect(computePlaybackRate(135.48, NaN)).toBeCloseTo(1);
    expect(computePlaybackRate(135.48, 0)).toBeCloseTo(1);
  });

  it("honours per-source clamp bounds (e.g. bongo: videoBpm 600, [0.1, 0.35])", () => {
    expect(computePlaybackRate(120, 600, undefined, 0.1, 0.35)).toBeCloseTo(0.2);
    expect(computePlaybackRate(40, 600, undefined, 0.1, 0.35)).toBeCloseTo(0.1); // clamped up
    // no-tempo fallback is clamped into the source range, not a bare 1
    expect(computePlaybackRate(null, 600, undefined, 0.1, 0.35)).toBeCloseTo(0.35);
    expect(computePlaybackRate(null, 135.48)).toBeCloseTo(1); // cat unchanged
  });

  it("honours a manual double-time override over the auto fold", () => {
    // true forces a halve even below the ceiling (140 -> 70)
    expect(computePlaybackRate(140, DEFAULT_VIDEO_BPM, true)).toBeCloseTo(70 / 135.48);
    // false keeps an above-ceiling tempo unfolded (170 stays 170)
    expect(computePlaybackRate(170, DEFAULT_VIDEO_BPM, false)).toBeCloseTo(170 / 135.48);
    // undefined defers to the auto fold (170 -> 85)
    expect(computePlaybackRate(170, DEFAULT_VIDEO_BPM)).toBeCloseTo(85 / 135.48);
  });
});
