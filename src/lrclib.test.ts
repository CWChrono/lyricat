import { describe, it, expect, vi } from "vitest";
import { parseLrc, fetchLrclibLines } from "./lrclib";

const res = (ok: boolean, body: unknown): Response =>
  ({ ok, json: () => Promise.resolve(body) }) as unknown as Response;

describe("parseLrc", () => {
  it("parses timed lines into sorted ms spans", () => {
    const lines = parseLrc("[00:01.00] hello\n[00:03.50] world");
    expect(lines).toEqual([
      { start: 1000, text: "hello" },
      { start: 3500, text: "world" },
    ]);
  });
  it("treats a 2-digit fraction as centiseconds and 3-digit as ms", () => {
    expect(parseLrc("[00:00.05] a\n[00:01.250] b")).toEqual([
      { start: 50, text: "a" },
      { start: 1250, text: "b" },
    ]);
  });
  it("drops metadata/empty lines and emits a span per repeated tag", () => {
    const lines = parseLrc("[ar:Someone]\n[00:01.00][00:05.00] la\n[00:02.00] \n");
    expect(lines).toEqual([
      { start: 1000, text: "la" },
      { start: 5000, text: "la" },
    ]);
  });
  it("is null when fewer than two timed lines survive", () => {
    expect(parseLrc("[00:01.00] only one")).toBeNull();
    expect(parseLrc("")).toBeNull();
  });
});

describe("fetchLrclibLines", () => {
  const track = { title: "Song", artist: "Artist", album: "Album", durationSec: 200 };

  it("uses the exact /get hit when it has synced lyrics", async () => {
    const fetchFn = vi.fn().mockResolvedValue(res(true, { syncedLyrics: "[00:01.00] a\n[00:02.00] b" }));
    const lines = await fetchLrclibLines(fetchFn, track);
    expect(lines).toHaveLength(2);
    expect(fetchFn.mock.calls[0][0]).toContain("/get?");
    expect(fetchFn.mock.calls[0][0]).toContain("duration=200");
  });

  it("falls back to /search when /get has no synced lyrics", async () => {
    const fetchFn = vi
      .fn()
      .mockResolvedValueOnce(res(true, { instrumental: true }))
      .mockResolvedValueOnce(res(true, [{ syncedLyrics: null }, { syncedLyrics: "[00:00.00] x\n[00:01.00] y" }]));
    const lines = await fetchLrclibLines(fetchFn, track);
    expect(lines).toHaveLength(2);
    expect(fetchFn.mock.calls[1][0]).toContain("/search?");
  });

  it("returns null when nothing has synced lyrics", async () => {
    const fetchFn = vi.fn().mockResolvedValue(res(true, []));
    expect(await fetchLrclibLines(fetchFn, track)).toBeNull();
  });

  it("swallows transport errors", async () => {
    const fetchFn = vi.fn().mockRejectedValue(new Error("offline"));
    expect(await fetchLrclibLines(fetchFn, track)).toBeNull();
  });
});
