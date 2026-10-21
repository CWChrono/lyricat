import { describe, it, expect } from "vitest";
import { lrcKey, readLrcCache, writeLrcCache, listLrcCache, deleteLrcCache, LRC_VERSION } from "./lyriccache";

// A Map-backed fake of the sliver of the Storage (localStorage) API the module uses.
function fakeStore() {
  const map = new Map<string, string>();
  return {
    map,
    getItem: (k: string) => (map.has(k) ? map.get(k)! : null),
    setItem: (k: string, v: string) => void map.set(k, v),
    removeItem: (k: string) => void map.delete(k),
    get length() {
      return map.size;
    },
    key: (i: number) => [...map.keys()][i] ?? null,
  };
}

describe("lrcKey", () => {
  it("builds the versioned localStorage key", () => {
    expect(lrcKey("abc123")).toBe(`catjam-lyric:${LRC_VERSION}:abc123`);
    expect(lrcKey("abc123", "v2")).toBe("catjam-lyric:v2:abc123");
  });
});

describe("readLrcCache / writeLrcCache", () => {
  it("round-trips an LRC under its track id", async () => {
    const s = fakeStore();
    await writeLrcCache("track1", "[00:01.00] hi", LRC_VERSION, s);
    expect(s.map.get("catjam-lyric:v1:track1")).toBe("[00:01.00] hi");
    expect(await readLrcCache("track1", LRC_VERSION, s)).toBe("[00:01.00] hi");
  });

  it("returns null for a missing track", async () => {
    expect(await readLrcCache("nope", LRC_VERSION, fakeStore())).toBeNull();
  });

  it("is a no-op without an id or lyrics, and null when storage is unavailable", async () => {
    const s = fakeStore();
    await writeLrcCache("", "x", LRC_VERSION, s);
    await writeLrcCache("track1", "", LRC_VERSION, s);
    expect(s.map.size).toBe(0);
    expect(await readLrcCache("track1", LRC_VERSION, undefined)).toBeNull();
  });
});

describe("listLrcCache / deleteLrcCache", () => {
  it("lists every saved entry (id + lrc), sorted by id", async () => {
    const s = fakeStore();
    await writeLrcCache("bravo", "[00:01.00] b", LRC_VERSION, s);
    await writeLrcCache("alpha", "[00:02.00] a", LRC_VERSION, s);
    const entries = await listLrcCache(LRC_VERSION, s);
    expect(entries.map((e) => e.id)).toEqual(["alpha", "bravo"]);
    expect(entries[0].lrc).toBe("[00:02.00] a");
  });

  it("ignores entries from other versions", async () => {
    const s = fakeStore();
    await writeLrcCache("t1", "[00:01.00] x", "v1", s);
    await writeLrcCache("t1", "[00:01.00] y", "v2", s);
    expect((await listLrcCache("v1", s)).map((e) => e.id)).toEqual(["t1"]);
    expect(await readLrcCache("t1", "v2", s)).toBe("[00:01.00] y");
  });

  it("deletes a single entry, leaving the rest", async () => {
    const s = fakeStore();
    await writeLrcCache("t1", "[00:01.00] a", LRC_VERSION, s);
    await writeLrcCache("t2", "[00:01.00] b", LRC_VERSION, s);
    await deleteLrcCache("t1", LRC_VERSION, s);
    expect((await listLrcCache(LRC_VERSION, s)).map((e) => e.id)).toEqual(["t2"]);
  });

  it("re-saving an id overwrites its LRC (Edit → Save)", async () => {
    const s = fakeStore();
    await writeLrcCache("t1", "[00:01.00] old", LRC_VERSION, s);
    await writeLrcCache("t1", "[00:01.00] new", LRC_VERSION, s);
    expect(await readLrcCache("t1", LRC_VERSION, s)).toBe("[00:01.00] new");
  });
});
