import { describe, it, expect } from "vitest";
import { KeyValueStore } from "./overrides";
import { remaining, consume, utcDay } from "./ratelimit";

function memStore(): KeyValueStore & { data: Record<string, string> } {
  const data: Record<string, string> = {};
  return { data, get: (k) => data[k] ?? null, set: (k, v) => void (data[k] = v) };
}

describe("utcDay", () => {
  it("is the UTC calendar day, YYYY-MM-DD", () => {
    expect(utcDay(new Date("2026-09-24T23:59:59.000Z"))).toBe("2026-09-24");
    expect(utcDay(new Date("2026-09-25T00:00:00.000Z"))).toBe("2026-09-25");
  });
});

describe("daily budget", () => {
  const DAY = "2026-09-24";

  it("starts at the full limit and counts down as calls are consumed", () => {
    const s = memStore();
    expect(remaining(s, "musicae-spotify", 10, DAY)).toBe(10);
    consume(s, "musicae-spotify", DAY);
    consume(s, "musicae-spotify", DAY);
    expect(remaining(s, "musicae-spotify", 10, DAY)).toBe(8);
  });

  it("stops at zero and never goes negative", () => {
    const s = memStore();
    for (let i = 0; i < 15; i++) consume(s, "dj", DAY);
    expect(remaining(s, "dj", 10, DAY)).toBe(0);
  });

  it("tracks providers independently", () => {
    const s = memStore();
    consume(s, "musicae-spotify", DAY);
    expect(remaining(s, "musicae-spotify", 10, DAY)).toBe(9);
    expect(remaining(s, "musicae-dj", 10, DAY)).toBe(10);
  });

  it("resets when the UTC day rolls over", () => {
    const s = memStore();
    for (let i = 0; i < 10; i++) consume(s, "musicae-spotify", DAY);
    expect(remaining(s, "musicae-spotify", 10, DAY)).toBe(0);
    expect(remaining(s, "musicae-spotify", 10, "2026-09-25")).toBe(10); // new day → fresh budget
  });

  it("persists across reads (survives a reload)", () => {
    const s = memStore();
    consume(s, "musicae-spotify", DAY);
    const reloaded: KeyValueStore = { get: (k) => s.data[k] ?? null, set: (k, v) => void (s.data[k] = v) };
    expect(remaining(reloaded, "musicae-spotify", 10, DAY)).toBe(9);
  });

  it("tolerates corrupt storage", () => {
    const s = memStore();
    s.set("catjam-ratelimit", "{not json");
    expect(remaining(s, "musicae-spotify", 10, DAY)).toBe(10);
    consume(s, "musicae-spotify", DAY); // recovers to a clean count
    expect(remaining(s, "musicae-spotify", 10, DAY)).toBe(9);
  });
});
