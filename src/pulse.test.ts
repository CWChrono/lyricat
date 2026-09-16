import { describe, it, expect, beforeEach, afterEach } from "vitest";
import {
  clamp01,
  depthFromStats,
  beatPhase,
  pulseEnvelope,
  onsetEnvelope,
  brightnessFor,
  scaleFor,
  createVideoPulse,
} from "./pulse";

describe("clamp01", () => {
  it("clamps into [0,1] and coerces non-finite to 0", () => {
    expect(clamp01(-1)).toBe(0);
    expect(clamp01(0.4)).toBe(0.4);
    expect(clamp01(2)).toBe(1);
    expect(clamp01(NaN)).toBe(0);
    expect(clamp01(Infinity)).toBe(0);
  });
});

describe("depthFromStats", () => {
  it("dancier + more energetic tracks pulse harder", () => {
    expect(depthFromStats(0.9, 0.8)).toBeGreaterThan(depthFromStats(0.2, 0.2));
  });
  it("danceability leads, energy nudges", () => {
    expect(depthFromStats(0.8, 0.8)).toBeCloseTo(0.8);
    expect(depthFromStats(0.8, 0.4)).toBeCloseTo(0.7); // 0.75*0.8 + 0.25*0.4
  });
  it("falls back to a moderate default when stats are missing", () => {
    expect(depthFromStats(undefined, undefined)).toBeCloseTo(0.5);
    expect(depthFromStats(0.6, undefined)).toBeCloseTo(0.6); // energy mirrors danceability
  });
  it("stays within [0,1]", () => {
    expect(depthFromStats(5, 5)).toBe(1);
    expect(depthFromStats(-1, -1)).toBe(0);
  });
});

describe("beatPhase", () => {
  it("is 0 at the start of a beat and ~1 just before the next", () => {
    // 120 bpm → 0.5s per beat.
    expect(beatPhase(0, 120)).toBeCloseTo(0);
    expect(beatPhase(0.25, 120)).toBeCloseTo(0.5);
    expect(beatPhase(0.5, 120)).toBeCloseTo(0); // wrapped to the next beat
  });
  it("guards non-positive tempo with a default and never leaves [0,1)", () => {
    expect(beatPhase(1.3, 0)).toBeGreaterThanOrEqual(0);
    expect(beatPhase(1.3, 0)).toBeLessThan(1);
  });
});

describe("pulseEnvelope", () => {
  it("rests at the beat boundaries and peaks in between", () => {
    expect(pulseEnvelope(0)).toBeCloseTo(0);
    expect(pulseEnvelope(0.12)).toBeCloseTo(1); // peak at the end of the attack
    expect(pulseEnvelope(1)).toBeCloseTo(0);
  });
  it("decays monotonically after the peak", () => {
    expect(pulseEnvelope(0.3)).toBeGreaterThan(pulseEnvelope(0.6));
    expect(pulseEnvelope(0.6)).toBeGreaterThan(pulseEnvelope(0.9));
  });
  it("sharpness>1 makes the pulse more abrupt: peaks earlier, rests by mid-beat", () => {
    expect(pulseEnvelope(0.06, 2)).toBeCloseTo(1); // peak arrives at half the phase
    expect(pulseEnvelope(0.5, 2)).toBeCloseTo(0); // fully rested by the mid-beat
    expect(pulseEnvelope(0.6, 1)).toBeGreaterThan(0); // still going at 1x…
    expect(pulseEnvelope(0.6, 2)).toBeCloseTo(0); // …already at rest at 2x
  });
});

describe("onsetEnvelope", () => {
  const onsets = [1000, 1500, 5000];
  it("rests before the first onset", () => {
    expect(onsetEnvelope(0, onsets)).toBeCloseTo(0);
    expect(onsetEnvelope(999, onsets)).toBeCloseTo(0);
  });
  it("fires right after an onset and decays before the next", () => {
    expect(onsetEnvelope(1000, onsets)).toBeCloseTo(0); // at the onset (start of attack)
    expect(onsetEnvelope(1046, onsets)).toBeCloseTo(1, 1); // attack peak (~ATTACK × window)
    expect(onsetEnvelope(1080, onsets)).toBeGreaterThan(0.7); // still a strong pulse
    expect(onsetEnvelope(1490, onsets)).toBeLessThan(0.2); // decayed before the next onset
  });
  it("uses a default decay window for the final onset", () => {
    expect(onsetEnvelope(5060, onsets)).toBeGreaterThan(0.5); // pulses after the last onset
    expect(onsetEnvelope(9000, onsets)).toBeCloseTo(0); // long gone
  });
  it("returns rest for an empty onset list", () => {
    expect(onsetEnvelope(1234, [])).toBe(0);
  });
});

describe("brightnessFor / scaleFor", () => {
  it("rest at 1 and rise with envelope × depth × intensity", () => {
    expect(brightnessFor(0, 1, 1, true)).toBeCloseTo(1);
    expect(brightnessFor(1, 1, 1, true)).toBeGreaterThan(1);
    expect(scaleFor(0, 1, 1, true)).toBeCloseTo(1);
    expect(scaleFor(1, 1, 1, true)).toBeGreaterThan(1);
  });
  it("dancier songs bounce/brighten more than chill ones", () => {
    expect(brightnessFor(1, 0.9, 1, true)).toBeGreaterThan(brightnessFor(1, 0.2, 1, true));
    expect(scaleFor(1, 0.9, 1, true)).toBeGreaterThan(scaleFor(1, 0.2, 1, true));
  });
  it("keep the scale bounce very slight (<= +6%)", () => {
    expect(scaleFor(1, 1, 1, true)).toBeLessThanOrEqual(1.06);
  });
  it("return exactly 1 (no effect) when disabled", () => {
    expect(brightnessFor(1, 1, 1, false)).toBe(1);
    expect(scaleFor(1, 1, 1, false)).toBe(1);
  });
});

describe("createVideoPulse (animator)", () => {
  let frameCb: FrameRequestCallback | null;
  const origRaf = globalThis.requestAnimationFrame;
  const origCancel = globalThis.cancelAnimationFrame;

  beforeEach(() => {
    frameCb = null;
    // Capture the frame callback instead of looping, so we can step one frame.
    globalThis.requestAnimationFrame = ((cb: FrameRequestCallback) => {
      frameCb = cb;
      return 1;
    }) as typeof requestAnimationFrame;
    globalThis.cancelAnimationFrame = (() => {}) as typeof cancelAnimationFrame;
  });
  afterEach(() => {
    globalThis.requestAnimationFrame = origRaf;
    globalThis.cancelAnimationFrame = origCancel;
  });

  const fakeVideo = (transform = "") =>
    ({ style: { transform, transformOrigin: "", filter: "" } }) as unknown as HTMLVideoElement;
  const tick = () => frameCb?.(0);
  // 75 ms at 120 bpm → phase 0.15: both the glow and the (sharper) bounce are
  // active there. Mid-beat (phase 0.5) is now rest for the sharpened scale.
  const playingAt = (ms: number) => ({ getProgress: () => ms, isPlaying: () => true });
  const num = (re: RegExp, s: string) => parseFloat(re.exec(s)![1]);

  it("brightens and bounces on the beat while playing", () => {
    const p = createVideoPulse(() => ({ brightness: true, scale: true, intensity: 1 }), playingAt(75));
    const v = fakeVideo();
    p.attach(v);
    p.setTrack(120, 1);
    tick();
    expect(num(/brightness\(([\d.]+)\)/, v.style.filter)).toBeGreaterThan(1);
    // Non-uniform: mostly vertical (sy), slight rightward lean (sx < sy).
    const sx = num(/scale\(([\d.]+),/, v.style.transform);
    const sy = num(/scale\([\d.]+,\s*([\d.]+)\)/, v.style.transform);
    expect(sy).toBeGreaterThan(1);
    expect(sy).toBeLessThanOrEqual(1.06); // "very slight"
    expect(sx).toBeGreaterThan(1); // grows rightward a little…
    expect(sx).toBeLessThan(sy); // …but far less than it grows upward
    expect(v.style.transformOrigin).toBe("left bottom"); // bottom-left pivot
  });

  it("composes the scale with the base transform (Bongo translateY preserved)", () => {
    const p = createVideoPulse(() => ({ brightness: false, scale: true, intensity: 1 }), playingAt(75));
    const v = fakeVideo("translateY(17px)");
    p.attach(v);
    p.setTrack(120, 1);
    tick();
    expect(v.style.transform.startsWith("translateY(17px) scale(")).toBe(true);
    expect(v.style.filter).toBe(""); // brightness toggle independent + off
  });

  it("rests (no effect) when both toggles are off", () => {
    const p = createVideoPulse(() => ({ brightness: false, scale: false, intensity: 1 }), playingAt(250));
    const v = fakeVideo("translateY(17px)");
    p.attach(v);
    p.setTrack(120, 1);
    tick();
    expect(v.style.filter).toBe("");
    expect(v.style.transform).toBe("translateY(17px)");
  });

  it("rests while paused", () => {
    const p = createVideoPulse(
      () => ({ brightness: true, scale: true, intensity: 1 }),
      { getProgress: () => 250, isPlaying: () => false }
    );
    const v = fakeVideo();
    p.attach(v);
    p.setTrack(120, 1);
    tick();
    expect(v.style.filter).toBe("");
    expect(v.style.transform).toBe("");
  });

  it("explicit onsets override the beat clock", () => {
    const p = createVideoPulse(() => ({ brightness: true, scale: false, intensity: 1 }), playingAt(1046));
    const v = fakeVideo();
    p.attach(v);
    p.setTrack(120, 1);
    p.setOnsets([1000, 1500]); // syllable-style onsets; 1046 ≈ attack peak
    tick();
    expect(num(/brightness\(([\d.]+)\)/, v.style.filter)).toBeGreaterThan(1.5);
  });
});
