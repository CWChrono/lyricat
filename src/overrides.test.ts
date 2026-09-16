import { describe, it, expect } from "vitest";
import {
  readOverrides,
  getOverride,
  setStoredBpm,
  setDelayMs,
  setTrackName,
  flipDoubleTime,
  clampDelay,
  KeyValueStore,
} from "./overrides";

function memStore(initial: Record<string, string> = {}): KeyValueStore {
  const data = { ...initial };
  return {
    get: (k) => (k in data ? data[k] : null),
    set: (k, v) => {
      data[k] = v;
    },
  };
}

describe("clampDelay", () => {
  it("rounds and clamps into [0, 500]", () => {
    expect(clampDelay(-10)).toBe(0);
    expect(clampDelay(123.6)).toBe(124);
    expect(clampDelay(999)).toBe(500);
    expect(clampDelay(NaN)).toBe(0);
  });
});

describe("overrides", () => {
  it("returns undefined when a track has nothing recorded", () => {
    expect(getOverride(memStore(), "A")).toBeUndefined();
  });

  it("first double-time toggle inverts what the auto heuristic is doing", () => {
    const folds = memStore();
    expect(flipDoubleTime(folds, "A", true)).toBe(false); // auto folds -> turn off
    expect(getOverride(folds, "A")).toEqual({ doubleTime: false });

    const noFold = memStore();
    expect(flipDoubleTime(noFold, "B", false)).toBe(true); // auto leaves -> mark double-time
    expect(getOverride(noFold, "B")).toEqual({ doubleTime: true });
  });

  it("later toggles flip the stored value and ignore the auto arg", () => {
    const s = memStore();
    flipDoubleTime(s, "C", false); // -> true
    expect(flipDoubleTime(s, "C", true)).toBe(false);
    expect(flipDoubleTime(s, "C", true)).toBe(true);
  });

  it("stores name, bpm and delay alongside double-time without clobbering", () => {
    const s = memStore();
    setStoredBpm(s, "A", 128.4);
    flipDoubleTime(s, "A", false); // -> true
    setDelayMs(s, "A", 250);
    setTrackName(s, "A", "Venus - Regina Song");
    expect(getOverride(s, "A")).toEqual({
      name: "Venus - Regina Song",
      bpm: 128.4,
      doubleTime: true,
      delayMs: 250,
    });
  });

  it("clamps stored delay and ignores invalid bpm", () => {
    const s = memStore();
    setDelayMs(s, "A", 9999);
    setStoredBpm(s, "A", 0); // invalid, ignored
    expect(getOverride(s, "A")).toEqual({ delayMs: 500 });
  });

  it("migrates the legacy boolean format and survives corrupt storage", () => {
    const legacy = memStore({ "catjam-doubletime-overrides": JSON.stringify({ X: true }) });
    expect(getOverride(legacy, "X")).toEqual({ doubleTime: true });

    const corrupt = memStore({ "catjam-doubletime-overrides": "not json" });
    expect(readOverrides(corrupt)).toEqual({});
  });
});
