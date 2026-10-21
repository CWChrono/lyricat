// Type shims for the JP romanizer's vendor libs (no .d.ts shipped). Used ONLY by src/ja/entry.ts, which
// is compiled into a SEPARATE extension by its own esbuild step — never bundled into cat-jam.js.

declare module "kuroshiro" {
  interface ConvertOptions {
    to?: "hiragana" | "katakana" | "romaji";
    mode?: "normal" | "spaced" | "okurigana" | "furigana";
    romajiSystem?: "nippon" | "passport" | "hepburn";
  }
  export default class Kuroshiro {
    init(analyzer: unknown): Promise<void>;
    convert(text: string, options?: ConvertOptions): Promise<string>;
  }
}

declare module "kuroshiro-analyzer-kuromoji" {
  export default class KuromojiAnalyzer {
    constructor(opts?: { dictPath?: string });
  }
}

declare module "kuromoji/src/loader/BrowserDictionaryLoader" {
  interface LoaderProto {
    loadArrayBuffer(url: string, callback: (err: unknown, buffer: ArrayBuffer | null) => void): void;
  }
  const BrowserDictionaryLoader: { prototype: LoaderProto };
  export default BrowserDictionaryLoader;
}
