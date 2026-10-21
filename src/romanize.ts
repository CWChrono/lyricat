// JS-native romanization, bundled — replaces Spicy Lyrics' unreliable (render-time, uncached)
// transliteration. Korean via es-hangul (Revised Romanization, rule-based), Chinese via pinyin-pro
// (toneless pinyin). Japanese is not handled here yet (kuromoji dictionary hosting is a later phase).
//
// Each call romanizes ONE word-unit (a group of characters) into a single SPACE-FREE token, so it stays
// exactly one group in the line editor and aligns 1:1 with the original word it labels.

import { romanize as koRomanize } from "es-hangul";
import { pinyin } from "pinyin-pro";
import { SongLang } from "./langdetect";
import { romanizeJaWords } from "./romanize-ja"; // talks to the global only — no vendor code bundled here

/** Languages the engine can romanize. KO/ZH are bundled + synchronous. JA is handled by the separate
 *  `catjam-ja-romanizer` extension (async, downloads a dictionary once) — see romanizeWordsAsync. */
export function canRomanize(lang: SongLang): boolean {
  return lang === "ko" || lang === "zh" || lang === "ja";
}

/** Romanize one word-unit → a single space-free romaja token. Unsupported language or any failure returns
 *  the original text unchanged (never throws — romanization is best-effort + hand-tuned afterwards). */
export function romanizeWord(text: string, lang: SongLang): string {
  const t = text.trim();
  if (!t) return "";
  try {
    if (lang === "ko") return koRomanize(t).replace(/\s+/g, "");
    if (lang === "zh") return (pinyin(t, { toneType: "none", type: "array" }) as string[]).join("").replace(/\s+/g, "");
    return t; // ja / other — not bundled yet
  } catch {
    return t;
  }
}

/** Romanize a list of word-units (one romaja per word, order preserved). Synchronous — KO/ZH only. */
export function romanizeWords(words: readonly string[], lang: SongLang): string[] {
  return words.map((w) => romanizeWord(w, lang));
}

/** Romanize a list of word-units. KO/ZH resolve synchronously; JA is delegated to the separate romanizer
 *  extension via the global (rejects with a clear message if that extension isn't loaded yet). */
export async function romanizeWordsAsync(words: readonly string[], lang: SongLang): Promise<string[]> {
  if (lang === "ja") return romanizeJaWords(words);
  return words.map((w) => romanizeWord(w, lang));
}
