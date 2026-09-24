import { describe, it, expect, vi } from "vitest";
import { buildRecordingQuery, parseSearchIsrc, fetchIsrcByText } from "./musicbrainz";
import { FetchLike } from "./reccobeats";

function okJson(body: unknown): { ok: boolean; status: number; json(): Promise<unknown> } {
  return { ok: true, status: 200, json: () => Promise.resolve(body) };
}
function status(code: number): { ok: boolean; status: number; json(): Promise<unknown> } {
  return { ok: false, status: code, json: () => Promise.resolve({}) };
}
const rec = (score: number, isrcs: unknown) => ({ score, isrcs });

describe("buildRecordingQuery", () => {
  it("quotes the title and, when present, the artist", () => {
    expect(buildRecordingQuery("Blinding Lights", "The Weeknd")).toBe(
      'recording:"Blinding Lights" AND artist:"The Weeknd"'
    );
    expect(buildRecordingQuery("Instrumental")).toBe('recording:"Instrumental"');
  });
  it("escapes embedded quotes and backslashes", () => {
    expect(buildRecordingQuery('say "hi"', "a\\b")).toBe(
      'recording:"say \\"hi\\"" AND artist:"a\\\\b"'
    );
  });
});

describe("parseSearchIsrc", () => {
  it("returns the first confident recording's first isrc", () => {
    const body = { recordings: [rec(100, []), rec(100, ["USUG11904206", "OTHER"])] };
    expect(parseSearchIsrc(body)).toBe("USUG11904206");
  });
  it("skips recordings below the score gate", () => {
    const body = { recordings: [rec(70, ["LOWSCORE0001"]), rec(95, ["USUG11904206"])] };
    expect(parseSearchIsrc(body)).toBe("USUG11904206");
    expect(parseSearchIsrc({ recordings: [rec(70, ["LOWSCORE0001"])] })).toBeNull();
  });
  it("honours a custom minScore", () => {
    expect(parseSearchIsrc({ recordings: [rec(80, ["USUG11904206"])] }, 75)).toBe("USUG11904206");
  });
  it("returns null for empty, missing, or isrc-less results", () => {
    expect(parseSearchIsrc({ count: 0, recordings: [] })).toBeNull();
    expect(parseSearchIsrc({})).toBeNull();
    expect(parseSearchIsrc(null)).toBeNull();
    expect(parseSearchIsrc({ recordings: [rec(100, null)] })).toBeNull();
    expect(parseSearchIsrc({ recordings: [rec(100, [123])] })).toBeNull();
  });
});

describe("fetchIsrcByText", () => {
  it("queries the recording endpoint and returns the matched isrc", async () => {
    const fetchFn = vi
      .fn<FetchLike>()
      .mockResolvedValue(okJson({ recordings: [rec(100, ["USUG11904206"])] }));

    expect(await fetchIsrcByText(fetchFn, "Blinding Lights", "The Weeknd")).toBe("USUG11904206");
    const url = fetchFn.mock.calls[0][0];
    expect(url).toContain("/ws/2/recording");
    expect(url).toContain("fmt=json");
    expect(decodeURIComponent(url)).toContain('recording:"Blinding Lights" AND artist:"The Weeknd"');
  });

  it("returns null (no request) when there is no title", async () => {
    const fetchFn = vi.fn<FetchLike>();
    expect(await fetchIsrcByText(fetchFn, "")).toBeNull();
    expect(fetchFn).not.toHaveBeenCalled();
  });

  it("treats a busy/error response as a miss", async () => {
    const fetchFn = vi.fn<FetchLike>().mockResolvedValue(status(503));
    expect(await fetchIsrcByText(fetchFn, "X", "Y")).toBeNull();
  });

  it("swallows a network error and returns null", async () => {
    const fetchFn = vi.fn<FetchLike>().mockRejectedValue(new Error("offline"));
    expect(await fetchIsrcByText(fetchFn, "X", "Y")).toBeNull();
  });
});
