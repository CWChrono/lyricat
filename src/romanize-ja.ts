// Cat-jam side of Japanese romanization: it does NOT import kuroshiro/kuromoji (that's the separate,
// crash-isolated `catjam-ja-romanizer` extension built by its own esbuild step). It only talks to the
// global that extension registers — so nothing heavy enters the main bundle and nothing here can crash boot.

interface JaRomanizerApi {
  romanizeWords(words: string[]): Promise<string[]>;
  ready(): boolean;
  warm(): Promise<unknown>;
}

function api(): JaRomanizerApi | null {
  const g = (globalThis as unknown as { __catjamJa?: JaRomanizerApi }).__catjamJa;
  return g && typeof g.romanizeWords === "function" ? g : null;
}

/** True when the separate JP romanizer extension is loaded (so the UI can tailor its messaging). */
export function jaRomanizerAvailable(): boolean {
  return !!api();
}

/** True once the JP dictionary has finished loading this session. */
export function jaRomanizerReady(): boolean {
  return !!api()?.ready();
}

/** Romanize Japanese word-units → one romaja per unit (1:1). Throws a clear error if the companion
 *  extension isn't loaded (e.g. first apply before a Spotify restart). */
export async function romanizeJaWords(words: readonly string[]): Promise<string[]> {
  const a = api();
  if (!a) throw new Error("JP romanizer not loaded — restart Spotify after applying");
  return a.romanizeWords([...words]);
}
