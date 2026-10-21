import { describe, it, expect } from "vitest";
import { tokenizeLine, serializeLine, reconcileLine, TimedWord } from "./lineedit";

describe("tokenizeLine", () => {
  it("splits on spaces, slashes, and hyphens; trims + drops blanks", () => {
    expect(tokenizeLine("hello world")).toEqual(["hello", "world"]);
    expect(tokenizeLine("안녕/하세요")).toEqual(["안녕", "하세요"]);
    expect(tokenizeLine("na-na-na")).toEqual(["na", "na", "na"]);
    expect(tokenizeLine("  a //  b -  c ")).toEqual(["a", "b", "c"]); // mixed + collapsed runs
    expect(tokenizeLine("")).toEqual([]);
  });
});

describe("serializeLine", () => {
  it("joins with a delimiter (default ' / ')", () => {
    expect(serializeLine(["안녕", "하세요"])).toBe("안녕 / 하세요");
    expect(serializeLine(["a", "b"], " ")).toBe("a b");
  });
});

describe("reconcileLine", () => {
  const base: TimedWord[] = [
    { text: "I", start: 1000, end: 1200 },
    { text: "love", start: 1200, end: 1600 },
    { text: "you", start: 1600, end: 2000 },
  ];

  it("no change → keeps every word's timing (mode unchanged)", () => {
    const r = reconcileLine(base, ["I", "love", "you"], 1000, 2000);
    expect(r.mode).toBe("unchanged");
    expect(r.words).toEqual([
      { text: "I", start: 1000, end: 1200, from: 0 },
      { text: "love", start: 1200, end: 1600, from: 1 },
      { text: "you", start: 1600, end: 2000, from: 2 },
    ]);
  });

  it("pure deletion → surviving words keep exact timing (gap left behind)", () => {
    const r = reconcileLine(base, ["I", "you"], 1000, 2000);
    expect(r.mode).toBe("surgical");
    expect(r.words).toEqual([
      { text: "I", start: 1000, end: 1200, from: 0 },
      { text: "you", start: 1600, end: 2000, from: 2 }, // unchanged; the 1200–1600 gap just stays empty
    ]);
  });

  it("pure insertion → kept words keep timing; the new word splits the adjacent gap", () => {
    // insert "really" between "I" (ends 1200) and "love" (starts 1200): gap is zero → must rebalance
    const spaced: TimedWord[] = [
      { text: "I", start: 1000, end: 1100 },
      { text: "love", start: 1400, end: 1600 },
    ];
    const r = reconcileLine(spaced, ["I", "really", "love"], 1000, 1600);
    expect(r.mode).toBe("surgical");
    expect(r.words[0]).toEqual({ text: "I", start: 1000, end: 1100, from: 0 });
    expect(r.words[2]).toEqual({ text: "love", start: 1400, end: 1600, from: 1 });
    // "really" fills the whole 1100–1400 gap
    expect(r.words[1].from).toBeNull();
    expect(r.words[1].start).toBe(1100);
    expect(r.words[1].end).toBe(1400);
  });

  it("pure insertion with no room → falls back to rebalance", () => {
    const r = reconcileLine(base, ["I", "really", "love", "you"], 1000, 2000); // I|love contiguous, no gap
    expect(r.mode).toBe("rebalance");
    expect(r.words).toHaveLength(4);
    expect(r.words[0].start).toBe(1000);
    expect(r.words[3].end).toBe(2000);
  });

  it("substitution (add AND remove) → rebalance across the window, weighted by char count", () => {
    const r = reconcileLine(base, ["I", "adore", "you"], 1000, 2200);
    expect(r.mode).toBe("rebalance");
    expect(r.words.map((w) => w.text)).toEqual(["I", "adore", "you"]);
    expect(r.words[0].start).toBe(1000);
    expect(r.words[r.words.length - 1].end).toBe(2200);
    // "adore" (5 chars) should get a wider slot than "I" (1 char)
    const w = r.words.map((x) => x.end - x.start);
    expect(w[1]).toBeGreaterThan(w[0]);
    // matched words still report their origin for flag/roman carry-over
    expect(r.words[0].from).toBe(0);
    expect(r.words[2].from).toBe(2);
  });

  it("reorder → rebalance (both an add and a remove in LCS terms)", () => {
    const r = reconcileLine(
      [
        { text: "a", start: 0, end: 500 },
        { text: "b", start: 500, end: 1000 },
      ],
      ["b", "a"],
      0,
      1000
    );
    expect(r.mode).toBe("rebalance");
    expect(r.words.map((w) => w.text)).toEqual(["b", "a"]);
  });

  it("handles repeated words by position, not collapse", () => {
    const la: TimedWord[] = [
      { text: "la", start: 0, end: 300 },
      { text: "la", start: 300, end: 600 },
      { text: "la", start: 600, end: 900 },
    ];
    const r = reconcileLine(la, ["la", "la"], 0, 900); // drop one "la"
    expect(r.mode).toBe("surgical");
    expect(r.words).toHaveLength(2);
    expect(r.words.map((w) => [w.start, w.end])).toEqual([
      [0, 300],
      [300, 600],
    ]);
  });

  it("CJK re-grouping (merge syllables) rebalances across the line window", () => {
    const syl: TimedWord[] = [
      { text: "안", start: 0, end: 200 },
      { text: "녕", start: 200, end: 400 },
      { text: "하", start: 400, end: 600 },
      { text: "세", start: 600, end: 800 },
      { text: "요", start: 800, end: 1000 },
    ];
    // regroup 5 syllables → 2 words via "/" — a substitution-shaped change → rebalance
    const r = reconcileLine(syl, tokenizeLine("안녕/하세요"), 0, 1000);
    expect(r.mode).toBe("rebalance");
    expect(r.words.map((w) => w.text)).toEqual(["안녕", "하세요"]);
    expect(r.words[0].start).toBe(0);
    expect(r.words[1].end).toBe(1000);
  });
});
