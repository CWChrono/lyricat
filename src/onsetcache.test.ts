import { describe, it, expect } from "vitest";
import { encodeOnsets, decodeOnsets, readOnsetCache, writeOnsetCache, removeOnsetCache } from "./onsetcache";
import { KeyValueStore } from "./overrides";

const memStore = (): KeyValueStore => {
  const m = new Map<string, string>();
  return { get: (k) => m.get(k) ?? null, set: (k, v) => void m.set(k, v) };
};

describe("encode/decode onsets", () => {
  it("round-trips onset spans through the compact form", () => {
    const onsets = [
      { start: 1000, end: 1200 },
      { start: 1500, end: 1800 },
      { start: 2000 }, // no end
    ];
    const encoded = encodeOnsets(onsets);
    expect(decodeOnsets(encoded)).toEqual(onsets);
  });
  it("is compact: delta-encoded, base + per-onset tokens", () => {
    expect(encodeOnsets([{ start: 1000, end: 1200 }, { start: 1500, end: 1800 }])).toBe("13|1000|0+200,500+300");
  });
  it("returns null for empty / malformed / wrong-version input", () => {
    expect(encodeOnsets([])).toBe("");
    expect(decodeOnsets("")).toBeNull();
    expect(decodeOnsets(null)).toBeNull();
    expect(decodeOnsets("1|1000|0+200")).toBeNull(); // older version → recompute
    expect(decodeOnsets("garbage")).toBeNull();
  });
});

describe("onset cache store", () => {
  it("persists and reads back a track's bop map", () => {
    const s = memStore();
    const onsets = [{ start: 0, end: 150 }, { start: 150, end: 300 }];
    writeOnsetCache(s, "trackA", onsets);
    expect(readOnsetCache(s, "trackA")).toEqual(onsets);
    expect(readOnsetCache(s, "trackB")).toBeNull();
  });
  it("ignores empty onsets and blank ids", () => {
    const s = memStore();
    writeOnsetCache(s, "trackA", []);
    expect(readOnsetCache(s, "trackA")).toBeNull();
    writeOnsetCache(s, "", [{ start: 0, end: 1 }]);
    expect(readOnsetCache(s, "")).toBeNull();
  });
  it("removeOnsetCache drops one track, leaving others intact", () => {
    const s = memStore();
    writeOnsetCache(s, "trackA", [{ start: 0, end: 150 }]);
    writeOnsetCache(s, "trackB", [{ start: 0, end: 200 }]);
    removeOnsetCache(s, "trackA");
    expect(readOnsetCache(s, "trackA")).toBeNull(); // gone → next play recomputes
    expect(readOnsetCache(s, "trackB")).toEqual([{ start: 0, end: 200 }]); // untouched
    removeOnsetCache(s, "trackA"); // absent → no-op, no throw
  });
  it("a failed write (storage full) leaves the cache at its last persisted value — the read memo never shows the dropped entry", () => {
    const m = new Map<string, string>();
    let failSet = false;
    const s: KeyValueStore = {
      get: (k) => m.get(k) ?? null,
      set: (k, v) => {
        if (failSet) throw new Error("QuotaExceeded");
        m.set(k, v);
      },
    };
    writeOnsetCache(s, "trackA", [{ start: 0, end: 150 }]); // persists + primes the memo
    expect(readOnsetCache(s, "trackA")).toEqual([{ start: 0, end: 150 }]);
    failSet = true;
    writeOnsetCache(s, "trackB", [{ start: 0, end: 200 }]); // store.set throws → silently dropped
    // The dropped write must NOT surface via the memo, and trackA must still read correctly.
    expect(readOnsetCache(s, "trackB")).toBeNull();
    expect(readOnsetCache(s, "trackA")).toEqual([{ start: 0, end: 150 }]);
  });
});
