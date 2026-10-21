import { describe, it, expect, vi } from "vitest";
import { collectSpans, onsetSpansFromLyrics, createSpicyOnsetReader, lyricLines, plainLyricLines } from "./spicylyrics";

// One immediate probe, no steady polling (maxWaitMs 0) — for the single-shot cases.
const noWait = { sleep: () => Promise.resolve(), retries: [0], maxWaitMs: 0 };
const expectedSpans = [
  { start: 1000, end: 1400 },
  { start: 1500, end: 1800 },
  { start: 2000, end: 2600 },
  { start: 2100, end: 2500 },
];

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
      Background: [
        { StartTime: 2.1, EndTime: 2.5, Syllables: [{ Text: "ooh", StartTime: 2.1, EndTime: 2.5 }] },
      ],
    },
  ],
};

const bySt = (a: { start: number }, b: { start: number }) => a.start - b.start;

describe("collectSpans", () => {
  it("harvests sung units (Text + StartTime) as {start,end}, skipping aggregates", () => {
    const spans = collectSpans(syllableLyrics).sort(bySt);
    // Only the leaf syllables (they carry Text); Lead/Content/top-level are skipped.
    // The text rides along so a line-synced span can later be split into syllables.
    expect(spans).toEqual([
      { start: 1.0, end: 1.4, text: "Let" },
      { start: 1.5, end: 1.8, text: "me" },
      { start: 2.0, end: 2.6, text: "be" },
      { start: 2.1, end: 2.5, text: "ooh", secondary: true }, // under Background → tagged secondary
    ]);
  });
  it("is safe on empty / non-object / textless input", () => {
    expect(collectSpans(null)).toEqual([]);
    expect(collectSpans("nope")).toEqual([]);
    expect(collectSpans({ Lead: { StartTime: 1, Syllables: [] } })).toEqual([]); // no Text anywhere
  });
  it("skips an AGGREGATE line that carries its own Text alongside its word children", () => {
    // Some Spicy word-synced builds put the whole-line Text on the line object too. Only the finer
    // word/syllable leaves must survive — else the editor gets a line-spanning span on top of its
    // own words (one giant 'word' == the full line).
    const hybridLine = (start: number, text: string, words: [string, number, number][]) => ({
      StartTime: start,
      EndTime: words[words.length - 1][2], // the line-level aggregate span…
      Text: text, // …with the whole-line text, alongside its syllables
      Lead: { Syllables: words.map(([Text, StartTime, EndTime]) => ({ Text, StartTime, EndTime })) },
    });
    const hybrid = {
      Content: [
        hybridLine(1.0, "Let me be", [["Let", 1.0, 1.4], ["me", 1.5, 1.8], ["be", 2.0, 2.6]]),
        hybridLine(3.0, "come with", [["come", 3.0, 3.4], ["with", 3.5, 3.9]]),
      ],
    };
    // The whole-line aggregate spans are dropped; only the word leaves survive.
    expect(collectSpans(hybrid).sort(bySt)).toEqual([
      { start: 1.0, end: 1.4, text: "Let" },
      { start: 1.5, end: 1.8, text: "me" },
      { start: 2.0, end: 2.6, text: "be" },
      { start: 3.0, end: 3.4, text: "come" },
      { start: 3.5, end: 3.9, text: "with" },
    ]);
    // And grouping yields two lines of words, never a line-spanning "word" over its own words.
    const lines = lyricLines(hybrid);
    expect(lines?.length).toBe(2);
    expect(lines?.[0].map((s) => s.text)).toEqual(["Let", "me", "be"]);
    expect(lines?.[1].map((s) => s.text)).toEqual(["come", "with"]);
  });
});

describe("lyricLines — line grouping (giant-block regression)", () => {
  const line = (t: number, text: string) => ({ StartTime: t, Text: text });
  it("groups top-level Content lines", () => {
    expect(lyricLines({ Content: [line(1, "line one"), line(3, "line two")] })?.length).toBe(2);
  });
  it("finds lines nested deeper than the top level (the regression)", () => {
    const lines = lyricLines({ Content: { Lines: [line(1, "one two"), line(3, "three four")] } });
    expect(lines?.length).toBe(2); // NOT collapsed into a single giant block
    expect(lines?.[0][0].text).toBe("one two");
  });
  it("treats a top-level array of line-spans as separate lines", () => {
    expect(lyricLines([line(1, "first line here"), line(3, "second line here")])?.length).toBe(2);
  });
  it("keeps word-synced syllables grouped under their own line", () => {
    const lines = lyricLines({
      Content: [
        { StartTime: 1, Syllables: [{ StartTime: 1, Text: "he" }, { StartTime: 1.2, Text: "llo" }] },
        { StartTime: 3, Syllables: [{ StartTime: 3, Text: "world" }] },
      ],
    });
    expect(lines?.length).toBe(2);
    expect(lines?.[0].length).toBe(2); // two syllables in line 1
  });
});

describe("plainLyricLines — text pull, timing-agnostic", () => {
  it("extracts UNSYNCED/static lyrics with no StartTime (the FREEDOM case)", () => {
    const lines = plainLyricLines({ Type: "Static", Lines: [{ Text: "FREE" }, { Text: "La la la la" }, { Text: "Yeah" }] });
    expect(lines).toEqual(["FREE", "La la la la", "Yeah"]);
  });
  it("joins static syllables within a line", () => {
    const lines = plainLyricLines({
      Lines: [
        { Syllables: [{ Text: "he" }, { Text: "llo" }] },
        { Syllables: [{ Text: "world" }] },
      ],
    });
    expect(lines).toEqual(["he llo", "world"]);
  });
  it("accepts a plain array of line strings", () => {
    expect(plainLyricLines({ Content: ["line one", "line two"] })).toEqual(["line one", "line two"]);
  });
  it("prefers a timed structure when present (clean line text)", () => {
    const lines = plainLyricLines({ Content: [{ StartTime: 1, Text: "line one" }, { StartTime: 3, Text: "line two" }] });
    expect(lines).toEqual(["line one", "line two"]);
  });
  it("falls back to a newline-delimited blob", () => {
    expect(plainLyricLines({ Lyrics: "first\nsecond\nthird" })).toEqual(["first", "second", "third"]);
  });
  it("returns null when there is no text", () => {
    expect(plainLyricLines({ Type: "Static", Lines: [] })).toBeNull();
    expect(plainLyricLines(null)).toBeNull();
  });
});

describe("onsetSpansFromLyrics", () => {
  it("returns sorted, de-duplicated spans in ms (seconds normalized ×1000)", () => {
    expect(onsetSpansFromLyrics(syllableLyrics)).toEqual([
      { start: 1000, end: 1400 },
      { start: 1500, end: 1800 },
      { start: 2000, end: 2600 },
      { start: 2100, end: 2500 },
    ]);
  });
  it("leaves millisecond-scale data unscaled", () => {
    const ms = { Content: [{ Text: "a", StartTime: 1000, EndTime: 1200 }, { Text: "b", StartTime: 90000 }] };
    expect(onsetSpansFromLyrics(ms)).toEqual([{ start: 1000, end: 1200 }, { start: 90000 }]);
  });
  const lineLyrics = {
    Content: [
      { Text: "let me be", StartTime: 1.0, EndTime: 1.9 },
      { Text: "come with the wind", StartTime: 2.0, EndTime: 3.0 },
    ],
  };
  it("expands line-synced lyrics into estimated per-syllable onsets when enabled", () => {
    const out = onsetSpansFromLyrics(lineLyrics, true); // estimateLines on
    // "let me be" = 3 syllables → 3 onsets in the first line's window alone.
    expect(out!.length).toBeGreaterThan(4);
    expect(out![0]).toEqual({ start: 1000, end: 1300 });
  });
  it("keeps line-synced lyrics one-onset-per-line when the estimator is off", () => {
    expect(onsetSpansFromLyrics(lineLyrics)).toEqual([
      { start: 1000, end: 1900 },
      { start: 2000, end: 3000 },
    ]);
  });
  it("returns null for unsynced / too-few onsets", () => {
    expect(onsetSpansFromLyrics({ Type: "Static", Lines: [{ Text: "a" }] })).toBeNull();
    expect(onsetSpansFromLyrics({ Content: [{ Text: "a", StartTime: 5 }] })).toBeNull(); // only one
    expect(onsetSpansFromLyrics(null)).toBeNull();
  });
});

describe("createSpicyOnsetReader", () => {
  it("reads the cache by track id and returns onset spans when enabled", async () => {
    const read = vi.fn().mockResolvedValue(syllableLyrics);
    const fetchOnsets = createSpicyOnsetReader(() => true, { ...noWait, read });
    expect(await fetchOnsets("spotify:track:6o6wFh2PTFJbcM8mxTa30C")).toEqual(expectedSpans);
    expect(read).toHaveBeenCalledWith("6o6wFh2PTFJbcM8mxTa30C"); // id, not the full uri
  });
  it("no-ops (null) when disabled — without touching the cache", async () => {
    const read = vi.fn();
    const fetchOnsets = createSpicyOnsetReader(() => false, { ...noWait, read });
    expect(await fetchOnsets("spotify:track:x")).toBeNull();
    expect(read).not.toHaveBeenCalled();
  });
  it("null for a non-track uri", async () => {
    const fetchOnsets = createSpicyOnsetReader(() => true, { ...noWait, read: async () => syllableLyrics });
    expect(await fetchOnsets("spotify:episode:pod")).toBeNull();
  });
  it("retries, picking up lyrics that land on a later attempt", async () => {
    const read = vi
      .fn()
      .mockResolvedValueOnce(null) // not cached yet
      .mockResolvedValueOnce(syllableLyrics); // Spicy Lyrics finished fetching
    const fetchOnsets = createSpicyOnsetReader(() => true, {
      sleep: () => Promise.resolve(),
      retries: [0, 10],
      read,
    });
    expect(await fetchOnsets("spotify:track:x")).toEqual(expectedSpans);
    expect(read).toHaveBeenCalledTimes(2);
  });
  it("keeps polling past the warmup and picks up lyrics that land mid-song", async () => {
    const read = vi
      .fn()
      .mockResolvedValueOnce(null) // warmup probe 1
      .mockResolvedValueOnce(null) // warmup probe 2
      .mockResolvedValue(syllableLyrics); // lands on a later steady poll
    const fetchOnsets = createSpicyOnsetReader(() => true, {
      sleep: () => Promise.resolve(),
      retries: [0, 5], // two warmup probes
      pollIntervalMs: 5,
      maxWaitMs: 100,
      read,
    });
    expect(await fetchOnsets("spotify:track:x")).toEqual(expectedSpans);
    expect(read).toHaveBeenCalledTimes(3); // 2 warmup + 1 steady poll
  });
  it("a newer request supersedes an in-flight poll (the old one resolves null)", async () => {
    let release: () => void = () => {};
    const gate = new Promise<void>((r) => (release = r));
    const read = vi
      .fn()
      .mockImplementationOnce(async () => {
        await gate; // first track's read hangs until released
        return null;
      })
      .mockResolvedValue(syllableLyrics); // second track resolves immediately
    const fetchOnsets = createSpicyOnsetReader(() => true, {
      sleep: () => Promise.resolve(),
      retries: [0],
      pollIntervalMs: 5,
      maxWaitMs: 1000, // high, so only the supersession stops the first poll
      read,
    });
    const first = fetchOnsets("spotify:track:a");
    const second = await fetchOnsets("spotify:track:b"); // bumps the token
    release();
    expect(second).toEqual(expectedSpans);
    expect(await first).toBeNull(); // superseded → bails instead of applying to the new track
  });
  it("stops re-parsing a cached-but-unsynced track once past the warmup", async () => {
    const staticLyrics = { Type: "Static", Lines: [{ Text: "no timing here" }] }; // no StartTime
    const read = vi.fn().mockResolvedValue(staticLyrics); // always cached, never synced
    const fetchOnsets = createSpicyOnsetReader(() => true, {
      sleep: () => Promise.resolve(),
      retries: [0, 5], // two warmup probes
      pollIntervalMs: 5,
      maxWaitMs: 100_000, // high: the unsynced-stop must end it, not the budget
      read,
    });
    expect(await fetchOnsets("spotify:track:x")).toBeNull();
    expect(read).toHaveBeenCalledTimes(3); // 2 warmup + 1 steady, then stop (not ~thousands)
  });
  it("null on a persistent miss or a read error (falls back to the beat)", async () => {
    const miss = createSpicyOnsetReader(() => true, { ...noWait, read: async () => null });
    expect(await miss("spotify:track:x")).toBeNull();
    const boom = createSpicyOnsetReader(() => true, {
      ...noWait,
      read: async () => {
        throw new Error("cache");
      },
    });
    expect(await boom("spotify:track:x")).toBeNull();
  });
});
