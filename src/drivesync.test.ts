import { describe, it, expect, vi } from "vitest";
import {
  buildBundle,
  buildLibraryBundle,
  readBundle,
  fingerprint,
  hashContent,
  lyricFileName,
  trackIdFromFileName,
  lyricCategory,
  decideAutoSync,
  needsDownload,
  hasCreds,
  createDriveClient,
  buildAuthUrl,
  parseAuthCode,
  exchangeCode,
  DRIVE_SCOPE,
  LIBRARY_FILENAME,
  LYRICS_FOLDER,
  FOLDER_MIME,
  type BundleParts,
  type DriveCreds,
} from "./drivesync";

const parts = (over: Partial<BundleParts> = {}): BundleParts => ({
  settings: { "catjam-word-debug": true },
  overrides: { abc: { bpm: 120 } },
  starred: ["abc", "def"],
  lyrics: { abc: "[00:01.00] <00:01.00> hi <00:01.50>" },
  ...over,
});

const creds: DriveCreds = { clientId: "cid", clientSecret: "sec", refreshToken: "ref", folderId: "fold" };

const jsonRes = (body: unknown, ok = true, status = 200): Response =>
  ({ ok, status, json: async () => body, text: async () => JSON.stringify(body) } as unknown as Response);
const textRes = (body: string, ok = true, status = 200): Response =>
  ({ ok, status, json: async () => JSON.parse(body), text: async () => body } as unknown as Response);

describe("hasCreds", () => {
  it("requires all four fields", () => {
    expect(hasCreds(creds)).toBe(true);
    expect(hasCreds({ ...creds, refreshToken: "" })).toBe(false);
    expect(hasCreds({ ...creds, folderId: "" })).toBe(false);
  });
});

describe("buildLibraryBundle / readBundle", () => {
  it("library bundle drops lyrics; full bundle keeps them", () => {
    const lib = buildLibraryBundle(parts(), "2026-01-01T00:00:00Z");
    expect(lib).not.toHaveProperty("lyrics");
    expect(readBundle(JSON.stringify(lib)).lyrics).toEqual({}); // none in the cloud JSON
    const full = buildBundle(parts(), "2026-01-01T00:00:00Z");
    expect(readBundle(JSON.stringify(full)).lyrics).toEqual(parts().lyrics); // backup slot keeps them
  });
  it("tolerates garbage / missing fields", () => {
    expect(readBundle("not json")).toEqual({ settings: {}, overrides: {}, starred: [], lyrics: {} });
    expect(readBundle(JSON.stringify({ starred: ["a", 1, "b"], lyrics: { a: "x", b: 2 } }))).toEqual({
      settings: {},
      overrides: {},
      starred: ["a", "b"],
      lyrics: { a: "x" },
    });
  });
});

describe("fingerprint", () => {
  it("is stable across property order and ignores envelope fields", () => {
    const a = fingerprint(parts());
    const reordered = { lyrics: parts().lyrics, starred: parts().starred, overrides: parts().overrides, settings: parts().settings };
    expect(fingerprint(reordered as BundleParts)).toBe(a);
    expect(fingerprint(buildBundle(parts(), "2099-09-09T00:00:00Z"))).toBe(a);
  });
  it("changes when any content changes, including a lyric", () => {
    const base = fingerprint(parts());
    expect(fingerprint(parts({ starred: ["abc"] }))).not.toBe(base);
    expect(fingerprint(parts({ lyrics: { abc: "different" } }))).not.toBe(base);
  });
});

describe("hashContent", () => {
  it("is deterministic and content-sensitive", () => {
    expect(hashContent("abc")).toBe(hashContent("abc"));
    expect(hashContent("abc")).not.toBe(hashContent("abd"));
  });
});

describe("lyric filenames", () => {
  it("builds a browsable name with the id tag and round-trips the id", () => {
    const fn = lyricFileName("6f807x6Abc", "Blinding Lights - The Weeknd");
    expect(fn).toBe("Blinding Lights - The Weeknd [6f807x6Abc].lrc");
    expect(trackIdFromFileName(fn)).toBe("6f807x6Abc");
  });
  it("falls back to <id>.lrc with no name, and still round-trips", () => {
    expect(lyricFileName("abc123")).toBe("abc123.lrc");
    expect(trackIdFromFileName("abc123.lrc")).toBe("abc123");
  });
  it("strips illegal characters and brackets from the name", () => {
    const fn = lyricFileName("id1", 'A/B:C*? "Song" [x]');
    expect(fn.endsWith("[id1].lrc")).toBe(true);
    expect(fn).not.toMatch(/[/:*?"]/);
    expect(trackIdFromFileName(fn)).toBe("id1");
  });
  it("returns null for a non-lyric filename", () => {
    expect(trackIdFromFileName("catjam-sync.json")).toBeNull();
    expect(trackIdFromFileName("notes.txt")).toBeNull();
  });
});

describe("decideAutoSync (upload-only policy)", () => {
  const fp = "deadbeef";
  it("uploads when cloud has no library file", () => {
    expect(decideAutoSync(fp, {}, { exists: false })).toBe("upload");
  });
  it("uploads when local changed and cloud is unchanged since last sync", () => {
    expect(decideAutoSync(fp, { fingerprint: "old", modifiedTime: "T1" }, { exists: true, modifiedTime: "T1" })).toBe("upload");
  });
  it("noop when neither side changed", () => {
    expect(decideAutoSync(fp, { fingerprint: fp, modifiedTime: "T1" }, { exists: true, modifiedTime: "T1" })).toBe("noop");
  });
  it("cloud-ahead when only cloud changed", () => {
    expect(decideAutoSync(fp, { fingerprint: fp, modifiedTime: "T1" }, { exists: true, modifiedTime: "T2" })).toBe("cloud-ahead");
  });
  it("conflict when both changed", () => {
    expect(decideAutoSync(fp, { fingerprint: "old", modifiedTime: "T1" }, { exists: true, modifiedTime: "T2" })).toBe("conflict");
  });
});

describe("lyricCategory (subfolder routing)", () => {
  it("files by precedence starred > bookmarked > normal", () => {
    expect(lyricCategory(true, false)).toBe("starred");
    expect(lyricCategory(true, true)).toBe("starred"); // starred wins over bookmarked
    expect(lyricCategory(false, true)).toBe("bookmarked");
    expect(lyricCategory(false, false)).toBe("normal");
  });
});

describe("needsDownload (incremental pull)", () => {
  it("fetches when the file is missing locally", () => {
    expect(needsDownload("T2", "T1", false)).toBe(true);
  });
  it("skips when local exists and the cloud version is unchanged", () => {
    expect(needsDownload("T1", "T1", true)).toBe(false);
  });
  it("fetches when the cloud version changed (another machine edited it)", () => {
    expect(needsDownload("T2", "T1", true)).toBe(true);
  });
  it("fetches when we have no record of the remote version", () => {
    expect(needsDownload("T1", undefined, true)).toBe(true);
  });
});

describe("manual re-auth helpers", () => {
  it("buildAuthUrl requests offline access + forced consent for the drive.file scope", () => {
    const url = new URL(buildAuthUrl("CID", "http://localhost"));
    expect(url.origin + url.pathname).toBe("https://accounts.google.com/o/oauth2/v2/auth");
    expect(url.searchParams.get("client_id")).toBe("CID");
    expect(url.searchParams.get("redirect_uri")).toBe("http://localhost");
    expect(url.searchParams.get("access_type")).toBe("offline");
    expect(url.searchParams.get("prompt")).toBe("consent");
    expect(url.searchParams.get("scope")).toBe(DRIVE_SCOPE);
  });
  it("parseAuthCode handles a bare code or a pasted redirect URL, rejects junk", () => {
    expect(parseAuthCode("4/0Abc-def_123")).toBe("4/0Abc-def_123");
    expect(parseAuthCode("http://localhost/?code=4%2F0Abc-def&scope=x")).toBe("4/0Abc-def");
    expect(parseAuthCode("  ")).toBeNull();
    expect(parseAuthCode("not a code with spaces")).toBeNull();
  });
  it("exchangeCode posts the authorization_code grant and returns the refresh token", async () => {
    const fetchLike = vi.fn(async (_url: string, _init?: RequestInit) => jsonRes({ refresh_token: "1//NEW" }));
    const token = await exchangeCode({ clientId: "cid", clientSecret: "sec" }, "CODE", "http://localhost", fetchLike);
    expect(token).toBe("1//NEW");
    const body = String((fetchLike.mock.calls[0][1] as RequestInit).body);
    expect(body).toContain("grant_type=authorization_code");
    expect(body).toContain("code=CODE");
    expect(body).toContain("redirect_uri=http%3A%2F%2Flocalhost");
  });
  it("exchangeCode throws when no refresh token comes back", async () => {
    const fetchLike = vi.fn(async (_url: string, _init?: RequestInit) => jsonRes({ access_token: "AT" }));
    await expect(exchangeCode({ clientId: "c", clientSecret: "s" }, "CODE", "http://localhost", fetchLike)).rejects.toThrow(
      /No refresh token/,
    );
  });
});

describe("createDriveClient", () => {
  it("caches the access token until near expiry", async () => {
    let t = 0;
    const fetchLike = vi.fn(async (url: string, _init?: RequestInit) => {
      if (url.includes("oauth2")) return jsonRes({ access_token: "AT", expires_in: 3600 });
      return jsonRes({ files: [] });
    });
    const client = createDriveClient(creds, fetchLike, () => t);
    await client.findFile("x", "p");
    await client.findFile("y", "p");
    expect(fetchLike.mock.calls.filter((c) => String(c[0]).includes("oauth2")).length).toBe(1);
    t = 3600 * 1000;
    await client.findFile("z", "p");
    expect(fetchLike.mock.calls.filter((c) => String(c[0]).includes("oauth2")).length).toBe(2);
  });

  it("findFile escapes apostrophes in the name query", async () => {
    const fetchLike = vi.fn(async (url: string, _init?: RequestInit) => {
      if (url.includes("oauth2")) return jsonRes({ access_token: "AT", expires_in: 3600 });
      return jsonRes({ files: [{ id: "F", name: "Don't Stop.lrc", modifiedTime: "T" }] });
    });
    const client = createDriveClient(creds, fetchLike, () => 0);
    const f = await client.findFile("Don't Stop.lrc", "fold");
    expect(f?.id).toBe("F");
    const call = fetchLike.mock.calls.find((c) => String(c[0]).includes("files?"))!;
    expect(decodeURIComponent(String(call[0]))).toContain("name='Don\\'t Stop.lrc'");
    expect(decodeURIComponent(String(call[0]))).toContain("'fold' in parents");
  });

  it("ensureFolder returns an existing subfolder id without creating", async () => {
    const fetchLike = vi.fn(async (url: string, _init?: RequestInit) => {
      if (url.includes("oauth2")) return jsonRes({ access_token: "AT", expires_in: 3600 });
      return jsonRes({ files: [{ id: "LYR", name: LYRICS_FOLDER }] });
    });
    const client = createDriveClient(creds, fetchLike, () => 0);
    expect(await client.ensureFolder(LYRICS_FOLDER, "fold")).toBe("LYR");
    // No folder-create POST (the only POST allowed is the oauth2 token refresh).
    expect(fetchLike.mock.calls.some((c) => !String(c[0]).includes("oauth2") && (c[1] as RequestInit)?.method === "POST")).toBe(false);
    const q = decodeURIComponent(String(fetchLike.mock.calls.find((c) => String(c[0]).includes("files?"))![0]));
    expect(q).toContain(`mimeType='${FOLDER_MIME}'`);
  });

  it("ensureFolder creates the subfolder when missing", async () => {
    const fetchLike = vi.fn(async (url: string, init?: RequestInit) => {
      if (url.includes("oauth2")) return jsonRes({ access_token: "AT", expires_in: 3600 });
      if (init?.method === "POST") return jsonRes({ id: "NEWFOLDER" });
      return jsonRes({ files: [] }); // not found
    });
    const client = createDriveClient(creds, fetchLike, () => 0);
    expect(await client.ensureFolder(LYRICS_FOLDER, "fold")).toBe("NEWFOLDER");
    const post = fetchLike.mock.calls.find((c) => !String(c[0]).includes("oauth2") && (c[1] as RequestInit)?.method === "POST")!;
    const body = JSON.parse(String((post[1] as RequestInit).body));
    expect(body).toMatchObject({ name: LYRICS_FOLDER, mimeType: FOLDER_MIME, parents: ["fold"] });
  });

  it("listChildren returns files with names", async () => {
    const kids = [
      { id: "1", name: "A [id1].lrc", modifiedTime: "T1" },
      { id: "2", name: "B [id2].lrc", modifiedTime: "T2" },
    ];
    const fetchLike = vi.fn(async (url: string, _init?: RequestInit) => {
      if (url.includes("oauth2")) return jsonRes({ access_token: "AT", expires_in: 3600 });
      return jsonRes({ files: kids });
    });
    const client = createDriveClient(creds, fetchLike, () => 0);
    expect(await client.listChildren("LYR")).toEqual(kids);
  });

  it("listChildren follows nextPageToken across pages (no 1000-file truncation)", async () => {
    const page1 = [{ id: "1", name: "A [id1].lrc" }, { id: "2", name: "B [id2].lrc" }];
    const page2 = [{ id: "3", name: "C [id3].lrc" }];
    const fetchLike = vi.fn(async (url: string, _init?: RequestInit) => {
      if (url.includes("oauth2")) return jsonRes({ access_token: "AT", expires_in: 3600 });
      if (url.includes("pageToken=")) return jsonRes({ files: page2 }); // page 2: no further token → stop
      return jsonRes({ files: page1, nextPageToken: "PAGE2" }); // page 1 → cursor to page 2
    });
    const client = createDriveClient(creds, fetchLike, () => 0);
    expect(await client.listChildren("LYR")).toEqual([...page1, ...page2]);
    const listCalls = fetchLike.mock.calls.filter((c) => String(c[0]).includes("drive/v3/files?"));
    expect(listCalls.length).toBe(2); // exactly two pages fetched
    expect(String(listCalls[1][0])).toContain("pageToken=PAGE2");
  });

  it("upload creates a .lrc with text/plain in the lyrics folder", async () => {
    const fetchLike = vi.fn(async (url: string, _init?: RequestInit) => {
      if (url.includes("oauth2")) return jsonRes({ access_token: "AT", expires_in: 3600 });
      return jsonRes({ id: "NEW", name: "A [id1].lrc", modifiedTime: "T1" });
    });
    const client = createDriveClient(creds, fetchLike, () => 0);
    const res = await client.upload({ name: "A [id1].lrc", content: "[00:01] hi", parentId: "LYR", mimeType: "text/plain" });
    expect(res.id).toBe("NEW");
    const call = fetchLike.mock.calls.find((c) => String(c[0]).includes("/upload/"))!;
    expect(String(call[0])).toContain("uploadType=multipart");
    const body = String((call[1] as RequestInit).body);
    expect(body).toContain("A [id1].lrc"); // metadata part names the file
    expect(body).toContain("text/plain"); // media part type
    expect(body).toContain('"parents":["LYR"]');
  });

  it("upload replaces contents with a media PATCH when given an id", async () => {
    const fetchLike = vi.fn(async (url: string, _init?: RequestInit) => {
      if (url.includes("oauth2")) return jsonRes({ access_token: "AT", expires_in: 3600 });
      return jsonRes({ id: "FID", name: LIBRARY_FILENAME, modifiedTime: "T2" });
    });
    const client = createDriveClient(creds, fetchLike, () => 0);
    const res = await client.upload({ name: LIBRARY_FILENAME, content: '{"x":2}', parentId: "fold", existingId: "FID" });
    expect(res).toEqual({ id: "FID", name: LIBRARY_FILENAME, modifiedTime: "T2" });
    const call = fetchLike.mock.calls.find((c) => String(c[0]).includes("/upload/drive/v3/files/FID"))!;
    expect(String(call[0])).toContain("uploadType=media");
    expect((call[1] as RequestInit).method).toBe("PATCH");
    expect(String((call[1] as RequestInit).body)).toBe('{"x":2}');
  });

  it("move reparents a file via addParents/removeParents", async () => {
    const fetchLike = vi.fn(async (url: string, _init?: RequestInit) => {
      if (url.includes("oauth2")) return jsonRes({ access_token: "AT", expires_in: 3600 });
      return jsonRes({ id: "FID", name: "x.lrc", modifiedTime: "T3" });
    });
    const client = createDriveClient(creds, fetchLike, () => 0);
    const res = await client.move("FID", "NEWP", "OLDP");
    expect(res).toEqual({ id: "FID", name: "x.lrc", modifiedTime: "T3" });
    const call = fetchLike.mock.calls.find((c) => String(c[0]).includes("/files/FID?"))!;
    expect((call[1] as RequestInit).method).toBe("PATCH");
    expect(String(call[0])).toContain("addParents=NEWP");
    expect(String(call[0])).toContain("removeParents=OLDP");
  });

  it("download fetches alt=media and returns raw text", async () => {
    const fetchLike = vi.fn(async (url: string, _init?: RequestInit) => {
      if (url.includes("oauth2")) return jsonRes({ access_token: "AT", expires_in: 3600 });
      return textRes("[00:01] lyric");
    });
    const client = createDriveClient(creds, fetchLike, () => 0);
    expect(await client.download("FID")).toBe("[00:01] lyric");
    expect(fetchLike.mock.calls.some((c) => String(c[0]).includes("/files/FID?alt=media"))).toBe(true);
  });

  it("throws a descriptive error on a failed token refresh", async () => {
    const fetchLike = vi.fn(async (_url: string, _init?: RequestInit) => jsonRes({ error: "invalid_grant" }, false, 400));
    const client = createDriveClient(creds, fetchLike, () => 0);
    await expect(client.findFile("x", "p")).rejects.toThrow(/token refresh failed \(400\)/);
  });
});
