// Minimal Node globals for the bundled kuromoji/zlib.js dependencies, which reference `process` and
// `global` even in the browser (process.nextTick/env/cwd/platform/…). Without these, Spotify's runtime
// throws "process is not defined" the moment the vendor code evaluates. Imported FIRST by entry.ts so it
// runs before any vendor module. (kuromoji's analyzer picks the browser path via `typeof window`, which
// this shim does not affect — so it can't accidentally flip it into the Node code path.)

const g = globalThis as unknown as { process?: unknown; global?: unknown };

if (!g.process) {
  g.process = {
    env: {},
    nextTick: (fn: (...a: unknown[]) => void, ...args: unknown[]): void => void Promise.resolve().then(() => fn(...args)),
    cwd: (): string => "/",
    platform: "",
    argv: [] as string[],
    version: "",
    versions: {} as Record<string, string>, // no `.node` → analyzer/isNode stays browser
    nextIdx: 0,
  };
}
if (!g.global) g.global = g;

export {};
