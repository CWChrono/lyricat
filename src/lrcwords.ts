// Word-level ("enhanced") LRC, used purely to persist + reload our word-by-word detection —
// the per-word fire windows the cat pops on. We don't care about line structure here; the data
// is a FLAT list of words, each with a [start, end] window (ms). It's serialized as LRC only so
// it round-trips through the same lyric cache and the onset pipeline (which reads the inline
// `<mm:ss.xx>` word timestamps verbatim, exactly like true word-synced lyrics).

/** One word: its text and its [start, end] fire window (ms). */
export interface LrcWord {
  text: string;
  start: number;
  end: number;
  /** A background / secondary-vocal word — the thin top lane in the editor. A purely VISUAL lane,
   *  orthogonal to `singer` (either voice can appear in either lane). Persisted via an invisible marker. */
  secondary?: boolean;
  /** Which duet VOICE sings this word — the only thing that decides which cat pops:
   *   - undefined → BOTH cats (unison / default), canonical TTML agent "both"
   *   - "a"       → the MIRROR cat only, TTML agent "a" (UI alias defaults to "Mittens")
   *   - "b"       → the MAIN cat only, TTML agent "b" (UI alias defaults to "Biscuit")
   *  Persisted via invisible marks. (Replaces the old `duet` flag; old duet words load as "a".) */
  singer?: "a" | "b";
  /** An OVERLAPPING main note — a lead word (never `secondary`) whose END is decoupled from the usual
   *  non-overlap clamp, so a sustained vocal can stretch PAST the following lines without pushing them.
   *  Its trailing edge is locked in the main lane (can't push/block) and edited from the background lane.
   *  Persisted via an invisible marker. */
  overlap?: boolean;
}

// A word with a start tag but no following tag gets this much duration by default.
const DEFAULT_WORD_MS = 300;
// Invisible prefixes (not whitespace, so they survive trim) flagging a word. Other LRC players render
// nothing for them; our parser strips + flags them. A word carries at most one singer mark, plus an
// optional background mark (the lane is independent of the voice).
const SECONDARY_MARK = String.fromCharCode(0x2063); // U+2063 INVISIBLE SEPARATOR → background lane
const SINGER_A_MARK = String.fromCharCode(0x2064); // U+2064 INVISIBLE PLUS → singer "a" (reuses the old
// duet mark, so pre-existing duet words transparently load as singer "a" / the mirror voice)
const SINGER_B_MARK = String.fromCharCode(0x2062); // U+2062 INVISIBLE TIMES → singer "b"
const OVERLAP_MARK = String.fromCharCode(0x2061); // U+2061 FUNCTION APPLICATION → overlapping main note

/** Strip the leading invisible flag marks (any order) → the plain text + which flags were set. */
function parseWordFlags(raw: string): { text: string; secondary: boolean; singer?: "a" | "b"; overlap: boolean } {
  let s = raw;
  let secondary = false;
  let overlap = false;
  let singer: "a" | "b" | undefined;
  for (;;) {
    if (s.startsWith(SECONDARY_MARK)) (secondary = true), (s = s.slice(SECONDARY_MARK.length));
    else if (s.startsWith(SINGER_A_MARK)) (singer = "a"), (s = s.slice(SINGER_A_MARK.length));
    else if (s.startsWith(SINGER_B_MARK)) (singer = "b"), (s = s.slice(SINGER_B_MARK.length));
    else if (s.startsWith(OVERLAP_MARK)) (overlap = true), (s = s.slice(OVERLAP_MARK.length));
    else break;
  }
  return { text: s.trim(), secondary, singer, overlap };
}

/** The invisible flag prefix to write before a word's text. */
function wordFlagPrefix(w: { secondary?: boolean; singer?: "a" | "b"; overlap?: boolean }): string {
  const singerMark = w.singer === "a" ? SINGER_A_MARK : w.singer === "b" ? SINGER_B_MARK : "";
  return `${w.secondary ? SECONDARY_MARK : ""}${singerMark}${w.overlap ? OVERLAP_MARK : ""}`;
}

const LINE_TAG = /\[(\d{1,3}):(\d{2})(?:[.:](\d{1,3}))?\]/g;
const WORD_TAG = /<(\d{1,3}):(\d{2})(?:[.:](\d{1,3}))?>/g;

/** A tag's captures → milliseconds (2-digit fraction = centiseconds, 1-digit = tenths). */
function tagMs(min: string, sec: string, frac?: string): number {
  let ms = (parseInt(min, 10) * 60 + parseInt(sec, 10)) * 1000;
  if (frac) ms += frac.length === 3 ? parseInt(frac, 10) : parseInt(frac, 10) * (frac.length === 2 ? 10 : 100);
  return ms;
}

/** True when the LRC carries inline word timestamps (`<mm:ss>`) — i.e. it's word-level. */
export function hasWordTimestamps(lrc: string): boolean {
  return /<\d{1,3}:\d{2}/.test(lrc);
}

/** `mm:ss.xx` for an ms time (centisecond precision), as LRC tags are written. */
export function fmtLrcTime(ms: number): string {
  const cs = Math.max(0, Math.round(ms / 10)); // centiseconds
  const sec = Math.floor(cs / 100);
  const pad = (n: number): string => String(n).padStart(2, "0");
  return `${pad(Math.floor(sec / 60))}:${pad(sec % 60)}.${pad(cs % 100)}`;
}

/**
 * Parse word-level LRC into a flat, start-sorted list of words. Within each text line the
 * `<ts>` tags are read in order: the text between two consecutive tags (when non-blank) is a
 * word whose start is the first tag and whose end is the second (so an explicit closing tag
 * gives a gap, and a gapless file's end is simply the next word's start). Line `[..]` tags are
 * ignored — we only care about the words.
 */
export function parseWordLrc(lrc: string): LrcWord[] {
  if (!lrc || typeof lrc !== "string") return [];
  const words: LrcWord[] = [];
  for (const raw of lrc.split(/\r?\n/)) {
    const body = raw.replace(LINE_TAG, "");
    const tags = [...body.matchAll(WORD_TAG)];
    for (let i = 0; i < tags.length; i++) {
      const from = (tags[i].index ?? 0) + tags[i][0].length;
      const to = i + 1 < tags.length ? tags[i + 1].index ?? body.length : body.length;
      const { text, secondary, singer, overlap } = parseWordFlags(body.slice(from, to).trim());
      if (!text) continue; // blank slice → a gap between a closing tag and the next word's start
      const start = tagMs(tags[i][1], tags[i][2], tags[i][3]);
      const end =
        i + 1 < tags.length ? tagMs(tags[i + 1][1], tags[i + 1][2], tags[i + 1][3]) : start + DEFAULT_WORD_MS;
      words.push({ text, start, end: Math.max(start + 1, end), ...(secondary ? { secondary: true } : {}), ...(singer ? { singer } : {}), ...(overlap ? { overlap: true } : {}) });
    }
  }
  return words.sort((a, b) => a.start - b.start);
}

/** Serialize a flat word list back to word-level LRC — one word per line, `[s] <s> text <e>`. */
export function serializeWordLrc(words: readonly LrcWord[]): string {
  return words
    .slice()
    .sort((a, b) => a.start - b.start)
    .map((w) => `[${fmtLrcTime(w.start)}] <${fmtLrcTime(w.start)}> ${wordFlagPrefix(w)}${w.text} <${fmtLrcTime(w.end)}>`)
    .join("\n");
}

/** One lyric line: its `[..]` start (ms) and its words — the line boundary is kept so the editor
 *  can show seekable line markers, even though word timing is edited flat. */
export interface LrcLine {
  start: number;
  words: LrcWord[];
}

/** Parse word-level LRC preserving line grouping: each `[start]` line and its `<..>` words. */
export function parseWordLrcLines(lrc: string): LrcLine[] {
  if (!lrc || typeof lrc !== "string") return [];
  const lines: LrcLine[] = [];
  for (const raw of lrc.split(/\r?\n/)) {
    LINE_TAG.lastIndex = 0;
    const lm = LINE_TAG.exec(raw);
    if (!lm) continue;
    const start = tagMs(lm[1], lm[2], lm[3]);
    const body = raw.replace(LINE_TAG, "");
    const tags = [...body.matchAll(WORD_TAG)];
    const words: LrcWord[] = [];
    for (let i = 0; i < tags.length; i++) {
      const from = (tags[i].index ?? 0) + tags[i][0].length;
      const to = i + 1 < tags.length ? tags[i + 1].index ?? body.length : body.length;
      const { text, secondary, singer, overlap } = parseWordFlags(body.slice(from, to).trim());
      if (!text) continue;
      const ws = tagMs(tags[i][1], tags[i][2], tags[i][3]);
      const we = i + 1 < tags.length ? tagMs(tags[i + 1][1], tags[i + 1][2], tags[i + 1][3]) : ws + DEFAULT_WORD_MS;
      words.push({ text, start: ws, end: Math.max(ws + 1, we), ...(secondary ? { secondary: true } : {}), ...(singer ? { singer } : {}), ...(overlap ? { overlap: true } : {}) });
    }
    lines.push({ start, words });
  }
  return lines.sort((a, b) => a.start - b.start);
}

/** Serialize lines (line grouping preserved) to word-level LRC: `[lineStart] <s> w <e> …`. */
export function serializeWordLrcLines(lines: readonly LrcLine[]): string {
  return lines
    .map((l) => {
      const body = l.words
        .slice()
        .sort((a, b) => a.start - b.start)
        .map((w) => `<${fmtLrcTime(w.start)}> ${wordFlagPrefix(w)}${w.text} <${fmtLrcTime(w.end)}>`)
        .join(" ");
      return `[${fmtLrcTime(l.start)}]${body ? " " + body : ""}`;
    })
    .join("\n");
}

/** Onset spans (ms) for the words passing `pred`, start-sorted — the verbatim fire windows. */
function onsetsWhere(words: readonly LrcWord[], pred: (w: LrcWord) => boolean): { start: number; end: number }[] {
  return words
    .filter(pred)
    .sort((a, b) => a.start - b.start)
    .map((w) => ({ start: w.start, end: Math.max(w.start + 1, w.end) }));
}

// Which cat pops on a word is decided SOLELY by its `singer` voice — the lead/background lane is purely
// visual and never gates an onset. Default (undefined) words are unison: both cats pop.

/** The MAIN cat's onset spans (ms): every word EXCEPT singer "a" (the Mittens/mirror-only voice) — i.e.
 *  the unison/default words plus singer "b" (Biscuit). */
export function wordOnsets(words: readonly LrcWord[]): { start: number; end: number }[] {
  return onsetsWhere(words, (w) => w.singer !== "a");
}

/** The MIRROR cat's onset spans (ms): every word EXCEPT singer "b" (the Biscuit/main-only voice) — i.e.
 *  the unison/default words plus singer "a" (Mittens). */
export function mirrorWordOnsets(words: readonly LrcWord[]): { start: number; end: number }[] {
  return onsetsWhere(words, (w) => w.singer !== "b");
}
