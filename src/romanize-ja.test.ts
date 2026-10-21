import { describe, it, expect, afterEach } from "vitest";
import { jaRomanizerAvailable, jaRomanizerReady, romanizeJaWords } from "./romanize-ja";

const g = globalThis as unknown as { __catjamJa?: unknown };
afterEach(() => {
  delete g.__catjamJa;
});

describe("romanize-ja (global handshake)", () => {
  it("reports unavailable + throws clearly when the companion extension isn't loaded", async () => {
    expect(jaRomanizerAvailable()).toBe(false);
    expect(jaRomanizerReady()).toBe(false);
    await expect(romanizeJaWords(["君"])).rejects.toThrow(/not loaded/i);
  });

  it("delegates to window.__catjamJa when present, passing a plain array", async () => {
    let received: string[] | null = null;
    g.__catjamJa = {
      romanizeWords: (words: string[]) => {
        received = words;
        return Promise.resolve(words.map((w) => `rom:${w}`));
      },
      ready: () => true,
      warm: () => Promise.resolve(),
    };
    expect(jaRomanizerAvailable()).toBe(true);
    expect(jaRomanizerReady()).toBe(true);
    expect(await romanizeJaWords(["君", "の"])).toEqual(["rom:君", "rom:の"]);
    expect(Array.isArray(received)).toBe(true); // got a real array, not a readonly view
  });
});
