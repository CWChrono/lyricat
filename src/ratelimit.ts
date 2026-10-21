// Per-provider daily request budgets, persisted so the cap survives Spotify
// restarts. Some BPM providers (the RapidAPI/Musicae ones) are free-tier limited
// to a handful of lookups per day; blowing past that gets the key throttled
// (HTTP 429). This tracks each provider's usage against a UTC calendar day and
// refuses further calls once the limit is reached. The logic is pure and takes an
// injected `today` string so it's deterministic to test.

import { KeyValueStore } from "./overrides";

const STORAGE_KEY = "catjam-ratelimit";

interface DailyCount {
  /** UTC calendar day, "YYYY-MM-DD". Usage resets when this rolls over. */
  date: string;
  count: number;
}

type Counts = Record<string, DailyCount>;

/** The current UTC day as "YYYY-MM-DD" (the reset boundary). */
export function utcDay(now: Date): string {
  return now.toISOString().slice(0, 10);
}

function read(store: KeyValueStore): Counts {
  try {
    const parsed = JSON.parse(store.get(STORAGE_KEY) || "{}");
    if (!parsed || typeof parsed !== "object") return {};
    const out: Counts = {};
    for (const [id, v] of Object.entries(parsed as Record<string, unknown>)) {
      const { date, count } = (v ?? {}) as Partial<DailyCount>;
      if (typeof date === "string" && typeof count === "number" && Number.isFinite(count) && count >= 0) {
        out[id] = { date, count };
      }
    }
    return out;
  } catch {
    return {};
  }
}

/** Today's usage for a provider (0 once the stored day is stale). */
function usedToday(counts: Counts, id: string, today: string): number {
  const slot = counts[id];
  return slot && slot.date === today ? slot.count : 0;
}

/** How many calls remain in a provider's daily budget (never negative). */
export function remaining(store: KeyValueStore, id: string, limit: number, today: string): number {
  return Math.max(0, limit - usedToday(read(store), id, today));
}

/**
 * Record one used call against a provider's daily budget. Call this only after a
 * request actually reached the provider (any HTTP response) — not on a network
 * error the provider never saw — so transient failures don't burn the budget.
 */
export function consume(store: KeyValueStore, id: string, today: string): void {
  const counts = read(store);
  counts[id] = { date: today, count: usedToday(counts, id, today) + 1 };
  store.set(STORAGE_KEY, JSON.stringify(counts));
}
