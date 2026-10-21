import { describe, it, expect } from "vitest";
import { countSyllables, wordSyllables, lineWords, splitSyllables, isSyllableTimedText, spansAreLineLevel, expandLineSpans, audioTimedLineSpans, alignToBoundaries, timedLines, LyricSpan } from "./syllables";
import { parseSegments } from "./audioanalysis";

describe("countSyllables", () => {
  it("counts single-nucleus English words", () => {
    expect(countSyllables("cat")).toBe(1);
    expect(countSyllables("apple")).toBe(2);
    expect(countSyllables("go")).toBe(1);
  });
  it("counts adjacent vowels as separate morae (romaji-friendly)", () => {
    // Each vowel is its own mora — romaji "ai"/"ou" = 2, not the English digraph = 1.
    expect(countSyllables("ai")).toBe(2);
    expect(countSyllables("arigatou")).toBe(5); // a-ri-ga-to-u
  });
  it("keeps Korean-RR / glide clusters as one nucleus", () => {
    expect(countSyllables("annyeong")).toBe(2); // an-nyeong ('yeo' is one nucleus)
    expect(countSyllables("seoul")).toBe(2); // seo-ul ('eo' one, 'u' one)
  });
  it("drops a silent trailing English 'e' (but keeps '-le')", () => {
    expect(countSyllables("where")).toBe(1);
    expect(countSyllables("cake")).toBe(1);
    expect(countSyllables("table")).toBe(2); // '-le' stays voiced
    expect(countSyllables("only")).toBe(2); // 'y' counts as a vowel
  });
  it("sums a whole line across its words + separators", () => {
    expect(countSyllables("let me be")).toBe(3);
    expect(countSyllables("balam-i bul-eooneun")).toBeGreaterThanOrEqual(5);
  });
  it("treats each CJK / Hangul / kana character as a syllable", () => {
    expect(countSyllables("사랑해")).toBe(3); // Hangul blocks
    expect(countSyllables("こんにちは")).toBe(5); // kana
    expect(countSyllables("愛")).toBe(1); // ideograph
  });
  it("is zero for blank text", () => {
    expect(countSyllables("")).toBe(0);
    expect(countSyllables("   ")).toBe(0);
  });
});

describe("spansAreLineLevel", () => {
  const span = (text: string): LyricSpan => ({ start: 0, text });
  it("is true when spans hold whole phrases", () => {
    expect(spansAreLineLevel([span("let me be"), span("come with the wind"), span("here")])).toBe(true);
  });
  it("is false for single-token (word-synced) spans", () => {
    expect(spansAreLineLevel([span("let"), span("me"), span("be")])).toBe(false);
  });
  it("uses timing for scriptless text (no word spaces): far apart = line-level", () => {
    const at = (start: number, text: string): LyricSpan => ({ start, text });
    // Japanese lines seconds apart, no spaces → line-level via the gap heuristic.
    expect(spansAreLineLevel([at(0, "夜に駆ける"), at(3000, "沈むように"), at(6000, "溶けてゆくように")])).toBe(true);
    // Dense per-character timing → word (mora) level, left as-is.
    expect(spansAreLineLevel([at(0, "夜"), at(200, "に"), at(400, "駆")])).toBe(false);
  });
  it("classifies scattered-space line-synced lyrics (some lines spaced) by cadence, not the stray space", () => {
    const at = (start: number, text: string): LyricSpan => ({ start, text });
    // Real Japanese line-synced track: only a few lines carry a phrase-break space, the rest none,
    // and lines are seconds apart → line-level. (The stray space used to force a word-synced verdict.)
    expect(
      spansAreLineLevel([
        at(694, "アイシテル その声は"), // spaced
        at(3943, "繰り返す波 愛しくなる"), // spaced
        at(7372, "魔法みたいに 優しい歌"), // spaced
        at(22440, "ねえきみを救いたい"), // no space
        at(25509, "だけど僕も救われたい"), // no space
        at(29072, "存在理由を探しては"), // no space
        at(32525, "一人反省会"), // no space
      ])
    ).toBe(true);
  });
});

describe("lineWords", () => {
  it("returns each word token with its syllable count (English → per word)", () => {
    expect(lineWords("hello world")).toEqual([
      { text: "hello", syllables: 2 },
      { text: "world", syllables: 1 },
    ]);
  });
});

describe("splitSyllables", () => {
  it("splits romanized words maximal-onset style", () => {
    expect(splitSyllables("balam")).toEqual(["ba", "lam"]);
    expect(splitSyllables("saranghae")).toEqual(["sa", "rang", "hae"]);
    expect(splitSyllables("arigatou")).toEqual(["a", "ri", "ga", "to", "u"]);
    expect(splitSyllables("go")).toEqual(["go"]); // one nucleus → unchanged
  });
});

describe("isSyllableTimedText", () => {
  it("flags native CJK and romanized Korean/Japanese, not English", () => {
    expect(isSyllableTimedText("사랑해")).toBe(true); // native
    expect(isSyllableTimedText("balam-i bul-eooneun gos-eseo")).toBe(true); // romanized KR markers
    expect(isSyllableTimedText("come with the wind tonight")).toBe(false); // English
  });
  it("triggers aggressively — a single marker or intra-word hyphen is enough", () => {
    expect(isSyllableTimedText("annyeong haseyo")).toBe(true); // one 'yeo' marker
    expect(isSyllableTimedText("neng-gul")).toBe(true); // intra-word hyphen alone
    expect(isSyllableTimedText("ryusei kyoto")).toBe(true); // romaji glides
  });
  it("still leaves marker-free English alone", () => {
    expect(isSyllableTimedText("hold me close tonight")).toBe(false);
    expect(isSyllableTimedText("i will always love you")).toBe(false);
  });
});

describe("lineWords — syllable-timed", () => {
  it("collapses a short romanized word to a single pop (≤ SYLLABLES_PER_POP)", () => {
    // "saranghae" → sa·rang·hae = 3 syllables → one grouped pop, not three.
    expect(lineWords("saranghae").map((u) => u.text)).toEqual(["saranghae"]);
    expect(lineWords("saranghae").map((u) => u.syllables)).toEqual([3]);
  });
  it("groups per token, chained words still separated", () => {
    const units = lineWords("balam-i bul-eooneun gos-eseo");
    expect(units[0]).toEqual({ text: "balam", syllables: 2 }); // short word → one pop
    expect(units[1]).toEqual({ text: "i", syllables: 1 });
  });
  it("groups NATIVE Hangul too — a short word is one pop, not one-per-glyph", () => {
    expect(lineWords("사랑해").map((u) => u.text)).toEqual(["사랑해"]); // one pop (3 syllables)
  });
  it("evaluates a spaced Hangul line as its words (the 5-word screenshot case)", () => {
    const units = lineWords("괜히 감추기 싫어 우린 해야해");
    expect(units).toHaveLength(5); // five words → five pops, not twelve glyphs
    expect(units.map((u) => u.text)).toEqual(["괜히", "감추기", "싫어", "우린", "해야해"]);
  });
  it("splits only a long chained run beyond the group size", () => {
    // A single 6-syllable native run → two pops (3 + 3), not one and not six.
    expect(lineWords("가나다라마바")).toHaveLength(2);
  });
});

describe("timedLines", () => {
  it("splits a line-synced line into per-word play times (white-as-played source)", () => {
    const lines = timedLines([[{ start: 0, end: 1500, text: "let me be" }]]);
    expect(lines).toHaveLength(1);
    expect(lines[0].words.map((w) => w.text)).toEqual(["let", "me", "be"]);
    expect(lines[0].words.map((w) => w.start)).toEqual([0, 500, 1000]); // evenly weighted
  });
  it("keeps word-synced spans verbatim, one display line per structural line", () => {
    const lines = timedLines([
      [{ start: 0, end: 300, text: "a" }, { start: 300, end: 600, text: "b" }],
      [{ start: 3000, end: 3300, text: "c" }],
    ]);
    expect(lines.map((l) => l.words.map((w) => w.text))).toEqual([["a", "b"], ["c"]]);
  });
});

describe("wordSyllables", () => {
  it("returns one weight per word", () => {
    expect(wordSyllables("hello world")).toEqual([2, 1]); // hel-lo, world
    expect(wordSyllables("let me be")).toEqual([1, 1, 1]);
  });
  it("groups a short CJK word into one weighted pop", () => {
    expect(wordSyllables("사랑해")).toEqual([3]); // one pop, weight = its 3 syllables
  });
});

describe("expandLineSpans", () => {
  it("pops once per word, one span each", () => {
    // "let me be" = 3 one-syllable words over 900ms → 3 equal spans.
    const out = expandLineSpans([{ start: 1000, end: 1900, text: "let me be" }]);
    expect(out).toEqual([
      { start: 1000, end: 1300 },
      { start: 1300, end: 1600 },
      { start: 1600, end: 1900 },
    ]);
  });
  it("holds each word proportional to its syllable count (cadence)", () => {
    // "hello"(2) + "world"(1) over 1500ms → hello gets 2/3 (1000ms), world 1/3 (500ms).
    const out = expandLineSpans([{ start: 0, end: 1500, text: "hello world" }]);
    expect(out).toEqual([
      { start: 0, end: 1000 },
      { start: 1000, end: 1500 },
    ]);
  });
  it("bounds a line by the next line's start, not its own end", () => {
    const out = expandLineSpans([
      { start: 0, end: 100000, text: "la la" }, // bogus far end, 2 syllables
      { start: 1000, text: "next" },
    ]);
    // The first line is capped at the next start (1000): 2 syllables → 0–500, 500–1000.
    expect(out[0]).toEqual({ start: 0, end: 500 });
    expect(out[1]).toEqual({ start: 500, end: 1000 });
  });
  it("distributes a line's words by syllable weight (the 'somewhere only we know' case)", () => {
    // ≈ [3,2,1,1] syllables → 4 pops, each word held ∝ its syllables, last reaching the end.
    const out = expandLineSpans([{ start: 0, end: 7000, text: "somewhere only we know" }]);
    expect(out.length).toBe(4); // one pop per word
    expect(out[0].start).toBe(0);
    expect(out[out.length - 1].end).toBe(7000);
    const dur = (o: { start: number; end?: number }) => (o.end ?? 0) - o.start;
    expect(dur(out[0])).toBeGreaterThan(dur(out[2])); // "somewhere" lingers longer than "we"
  });
  it("spreads across a long line's full end, not a fixed cap", () => {
    // A slow 6s line must pop across all 6s, not bunch into the first couple seconds.
    const out = expandLineSpans([{ start: 0, end: 6000, text: "one two three" }]);
    expect(out[out.length - 1].end).toBe(6000); // last word reaches the line end
    expect(out.length).toBe(3); // one pop per word
  });
  it("passes a single-syllable span through unchanged", () => {
    expect(expandLineSpans([{ start: 500, end: 700, text: "go" }])).toEqual([{ start: 500, end: 700 }]);
  });
  it("aligns each word to the nearest off-beat boundary (one pop per word, tiled)", () => {
    // "let me be" → expected 0/500/1000; boundaries 60/540/960 → words align onto them.
    const segs = parseSegments({
      segments: [{ start: 0.06, duration: 0.4 }, { start: 0.54, duration: 0.4 }, { start: 0.96, duration: 0.4 }],
    })!;
    const out = audioTimedLineSpans([{ start: 0, end: 1500, text: "let me be" }], segs);
    expect(out).toEqual([
      { start: 60, end: 540 },
      { start: 540, end: 960 },
      { start: 960, end: 1500 },
    ]);
  });
  it("aligns monotonically within the window, else keeps the guess", () => {
    expect(alignToBoundaries([0, 500, 1000], [60, 540, 960])).toEqual([60, 540, 960]);
    expect(alignToBoundaries([0, 500], [60, 2000])).toEqual([60, 500]); // 2000 too far → keep guess
  });
  it("prefers a vocal (off-beat) candidate over a closer drum (on-beat) one", () => {
    // Expected pop at 500ms. Candidates: 520 (on the beat → drum) and 600 (off-beat → vocal).
    // 520 is closer, but the on-beat penalty makes the vocal boundary win. Count stays lyric-fixed.
    const segs = parseSegments({
      segments: [{ start: 0.0, duration: 0.5 }, { start: 0.52, duration: 0.08 }, { start: 0.6, duration: 0.4 }],
    })!;
    const out = audioTimedLineSpans([{ start: 0, end: 1000, text: "la la" }], segs, [500]);
    expect(out).toHaveLength(2); // two words → two pops, no upcount
    expect(out[1].start).toBe(600); // snapped to the off-beat vocal boundary, not the on-beat 520
  });
  it("prefers a louder-attack boundary over a closer fading one (onset strength)", () => {
    // Second word's guess is 450ms. 400ms is closer but fades; 600ms attacks (loudness rises).
    // The onset-strength bonus overcomes the distance, so the pop lands on the attack.
    const segs = parseSegments({
      segments: [
        { start: 0.0, duration: 0.4, loudness_max: -5 },
        { start: 0.4, duration: 0.2, loudness_max: -20 }, // 400ms: quieter than before → fade
        { start: 0.6, duration: 0.4, loudness_max: -3 }, // 600ms: louder → attack
      ],
    })!;
    const out = audioTimedLineSpans([{ start: 0, end: 900, text: "do re" }], segs);
    expect(out[1].start).toBe(600);
  });
  it("ends the line when the vocal tapers, not at the nominal line end", () => {
    // Two words sung early, then a loud on-beat (drum) tail and a near-silent off-beat segment.
    // The mouth should close just after the vocal, not hold open to the 4000ms line end.
    const segs = parseSegments({
      segments: [
        { start: 0.0, duration: 0.3, loudness_max: -5 },
        { start: 0.3, duration: 0.3, loudness_max: -5 },
        { start: 1.0, duration: 0.5, loudness_max: -3 }, // on-beat → ignored as the beat
        { start: 2.0, duration: 0.5, loudness_max: -28 }, // off-beat but near-silent
      ],
    })!;
    const out = audioTimedLineSpans([{ start: 0, end: 4000, text: "la la" }], segs, [1000, 2000]);
    expect(out[out.length - 1].end).toBeLessThan(1000);
  });
  it("preserves inter-line gaps (silence stays mouth-closed) and never adds pops", () => {
    // Two one-word lines with a gap between; no segments → starts kept. Gap 800–2000 has
    // no onset, so the frame reads closed there. Exactly 2 pops (one per word).
    const out = audioTimedLineSpans(
      [{ start: 0, end: 800, text: "hello" }, { start: 2000, end: 2800, text: "world" }],
      [],
    );
    expect(out).toEqual([{ start: 0, end: 800 }, { start: 2000, end: 2800 }]);
  });
  it("estimates a line's length from syllables when it has no end time", () => {
    // No EndTime; next line is 10s away. The open should cover the line's sung length
    // (~a few hundred ms per syllable), not stretch toward the 10s gap.
    const out = expandLineSpans([{ start: 0, text: "one two three" }, { start: 10000, text: "next" }]);
    const line1 = out.filter((o) => o.start < 10000);
    expect(line1[line1.length - 1].end).toBeLessThan(2000); // ends with the line, not the gap
  });
});
