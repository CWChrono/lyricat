import { describe, it, expect } from "vitest";
import { romanizeWord, romanizeWords, canRomanize } from "./romanize";

describe("canRomanize", () => {
  it("supports Korean + Chinese + Japanese (JA via the separate extension), not 'other'", () => {
    expect(canRomanize("ko")).toBe(true);
    expect(canRomanize("zh")).toBe(true);
    expect(canRomanize("ja")).toBe(true);
    expect(canRomanize("other")).toBe(false);
  });
});

describe("romanizeWord", () => {
  it("romanizes Korean (Revised Romanization), space-free", () => {
    expect(romanizeWord("안녕하세요", "ko")).toBe("annyeonghaseyo");
    expect(romanizeWord("사랑", "ko")).toBe("sarang");
    expect(romanizeWord("안녕하세요", "ko")).not.toMatch(/\s/);
  });

  it("romanizes Chinese (toneless pinyin), space-free", () => {
    expect(romanizeWord("月亮", "zh")).toBe("yueliang");
    expect(romanizeWord("我爱你", "zh")).toBe("woaini");
    expect(romanizeWord("月亮", "zh")).not.toMatch(/\s/);
  });

  it("passes unsupported languages / blanks through unchanged", () => {
    expect(romanizeWord("hello", "other")).toBe("hello");
    expect(romanizeWord("君", "ja")).toBe("君"); // sync path never does JA — that's romanizeWordsAsync
    expect(romanizeWord("   ", "ko")).toBe("");
  });

  it("romanizeWords keeps order + count (1:1 with the originals)", () => {
    expect(romanizeWords(["안녕", "하세요"], "ko")).toEqual(["annyeong", "haseyo"]);
    expect(romanizeWords(["我", "爱", "你"], "zh")).toEqual(["wo", "ai", "ni"]);
  });
});
