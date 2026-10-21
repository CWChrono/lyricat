import { describe, it, expect } from "vitest";
import { detectSongLanguage, LANG_LABEL } from "./langdetect";

describe("detectSongLanguage", () => {
  it("detects Japanese from kana (even when kanji-heavy)", () => {
    expect(detectSongLanguage("君の名前")).toBe("ja"); // の is hiragana → ja despite the kanji
    expect(detectSongLanguage("カタカナ")).toBe("ja");
    expect(detectSongLanguage("夜に駆ける")).toBe("ja"); // に = kana
  });

  it("detects Korean from Hangul (incl. mixed hanja)", () => {
    expect(detectSongLanguage("안녕하세요")).toBe("ko");
    expect(detectSongLanguage("사랑 歌")).toBe("ko"); // mostly Hangul + a stray hanja → ko
  });

  it("detects Chinese from Han with no kana", () => {
    expect(detectSongLanguage("我爱你")).toBe("zh");
    expect(detectSongLanguage("月亮代表我的心")).toBe("zh");
  });

  it("returns 'other' for Latin / empty / punctuation", () => {
    expect(detectSongLanguage("hello world")).toBe("other");
    expect(detectSongLanguage("")).toBe("other");
    expect(detectSongLanguage("!!! 123 ???")).toBe("other");
  });

  it("kana outweighs a lone Han char → Japanese, not Chinese", () => {
    expect(detectSongLanguage("恋するフォーチュンクッキー")).toBe("ja");
  });

  it("exposes human labels", () => {
    expect(LANG_LABEL.ja).toBe("Japanese");
    expect(LANG_LABEL.zh).toBe("Chinese");
  });
});
