import { describe, it, expect } from "vitest";
import {
  readOverrides,
  getOverride,
  setStoredBpm,
  setDetectedBpm,
  clearStoredBpm,
  setDelayMs,
  setTrackName,
  setIsrc,
  setDoubleTime,
  setDetectedMeter,
  clearDoubleTime,
  removeOverride,
  matchByName,
  clampDelay,
  getLyricOffset,
  setLyricOffset,
  clampLyricOffset,
  MAX_LYRIC_OFFSET_MS,
  getBookmark,
  setBookmark,
  clearBookmark,
  previewBackfillCandidates,
  unsourcedBackfillCandidates,
  recordDetection,
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

describe("lyric sync offset", () => {
  it("clampLyricOffset rounds and clamps into the signed range", () => {
    expect(clampLyricOffset(123.6)).toBe(124);
    expect(clampLyricOffset(-123.6)).toBe(-124); // negative allowed
    expect(clampLyricOffset(MAX_LYRIC_OFFSET_MS + 1)).toBe(MAX_LYRIC_OFFSET_MS);
    expect(clampLyricOffset(-MAX_LYRIC_OFFSET_MS - 1)).toBe(-MAX_LYRIC_OFFSET_MS);
    expect(clampLyricOffset(NaN)).toBe(0);
  });

  it("defaults to 0 and round-trips a signed value", () => {
    const s = memStore();
    expect(getLyricOffset(s, "A")).toBe(0);
    setLyricOffset(s, "A", -250);
    expect(getLyricOffset(s, "A")).toBe(-250);
    expect(getOverride(s, "A")).toEqual({ lyricOffsetMs: -250 });
    setLyricOffset(s, "A", 400);
    expect(getLyricOffset(s, "A")).toBe(400);
  });

  it("setting 0 clears the field (and the whole entry when nothing else remains)", () => {
    const s = memStore();
    setLyricOffset(s, "A", 300);
    setLyricOffset(s, "A", 0);
    expect(getOverride(s, "A")).toBeUndefined(); // offset was the only field → entry removed
  });

  it("keeps the rest of an entry when the offset is cleared", () => {
    const s = memStore();
    setDoubleTime(s, "A", 2);
    setLyricOffset(s, "A", 120);
    expect(getOverride(s, "A")).toEqual({ doubleTime: 2, lyricOffsetMs: 120 });
    setLyricOffset(s, "A", 0);
    expect(getOverride(s, "A")).toEqual({ doubleTime: 2 }); // offset gone, meter kept
  });
});

describe("editor bookmark", () => {
  it("defaults to null and round-trips a position (0 is valid)", () => {
    const s = memStore();
    expect(getBookmark(s, "A")).toBeNull();
    setBookmark(s, "A", 1234.6);
    expect(getBookmark(s, "A")).toBe(1235); // rounded
    expect(getOverride(s, "A")).toEqual({ bookmarkMs: 1235 });
    setBookmark(s, "A", 0); // 0 is a real position (start of song), not a clear
    expect(getBookmark(s, "A")).toBe(0);
    expect(getOverride(s, "A")).toEqual({ bookmarkMs: 0 });
  });

  it("clamps a negative position to 0", () => {
    const s = memStore();
    setBookmark(s, "A", -50);
    expect(getBookmark(s, "A")).toBe(0);
  });

  it("clearBookmark removes it (and the whole entry when nothing else remains)", () => {
    const s = memStore();
    setBookmark(s, "A", 500);
    clearBookmark(s, "A");
    expect(getBookmark(s, "A")).toBeNull();
    expect(getOverride(s, "A")).toBeUndefined();
  });

  it("keeps the rest of an entry when the bookmark is cleared, and survives a BPM clear", () => {
    const s = memStore();
    setDoubleTime(s, "A", 3);
    setBookmark(s, "A", 800);
    expect(getOverride(s, "A")).toEqual({ doubleTime: 3, bookmarkMs: 800 });
    clearBookmark(s, "A");
    expect(getOverride(s, "A")).toEqual({ doubleTime: 3 }); // bookmark gone, meter kept
  });
});

describe("recordDetection (legitimate vs preview)", () => {
  it("promotes a real-provider result to the authoritative bpm, keeping provenance", () => {
    const s = memStore();
    recordDetection(s, "x", 188.25, "musicae-spotify");
    expect(getOverride(s, "x")).toEqual({ bpm: 188.25, detectedBpm: 188.25, bpmSource: "musicae-spotify" });
    expect(previewBackfillCandidates(s)).toEqual([]); // has bpm → not a sync candidate
    expect(unsourcedBackfillCandidates(s)).toEqual([]);
  });

  it("keeps a preview scan as detectedBpm only (still a sync candidate)", () => {
    const s = memStore();
    recordDetection(s, "y", 96.9, "preview");
    expect(getOverride(s, "y")).toEqual({ detectedBpm: 96.9, bpmSource: "preview" });
    expect(previewBackfillCandidates(s)).toEqual(["y"]);
  });

  it("treats every non-preview source as legitimate", () => {
    const s = memStore();
    recordDetection(s, "r", 128, "reccobeats");
    recordDetection(s, "g", 120, "getsongbpm");
    expect(getOverride(s, "r")?.bpm).toBe(128);
    expect(getOverride(s, "g")?.bpm).toBe(120);
  });
});

describe("previewBackfillCandidates (API-sync greenlight)", () => {
  it("selects only preview-sourced detections with no manual override", () => {
    const s = memStore();
    setDetectedBpm(s, "prev", 96.9, "preview"); // greenlit — rough scan
    setDetectedBpm(s, "recco", 128, "reccobeats"); // real provider — left alone
    setDetectedBpm(s, "musicae", 188.25, "musicae-spotify"); // real provider — left alone
    setDetectedBpm(s, "manual", 100, "preview");
    setStoredBpm(s, "manual", 140); // manual override present — left alone
    setTrackName(s, "named", "Song - Artist"); // no detection at all — excluded
    expect(previewBackfillCandidates(s)).toEqual(["prev"]);
  });

  it("is empty when nothing was preview-detected", () => {
    const s = memStore();
    setDetectedBpm(s, "recco", 128, "reccobeats");
    expect(previewBackfillCandidates(s)).toEqual([]);
  });
});

describe("unsourcedBackfillCandidates (legacy entries missing a source)", () => {
  it("selects detected entries with no bpmSource and no manual override", () => {
    const s = memStore();
    setDetectedBpm(s, "legacy", 95.9); // detected, no source recorded → candidate
    setDetectedBpm(s, "tagged", 128, "reccobeats"); // has a source → excluded
    setDetectedBpm(s, "prev", 90, "preview"); // preview-tagged → handled elsewhere
    setDetectedBpm(s, "man", 100); // no source, but…
    setStoredBpm(s, "man", 150); // …manual override → excluded
    setTrackName(s, "named", "x - y"); // no detection → excluded
    expect(unsourcedBackfillCandidates(s)).toEqual(["legacy"]);
    expect(previewBackfillCandidates(s)).toEqual(["prev"]); // the two sets don't overlap
  });
});

describe("overrides", () => {
  it("returns undefined when a track has nothing recorded", () => {
    expect(getOverride(memStore(), "A")).toBeUndefined();
  });

  // readOverrides memoizes the parsed map keyed by the raw stored string. A write must still be
  // visible on the next read (cache invalidates), and a write must NOT mutate a map a prior read
  // handed out (writers clone before mutating).
  it("memoizes reads but reflects writes, without mutating a previously-returned map", () => {
    const s = memStore();
    setDoubleTime(s, "A", 2);
    const snapshot = readOverrides(s); // caller holds this reference
    expect(snapshot).toEqual({ A: { doubleTime: 2 } });
    expect(readOverrides(s)).toBe(snapshot); // unchanged storage → same cached object (no re-parse)
    setDoubleTime(s, "B", 3); // a write
    expect(snapshot).toEqual({ A: { doubleTime: 2 } }); // the old snapshot is untouched
    expect(getOverride(s, "B")).toEqual({ doubleTime: 3 }); // but the new value is visible
  });

  it("stores a meter divisor and ignores invalid values (< 1)", () => {
    const s = memStore();
    setDoubleTime(s, "A", 2); // half-time
    expect(getOverride(s, "A")).toEqual({ doubleTime: 2 });
    setDoubleTime(s, "A", 3); // 3-beat meter overwrites
    expect(getOverride(s, "A")).toEqual({ doubleTime: 3 });
    setDoubleTime(s, "A", 0); // invalid → unchanged
    expect(getOverride(s, "A")).toEqual({ doubleTime: 3 });
  });

  it("detected meter sets the divisor + provenance; a manual pick clears detection", () => {
    const s = memStore();
    setDetectedMeter(s, "A", 3, 3); // detected 3/4 → ÷3, flagged, with the time signature
    expect(getOverride(s, "A")).toEqual({ doubleTime: 3, meterDetected: true, timeSignature: 3 });
    setDoubleTime(s, "A", 2); // manual pick → drops the detected provenance
    expect(getOverride(s, "A")).toEqual({ doubleTime: 2 });
  });

  it("records an octave-fold detection (divisor only, no time signature)", () => {
    const s = memStore();
    setDetectedMeter(s, "A", 2); // double-time fold → ÷2, no meter numerator
    expect(getOverride(s, "A")).toEqual({ doubleTime: 2, meterDetected: true });
  });

  it("strips a legacy 4/4 detected meter so common time reads as raw 1×", () => {
    const s = memStore();
    // Common time used to be stored as a detected ÷4 (later ÷1) meter; it now bounces
    // raw with no override.
    s.set("catjam-doubletime-overrides", JSON.stringify({ A: { doubleTime: 4, meterDetected: true, timeSignature: 4 } }));
    expect(getOverride(s, "A")).toEqual({});
  });

  it("keeps a legacy non-4/4 detected meter (3/4 → ÷3)", () => {
    const s = memStore();
    s.set("catjam-doubletime-overrides", JSON.stringify({ A: { doubleTime: 3, meterDetected: true, timeSignature: 3 } }));
    expect(getOverride(s, "A")).toEqual({ doubleTime: 3, meterDetected: true, timeSignature: 3 });
  });

  it("clearDoubleTime removes the divisor and the detected provenance", () => {
    const s = memStore();
    setDetectedMeter(s, "A", 3);
    clearDoubleTime(s, "A"); // reset to non-detected (raw)
    expect(getOverride(s, "A")).toBeUndefined();
  });

  it("detected meter and a manual divisor never coexist (single divisor field)", () => {
    const s = memStore();
    setStoredBpm(s, "A", 120);
    setDetectedMeter(s, "A", 3, 3);
    // doubleTime is the one effective divisor — no separate competing field.
    expect(getOverride(s, "A")).toEqual({ bpm: 120, doubleTime: 3, meterDetected: true, timeSignature: 3 });
  });

  it("stores name, bpm and delay alongside the meter divisor without clobbering", () => {
    const s = memStore();
    setStoredBpm(s, "A", 128.4);
    setDoubleTime(s, "A", 2);
    setDelayMs(s, "A", 250);
    setTrackName(s, "A", "Venus - Regina Song");
    expect(getOverride(s, "A")).toEqual({
      name: "Venus - Regina Song",
      bpm: 128.4,
      doubleTime: 2,
      delayMs: 250,
    });
  });

  it("backpopulates an isrc without clobbering, and ignores a blank one", () => {
    const s = memStore();
    setDetectedBpm(s, "A", 128);
    setIsrc(s, "A", "USUG11904206");
    expect(getOverride(s, "A")).toEqual({ isrc: "USUG11904206", detectedBpm: 128 });
    setIsrc(s, "A", ""); // blank ignored — keeps the existing isrc
    expect(getOverride(s, "A")).toEqual({ isrc: "USUG11904206", detectedBpm: 128 });
  });

  it("round-trips the isrc field through storage", () => {
    const s = memStore();
    setIsrc(s, "A", "GBAYE0601498");
    expect(readOverrides(s)).toEqual({ A: { isrc: "GBAYE0601498" } });
  });

  it("tags detected BPM with its provenance and round-trips it", () => {
    const s = memStore();
    setDetectedBpm(s, "A", 128, "reccobeats");
    expect(getOverride(s, "A")).toEqual({ detectedBpm: 128, bpmSource: "reccobeats" });
    setDetectedBpm(s, "A", 130, "preview"); // re-detect overwrites both bpm + source
    expect(getOverride(s, "A")).toEqual({ detectedBpm: 130, bpmSource: "preview" });
  });

  it("drops an orphan/invalid bpmSource (no detected value, or unknown source)", () => {
    const s = memStore();
    s.set("catjam-doubletime-overrides", JSON.stringify({ A: { bpmSource: "reccobeats" } }));
    expect(getOverride(s, "A")).toEqual({}); // source alone is meaningless → stripped
    s.set("catjam-doubletime-overrides", JSON.stringify({ B: { detectedBpm: 90, bpmSource: "bogus" } }));
    expect(getOverride(s, "B")).toEqual({ detectedBpm: 90 }); // invalid source stripped, bpm kept
  });

  it("clamps stored delay and ignores invalid bpm", () => {
    const s = memStore();
    setDelayMs(s, "A", 9999);
    setStoredBpm(s, "A", 0); // invalid, ignored
    expect(getOverride(s, "A")).toEqual({ delayMs: 500 });
  });

  it("clears a manual bpm but keeps the detected value to reset to", () => {
    const s = memStore();
    setDetectedBpm(s, "A", 145);
    setStoredBpm(s, "A", 92);
    expect(getOverride(s, "A")).toEqual({ bpm: 92, detectedBpm: 145 });
    clearStoredBpm(s, "A");
    expect(getOverride(s, "A")).toEqual({ detectedBpm: 145 }); // manual gone, detected kept
  });

  it("drops the entry on clear when nothing else remains", () => {
    const s = memStore();
    setStoredBpm(s, "A", 128); // manual only, no detected
    clearStoredBpm(s, "A");
    expect(getOverride(s, "A")).toBeUndefined();

    setStoredBpm(s, "B", 128);
    setDoubleTime(s, "B", 2);
    clearStoredBpm(s, "B");
    expect(getOverride(s, "B")).toEqual({ doubleTime: 2 }); // meter kept
  });

  it("removes an entry by id", () => {
    const s = memStore();
    setStoredBpm(s, "A", 120);
    expect(removeOverride(s, "A")).toBe(true);
    expect(getOverride(s, "A")).toBeUndefined();
    expect(removeOverride(s, "A")).toBe(false); // already gone
  });

  it("matches entries by name via regex, case-insensitive, with substring fallback", () => {
    const s = memStore();
    setTrackName(s, "A", "War - keshi");
    setTrackName(s, "B", "Heavenmade - JHIN");
    setTrackName(s, "C", "venus - Regina Song");
    expect(matchByName(s, "keshi")).toEqual(["A"]);
    expect(matchByName(s, "VENUS")).toEqual(["C"]); // case-insensitive
    expect(matchByName(s, "war|jhin")).toEqual(["A", "B"]); // regex alternation
    expect(matchByName(s, "(")).toEqual([]); // invalid regex -> substring, no match
    expect(matchByName(s, "nope")).toEqual([]);
  });

  it("migrates the legacy boolean formats and survives corrupt storage", () => {
    // Legacy top-level boolean map: true → half-time (divisor 2).
    const legacy = memStore({ "catjam-doubletime-overrides": JSON.stringify({ X: true }) });
    expect(getOverride(legacy, "X")).toEqual({ doubleTime: 2 });

    // Legacy per-entry boolean doubleTime: true → 2, false → 1 (raw).
    const entryBool = memStore({
      "catjam-doubletime-overrides": JSON.stringify({ Y: { doubleTime: true }, Z: { doubleTime: false } }),
    });
    expect(getOverride(entryBool, "Y")).toEqual({ doubleTime: 2 });
    expect(getOverride(entryBool, "Z")).toEqual({ doubleTime: 1 });

    const corrupt = memStore({ "catjam-doubletime-overrides": "not json" });
    expect(readOverrides(corrupt)).toEqual({});
  });
});
