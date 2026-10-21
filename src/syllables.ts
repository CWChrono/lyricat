// Best-effort syllable estimation for line-level lyrics. Word-synced lyrics already
// carry a timestamp per word/syllable, but a lot of tracks only have *line*-synced
// lyrics: one {start, end, text} per whole line. To still pop the cat's mouth per
// syllable, we guess how many syllables a line holds and spread that many onset
// spans evenly across the line's play time.
//
// The syllable count is a heuristic (no dictionary): count vowel groups for Latin
// script — the classic ~85%-accurate rule (vowel runs, minus a silent trailing 'e')
// — and treat each CJK/Hangul/kana character as its own syllable. It doesn't need to
// be exact; it just needs to land the right *rhythm* of pops across the line.

import { PulseOnset } from "./pulse";
import { Segment, offBeatBoundaries, nearBeat, vocalEndMs } from "./audioanalysis";

/** A timed lyric unit carrying its text, so a line can be split into syllables. */
export interface LyricSpan {
  start: number;
  end?: number;
  text: string;
  /** Romanization of this span's text (Spicy's `TransliteratedText`), when present. For a
   *  space-less script (Japanese/Chinese) a whole-line span carries the only word boundaries it
   *  has here — the romaji words — which drive how the native line is split. */
  roman?: string;
  /** True for a BACKGROUND vocal (Spicy's `Background` group) — a secondary line that overlaps the
   *  lead. Carried through so the editor can show it on its own lane and the cat can ignore it. */
  secondary?: boolean;
}

// CJK ideographs, Hangul syllable blocks, and Japanese kana — each character is ~one
// syllable, so we count them directly rather than looking for vowels.
const CJK_RE = /[぀-ヿ㐀-䶿一-鿿가-힯ｦ-ﾝ]/g;
const CJK_CHAR = /[぀-ヿ㐀-䶿一-鿿가-힯ｦ-ﾝ]/; // single-char test (non-global)
// Word / syllable / morpheme separators a romanizer may emit (whitespace, hyphens
// and dashes, hyphenation point, middle dot). Split on them so a vowel run can't
// merge across a boundary the romanizer already marked.
const SEP_RE = /[\s-‐-―·‧]+/;

// Multilingual mode: vowel clusters that are a *single* nucleus (glides + Korean RR
// digraphs), so they don't get split into separate morae like a true vowel run would.
// Longest first (trigraphs before digraphs) so "yeo"/"wae" win over "ye"/"wa".
const NUCLEUS_CLUSTERS = ["yeo", "wae", "weo", "yae", "eo", "eu", "ae", "oe", "ui", "ya", "yo", "yu", "ye", "wa", "wo", "wi", "we"];

/**
 * Nucleus count for one maximal vowel run: walk it left-to-right, consuming a known
 * glide / Korean-RR cluster as one nucleus, otherwise one letter = one nucleus. So
 * romaji "ai" → 2, "ou" → 2 (each vowel a mora), while Korean "eo"/"yeo" stay 1. This
 * favours non-English romanization (the bulk of what we cover) over English, where it
 * can over-count a vowel digraph by one — acceptable for a best-effort pop rhythm.
 */
function vowelNuclei(run: string): number {
  let i = 0;
  let n = 0;
  while (i < run.length) {
    const three = run.slice(i, i + 3);
    const two = run.slice(i, i + 2);
    if (three.length === 3 && NUCLEUS_CLUSTERS.includes(three)) i += 3;
    else if (two.length === 2 && NUCLEUS_CLUSTERS.includes(two)) i += 2;
    else i += 1;
    n++;
  }
  return n;
}

/** Syllables in a single Latin token via digraph-aware vowel nuclei. */
function latinWordSyllables(word: string): number {
  const w = word.toLowerCase().replace(/[^a-z]/g, "");
  if (!w) return 0;
  const runs = w.match(/[aeiouy]+/g) ?? [];
  let n = runs.reduce((sum, r) => sum + vowelNuclei(r), 0);
  // Silent trailing 'e' (English: where→1, cake→1) — but keep '-le' (table) where it's
  // voiced. English silent-e is the dominant case in lyrics; this is mildly wrong for a
  // romaji CVe like "kare", an accepted best-effort trade.
  if (n > 1 && w.endsWith("e") && !w.endsWith("le")) n--;
  return Math.max(1, n);
}

/**
 * Estimated syllable count for a stretch of lyric text (a word, or a whole line).
 * CJK/Hangul/kana characters count one each; the remaining Latin tokens (split on
 * whitespace + the separators a romanizer emits) use digraph-aware vowel nuclei, so
 * romaji / Korean RR aren't under-counted the way plain vowel-groups would. Always
 * ≥ 1 for non-empty text, 0 for blank.
 */
export function countSyllables(text: string): number {
  if (!text) return 0;
  const cjk = text.match(CJK_RE);
  let total = cjk ? cjk.length : 0;
  const latin = text.replace(CJK_RE, " ");
  for (const word of latin.split(SEP_RE)) {
    if (word) total += latinWordSyllables(word);
  }
  return text.trim() ? Math.max(1, total) : 0;
}

/** Maximal vowel-nucleus spans within a word (indices into the lowercased word), with
 *  Korean-RR / glide clusters kept as one nucleus. Drives romanized syllable splitting. */
function nucleusSpans(lower: string): [number, number][] {
  const spans: [number, number][] = [];
  const re = /[aeiouy]+/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(lower))) {
    let i = m.index;
    const end = m.index + m[0].length;
    while (i < end) {
      const three = lower.slice(i, i + 3);
      const two = lower.slice(i, i + 2);
      const len = three.length === 3 && NUCLEUS_CLUSTERS.includes(three) ? 3 : two.length === 2 && NUCLEUS_CLUSTERS.includes(two) ? 2 : 1;
      spans.push([i, i + len]);
      i += len;
    }
  }
  return spans;
}

/**
 * Split a romanized token into syllables (one nucleus each), maximal-onset style: the last
 * consonant before a nucleus joins that nucleus's onset, the rest stay as the prior coda —
 * so "balam" → ba·lam, "saranghae" → sa·rang·hae, "arigatou" → a·ri·ga·to·u. Keeps the
 * original casing. One nucleus (or none) → the word unchanged.
 */
export function splitSyllables(word: string): string[] {
  const nuclei = nucleusSpans(word.toLowerCase());
  if (nuclei.length <= 1) return [word];
  const parts: string[] = [];
  let start = 0;
  for (let k = 0; k < nuclei.length; k++) {
    let cut: number;
    if (k + 1 < nuclei.length) {
      const consonants = nuclei[k + 1][0] - nuclei[k][1]; // consonants between the two nuclei
      cut = consonants >= 1 ? nuclei[k + 1][0] - 1 : nuclei[k + 1][0]; // give one to the next onset
    } else {
      cut = word.length;
    }
    if (cut > start) parts.push(word.slice(start, cut));
    start = cut;
  }
  return parts.length ? parts : [word];
}

// Markers that are distinctive of romanized syllable-timed languages (Korean RR / Japanese
// romaji) and rare in English — used to decide when to split a line into syllables. Kept to
// digraphs/trigraphs that almost never occur in English words, plus common romaji glides/
// geminates, so lowering the trigger count below doesn't start mis-flipping English lines.
const SYLLABLE_TIMED_MARK =
  /eo|eu|ae|oe|ui|yeo|yae|wae|weo|tsu|ryo|kyo|ryu|nyu|gyo|hyu|myo|pyo|byo|hyo|jya|jyu|jyo|kka|ttae|jja/g;

// A romanizer that hyphenates *inside* a token ("balam-i", "bul-eooneun", "gos-eseo") is
// explicitly marking syllable / morpheme splits — on its own a strong syllable-timed signal.
const INTRA_WORD_HYPHEN = /[a-z]-[a-z]/;

/**
 * True when a line should be treated as *syllable*-timed (pop per syllable) rather than
 * stress-timed (pop per word): native CJK/Hangul/kana, a romanizer's intra-word hyphenation,
 * or enough Korean-RR / Japanese-romaji markers. English stays word-level — the markers are
 * rare there, so even the single-marker trigger below leaves ordinary English untouched.
 * Generalizes beyond Korean to other romanized CV languages. Deliberately aggressive: one
 * marker is enough, since a false positive only means a line pops a bit more granularly.
 */
export function isSyllableTimedText(text: string): boolean {
  if (CJK_CHAR.test(text)) return true; // native script → one char per syllable
  const lower = text.toLowerCase();
  if (INTRA_WORD_HYPHEN.test(lower)) return true; // romanizer-marked syllable splits
  const marks = (lower.match(SYLLABLE_TIMED_MARK) ?? []).length;
  const words = (lower.match(/[a-z]+/g) ?? []).length || 1;
  return marks >= 1 && marks >= words * 0.12;
}

// Syllable-timed text (native CJK/Hangul/kana, or romanized Korean/Japanese) is counted one
// syllable per glyph / romaji syllable — far too fine to pop on each (it strobes the cat and
// reads as "one at a time"). Group this many syllables into a single pop unit so a typical
// word (≤3 syllables) is ONE pop and only a long chained run splits. Applies to native AND
// romanized alike, but never merges across a word boundary. 1 = pop every syllable.
const SYLLABLES_PER_POP = 3;

/** Consecutive items in chunks of `size` (last chunk may be shorter). size ≤ 1 → one each. */
function chunk<T>(items: readonly T[], size: number): T[][] {
  if (size <= 1) return items.map((i) => [i]);
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

/** A token's syllable units, in order: each native CJK/Hangul/kana glyph is one unit; each
 *  Latin run is split into romanized syllables. */
function tokenSyllables(token: string): string[] {
  const units: string[] = [];
  let latin = "";
  const flushLatin = (): void => {
    if (latin) {
      units.push(...splitSyllables(latin));
      latin = "";
    }
  };
  for (const ch of token) {
    if (CJK_CHAR.test(ch)) {
      flushLatin();
      units.push(ch);
    } else {
      latin += ch;
    }
  }
  flushLatin();
  return units;
}

/** A line-split timing unit: native text, its syllable weight, and (for a romaji-split unit) the
 *  romaji WORD it corresponds to. */
export interface LineUnit {
  text: string;
  syllables: number;
  roman?: string;
}

/**
 * Split a SPACE-LESS line (Japanese/Chinese) into real WORDS using its romanization, which marks the
 * word boundaries the native text doesn't. One unit per romaji word: the native glyphs apportioned to
 * it (largest-remainder, weighted by the romaji word's syllable count) with that romaji word attached.
 * The word COUNT and the per-word romaji are exact; the native glyph boundaries are approximate —
 * kanji compress several romaji syllables into one glyph, so they can't be mapped precisely without a
 * dictionary. Returns [] when the romaji holds ≤1 word (caller falls back to mora-grouping).
 */
/** The romaji WORDS of a romanization string — the exact split the native line is divided by, so
 *  the editor can hand each native word its matching romaji. */
export function splitRomanWords(roman: string): string[] {
  return roman.split(SEP_RE).filter(Boolean);
}

function splitByRoman(text: string, roman: string): LineUnit[] {
  const romanWords = splitRomanWords(roman);
  if (romanWords.length <= 1) return [];
  const weights = romanWords.map((w) => Math.max(1, latinWordSyllables(w)));
  const glyphs = tokenSyllables(text.split(SEP_RE).join("")); // native units, separators removed
  if (!glyphs.length) return romanWords.map((r, i) => ({ text: r, syllables: weights[i], roman: r }));
  const totalW = weights.reduce((a, b) => a + b, 0);
  const exact = weights.map((w) => (glyphs.length * w) / totalW);
  const counts = exact.map(Math.floor);
  let used = counts.reduce((a, b) => a + b, 0);
  const byFrac = exact.map((e, i) => ({ i, frac: e - Math.floor(e) })).sort((a, b) => b.frac - a.frac);
  for (let k = 0; used < glyphs.length && byFrac.length; k++, used++) counts[byFrac[k % byFrac.length].i]++;
  const out: LineUnit[] = [];
  let gi = 0;
  for (let i = 0; i < romanWords.length; i++) {
    const slice = glyphs.slice(gi, gi + counts[i]);
    gi += counts[i];
    out.push({ text: slice.join("") || romanWords[i], syllables: weights[i], roman: romanWords[i] });
  }
  return out;
}

/**
 * Split a line into its timing units — each the unit text + its syllable count. Stress-timed
 * lines (English) emit one unit per word with its nucleus count. A space-less syllable-timed line
 * (Japanese/Chinese) with a romanization splits into its real romaji WORDS; otherwise syllable-timed
 * lines (native CJK/Hangul, or romanized Korean/Japanese) group each word's syllables into chunks of
 * SYLLABLES_PER_POP — so a short word is one pop and a long chained run splits — grouping within
 * a word only, never across the spaces/hyphens that separate words. The exact tokenization the
 * timing uses, so the debug view shows the real units. Empty → [].
 */
export function lineWords(text: string, roman?: string): LineUnit[] {
  const perSyllable = isSyllableTimedText(text);
  if (perSyllable && roman) {
    const byRoman = splitByRoman(text, roman);
    if (byRoman.length > 1) return byRoman; // real words from the romaji
  }
  const out: LineUnit[] = [];
  for (const seg of text.split(SEP_RE)) {
    if (!seg) continue;
    if (perSyllable) {
      // One word's syllables, grouped into coarser pop units weighted by how many they hold.
      for (const group of chunk(tokenSyllables(seg), SYLLABLES_PER_POP)) {
        out.push({ text: group.join(""), syllables: group.length });
      }
    } else {
      out.push({ text: seg, syllables: latinWordSyllables(seg) }); // one pop per word
    }
  }
  return out;
}

/** Per-word syllable counts — the weights used to hand each word its share of the line. */
export function wordSyllables(text: string): number[] {
  return lineWords(text).map((w) => w.syllables);
}

// A word-synced span sits a few hundred ms from its neighbour; a line-synced span
// sits seconds away. Used only for scriptless text (no word spaces) where the
// multi-word test can't apply.
const LINE_GAP_MS = 900;

/**
 * True when the spans are *line*-synced (one timestamp per whole phrase) rather than
 * word-synced (one per token). Word-synced lyrics already have real per-syllable
 * timing and must be used as-is — the estimator is only for the line-level fallback.
 *
 * Latin/Korean text: line spans hold multiple space-separated words → line-level iff
 * at least half are multi-word. Scriptless text (Japanese/Chinese, no word spaces)
 * can't be judged that way, so fall back to timing — line spans are seconds apart.
 */
export function spansAreLineLevel(spans: readonly LyricSpan[]): boolean {
  if (spans.length < 2) return false;
  let multiWord = 0;
  for (const s of spans) if (/\S\s+\S/.test(s.text)) multiWord++;
  if (multiWord * 2 >= spans.length) return true; // a majority hold internal word spaces → whole phrases
  // Otherwise judge by CADENCE: line spans sit ~seconds apart, word/syllable spans are densely packed.
  // This is the reliable signal for scriptless text (Japanese/Chinese lines carry no word spaces) AND
  // for mixed lyrics where only SOME lines contain a phrase-break space — the old "any space present →
  // word-synced" shortcut misread those scattered-space line-synced tracks as word-synced.
  const gaps: number[] = [];
  for (let i = 1; i < spans.length; i++) gaps.push(spans[i].start - spans[i - 1].start);
  gaps.sort((a, b) => a - b);
  return gaps[gaps.length >> 1] > LINE_GAP_MS;
}

// When a line carries no end time, estimate its sung length from its syllable count
// at roughly this rate, so the mouth opens only for as long as the line is actually
// sung (not a flat window that bleeds into the instrumental gap after it).
const MS_PER_SYLLABLE = 320;
// Absolute ceiling on that estimate — a guard against a runaway line. A real EndTime
// is always honoured in full (bounded only by the next line's start).
const DEFAULT_LINE_MS = 4000;
// Don't manufacture onsets faster than this — caps the pops on a short, dense line so
// the mouth doesn't strobe.
const MIN_SYLLABLE_MS = 110;

/**
 * Expand line-synced spans into one onset *per word*, timed to emulate sung cadence:
 * each word is held for a slice of the line proportional to its syllable count — so a
 * three-syllable word lingers three times as long as a one-syllable word — with the
 * mouth popping once at each word's onset. A one-word (or too-short) line passes
 * through unchanged; a line with more words than its play time allows (< MIN_SYLLABLE_MS
 * each) falls back to evenly-spaced pops. Input should be sorted by start.
 */
export function expandLineSpans(spans: readonly LyricSpan[]): PulseOnset[] {
  const out: PulseOnset[] = [];
  for (let i = 0; i < spans.length; i++) {
    const span = spans[i];
    const start = span.start;
    const nextStart = i + 1 < spans.length ? spans[i + 1].start : Infinity;
    const weights = wordSyllables(span.text);
    // Honour the line's real end when present; otherwise estimate its sung length from
    // the syllable count so the open ends with the line, not at a flat window. Always
    // bounded by the next line's start so words never overlap it.
    const totalSyll = weights.reduce((a, b) => a + b, 0) || weights.length || 1;
    const rawEnd = span.end ?? start + Math.min(totalSyll * MS_PER_SYLLABLE, DEFAULT_LINE_MS);
    const end = Math.max(start, Math.min(rawEnd, nextStart));
    const dur = end - start;
    if (weights.length <= 1 || dur < 2 * MIN_SYLLABLE_MS) {
      out.push(span.end !== undefined ? { start, end } : { start });
      continue;
    }
    const maxPops = Math.max(1, Math.floor(dur / MIN_SYLLABLE_MS));
    if (weights.length <= maxPops) {
      // One pop per word; each word's duration is its share of the line's syllables.
      const total = weights.reduce((a, b) => a + b, 0) || weights.length;
      let cursor = start;
      for (const w of weights) {
        const s = Math.round(cursor);
        cursor += (dur * w) / total; // syllable-weighted slice → cadence
        out.push({ start: s, end: Math.round(cursor) });
      }
    } else {
      // Too many words for the time available → even, capped spacing (no strobe).
      const step = dur / maxPops;
      for (let j = 0; j < maxPops; j++) {
        out.push({ start: Math.round(start + step * j), end: Math.round(start + step * (j + 1)) });
      }
    }
  }
  return out;
}

// How far a word may move to meet a real audio boundary. Wider than a nudge: the whole
// point is to follow non-uniform cadence (front-loaded, slurred, held), not just jitter.
const ALIGN_WINDOW_MS = 300;
// A boundary this close to a beat is likely percussion…
const BEAT_NEAR_MS = 70;
// …so it costs this much extra when competing as a pop target — enough that a true vocal
// boundary in reach wins, but small enough that an on-beat boundary is still usable when it's
// the only candidate (the vocal often lands on the beat too).
const ON_BEAT_PENALTY_MS = 140;

/** A penalty fn that deprioritizes beat-aligned (drum-ish) boundaries, or undefined when
 *  there's no beat grid to judge against. */
function onBeatPenalty(beats?: readonly number[]): ((b: number) => number) | undefined {
  if (!beats || !beats.length) return undefined;
  return (b: number) => (nearBeat(b, beats, BEAT_NEAR_MS) ? ON_BEAT_PENALTY_MS : 0);
}

// Cost reduction (ms) per dB a boundary's segment swells louder than the previous one. A
// loudness *rise* marks a real attack (a syllable onset), so attacks beat non-attacks at a
// given distance; a boundary that only fades gets no bonus.
const STRENGTH_BONUS_PER_DB = 12;

/**
 * Candidate-scoring for `alignToBoundaries`: on-beat (drum) boundaries cost more, boundaries
 * that *attack* (rise in loudness vs the prior segment) cost less. So among the real audio
 * events in reach of a lyric-counted pop, it lands on a loud vocal onset rather than whatever
 * boundary is merely nearest. Keyed by the same rounded-ms the boundary list uses.
 */
function candidatePenalty(segments: readonly Segment[], beats?: readonly number[]): (b: number) => number {
  const rise = new Map<number, number>();
  for (let i = 0; i < segments.length; i++) {
    const b = Math.round(segments[i].start * 1000);
    const prev = i > 0 ? segments[i - 1].loudnessMax : segments[i].loudnessStart;
    rise.set(b, segments[i].loudnessMax - prev); // dB jump into this segment; positive = attack
  }
  const beatPen = onBeatPenalty(beats);
  return (b: number) => {
    const beat = beatPen ? beatPen(b) : 0;
    const bonus = Math.max(0, rise.get(b) ?? 0) * STRENGTH_BONUS_PER_DB;
    return beat - bonus;
  };
}

/**
 * Align each word's expected (syllable-weighted) start onto a real audio event, monotonically:
 * word i takes the candidate boundary nearest its expected time that comes after word i-1's,
 * within ALIGN_WINDOW_MS; otherwise it keeps the guess. Each boundary is used once, so slurred
 * words (few boundaries) end up close together (fast, matching the slur) and held words sit on
 * their sustained-note onset.
 *
 * The candidate pool is the FULL set of boundaries (every potential pop the audio surfaces);
 * `penalty` lets the caller *deprioritize* some of them (e.g. on-beat/percussion boundaries)
 * so vocal-ish events win when both are in reach — selection, not exclusion. The number of
 * pops is always `expected.length` (lyric-governed); the audio only decides *where* each lands.
 */
export function alignToBoundaries(
  expected: readonly number[],
  boundaries: readonly number[],
  penalty?: (b: number) => number
): number[] {
  if (boundaries.length === 0) return expected.slice();
  const out: number[] = [];
  let bi = 0; // boundaries are consumed in order → monotonic, no reuse
  for (let w = 0; w < expected.length; w++) {
    const t = expected[w];
    let bestIdx = -1;
    let bestCost = Infinity;
    for (let j = bi; j < boundaries.length; j++) {
      const dist = Math.abs(boundaries[j] - t);
      if (dist > ALIGN_WINDOW_MS) continue; // out of reach — never snap this far, whatever the score
      const cost = dist + (penalty ? penalty(boundaries[j]) : 0); // penalty/bonus picks among in-reach ones
      if (cost <= bestCost) {
        bestCost = cost;
        bestIdx = j;
      }
    }
    let start = bestIdx >= 0 ? boundaries[bestIdx] : t; // no candidate in reach → keep the guess
    if (bestIdx >= 0) bi = bestIdx + 1;
    if (out.length && start <= out[out.length - 1]) start = out[out.length - 1] + MIN_SYLLABLE_MS;
    out.push(start);
  }
  return out;
}

/** Per-line: the word tokens, their aligned start times, and the line end. The single
 *  source of truth shared by the cat's onsets and the debug overlay. */
function alignedLine(
  span: LyricSpan,
  nextStart: number,
  segments?: readonly Segment[],
  beats?: readonly number[]
): { words: LineUnit[]; starts: number[]; end: number } {
  const words = lineWords(span.text, span.roman);
  const total = words.reduce((a, w) => a + w.syllables, 0) || words.length || 1;
  // Trust the line's own EndTime ONLY when it's long enough to actually hold the line's words. Some
  // sources give a bogus near-instant line end (end ≈ start, far shorter than the words need), which
  // would cram every word onto the head; in that case fall back to a syllable-count estimate.
  const estimate = span.start + Math.min(total * MS_PER_SYLLABLE, DEFAULT_LINE_MS);
  const rawEnd = span.end !== undefined && span.end - span.start >= total * MIN_SYLLABLE_MS ? span.end : estimate;
  const nominalEnd = Math.max(span.start, Math.min(rawEnd, nextStart));
  // Shrink the line to where the voice actually stops (ignoring the beat), so the words pack
  // into the sung span and the mouth closes before a trailing instrumental. No-op without audio.
  const end = segments ? vocalEndMs(segments, beats, span.start, nominalEnd) : nominalEnd;
  const dur = end - span.start;
  const expected: number[] = [];
  let cursor = span.start;
  for (const w of words) {
    expected.push(Math.round(cursor));
    cursor += (dur * w.syllables) / total; // syllable-weighted guess
  }
  // Candidate pool = EVERY segment boundary in the (vocal-trimmed) line — the full set of
  // potential pops the audio surfaces. Beat-aligned ones (likely drums) aren't excluded, just
  // penalized, and loud attacks are preferred, so a pop lands on a real vocal onset when one's
  // in reach. The lyric count (expected.length) still fixes how many pops fire.
  const starts = segments
    ? alignToBoundaries(expected, offBeatBoundaries(segments, span.start, end), candidatePenalty(segments, beats))
    : expected;
  return { words, starts, end };
}

/**
 * Onsets timed to the actual audio: each line's words are aligned onto its off-beat
 * segment boundaries (the real, non-uniform vocal events), never exceeding the word
 * count, with the inter-line gaps preserved so silence stays mouth-closed.
 */
export function audioTimedLineSpans(
  spans: readonly LyricSpan[],
  segments: readonly Segment[],
  beats?: readonly number[]
): PulseOnset[] {
  const out: PulseOnset[] = [];
  for (let i = 0; i < spans.length; i++) {
    const nextStart = i + 1 < spans.length ? spans[i + 1].start : Infinity;
    const { starts, end } = alignedLine(spans[i], nextStart, segments, beats);
    for (let j = 0; j < starts.length; j++) {
      const s = Math.round(starts[j]);
      out.push({ start: s, end: Math.round(Math.max(s + 1, j + 1 < starts.length ? starts[j + 1] : end)) });
    }
  }
  return out;
}

/** One word with its computed play time (ms) — for the real-time debug view. */
export interface TimedWord {
  text: string;
  start: number;
  end: number;
  roman?: string; // the romaji word this native unit corresponds to (romaji-split lines)
  secondary?: boolean; // a background-vocal word (carried from the span)
}
/** A line of timed words, as the mechanism sees it. */
export interface TimedLine {
  start: number;
  end: number;
  words: TimedWord[];
}

// A lyric line is "line-synced" (one span = whole phrase that still needs splitting) when it's a
// single span that tokenizes into more than one timing unit. Using the tokenizer (not a raw internal
// space test) means a space-LESS script — Japanese/Chinese, where a whole line carries no word
// spaces — is split the SAME as a spaced one, instead of being left as one giant un-split "word".
// A genuine single-unit span (one short word / one glyph) stays verbatim.
function isLineSyncedGroup(line: readonly LyricSpan[]): boolean {
  return line.length === 1 && lineWords(line[0].text, line[0].roman).length > 1;
}

/**
 * Timed words per line — for the debug overlay — honouring the REAL line structure
 * (`lyricLines`), so word-synced tracks render line-by-line instead of one giant block.
 * A line-synced line is split into weighted (and optionally audio-snapped) per-word times,
 * exactly like the onset path; a word/syllable-synced line uses its spans verbatim.
 */
export function timedLines(
  lines: readonly (readonly LyricSpan[])[],
  segments?: readonly Segment[],
  beats?: readonly number[]
): TimedLine[] {
  const out: TimedLine[] = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (!line.length) continue;
    const nextLineStart = i + 1 < lines.length && lines[i + 1].length ? lines[i + 1][0].start : Infinity;
    if (isLineSyncedGroup(line)) {
      const { words, starts, end } = alignedLine(line[0], nextLineStart, segments, beats);
      const timed = words.map((w, j) => ({
        text: w.text,
        start: Math.round(starts[j]),
        end: Math.round(j + 1 < starts.length ? starts[j + 1] : end),
        ...(w.roman ? { roman: w.roman } : {}),
      }));
      if (timed.length) out.push({ start: line[0].start, end, words: timed });
    } else {
      // Word/syllable-synced: the spans already carry real per-unit timing — use verbatim.
      const timed = line.map((s, j) => ({
        text: s.text.trim() || s.text,
        start: s.start,
        end: s.end ?? (j + 1 < line.length ? line[j + 1].start : s.start + 300),
        ...(s.secondary ? { secondary: true } : {}), // carry the background-vocal flag
      }));
      out.push({ start: line[0].start, end: timed[timed.length - 1].end, words: timed });
    }
  }
  return out;
}
