import { describe, it, expect, vi } from "vitest";
import {
  spotifyIdFromUri,
  parseTempo,
  parseFeature,
  parseIsrc,
  createAnalysisFetcher,
  fetchAnalysisByIsrc,
  parsePreviewUrl,
  parseAnalysisTempo,
  fetchTempoViaPreview,
  PreviewDeps,
  FetchLike,
} from "./reccobeats";

const noSleep = () => Promise.resolve();

function okJson(body: unknown): { ok: boolean; status: number; json(): Promise<unknown> } {
  return { ok: true, status: 200, json: () => Promise.resolve(body) };
}
function status(code: number): { ok: boolean; status: number; json(): Promise<unknown> } {
  return { ok: false, status: code, json: () => Promise.resolve({}) };
}
const features = (tempo: number) => ({ content: [{ tempo }] });
const featuresFull = (tempo: number, danceability: number, energy: number) => ({
  content: [{ tempo, danceability, energy }],
});

describe("spotifyIdFromUri", () => {
  it("extracts the base-62 id from a track uri", () => {
    expect(spotifyIdFromUri("spotify:track:0x6wSM6ixlhKPZ9QpaUyyu")).toBe("0x6wSM6ixlhKPZ9QpaUyyu");
  });
  it("returns null for episodes, local files, undefined and malformed input", () => {
    expect(spotifyIdFromUri("spotify:episode:abc")).toBeNull();
    expect(spotifyIdFromUri("spotify:local:artist:album:song:123")).toBeNull();
    expect(spotifyIdFromUri(undefined)).toBeNull();
    expect(spotifyIdFromUri("not-a-uri")).toBeNull();
    expect(spotifyIdFromUri("spotify:track:")).toBeNull();
  });
});

describe("parseTempo", () => {
  it("pulls tempo out of a features response", () => {
    expect(parseTempo(features(148.033))).toBeCloseTo(148.033);
  });
  it("returns null for missing content, empty content, or non-positive/non-number tempo", () => {
    expect(parseTempo({})).toBeNull();
    expect(parseTempo({ content: [] })).toBeNull();
    expect(parseTempo({ content: [{}] })).toBeNull();
    expect(parseTempo({ content: [{ tempo: "fast" }] })).toBeNull();
    expect(parseTempo({ content: [{ tempo: 0 }] })).toBeNull();
    expect(parseTempo({ content: [{ tempo: -5 }] })).toBeNull();
    expect(parseTempo(null)).toBeNull();
  });
});

describe("parseFeature", () => {
  it("reads danceability/energy in [0,1]", () => {
    expect(parseFeature(featuresFull(120, 0.82, 0.61), "danceability")).toBeCloseTo(0.82);
    expect(parseFeature(featuresFull(120, 0.82, 0.61), "energy")).toBeCloseTo(0.61);
  });
  it("returns undefined for missing, out-of-range, or non-number values", () => {
    expect(parseFeature({}, "danceability")).toBeUndefined();
    expect(parseFeature(features(120), "danceability")).toBeUndefined();
    expect(parseFeature({ content: [{ danceability: 1.5 }] }, "danceability")).toBeUndefined();
    expect(parseFeature({ content: [{ danceability: "hi" }] }, "danceability")).toBeUndefined();
  });
});

describe("parseIsrc", () => {
  it("pulls the isrc out of a features/track response", () => {
    expect(parseIsrc({ content: [{ tempo: 120, isrc: "USUG11904206" }] })).toBe("USUG11904206");
  });
  it("returns null for missing, empty, blank, or non-string isrc", () => {
    expect(parseIsrc({})).toBeNull();
    expect(parseIsrc({ content: [] })).toBeNull();
    expect(parseIsrc({ content: [{ tempo: 120 }] })).toBeNull();
    expect(parseIsrc({ content: [{ isrc: "" }] })).toBeNull();
    expect(parseIsrc({ content: [{ isrc: 42 }] })).toBeNull();
    expect(parseIsrc(null)).toBeNull();
  });
});

describe("createAnalysisFetcher", () => {
  it("returns the track tempo from ReccoBeats", async () => {
    const fetchFn = vi.fn<FetchLike>().mockResolvedValue(okJson(features(95.006)));
    const fetchAnalysis = createAnalysisFetcher(fetchFn, noSleep);

    const result = await fetchAnalysis("spotify:track:venus");
    expect(result).toEqual({ tempoBpm: 95.006 });
    expect(fetchFn).toHaveBeenCalledOnce();
    expect(fetchFn.mock.calls[0][0]).toContain("ids=venus");
  });

  it("attaches danceability and energy when present", async () => {
    const fetchFn = vi.fn<FetchLike>().mockResolvedValue(okJson(featuresFull(128, 0.9, 0.7)));
    const fetchAnalysis = createAnalysisFetcher(fetchFn, noSleep);

    expect(await fetchAnalysis("spotify:track:dance")).toEqual({
      tempoBpm: 128,
      danceability: 0.9,
      energy: 0.7,
    });
  });

  it("caches a hit so replays and seeks do not refetch", async () => {
    const fetchFn = vi.fn<FetchLike>().mockResolvedValue(okJson(features(120)));
    const fetchAnalysis = createAnalysisFetcher(fetchFn, noSleep);

    await fetchAnalysis("spotify:track:A");
    await fetchAnalysis("spotify:track:A");
    expect(fetchFn).toHaveBeenCalledOnce();
  });

  it("caches a genuine miss (200 with no tempo) without hammering", async () => {
    const fetchFn = vi.fn<FetchLike>().mockResolvedValue(okJson({ content: [] }));
    const fetchAnalysis = createAnalysisFetcher(fetchFn, noSleep);

    expect(await fetchAnalysis("spotify:track:B")).toBeNull();
    expect(await fetchAnalysis("spotify:track:B")).toBeNull();
    expect(fetchFn).toHaveBeenCalledOnce();
  });

  it("treats 4xx as a definitive miss and does not retry", async () => {
    const fetchFn = vi.fn<FetchLike>().mockResolvedValue(status(404));
    const fetchAnalysis = createAnalysisFetcher(fetchFn, noSleep);

    expect(await fetchAnalysis("spotify:track:C")).toBeNull();
    expect(fetchFn).toHaveBeenCalledOnce();
  });

  it("retries 5xx up to the attempt cap and leaves it uncached", async () => {
    const fetchFn = vi.fn<FetchLike>().mockResolvedValue(status(503));
    const fetchAnalysis = createAnalysisFetcher(fetchFn, noSleep, 3);

    expect(await fetchAnalysis("spotify:track:D")).toBeNull();
    expect(fetchFn).toHaveBeenCalledTimes(3);

    // Not cached: a later play retries (and can succeed).
    fetchFn.mockResolvedValueOnce(okJson(features(130)));
    // first call of the second attempt round returns the success above
    const retry = await fetchAnalysis("spotify:track:D");
    expect(retry).toEqual({ tempoBpm: 130 });
  });

  it("retries after a network error, then succeeds", async () => {
    const fetchFn = vi
      .fn<FetchLike>()
      .mockRejectedValueOnce(new Error("network"))
      .mockResolvedValueOnce(okJson(features(100)));
    const fetchAnalysis = createAnalysisFetcher(fetchFn, noSleep);

    expect(await fetchAnalysis("spotify:track:E")).toEqual({ tempoBpm: 100 });
    expect(fetchFn).toHaveBeenCalledTimes(2);
  });

  it("never calls the network for non-track uris", async () => {
    const fetchFn = vi.fn<FetchLike>().mockResolvedValue(okJson(features(100)));
    const fetchAnalysis = createAnalysisFetcher(fetchFn, noSleep);

    expect(await fetchAnalysis("spotify:episode:pod")).toBeNull();
    expect(fetchFn).not.toHaveBeenCalled();
  });

  it("attaches the isrc when the response carries one", async () => {
    const body = { content: [{ tempo: 171, isrc: "USUG11904206" }] };
    const fetchFn = vi.fn<FetchLike>().mockResolvedValue(okJson(body));
    const fetchAnalysis = createAnalysisFetcher(fetchFn, noSleep);

    expect(await fetchAnalysis("spotify:track:iso")).toEqual({
      tempoBpm: 171,
      isrc: "USUG11904206",
    });
  });
});

describe("fetchAnalysisByIsrc", () => {
  it("queries audio-features with the isrc as the ids value", async () => {
    const fetchFn = vi.fn<FetchLike>().mockResolvedValue(okJson(features(128)));

    const result = await fetchAnalysisByIsrc(fetchFn, noSleep, "USUG11904206");
    expect(result).toEqual({ tempoBpm: 128 });
    expect(fetchFn.mock.calls[0][0]).toContain("ids=USUG11904206");
  });

  it("returns null on a miss (200 with no tempo) and does not throw", async () => {
    const fetchFn = vi.fn<FetchLike>().mockResolvedValue(okJson({ content: [] }));
    expect(await fetchAnalysisByIsrc(fetchFn, noSleep, "USUG11904206")).toBeNull();
  });

  it("returns null (without a request) for an empty isrc", async () => {
    const fetchFn = vi.fn<FetchLike>().mockResolvedValue(okJson(features(128)));
    expect(await fetchAnalysisByIsrc(fetchFn, noSleep, "")).toBeNull();
    expect(fetchFn).not.toHaveBeenCalled();
  });

  it("retries 5xx then gives up, returning null uncached", async () => {
    const fetchFn = vi.fn<FetchLike>().mockResolvedValue(status(503));
    expect(await fetchAnalysisByIsrc(fetchFn, noSleep, "USUG11904206", 3)).toBeNull();
    expect(fetchFn).toHaveBeenCalledTimes(3);
  });
});

describe("parsePreviewUrl", () => {
  it("extracts the audioPreview url from embed html", () => {
    const html = 'x{"audioPreview":{"url":"https://p.scdn.co/mp3-preview/abc123"}}y';
    expect(parsePreviewUrl(html)).toBe("https://p.scdn.co/mp3-preview/abc123");
  });
  it("falls back to a bare scdn url and returns null when absent", () => {
    expect(parsePreviewUrl("... https://p.scdn.co/mp3-preview/deadBEEF ...")).toBe(
      "https://p.scdn.co/mp3-preview/deadBEEF"
    );
    expect(parsePreviewUrl("<html>no preview here</html>")).toBeNull();
  });
});

describe("parseAnalysisTempo", () => {
  it("reads tempo from the flat analysis response", () => {
    expect(parseAnalysisTempo({ tempo: 147.24, energy: 0.8 })).toBeCloseTo(147.24);
  });
  it("returns null for missing or invalid tempo", () => {
    expect(parseAnalysisTempo({})).toBeNull();
    expect(parseAnalysisTempo({ tempo: 0 })).toBeNull();
    expect(parseAnalysisTempo(null)).toBeNull();
  });
});

describe("fetchTempoViaPreview", () => {
  const audio = new Blob(["fake-mp3"], { type: "audio/mpeg" });

  it("resolves tempo end to end and uploads the preview as 'audioFile'", async () => {
    let uploaded: FormData | undefined;
    const deps: PreviewDeps = {
      getPreviewUrl: vi.fn().mockResolvedValue("https://p.scdn.co/mp3-preview/x"),
      fetchBlob: vi.fn().mockResolvedValue(audio),
      postForm: vi.fn(async (_url: string, form: FormData) => {
        uploaded = form;
        return { tempo: 84.9 };
      }),
    };
    expect(await fetchTempoViaPreview("trackid", deps)).toBeCloseTo(84.9);
    expect(deps.getPreviewUrl).toHaveBeenCalledWith("trackid");
    expect(uploaded?.get("audioFile")).toBeInstanceOf(Blob);
  });

  it("returns null when the track has no preview", async () => {
    const deps: PreviewDeps = {
      getPreviewUrl: vi.fn().mockResolvedValue(null),
      fetchBlob: vi.fn(),
      postForm: vi.fn(),
    };
    expect(await fetchTempoViaPreview("trackid", deps)).toBeNull();
    expect(deps.fetchBlob).not.toHaveBeenCalled();
  });

  it("swallows transport errors and returns null", async () => {
    const deps: PreviewDeps = {
      getPreviewUrl: vi.fn().mockRejectedValue(new Error("resolve failed")),
      fetchBlob: vi.fn(),
      postForm: vi.fn(),
    };
    expect(await fetchTempoViaPreview("trackid", deps)).toBeNull();
  });
});
