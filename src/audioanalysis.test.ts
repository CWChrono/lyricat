import { describe, it, expect } from "vitest";
import {
  parseSegments,
  parseBeats,
  nearBeat,
  normalizeDb,
  loudnessDbAt,
  loudnessAt,
  segmentOnsets,
  snapToSegment,
  offBeatBoundaries,
  fetchAudioAnalysis,
  Segment,
} from "./audioanalysis";

const raw = {
  track: {},
  segments: [
    { start: 0, duration: 1, loudness_start: -20, loudness_max: -10, loudness_max_time: 0.5, loudness_end: 0 },
    { start: 1, duration: 1, loudness_start: -30, loudness_max: -6, loudness_max_time: 0.2, loudness_end: 0 },
    { start: 2, duration: 1, loudness_start: -25, loudness_max: -18, loudness_max_time: 0.5, loudness_end: 0 },
  ],
};

describe("parseSegments", () => {
  it("parses the analysis JSON into sorted segments", () => {
    const segs = parseSegments(raw)!;
    expect(segs).toHaveLength(3);
    expect(segs[1]).toMatchObject({ start: 1, loudnessMax: -6, loudnessMaxTime: 0.2 });
  });
  it("returns null for non-analysis / too-few segments", () => {
    expect(parseSegments(null)).toBeNull();
    expect(parseSegments({ segments: [] })).toBeNull();
    expect(parseSegments({ segments: [{ start: 0 }] })).toBeNull();
  });
});

describe("normalizeDb", () => {
  it("maps the dB floor…0 window to 0…1", () => {
    expect(normalizeDb(0)).toBe(1);
    expect(normalizeDb(-32)).toBe(0);
    expect(normalizeDb(-16)).toBeCloseTo(0.5);
    expect(normalizeDb(-100)).toBe(0); // clamped
  });
});

describe("loudness interpolation", () => {
  const segs = parseSegments(raw)!;
  it("rises to the peak over loudnessMaxTime, then falls toward the next start", () => {
    expect(loudnessDbAt(segs, 0)).toBeCloseTo(-20); // segment start
    expect(loudnessDbAt(segs, 0.5)).toBeCloseTo(-10); // the peak
    // halfway down the tail (0.5→1.0): -10 → next start (-30) → ~-20
    expect(loudnessDbAt(segs, 0.75)).toBeCloseTo(-20);
  });
  it("normalizes to [0,1] at a ms position", () => {
    expect(loudnessAt(segs, 500)).toBeCloseTo(normalizeDb(-10));
  });
});

describe("segmentOnsets", () => {
  const segs = parseSegments(raw)!;
  it("returns all segment boundaries (ms) within a time window when no count", () => {
    expect(segmentOnsets(segs, 0, 3000)).toEqual([0, 1000, 2000]);
  });
  it("snaps `count` evenly-spaced syllable times to the nearest boundary (not the loudest)", () => {
    // count 2 over 0–3000 → targets 750 & 2250 → snap to 1000 & 2000 (NOT the loud seg at 1000 only).
    expect(segmentOnsets(segs, 0, 3000, 2)).toEqual([1000, 2000]);
    // count 3 → targets 500/1500/2500 → 0/1000(or 2000)/2000 → all three boundaries.
    expect(segmentOnsets(segs, 0, 3000, 3)).toEqual([0, 1000, 2000]);
  });
});

describe("parseBeats / nearBeat", () => {
  it("parses beat start times to sorted ms", () => {
    expect(parseBeats({ beats: [{ start: 0.5 }, { start: 0 }, { start: 1.25 }] })).toEqual([0, 500, 1250]);
    expect(parseBeats({})).toEqual([]);
  });
  it("detects whether a time is within eps of a beat", () => {
    const beats = [0, 500, 1000];
    expect(nearBeat(480, beats, 70)).toBe(true); // 20ms from 500
    expect(nearBeat(300, beats, 70)).toBe(false); // 200ms from nearest
  });
});

describe("segmentOnsets beat suppression", () => {
  // boundaries at 0,250,500,750ms; beats at 0,500,1000 → 0 and 500 are on-beat.
  const segs = parseSegments({
    segments: [{ start: 0, duration: 0.25 }, { start: 0.25, duration: 0.25 }, { start: 0.5, duration: 0.25 }, { start: 0.75, duration: 0.25 }],
  })!;
  it("snaps syllables to off-beat boundaries, avoiding beat-aligned (drum) ones", () => {
    expect(segmentOnsets(segs, 0, 1000, 2, [0, 500, 1000])).toEqual([250, 750]);
  });
});

describe("offBeatBoundaries", () => {
  const segs = parseSegments({ segments: [{ start: 0 }, { start: 0.25 }, { start: 0.5 }, { start: 0.75 }] })!;
  it("returns in-window boundaries that aren't beat-aligned", () => {
    expect(offBeatBoundaries(segs, 0, 1000, [0, 500])).toEqual([250, 750]); // 0 & 500 are on-beat
    expect(offBeatBoundaries(segs, 0, 1000)).toEqual([0, 250, 500, 750]); // no beats → all
  });
});

describe("snapToSegment", () => {
  const segs = parseSegments({ segments: [{ start: 0.06 }, { start: 0.54 }, { start: 0.96 }] })!; // 60/540/960ms
  it("snaps to the nearest boundary within the window, else null", () => {
    expect(snapToSegment(segs, 500)).toBe(540);
    expect(snapToSegment(segs, 300)).toBeNull(); // 240ms from 60/540 — out of window
  });
  it("skips beat-aligned boundaries", () => {
    expect(snapToSegment(segs, 500, [540])).toBeNull(); // 540 is on-beat → skipped
  });
});

describe("fetchAudioAnalysis", () => {
  it("fetches via the injected getter and parses segments + beats", async () => {
    const withBeats = { ...raw, beats: [{ start: 0 }, { start: 1 }] };
    const a = await fetchAudioAnalysis("abc", async () => withBeats);
    expect(a?.segments).toHaveLength(3);
    expect(a?.beats).toEqual([0, 1000]);
  });
  it("returns null on a fetch error or empty id", async () => {
    expect(await fetchAudioAnalysis("abc", async () => { throw new Error("blocked"); })).toBeNull();
    expect(await fetchAudioAnalysis("", async () => raw)).toBeNull();
  });
});

// exported type is used (compile-time) so the import isn't dropped
const _typecheck: Segment = { start: 0, duration: 0, loudnessStart: 0, loudnessMax: 0, loudnessMaxTime: 0, loudnessEnd: 0 };
void _typecheck;
