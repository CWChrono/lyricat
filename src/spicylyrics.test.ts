import { describe, it, expect, vi } from "vitest";
import {
  collectStartTimes,
  onsetsFromLyrics,
  createSpicyOnsetReader,
  SpicyLyricsApi,
} from "./spicylyrics";

// A trimmed shape of Spicy Lyrics' ParsedSyllableLyrics (times in seconds).
const syllableLyrics = {
  Type: "Syllable",
  StartTime: 1.0,
  EndTime: 30.0,
  Content: [
    {
      Type: "Vocal",
      Lead: {
        StartTime: 1.0,
        EndTime: 3.0,
        Syllables: [
          { Text: "Let", StartTime: 1.0, EndTime: 1.4 },
          { Text: "me", StartTime: 1.5, EndTime: 1.8 },
          { Text: "be", StartTime: 2.0, EndTime: 2.6 },
        ],
      },
      Background: [{ StartTime: 2.1, EndTime: 2.5, Syllables: [{ Text: "ooh", StartTime: 2.1, EndTime: 2.5 }] }],
    },
  ],
};

describe("collectStartTimes", () => {
  it("harvests every StartTime (lead, syllables, background), ignoring EndTime", () => {
    const times = collectStartTimes(syllableLyrics).sort((a, b) => a - b);
    expect(times).toEqual([1.0, 1.0, 1.0, 1.5, 2.0, 2.1, 2.1]);
    expect(times).not.toContain(1.4); // EndTime excluded
  });
  it("is safe on empty / non-object input", () => {
    expect(collectStartTimes(null)).toEqual([]);
    expect(collectStartTimes("nope")).toEqual([]);
    expect(collectStartTimes({ Type: "Static", Lines: [{ Text: "x" }] })).toEqual([]);
  });
});

describe("onsetsFromLyrics", () => {
  it("returns sorted, de-duplicated onsets in ms (seconds normalized ×1000)", () => {
    expect(onsetsFromLyrics(syllableLyrics)).toEqual([1000, 1500, 2000, 2100]);
  });
  it("leaves millisecond-scale data unscaled", () => {
    const ms = { Content: [{ StartTime: 1000 }, { StartTime: 90000 }] };
    expect(onsetsFromLyrics(ms)).toEqual([1000, 90000]);
  });
  it("returns null for unsynced / too-few onsets", () => {
    expect(onsetsFromLyrics({ Type: "Static", Lines: [{ Text: "a" }] })).toBeNull();
    expect(onsetsFromLyrics({ StartTime: 5 })).toBeNull(); // only one
    expect(onsetsFromLyrics(null)).toBeNull();
  });
});

describe("createSpicyOnsetReader", () => {
  const api: SpicyLyricsApi = {
    db: { objectStores: { lyricsStore: { manager: { get: vi.fn().mockResolvedValue(syllableLyrics) } } } },
  };

  it("returns onsets when enabled and the cache has the track", async () => {
    const read = createSpicyOnsetReader(() => true, () => api);
    expect(await read("spotify:track:x")).toEqual([1000, 1500, 2000, 2100]);
  });
  it("no-ops (null) when disabled — without touching the API", async () => {
    const get = vi.fn();
    const read = createSpicyOnsetReader(() => false, () => ({ db: { objectStores: { lyricsStore: { manager: { get } } } } }));
    expect(await read("spotify:track:x")).toBeNull();
    expect(get).not.toHaveBeenCalled();
  });
  it("null when Spicy Lyrics is absent", async () => {
    const read = createSpicyOnsetReader(() => true, () => undefined);
    expect(await read("spotify:track:x")).toBeNull();
  });
  it("null on a cache miss or DB error (falls back to the beat)", async () => {
    const miss = createSpicyOnsetReader(() => true, () => ({ db: { objectStores: { lyricsStore: { manager: { get: vi.fn().mockResolvedValue(null) } } } } }));
    expect(await miss("spotify:track:x")).toBeNull();
    const boom = createSpicyOnsetReader(() => true, () => ({ db: { objectStores: { lyricsStore: { manager: { get: vi.fn().mockRejectedValue(new Error("db")) } } } } }));
    expect(await boom("spotify:track:x")).toBeNull();
  });
});
