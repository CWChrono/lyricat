import { describe, it, expect, vi } from "vitest";
import {
  findTempo,
  parseGetSongBpm,
  fetchGetSongBpm,
  findBpmLike,
  findTimeSignature,
  fetchMusicaeFeatures,
  fetchMusicaeDj,
} from "./bpmproviders";

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

describe("findBpmLike (Musicae)", () => {
  it("reads a number tempo from the features shape, keeping the fraction", () => {
    expect(findBpmLike({ audio_features: [{ tempo: 188.25, id: "x" }] })).toBe(188.25);
  });
  it("reads rhythm.bpm from the DJ shape, skipping the string tempo", () => {
    expect(findBpmLike({ rhythm: { tempo: "123.00 BPM", bpm: 122.746, half_time_bpm: 61.373 } })).toBe(122.746);
  });
  it("rejects out-of-range and absent values", () => {
    expect(findBpmLike({ rhythm: { bpm: 9999 } })).toBeNull();
    expect(findBpmLike({ error: { status: 404 } })).toBeNull();
    expect(findBpmLike(null)).toBeNull();
  });
});

describe("findTimeSignature (Musicae)", () => {
  it("reads the Spotify-shaped integer time_signature", () => {
    expect(findTimeSignature({ audio_features: [{ time_signature: 3 }] })).toBe(3);
    expect(findTimeSignature({ audio_features: [{ time_signature: 4 }] })).toBe(4);
  });
  it("parses the DJ-shaped 'N/M' string and beats_per_bar", () => {
    expect(findTimeSignature({ rhythm: { time_signature: "3/4", beats_per_bar: 3 } })).toBe(3);
    expect(findTimeSignature({ rhythm: { beats_per_bar: 4 } })).toBe(4);
  });
  it("rejects out-of-range / absent signatures", () => {
    expect(findTimeSignature({ rhythm: { time_signature: "1/4" } })).toBeUndefined();
    expect(findTimeSignature({ audio_features: [{ tempo: 120 }] })).toBeUndefined();
    expect(findTimeSignature(null)).toBeUndefined();
  });
});

describe("fetchMusicaeFeatures / fetchMusicaeDj (rate-limited RapidAPI providers)", () => {
  it("no key → no request, not responded", async () => {
    const f = vi.fn();
    expect(await fetchMusicaeFeatures(f, "", "ID")).toEqual({ responded: false, bpm: null });
    expect(f).not.toHaveBeenCalled();
  });

  it("features: calls the host with ids + rapidapi headers, returns fractional tempo", async () => {
    const f = vi.fn().mockResolvedValue(ok({ audio_features: [{ tempo: 188.25 }] }));
    expect(await fetchMusicaeFeatures(f, "KEY", "7G8Ycb0hYdQ7cgjVvZ9fAL")).toEqual({ responded: true, bpm: 188.25 });
    const [url, init] = f.mock.calls[0];
    expect(url).toContain("spotify-extended-audio-features-api.p.rapidapi.com/v1/audio-features?ids=7G8Ycb0hYdQ7cgjVvZ9fAL");
    expect((init as RequestInit).headers).toMatchObject({
      "x-rapidapi-key": "KEY",
      "x-rapidapi-host": "spotify-extended-audio-features-api.p.rapidapi.com",
    });
  });

  it("dj: calls the path-segment id endpoint, returns rhythm.bpm + time signature", async () => {
    const f = vi.fn().mockResolvedValue(ok({ rhythm: { tempo: "123.00 BPM", bpm: 122.746, time_signature: "4/4" } }));
    expect(await fetchMusicaeDj(f, "KEY", "0DiWol3AO6WpXZgp0goxAV")).toEqual({
      responded: true,
      bpm: 122.746,
      timeSignature: 4,
    });
    expect(f.mock.calls[0][0]).toContain("dj-track-audio-analysis-api.p.rapidapi.com/v2/audio-analysis/0DiWol3AO6WpXZgp0goxAV");
  });

  it("a 404/throttle response is responded (counts against budget) but no bpm", async () => {
    expect(await fetchMusicaeDj(vi.fn().mockResolvedValue(bad()), "KEY", "ID")).toEqual({ responded: true, bpm: null });
  });

  it("a network error is not responded (budget preserved)", async () => {
    const boom = vi.fn().mockRejectedValue(new Error("net"));
    expect(await fetchMusicaeFeatures(boom, "KEY", "ID")).toEqual({ responded: false, bpm: null });
  });
});
