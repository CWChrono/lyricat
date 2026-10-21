// The "line editor" core: turn a line of typed text into word-units and reconcile that edit against the
// line's EXISTING timed words, preserving timing where possible. Pure + fully unit-tested; the UI
// (app.tsx) and the romanizer build on this.
//
// Delimiters — space, "/", "-" — all split the text into word-units. "/" is the ergonomic one for
// spaceless CJK (you type 안녕/하세요 to make two singable units); "-" splits too (melisma / syllable
// breaks). A word-unit is whatever sits between delimiters.
//
// Reconcile rule (matches the product spec):
//   • the edit is ONLY insertions, or ONLY deletions  → SURGICAL: unchanged words keep their exact
//     [start,end]; deletions just vanish (leaving their gap); each inserted word takes a slice of the
//     gap between its surviving neighbours. If an insertion run has no room, that falls back to rebalance.
//   • anything else (a substitution, a reorder — i.e. BOTH adds and removes) → REBALANCE: re-space every
//     word across the line's [start,end] window, weighted by character count.

/** Split delimiters: any run of whitespace, "/", or "-". */
const DELIMS = /[\s/\-]+/;

/** Tokenize a line into word-units (delimiters stripped, blanks dropped). */
export function tokenizeLine(text: string): string[] {
  if (!text) return [];
  return text
    .split(DELIMS)
    .map((t) => t.trim())
    .filter(Boolean);
}

/** Join word-units back into a line's text with a single delimiter (default "/" for CJK legibility). */
export function serializeLine(words: readonly string[], delim = " / "): string {
  return words.join(delim);
}

/** One existing timed word (only the fields reconcile needs; callers keep the richer object). */
export interface TimedWord {
  text: string;
  start: number;
  end: number;
}

/** A reconciled word: its text + new [start,end], plus `from` = the index in the OLD list it was matched
 *  to (so the caller can carry that word's flags/romanization over), or null when it's freshly inserted. */
export interface ReconciledWord {
  text: string;
  start: number;
  end: number;
  from: number | null;
}

export interface ReconcileResult {
  words: ReconciledWord[];
  mode: "unchanged" | "surgical" | "rebalance";
}

/** LCS alignment of two string lists → the matched (oldIndex, newIndex) pairs, in order. Index-aware,
 *  so repeated words ("la la la") align by position rather than collapsing. */
function lcsPairs(a: readonly string[], b: readonly string[]): [number, number][] {
  const m = a.length;
  const n = b.length;
  const dp: number[][] = Array.from({ length: m + 1 }, () => new Array<number>(n + 1).fill(0));
  for (let i = m - 1; i >= 0; i--) {
    for (let j = n - 1; j >= 0; j--) {
      dp[i][j] = a[i] === b[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
    }
  }
  const pairs: [number, number][] = [];
  let i = 0;
  let j = 0;
  while (i < m && j < n) {
    if (a[i] === b[j]) {
      pairs.push([i, j]);
      i++;
      j++;
    } else if (dp[i + 1][j] >= dp[i][j + 1]) {
      i++;
    } else {
      j++;
    }
  }
  return pairs;
}

/** Spread `tokens` across [lineStart,lineEnd], widths weighted by character count (≥ minDur each when
 *  the window allows). `fromOf` maps each token index to its matched old index (flag carry-over). */
function rebalance(
  tokens: readonly string[],
  lineStart: number,
  lineEnd: number,
  minDur: number,
  fromOf: (j: number) => number | null
): ReconciledWord[] {
  const n = tokens.length;
  if (!n) return [];
  const span = Math.max(0, lineEnd - lineStart);
  const weights = tokens.map((t) => Math.max(1, [...t].length)); // code-point count (CJK-safe)
  const total = weights.reduce((s, w) => s + w, 0);
  // If the window can't give everyone minDur, fall back to an even split of whatever span exists.
  const useWeights = span >= minDur * n;
  const out: ReconciledWord[] = [];
  let cursor = lineStart;
  let acc = 0;
  for (let j = 0; j < n; j++) {
    acc += weights[j];
    const end = j === n - 1 ? lineEnd : lineStart + (useWeights ? (span * acc) / total : (span * (j + 1)) / n);
    const start = cursor;
    out.push({ text: tokens[j], start: Math.round(start), end: Math.max(Math.round(start) + 1, Math.round(end)), from: fromOf(j) });
    cursor = end;
  }
  return out;
}

/**
 * Reconcile an edited token list against a line's existing timed words.
 * @param old        the line's current words (start-sorted), timing in ms
 * @param tokens     the edited word-units (from tokenizeLine)
 * @param lineStart  the line window's start (ms) — used for inserts at the head / rebalance
 * @param lineEnd    the line window's end (ms)
 * @param minDur     minimum word duration (ms) an inserted/rebalanced word may take
 */
export function reconcileLine(
  old: readonly TimedWord[],
  tokens: readonly string[],
  lineStart: number,
  lineEnd: number,
  minDur = 60
): ReconcileResult {
  const oldTexts = old.map((w) => w.text);
  // Fast path: identical text list → nothing changed, keep everything.
  if (oldTexts.length === tokens.length && oldTexts.every((t, k) => t === tokens[k])) {
    return { words: old.map((w, k) => ({ text: w.text, start: w.start, end: w.end, from: k })), mode: "unchanged" };
  }

  const pairs = lcsPairs(oldTexts, tokens);
  const matchedOld = new Set(pairs.map((p) => p[0]));
  const matchedNew = new Set(pairs.map((p) => p[1]));
  const newToOld = new Map<number, number>(pairs.map(([oi, nj]) => [nj, oi]));
  const deletions = oldTexts.length - matchedOld.size;
  const insertions = tokens.length - matchedNew.size;
  const fromOf = (j: number): number | null => (newToOld.has(j) ? (newToOld.get(j) as number) : null);

  // Both adds AND removes (substitution / reorder) → rebalance the whole line.
  if (deletions > 0 && insertions > 0) {
    return { words: rebalance(tokens, lineStart, lineEnd, minDur, fromOf), mode: "rebalance" };
  }

  // Pure deletion: every token matched an old word → keep each kept word's timing verbatim.
  if (insertions === 0) {
    return {
      words: tokens.map((t, j) => {
        const oi = newToOld.get(j) as number;
        return { text: t, start: old[oi].start, end: old[oi].end, from: oi };
      }),
      mode: "surgical",
    };
  }

  // Pure insertion: every old word survives; new tokens drop into the gaps between surviving neighbours.
  // Walk the token list, grouping consecutive insertions between two kept anchors (or the line edges),
  // and split each run's available gap. If any run has no room, fall back to a full rebalance.
  const result: ReconciledWord[] = [];
  let k = 0;
  while (k < tokens.length) {
    if (matchedNew.has(k)) {
      const oi = newToOld.get(k) as number;
      result.push({ text: tokens[k], start: old[oi].start, end: old[oi].end, from: oi });
      k++;
      continue;
    }
    // Collect a run of inserted tokens [k, r)
    let r = k;
    while (r < tokens.length && !matchedNew.has(r)) r++;
    const runLen = r - k;
    const prevKept = result.length ? result[result.length - 1] : null; // already-placed left anchor
    const nextOi = r < tokens.length ? (newToOld.get(r) as number) : null; // right anchor (old index)
    const gapStart = prevKept ? prevKept.end : lineStart;
    const gapEnd = nextOi !== null ? old[nextOi].start : lineEnd;
    const gap = gapEnd - gapStart;
    if (gap < minDur * runLen) {
      // No room to insert without shoving neighbours → rebalance the whole line instead.
      return { words: rebalance(tokens, lineStart, lineEnd, minDur, fromOf), mode: "rebalance" };
    }
    const slot = gap / runLen;
    for (let s = 0; s < runLen; s++) {
      const start = gapStart + slot * s;
      result.push({ text: tokens[k + s], start: Math.round(start), end: Math.max(Math.round(start) + 1, Math.round(start + slot)), from: null });
    }
    k = r;
  }
  return { words: result, mode: "surgical" };
}
