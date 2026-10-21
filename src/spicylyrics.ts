// Best-effort onset source from the Spicy Lyrics extension, when the user has it
// installed and has opted in. Spicy Lyrics caches the synced lyrics it fetches
// per track in a per-origin CacheStorage ("SpicyLyrics_LyricsStore_g1", keyed by
// "/<trackId>", value { ExpiresAt, CacheVersion, Content }). Because CacheStorage
// is shared across extensions on the same origin, we read that cache directly —
// no dependency on Spicy Lyrics *exposing* anything, no network, no auth. We
// harvest each sung syllable's {Text, StartTime, EndTime} as a pulse onset span
// so the cat throbs on the syllables and holds through held notes.
//
// Entirely best-effort: null whenever Spicy Lyrics is absent (cache empty),
// hasn't cached the track yet, or the lyrics are unsynced — and the pulse falls
// back to its beat clock.

import { PulseOnset } from "./pulse";
import { LyricSpan, expandLineSpans, spansAreLineLevel } from "./syllables";

// The field Spicy Lyrics stores a syllable/line's romanization under (confirmed: `TransliteratedText`,
// present only on non-Latin text). The rest are defensive fallbacks for other builds/sources.
const ROMAN_FIELDS = [
  "TransliteratedText", "RomanizedText", "Romanized", "Romaji", "Romaja", "Romanization",
  "Transliteration", "Translit", "Pronunciation",
] as const;

/** The first non-empty romanization field on a record, or undefined. */
function romanOf(rec: Record<string, unknown>): string | undefined {
  for (const f of ROMAN_FIELDS) {
    const v = rec[f];
    if (typeof v === "string" && v.trim()) return v;
  }
  return undefined;
}

/**
 * Recursively harvest sung units — objects carrying a numeric `StartTime` *and* a
 * string `Text` (a syllable in word-synced lyrics, or a line in line-synced) — as
 * {start, end, text, roman?} spans. The text (and its romanization, when present) is kept so a
 * line-synced span can later be split into words. Depth-guarded; robust to the exact nesting.
 */
export function collectSpans(node: unknown, out: LyricSpan[] = [], depth = 0, secondary = false): LyricSpan[] {
  if (depth > 12 || node == null || typeof node !== "object") return out;
  if (Array.isArray(node)) {
    for (const item of node) collectSpans(item, out, depth + 1, secondary);
    return out;
  }
  const rec = node as Record<string, unknown>;
  // Descend FIRST, then only harvest this node's own span if the descent found NOTHING finer. A
  // word-synced line often carries its own StartTime+Text (the whole line) AND a syllable array whose
  // units each carry their own — that line is an AGGREGATE. Taking only the leaves keeps the harvest
  // at word/syllable granularity, so a whole-line span is never emitted on top of its own words (which
  // made `lyricLines` hand the editor one line-spanning "word" per line). A `Background` subtree
  // (Spicy's secondary vocals) marks everything under it as secondary.
  const before = out.length;
  for (const [key, value] of Object.entries(rec)) {
    if (value && typeof value === "object") collectSpans(value, out, depth + 1, secondary || key === "Background");
  }
  const foundFiner = out.length > before;
  if (
    !foundFiner &&
    typeof rec.StartTime === "number" &&
    Number.isFinite(rec.StartTime) &&
    typeof rec.Text === "string"
  ) {
    const end =
      typeof rec.EndTime === "number" && Number.isFinite(rec.EndTime) ? rec.EndTime : undefined;
    const roman = romanOf(rec);
    out.push({ start: rec.StartTime, end, text: rec.Text, ...(roman ? { roman } : {}), ...(secondary ? { secondary: true } : {}) });
  }
  return out;
}

// A whole song's last onset is ~10^2 in seconds but ~10^5 in ms; anything below
// this reads as seconds and is scaled up. Cleanly separates real tracks either
// way, so it doesn't matter that Spicy Lyrics' unit could change.
const SECONDS_MAX_MS = 10_000;

/**
 * Onset spans in **milliseconds**, sorted by start and de-duplicated by start,
 * or null when there aren't at least two (unsynced / empty). Normalizes
 * seconds → ms by scale.
 */
/** Normalized lyric spans (ms, sorted, de-duped by start) plus whether they're line-
 *  synced, or null when there's nothing usable. The shared front-end for every onset
 *  builder (plain, syllable-estimated, audio-timed). */
export function lyricSpans(parsed: unknown): { lines: LyricSpan[]; lineLevel: boolean } | null {
  const spans = collectSpans(parsed);
  if (spans.length < 2) return null;
  const maxStart = spans.reduce((m, s) => Math.max(m, s.start), 0);
  const k = maxStart < SECONDS_MAX_MS ? 1000 : 1; // seconds → ms
  const byStart = new Map<number, LyricSpan>();
  for (const s of spans) {
    const start = s.start * k;
    const end = typeof s.end === "number" ? s.end * k : undefined;
    const existing = byStart.get(start);
    if (!existing || (existing.end === undefined && end !== undefined)) {
      byStart.set(start, { start, end, text: s.text, ...(s.secondary ? { secondary: true } : {}) });
    }
  }
  const lines = [...byStart.values()].sort((a, b) => a.start - b.start);
  if (lines.length < 2) return null;
  return { lines, lineLevel: spansAreLineLevel(lines) };
}

/** Each normalized span as a plain onset (word-synced verbatim path). */
export function spansToOnsets(lines: readonly LyricSpan[]): PulseOnset[] {
  return lines.map((s) => (s.end !== undefined ? { start: s.start, end: s.end } : { start: s.start }));
}

/**
 * Timed romanization spans `{start(ms), roman}` harvested from Spicy's cached lyrics, when its timed
 * syllables/lines carry a romanized-text field (one of ROMAN_FIELDS). Empty when Spicy stores no
 * romanization (e.g. it transliterates only at render time) — the editor's toggle then no-ops.
 */
export function romanizationSpans(parsed: unknown): { start: number; roman: string }[] {
  const raw: { start: number; roman: string }[] = [];
  const walk = (node: unknown, depth: number): void => {
    if (depth > 12 || node == null || typeof node !== "object") return;
    if (Array.isArray(node)) {
      for (const item of node) walk(item, depth + 1);
      return;
    }
    const rec = node as Record<string, unknown>;
    if (typeof rec.StartTime === "number" && Number.isFinite(rec.StartTime)) {
      const roman = romanOf(rec);
      if (roman) raw.push({ start: rec.StartTime, roman });
    }
    for (const v of Object.values(rec)) if (v && typeof v === "object") walk(v, depth + 1);
  };
  walk(parsed, 0);
  if (!raw.length) return [];
  const maxStart = raw.reduce((m, s) => Math.max(m, s.start), 0);
  const k = maxStart < SECONDS_MAX_MS ? 1000 : 1; // seconds → ms, same scaling as lyricSpans
  return raw.map((s) => ({ start: s.start * k, roman: s.roman })).sort((a, b) => a.start - b.start);
}

/**
 * The array of per-line items in Spicy's parsed lyrics, wherever it's nested. Spicy has moved
 * these between shapes (`Content` / `Lines` / `lines`, sometimes one level deeper, sometimes the
 * top-level value itself), and a hard-coded key list silently falls back to one giant block when
 * the shape shifts. So instead we search the tree for the SHALLOWEST array whose items each carry
 * timed spans — the line array — which survives the format moving around. Null when none exists.
 */
function lineItems(parsed: unknown): unknown[] | null {
  let best: unknown[] | null = null;
  let bestDepth = Infinity;
  const visit = (node: unknown, depth: number): void => {
    if (depth > 8 || !node || typeof node !== "object") return;
    if (Array.isArray(node)) {
      let lines = 0;
      for (const item of node) if (item && typeof item === "object" && collectSpans(item).length) lines++;
      if (lines >= 2 && depth < bestDepth) {
        best = node;
        bestDepth = depth;
      }
      for (const item of node) visit(item, depth + 1); // descend in case the real lines sit deeper
      return;
    }
    for (const v of Object.values(node as Record<string, unknown>)) visit(v, depth + 1);
  };
  visit(parsed, 0);
  return best;
}

/**
 * Lyrics grouped by their REAL line structure (ms, sorted), preserving which words/
 * syllables belong to each line — unlike `lyricSpans`, which flattens everything. Used by
 * the debug overlay so word-synced tracks render line-by-line instead of one giant block.
 * Each inner array is a line's spans (one span = whole-line text for line-synced lyrics,
 * or several word/syllable spans for word-synced). Null when there's nothing usable.
 */
export function lyricLines(parsed: unknown): LyricSpan[][] | null {
  const items = lineItems(parsed);
  const raw: LyricSpan[][] = items
    ? items.map((it) => collectSpans(it)).filter((l) => l.length)
    : (() => {
        // No line container found. If the flat spans are themselves line-level (each span is a
        // whole line of text), each span IS a line — splitting avoids collapsing to one block.
        const flat = collectSpans(parsed);
        if (!flat.length) return [];
        return spansAreLineLevel(flat) ? flat.map((s) => [s]) : [flat];
      })();
  if (!raw.length) return null;
  let maxStart = 0;
  for (const line of raw) for (const s of line) maxStart = Math.max(maxStart, s.start);
  const k = maxStart < SECONDS_MAX_MS ? 1000 : 1; // seconds → ms
  const lines = raw.map((line) =>
    line
      .map((s) => ({
        start: s.start * k,
        end: typeof s.end === "number" ? s.end * k : undefined,
        text: s.text,
        ...(s.roman ? { roman: s.roman } : {}),
        ...(s.secondary ? { secondary: true } : {}),
      }))
      .sort((a, b) => a.start - b.start)
  );
  return lines;
}

/**
 * Best-effort PLAIN-TEXT lines from Spicy's cached lyrics — timing OR NOT. Unlike `lyricLines`, this
 * accepts UNSYNCED / "Static" lyrics (a `Text` with no `StartTime`), which Spicy still renders in its
 * panel but every timed path (collectSpans/lineItems) drops. Used to pre-fill the upload field so the
 * lyrics a user can plainly see are pullable. Strategy: a timed structure first (cleanest), else the
 * shallowest array whose items each yield text, else a single newline-delimited lyrics string. The
 * harvest mirrors `collectSpans` (descend first, take a node's own `Text` only if no finer text was
 * found under it) but without the `StartTime` gate. Null when no text exists anywhere.
 */
export function plainLyricLines(parsed: unknown): string[] | null {
  const timed = lyricLines(parsed);
  if (timed?.length) {
    const lines = timed
      .map((l) => (l.length > 1 ? l.map((s) => s.text).join(" ") : l[0]?.text ?? "").replace(/\s+/g, " ").trim())
      .filter(Boolean);
    if (lines.length) return lines;
  }

  // One line's text, StartTime-agnostic: harvest `Text` at the finest granularity (join syllables).
  const lineTextOf = (node: unknown): string => {
    if (typeof node === "string") return node.replace(/\s+/g, " ").trim();
    const parts: string[] = [];
    const walk = (n: unknown, depth: number): void => {
      if (depth > 12 || n == null || typeof n !== "object") return;
      if (Array.isArray(n)) {
        for (const it of n) walk(it, depth + 1);
        return;
      }
      const rec = n as Record<string, unknown>;
      const before = parts.length;
      for (const v of Object.values(rec)) if (v && typeof v === "object") walk(v, depth + 1);
      if (parts.length === before && typeof rec.Text === "string" && rec.Text.trim()) parts.push(rec.Text);
    };
    walk(node, 0);
    return parts.join(" ").replace(/\s+/g, " ").trim();
  };

  // Shallowest array whose items each yield some text — the line array, even without timing.
  let best: unknown[] | null = null;
  let bestDepth = Infinity;
  const visit = (node: unknown, depth: number): void => {
    if (depth > 8 || !node || typeof node !== "object") return;
    if (Array.isArray(node)) {
      let textful = 0;
      for (const it of node) if (lineTextOf(it)) textful++;
      if (textful >= 2 && depth < bestDepth) {
        best = node;
        bestDepth = depth;
      }
      for (const it of node) visit(it, depth + 1);
      return;
    }
    for (const v of Object.values(node as Record<string, unknown>)) visit(v, depth + 1);
  };
  visit(parsed, 0);
  if (best) {
    const lines = (best as unknown[]).map(lineTextOf).filter(Boolean);
    if (lines.length >= 2) return lines;
  }

  // Last resort: a single lyrics blob carrying its own newlines.
  let blob: string | null = null;
  const findBlob = (node: unknown, depth: number): void => {
    if (blob || depth > 8 || !node || typeof node !== "object") return;
    for (const v of Object.values(node as Record<string, unknown>)) {
      if (typeof v === "string" && v.includes("\n") && v.trim().length > 8) {
        blob = v;
        return;
      }
      if (v && typeof v === "object") findBlob(v, depth + 1);
    }
  };
  findBlob(parsed, 0);
  if (blob) {
    const lines = (blob as string)
      .split(/\r?\n/)
      .map((s) => s.trim())
      .filter(Boolean);
    if (lines.length) return lines;
  }
  return null;
}

export function onsetSpansFromLyrics(parsed: unknown, estimateLines = false): PulseOnset[] | null {
  const info = lyricSpans(parsed);
  if (!info) return null;
  // Word-synced lyrics have real per-syllable timing — used verbatim. Line-synced lyrics
  // are sub-divided into estimated syllables only when the line estimator is on.
  const out = estimateLines && info.lineLevel ? expandLineSpans(info.lines) : spansToOnsets(info.lines);
  return out.length >= 2 ? out : null;
}

// CacheStorage name Spicy Lyrics uses for API-fetched lyrics (version-pinned by
// the "_g1" suffix — if Spicy Lyrics bumps it, this needs to follow).
const LYRICS_CACHE = "SpicyLyrics_LyricsStore_g1";

/** The track ids Spicy Lyrics has cached lyrics for (keys are `/<trackId>`). Empty when the cache
 *  is absent/unreadable. Each still needs reading to tell word- from line-synced. */
export async function listSpicyLyricsCache(): Promise<string[]> {
  const cacheStorage: CacheStorage | undefined = (globalThis as { caches?: CacheStorage }).caches;
  if (!cacheStorage) return [];
  try {
    const cache = await cacheStorage.open(LYRICS_CACHE);
    const reqs = await cache.keys();
    const ids = new Set<string>();
    for (const r of reqs) {
      try {
        const seg = new URL(r.url).pathname.split("/").filter(Boolean).pop() ?? "";
        if (/^[A-Za-z0-9]{10,}$/.test(seg)) ids.add(seg); // base62 Spotify track id
      } catch {
        /* skip unparseable key */
      }
    }
    return [...ids];
  } catch {
    return [];
  }
}

/** Read the parsed lyrics object Spicy Lyrics cached for a track id, else null. */
export async function readSpicyLyricsCache(trackId: string): Promise<unknown | null> {
  const cacheStorage: CacheStorage | undefined = (globalThis as { caches?: CacheStorage }).caches;
  if (!cacheStorage) return null;
  try {
    const cache = await cacheStorage.open(LYRICS_CACHE);
    const res = await cache.match(`/${trackId}`);
    if (!res) return null;
    const wrapped = (await res.json()) as { Content?: unknown };
    return wrapped?.Content ?? null;
  } catch {
    return null;
  }
}

const sleepDefault = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/** Injectable transport, so the poll/parse logic stays unit-testable. */
export interface OnsetReaderOpts {
  read?: (trackId: string) => Promise<unknown | null>;
  sleep?: (ms: number) => Promise<void>;
  /** Fast initial probe delays (ms): catch a warm cache instantly and cover the
   *  first few seconds densely. After these, polling continues at `pollIntervalMs`. */
  retries?: number[];
  /** Steady poll interval (ms) after the warmup probes. */
  pollIntervalMs?: number;
  /** Give up polling a cold track after this long (ms) and stay on the beat. */
  maxWaitMs?: number;
  /** Turn the parsed Spicy Lyrics blob into onset spans. Lets the caller choose the
   *  timing strategy (plain / syllable-estimated / audio-timed) per track, live. The
   *  `uri` is passed so audio-timed builders can fetch that track's analysis. Defaults
   *  to word-synced verbatim (line-synced → one onset per line). */
  buildOnsets?: (parsed: unknown, uri: string) => Promise<PulseOnset[] | null> | PulseOnset[] | null;
}

/**
 * Build a `fetchOnsets(uri)` backed by Spicy Lyrics' lyrics cache. `enabled` gates
 * it (no-op until opted in). Spicy Lyrics fetches+caches on song change, but on a
 * cold track that can land many seconds in — so we don't give up at a fixed point:
 * we probe fast at first (warm cache → instant), then keep polling through playback
 * and resolve the moment the lyrics land. Onsets carry absolute timestamps and the
 * pulse clock is player-driven, so applying them **mid-song** is correct — sync
 * engages as soon as the cache warms, even on the very first play. A newer request
 * supersedes any in-flight poll (track skipped). Always resolves; null → beat.
 */
export function createSpicyOnsetReader(
  enabled: () => boolean,
  opts: OnsetReaderOpts = {}
): (uri: string) => Promise<PulseOnset[] | null> {
  const read = opts.read ?? readSpicyLyricsCache;
  const sleep = opts.sleep ?? sleepDefault;
  const warmup = opts.retries ?? [0, 500, 1000, 2000, 3500, 5000];
  const pollIntervalMs = opts.pollIntervalMs ?? 2500;
  const maxWaitMs = opts.maxWaitMs ?? 90_000;
  const buildOnsets = opts.buildOnsets ?? ((parsed: unknown) => onsetSpansFromLyrics(parsed));
  let latest = 0; // bumped per call; an older in-flight poll bails when superseded
  return async (uri: string): Promise<PulseOnset[] | null> => {
    const token = ++latest;
    if (!enabled()) return null;
    const parts = typeof uri === "string" ? uri.split(":") : [];
    const trackId = parts[0] === "spotify" && parts[1] === "track" ? parts[2] : "";
    if (!trackId) return null; // podcasts / local files have no track-lyrics cache

    let elapsed = 0;
    for (let idx = 0; ; idx++) {
      const inWarmup = idx < warmup.length;
      if (!inWarmup && elapsed >= maxWaitMs) return null; // cold track → give up to the beat
      const delay = inWarmup ? warmup[idx] : pollIntervalMs;
      if (delay > 0) {
        await sleep(delay);
        elapsed += delay;
      }
      if (token !== latest) return null; // a newer track superseded this poll
      if (!enabled()) return null; // toggled off during the wait
      let lyrics: unknown = null;
      try {
        lyrics = await read(trackId);
      } catch {
        lyrics = null;
      }
      const onsets = lyrics ? await buildOnsets(lyrics, uri) : null;
      if (onsets) return onsets;
      // Cached but no syllable/line timing (static lyrics / instrumental): once past
      // the dense warmup window, stop — re-parsing the same unchanged blob every tick
      // won't turn it synced. (A not-yet-cached track has `lyrics == null` → keep
      // polling; the warmup still allows a late first write.)
      if (lyrics && !inWarmup) return null;
    }
  };
}
