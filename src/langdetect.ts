// Guess a song's script/language from its lyric text, by Unicode range, to route romanization. This is
// NOT a full NLP detector — just enough to pick the right romanizer: any kana ⇒ Japanese (Japanese mixes
// kana + kanji), predominantly Hangul ⇒ Korean, Han ideographs without kana ⇒ Chinese, else "other".

export type SongLang = "ja" | "ko" | "zh" | "other";

/** Human label for a detected/selected language code. */
export const LANG_LABEL: Record<SongLang, string> = { ja: "Japanese", ko: "Korean", zh: "Chinese", other: "Other" };

/** Count characters per script and pick the romanization language. Counts by code point (surrogate-safe). */
export function detectSongLanguage(text: string): SongLang {
  if (!text) return "other";
  let kana = 0;
  let hangul = 0;
  let han = 0;
  for (const ch of text) {
    const c = ch.codePointAt(0) ?? 0;
    if ((c >= 0x3040 && c <= 0x30ff) || (c >= 0x31f0 && c <= 0x31ff)) kana++; // hiragana + katakana (+ phonetic ext)
    else if ((c >= 0xac00 && c <= 0xd7a3) || (c >= 0x1100 && c <= 0x11ff) || (c >= 0x3130 && c <= 0x318f) || (c >= 0xa960 && c <= 0xa97f))
      hangul++; // Hangul syllables + Jamo
    else if ((c >= 0x3400 && c <= 0x4dbf) || (c >= 0x4e00 && c <= 0x9fff) || (c >= 0xf900 && c <= 0xfaff)) han++; // CJK ideographs
  }
  if (!kana && !hangul && !han) return "other";
  if (hangul > kana && hangul >= han) return "ko"; // predominantly Hangul (hanja mixed in stays Korean)
  if (kana > 0) return "ja"; // any kana (with or without kanji) ⇒ Japanese
  if (han > 0) return "zh"; // Han only ⇒ Chinese
  return hangul > 0 ? "ko" : "other";
}
