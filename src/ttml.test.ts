import { describe, it, expect } from "vitest";
import { wordLrcToTtml, ttmlClock } from "./ttml";
import { serializeWordLrcLines, parseWordLrcLines } from "./lrcwords";

describe("ttmlClock", () => {
  it("formats ms as HH:MM:SS.mmm", () => {
    expect(ttmlClock(0)).toBe("00:00:00.000");
    expect(ttmlClock(1400)).toBe("00:00:01.400");
    expect(ttmlClock(61500)).toBe("00:01:01.500");
    expect(ttmlClock(3_661_123)).toBe("01:01:01.123");
  });
});

describe("wordLrcToTtml", () => {
  const lrc = serializeWordLrcLines([
    {
      start: 1000,
      words: [
        { text: "Let", start: 1000, end: 1400 },
        { text: "me", start: 1500, end: 1800 },
        { text: "ooh", start: 1600, end: 1900, secondary: true },
      ],
    },
  ]);

  it("emits a word-timed <p> with per-word <span begin/end>", () => {
    const out = wordLrcToTtml(lrc);
    expect(out).toContain('itunes:timing="Word"');
    expect(out).toContain("<p ");
    expect(out).toContain('<span begin="00:00:01.000" end="00:00:01.400">Let</span>');
    expect(out).toContain('<span begin="00:00:01.500" end="00:00:01.800">me</span>');
    // line begin/end span the words; every <p> defaults to the "both" agent
    expect(out).toMatch(/<p ttm:agent="both" begin="00:00:01\.000" end="00:00:01\.900">/);
  });

  it("tags background/secondary words with ttm:role=\"x-bg\" (independent of the voice)", () => {
    expect(wordLrcToTtml(lrc)).toContain('ttm:role="x-bg"');
  });

  it("maps the singer voice to ttm:agent on soloist spans, defining both/a/b agents in the head", () => {
    const l = serializeWordLrcLines([
      {
        start: 1000,
        words: [
          { text: "we", start: 1000, end: 1200 }, // default → no agent on the span (inherits "both")
          { text: "soft", start: 1200, end: 1500, singer: "a" }, // Mittens
          { text: "ly", start: 1500, end: 1800, singer: "b", secondary: true }, // Biscuit + background lane
        ],
      },
    ]);
    const out = wordLrcToTtml(l, { a: "Mittens", b: "Biscuit" });
    // head declares all three canonical agents, with nicknames on a/b
    expect(out).toContain('<ttm:agent type="group" xml:id="both"/>');
    expect(out).toContain('<ttm:agent type="person" xml:id="a"><ttm:name type="full">Mittens</ttm:name></ttm:agent>');
    expect(out).toContain('<ttm:agent type="person" xml:id="b"><ttm:name type="full">Biscuit</ttm:name></ttm:agent>');
    // default word carries no per-span agent; soloists do; "b" also keeps its x-bg lane role
    expect(out).toContain('<span begin="00:00:01.000" end="00:00:01.200">we</span>');
    expect(out).toContain('ttm:agent="a"');
    expect(out).toMatch(/ttm:agent="b" ttm:role="x-bg">ly<\/span>/);
  });

  it("uses custom nicknames as the agents' names (and falls back to defaults when unset)", () => {
    const l = serializeWordLrcLines([{ start: 0, words: [{ text: "x", start: 0, end: 500, singer: "a" }] }]);
    expect(wordLrcToTtml(l, { a: "Luna", b: "Oreo" })).toContain(">Luna</ttm:name>");
    expect(wordLrcToTtml(l)).toContain(">Mittens</ttm:name>"); // default when no names passed
  });

  it("XML-escapes special characters in lyric text", () => {
    const l = serializeWordLrcLines([{ start: 0, words: [{ text: "rock & <roll>", start: 0, end: 500 }] }]);
    const out = wordLrcToTtml(l);
    expect(out).toContain("rock &amp; &lt;roll&gt;");
    expect(out).not.toContain("rock & <roll>");
  });

  it("produces a valid empty body for lyric-less input", () => {
    const out = wordLrcToTtml("");
    expect(out).toContain("<body>");
    expect(out).toContain("</tt>");
    expect(out).not.toContain("<p ");
  });

  it("accepts pre-parsed LrcLine[] as well as raw LRC text (same output)", () => {
    expect(wordLrcToTtml(parseWordLrcLines(lrc))).toBe(wordLrcToTtml(lrc));
  });
});
