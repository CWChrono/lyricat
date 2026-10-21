import { describe, it, expect } from "vitest";
import {
  hasWordTimestamps,
  fmtLrcTime,
  parseWordLrc,
  serializeWordLrc,
  wordOnsets,
  mirrorWordOnsets,
  LrcWord,
} from "./lrcwords";

describe("hasWordTimestamps", () => {
  it("detects inline word tags, not plain line-synced LRC", () => {
    expect(hasWordTimestamps("[00:01.00] <00:01.00> hi")).toBe(true);
    expect(hasWordTimestamps("[00:01.00] hello world")).toBe(false);
  });
});

describe("fmtLrcTime", () => {
  it("formats ms as mm:ss.cc", () => {
    expect(fmtLrcTime(0)).toBe("00:00.00");
    expect(fmtLrcTime(1250)).toBe("00:01.25");
    expect(fmtLrcTime(95_010)).toBe("01:35.01");
  });
});

describe("parseWordLrc", () => {
  it("reads explicit [start, end] windows (gaps allowed)", () => {
    const words = parseWordLrc("[00:01.00] <00:01.00> hello <00:01.40> <00:02.00> world <00:02.30>");
    expect(words).toEqual([
      { text: "hello", start: 1000, end: 1400 },
      { text: "world", start: 2000, end: 2300 },
    ]);
  });
  it("treats a gapless file's end as the next word's start", () => {
    const words = parseWordLrc("[00:01.00] <00:01.00> a <00:01.50> b <00:02.00>");
    expect(words).toEqual([
      { text: "a", start: 1000, end: 1500 },
      { text: "b", start: 1500, end: 2000 },
    ]);
  });
  it("flattens across lines, sorted by start", () => {
    const words = parseWordLrc("[00:03.00] <00:03.00> c <00:03.30>\n[00:01.00] <00:01.00> a <00:01.30>");
    expect(words.map((w) => w.text)).toEqual(["a", "c"]);
  });
});

describe("serializeWordLrc / round-trip", () => {
  it("round-trips a flat word list (centisecond precision)", () => {
    const words: LrcWord[] = [
      { text: "one", start: 1000, end: 1300 },
      { text: "two", start: 2000, end: 2450 },
    ];
    expect(parseWordLrc(serializeWordLrc(words))).toEqual(words);
  });
});

describe("wordOnsets", () => {
  it("maps words to start-sorted onset spans using their own ends", () => {
    expect(
      wordOnsets([
        { text: "b", start: 2000, end: 2200 },
        { text: "a", start: 1000, end: 1500 },
      ])
    ).toEqual([
      { start: 1000, end: 1500 },
      { start: 2000, end: 2200 },
    ]);
  });

  it("routes by singer voice, ignoring the lane: main = not-'a', mirror = not-'b'", () => {
    const words: LrcWord[] = [
      { text: "unison", start: 1000, end: 1400 }, // default → BOTH cats
      { text: "unisonBg", start: 1100, end: 1300, secondary: true }, // default but background lane → still BOTH
      { text: "mittens", start: 2000, end: 2600, singer: "a" }, // "a" → mirror only
      { text: "biscuit", start: 2200, end: 2500, singer: "b" }, // "b" → main only
      { text: "mittensBg", start: 2400, end: 2700, secondary: true, singer: "a" }, // "a" in bg lane → mirror only
    ];
    expect(wordOnsets(words)).toEqual([
      { start: 1000, end: 1400 }, // unison
      { start: 1100, end: 1300 }, // unisonBg (lane doesn't matter)
      { start: 2200, end: 2500 }, // biscuit (b)
    ]);
    expect(mirrorWordOnsets(words)).toEqual([
      { start: 1000, end: 1400 }, // unison
      { start: 1100, end: 1300 }, // unisonBg
      { start: 2000, end: 2600 }, // mittens (a)
      { start: 2400, end: 2700 }, // mittensBg (a) — start-sorted
    ]);
  });

  it("a Mittens-only ('a') word never reaches the main cat; a Biscuit-only ('b') never reaches the mirror", () => {
    expect(wordOnsets([{ text: "m", start: 1000, end: 1500, singer: "a" }])).toEqual([]);
    expect(mirrorWordOnsets([{ text: "b", start: 1000, end: 1500, singer: "b" }])).toEqual([]);
  });

  it("round-trips lane + singer through serialize/parse (incl. old-duet mark loading as 'a')", () => {
    const words: LrcWord[] = [
      { text: "x", start: 1000, end: 1400, singer: "a" },
      { text: "y", start: 1500, end: 1800, secondary: true, singer: "b" },
      { text: "z", start: 2000, end: 2300 }, // default
    ];
    const parsed = parseWordLrc(serializeWordLrc(words));
    expect(parsed[0]).toMatchObject({ text: "x", singer: "a" });
    expect(parsed[0].secondary).toBeUndefined();
    expect(parsed[1]).toMatchObject({ text: "y", secondary: true, singer: "b" });
    expect(parsed[2].singer).toBeUndefined();
    expect(parsed[2].secondary).toBeUndefined();
    // Old duet mark (U+2064) must load as singer "a" so pre-existing edits migrate transparently.
    const oldDuet = `[00:01.00] <00:01.00> ${String.fromCharCode(0x2064)}migrated <00:01.40>`;
    expect(parseWordLrc(oldDuet)[0]).toMatchObject({ text: "migrated", singer: "a" });
  });

  it("round-trips the overlapping-main flag through serialize/parse (and composes with singer)", () => {
    const words: LrcWord[] = [
      { text: "staaay", start: 1000, end: 4000, overlap: true }, // a sustained lead note
      { text: "with", start: 1500, end: 1800, overlap: true, singer: "b" },
      { text: "me", start: 2000, end: 2300 },
    ];
    const parsed = parseWordLrc(serializeWordLrc(words));
    expect(parsed[0]).toMatchObject({ text: "staaay", overlap: true });
    expect(parsed[1]).toMatchObject({ text: "with", overlap: true, singer: "b" });
    expect(parsed[2].overlap).toBeUndefined(); // plain word: no flag
    expect(parsed[2].secondary).toBeUndefined();
  });
});
