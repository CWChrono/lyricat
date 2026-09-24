import { describe, it, expect, vi } from "vitest";
import { findTempo, parseGetSongBpm, fetchGetSongBpm } from "./bpmproviders";

const ok = (body: unknown) => ({ ok: true, json: async () => body }) as Response;
const bad = () => ({ ok: false, json: async () => ({}) }) as Response;

describe("findTempo (GetSongBPM)", () => {
  it("finds a valid nested tempo, rounding it", () => {
    expect(findTempo({ search: [{ tempo: "128" }] })).toBe(128);
    expect(findTempo({ result: { song: { tempo: 174.6 } } })).toBe(175);
  });
  it("ignores out-of-range / missing tempo", () => {
    expect(findTempo({ search: [{ tempo: "9999" }] })).toBeNull();
    expect(findTempo({ search: [{ title: "x" }] })).toBeNull();
    expect(findTempo(null)).toBeNull();
  });
});

describe("parseGetSongBpm", () => {
  it("reads the tempo from a search hit", () => {
    expect(parseGetSongBpm({ search: [{ tempo: "126", song_title: "x" }] })).toBe(126);
  });
});

describe("fetchGetSongBpm (key-gated, fail-soft)", () => {
  it("GetSongBPM: no key → no request", async () => {
    const f = vi.fn();
    expect(await fetchGetSongBpm(f, "", "Levels", "Avicii")).toBeNull();
    expect(f).not.toHaveBeenCalled();
  });
  it("GetSongBPM: hits api.getsong.co with key + lookup, returns tempo", async () => {
    const f = vi.fn().mockResolvedValue(ok({ search: [{ tempo: "126" }] }));
    expect(await fetchGetSongBpm(f, "KEY", "Levels", "Avicii")).toBe(126);
    const url = f.mock.calls[0][0] as string;
    expect(url).toContain("https://api.getsong.co/search/"); // the API host, not getsongbpm.com
    expect(url).toContain("api_key=KEY");
    expect(url).toContain(encodeURIComponent("song:Levels artist:Avicii"));
  });
  it("GetSongBPM: resolves the /song/ endpoint when search omits tempo", async () => {
    const f = vi
      .fn()
      .mockResolvedValueOnce(ok({ search: [{ song_id: "abc123", song_title: "Levels" }] })) // no tempo
      .mockResolvedValueOnce(ok({ song: { tempo: "128" } })); // /song/?id=abc123
    expect(await fetchGetSongBpm(f, "KEY", "Levels", "Avicii")).toBe(128);
    expect(f.mock.calls[1][0]).toContain("/song/?api_key=KEY&id=abc123");
  });
  it("GetSongBPM: an error/rate-limit response fails soft to null", async () => {
    expect(await fetchGetSongBpm(vi.fn().mockResolvedValue(bad()), "KEY", "Levels", "Avicii")).toBeNull();
  });
  it("a thrown fetch fails soft to null", async () => {
    const boom = vi.fn().mockRejectedValue(new Error("net"));
    expect(await fetchGetSongBpm(boom, "K", "t", "a")).toBeNull();
  });
});
