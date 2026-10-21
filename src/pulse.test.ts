import { describe, it, expect, beforeEach, afterEach } from "vitest";
import {
  clamp01,
  depthFromStats,
  beatPhase,
  pulseEnvelope,
  beatEnvelope,
  onsetEnvelope,
  onsetFlashEnvelope,
  sustainEnvelope,
  onsetArticulation,
  smoothstep,
  strengthCurve,
  onsetsAreSparse,
  brightnessFor,
  scaleFor,
  createVideoPulse,
  syllableFrameOpen,
  beatFrameOpen,
  PulseConfig,
  PlayerClock,
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

describe("smoothstep", () => {
  it("eases 0→1 with flat ends", () => {
    expect(smoothstep(0)).toBe(0);
    expect(smoothstep(1)).toBe(1);
    expect(smoothstep(0.5)).toBeCloseTo(0.5);
    expect(smoothstep(-1)).toBe(0); // clamped
    expect(smoothstep(2)).toBe(1);
  });
});

describe("beatEnvelope", () => {
  it("peaks ON the beat (phase 0), not after it — for both glow and bounce", () => {
    expect(beatEnvelope(0)).toBeCloseTo(1);
    expect(beatEnvelope(0, 2)).toBeCloseTo(1);
  });
  it("rises approaching the beat and rests mid-beat", () => {
    expect(beatEnvelope(0.97)).toBeGreaterThan(beatEnvelope(0.5)); // just-before-beat > mid-beat
    expect(beatEnvelope(0.5)).toBeLessThan(0.4);
  });
});

describe("onsetEnvelope (syllable spans, hold for the note)", () => {
  const onsets = [{ start: 1000, end: 1300 }, { start: 1500, end: 1600 }, { start: 5000 }];
  it("rests before the first onset", () => {
    expect(onsetEnvelope(0, onsets)).toBe(0);
    expect(onsetEnvelope(999, onsets)).toBe(0);
  });
  it("ramps up then holds at max across the note's length", () => {
    expect(onsetEnvelope(1000, onsets)).toBeCloseTo(0); // attack start
    expect(onsetEnvelope(1055, onsets)).toBeCloseTo(1, 1); // attack done → max
    expect(onsetEnvelope(1200, onsets)).toBeCloseTo(1); // held mid-note
    expect(onsetEnvelope(1300, onsets)).toBeCloseTo(1); // still max at the note end
  });
  it("eases back down after the note ends", () => {
    expect(onsetEnvelope(1400, onsets)).toBeLessThan(1); // decaying in the gap
    expect(onsetEnvelope(1300 + 190, onsets)).toBeCloseTo(0, 1); // released
  });
  it("holds longer for a longer (held) note", () => {
    const long = [{ start: 0, end: 2000 }, { start: 5000 }];
    const short = [{ start: 0, end: 100 }, { start: 5000 }];
    expect(onsetEnvelope(1000, long)).toBeCloseTo(1); // still held deep into the long note
    expect(onsetEnvelope(1000, short)).toBe(0); // short note long since released
  });
  it("lets the next onset cut a hold short", () => {
    expect(onsetEnvelope(1550, onsets)).toBeCloseTo(1); // second note holding
  });
  it("returns rest for an empty onset list", () => {
    expect(onsetEnvelope(1234, [])).toBe(0);
  });
});

describe("onsetFlashEnvelope (per-word brightness flash that lerps back down)", () => {
  const onsets = [{ start: 1000, end: 1300 }, { start: 1500 }, { start: 2000 }];
  it("rests before the first onset", () => {
    expect(onsetFlashEnvelope(0, onsets)).toBe(0);
  });
  it("flashes just after a word, then lerps back to base before the next", () => {
    expect(onsetFlashEnvelope(1000, onsets)).toBeCloseTo(0); // rise start
    expect(onsetFlashEnvelope(1075, onsets)).toBeCloseTo(1, 1); // peak
    expect(onsetFlashEnvelope(1250, onsets)).toBeLessThan(0.8); // decaying
    expect(onsetFlashEnvelope(1490, onsets)).toBeLessThan(0.1); // back at base before next word
  });
  it("lerps fully within a few-frame gap (window scales to the gap)", () => {
    const fast = [{ start: 0 }, { start: 48 }]; // ~3 frames at 60fps
    expect(onsetFlashEnvelope(6, fast)).toBeGreaterThan(0.3); // risen
    expect(onsetFlashEnvelope(46, fast)).toBeLessThan(0.15); // dropped to ~base by the next
  });
});

describe("sustainEnvelope (stay lit across dense syllables, dim only in gaps)", () => {
  it("holds 1 across back-to-back syllables (no reset per onset)", () => {
    const dense = [{ start: 0, end: 150 }, { start: 150, end: 300 }, { start: 300, end: 450 }];
    expect(sustainEnvelope(75, dense)).toBe(1);
    expect(sustainEnvelope(150, dense)).toBe(1); // boundary — still lit, not reset to 0
    expect(sustainEnvelope(300, dense)).toBe(1);
    expect(sustainEnvelope(450, dense)).toBe(1);
  });
  it("dims only in a real gap after a note", () => {
    const spans = [{ start: 0, end: 100 }, { start: 2000, end: 2100 }];
    expect(sustainEnvelope(50, spans)).toBe(1); // inside the note
    expect(sustainEnvelope(100 + 190, spans)).toBeCloseTo(0, 1); // released in the gap
    expect(sustainEnvelope(1000, spans)).toBe(0); // deep in the gap
  });
  it("rests before the first onset / empty", () => {
    expect(sustainEnvelope(0, [{ start: 100 }])).toBe(0);
    expect(sustainEnvelope(1234, [])).toBe(0);
  });
});

describe("onsetArticulation (brief per-syllable dip pulse)", () => {
  const onsets = [{ start: 1000 }, { start: 1200 }];
  it("pulses briefly right after each onset, 0 otherwise", () => {
    expect(onsetArticulation(1000, onsets)).toBeCloseTo(0); // at the onset (rise start)
    expect(onsetArticulation(1009, onsets)).toBeGreaterThan(0.8); // ~peak (ATTACK × window)
    expect(onsetArticulation(1075, onsets)).toBe(0); // window elapsed
    expect(onsetArticulation(1150, onsets)).toBe(0); // between onsets, past the window
  });
  it("0 before the first onset / empty", () => {
    expect(onsetArticulation(0, onsets)).toBe(0);
    expect(onsetArticulation(1234, [])).toBe(0);
  });
});

describe("brightnessFor (dim-and-release: dark base → natural peak, never over-bright)", () => {
  it("peaks at exactly 1 (natural, full detail) and dips to a dark base", () => {
    expect(brightnessFor(1, 1, 1, true)).toBeCloseTo(1); // peak = untouched webm, no blow-out
    expect(brightnessFor(0, 1, 1, true)).toBeCloseTo(0); // dip clamps to full dark at max strength
    expect(brightnessFor(0.5, 1, 1, true)).toBeGreaterThan(0.3);
    expect(brightnessFor(0.5, 1, 1, true)).toBeLessThan(1);
  });
  it("never exceeds 1 (no synthetic over-brightening)", () => {
    for (const e of [0, 0.3, 0.7, 1]) expect(brightnessFor(e, 1, 1, true)).toBeLessThanOrEqual(1);
  });
  it("high-energy songs dip darker between pulses than chill ones", () => {
    expect(brightnessFor(0, 0.9, 1, true)).toBeLessThan(brightnessFor(0, 0.2, 1, true));
  });
  it("intensity controls the dip depth, not the peak", () => {
    expect(brightnessFor(1, 1, 1, true)).toBeCloseTo(1); // peak natural at any intensity
    expect(brightnessFor(1, 1, 0.1, true)).toBeCloseTo(1);
    expect(brightnessFor(0, 1, 1, true)).toBeLessThan(brightnessFor(0, 1, 0.1, true)); // higher → darker dip
  });
  it("intensity 0 or disabled → constant 1 (no dip)", () => {
    expect(brightnessFor(0, 1, 0, true)).toBeCloseTo(1);
    expect(brightnessFor(1, 1, 1, false)).toBe(1);
  });
  it("beat-mode dimScale dips less than lyric mode", () => {
    expect(brightnessFor(0, 1, 1, true, 0.5)).toBeGreaterThan(brightnessFor(0, 1, 1, true, 1));
  });
});

describe("scaleFor (bounce)", () => {
  it("rests at 1 and rises with envelope × strength × intensity", () => {
    expect(scaleFor(0, 1, 1, true)).toBeCloseTo(1);
    expect(scaleFor(1, 1, 1, true)).toBeGreaterThan(1);
  });
  it("dancier songs bounce more than chill ones", () => {
    expect(scaleFor(1, 0.9, 1, true)).toBeGreaterThan(scaleFor(1, 0.2, 1, true));
  });
  it("peaks at +18% and is exactly 1 when disabled", () => {
    expect(scaleFor(1, 1, 1, true)).toBeCloseTo(1.18);
    expect(scaleFor(1, 1, 1, false)).toBe(1);
  });
});

describe("strengthCurve (exponential response to song strength)", () => {
  it("keeps the full/none endpoints", () => {
    expect(strengthCurve(1)).toBeCloseTo(1);
    expect(strengthCurve(0)).toBeCloseTo(0);
  });
  it("pushes low strength much lower than high strength (mellow ≪ intense)", () => {
    // depth 0.3 → 0.09 (barely there); depth 0.9 → 0.81 (pops). The ratio widens
    // vs a linear 0.3 : 0.9.
    expect(strengthCurve(0.3)).toBeCloseTo(0.09);
    expect(strengthCurve(0.9)).toBeCloseTo(0.81);
    expect(strengthCurve(0.9) / strengthCurve(0.3)).toBeGreaterThan(0.9 / 0.3);
  });
  it("makes a chill track barely bounce while a banger bounces hard", () => {
    const chill = scaleFor(1, 0.3, 1, true) - 1; // added scale
    const banger = scaleFor(1, 0.9, 1, true) - 1;
    expect(banger).toBeGreaterThan(chill * 8); // exponential gap, not linear (~3×)
  });
});

describe("onsetsAreSparse (line-level vs word-level detection)", () => {
  it("is false for dense word-level onsets", () => {
    expect(onsetsAreSparse([0, 300, 600, 900, 1200].map((start) => ({ start })))).toBe(false);
  });
  it("is true for sparse line-level onsets (long gaps)", () => {
    expect(onsetsAreSparse([0, 3000, 6500, 9000].map((start) => ({ start })))).toBe(true);
  });
  it("is false with fewer than two onsets", () => {
    expect(onsetsAreSparse([{ start: 100 }])).toBe(false);
    expect(onsetsAreSparse([])).toBe(false);
  });
});

describe("syllableFrameOpen (per-pulse frame decision)", () => {
  // Two back-to-back notes (end touches the next start), then a note followed by a
  // rest. The mouth holds open for each note, with a quick close-pop at each onset.
  const onsets = [
    { start: 1000, end: 1300 }, // dense: runs into the next
    { start: 1300, end: 2000 }, // dense: runs into the next
    { start: 2000, end: 2100 }, // then a rest until… (no next onset)
  ];
  it("is closed before the first syllable", () => {
    expect(syllableFrameOpen(500, onsets)).toBe(false);
  });
  it("opens through the body of each note", () => {
    expect(syllableFrameOpen(1100, onsets)).toBe(true); // early in note 1
    expect(syllableFrameOpen(1400, onsets)).toBe(true); // early in note 2
    expect(syllableFrameOpen(2010, onsets)).toBe(true); // early in note 3
  });
  it("closes the tail of each note so the pop lands on the boundary", () => {
    expect(syllableFrameOpen(1290, onsets)).toBe(false); // release tail of note 1 (ends 1300)
    expect(syllableFrameOpen(1950, onsets)).toBe(false); // release tail of note 2 (ends 2000)
    expect(syllableFrameOpen(2090, onsets)).toBe(false); // release tail of note 3 (ends 2100)
  });
  it("stays closed after the last note and through rests", () => {
    expect(syllableFrameOpen(2200, onsets)).toBe(false); // note 3 ended at 2100
    expect(syllableFrameOpen(3000, onsets)).toBe(false); // deep into the rest
  });
  it("is closed with no onsets", () => {
    expect(syllableFrameOpen(1100, null)).toBe(false);
    expect(syllableFrameOpen(1100, [])).toBe(false);
  });
});

describe("beatFrameOpen (Bongo beat-driven frame)", () => {
  it("holds each frame for one whole beat, alternating per beat (60bpm → 1s beats)", () => {
    expect(beatFrameOpen(0.5, 60)).toBe(false); // beat 0 → frame A
    expect(beatFrameOpen(1.5, 60)).toBe(true); // beat 1 → frame B
    expect(beatFrameOpen(2.5, 60)).toBe(false); // beat 2 → frame A
    expect(beatFrameOpen(3.5, 60)).toBe(true); // beat 3 → frame B
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
    ({ style: { transform, transformOrigin: "", filter: "", willChange: "" } }) as unknown as HTMLVideoElement;
  const tick = () => frameCb?.(0);
  // 75 ms at 120 bpm → phase 0.15: both the glow and the (sharper) bounce are active.
  const playingAt = (ms: number): PlayerClock => ({ getProgress: () => ms });
  const num = (re: RegExp, s: string) => parseFloat(re.exec(s)![1]);
  const makePulse = (config: PulseConfig, player: PlayerClock, playing = true) => {
    const p = createVideoPulse(player);
    p.setConfig(config);
    p.setPlaying(playing);
    return p;
  };

  it("brightens (filter) and bounces (transform) on the beat while playing", () => {
    const p = makePulse({ brightness: true, scale: true, brightnessIntensity: 1, scaleIntensity: 1 }, playingAt(75));
    const v = fakeVideo();
    p.attach(v);
    p.setTrack(120, 1);
    tick();
    // Dim-and-release: mid-pulse brightness is between the dark base and 1 (natural).
    const b = num(/brightness\(([\d.]+)\)/, v.style.filter);
    expect(b).toBeGreaterThan(0.4);
    expect(b).toBeLessThan(1);
    // Non-uniform: mostly vertical (sy), slight rightward lean (sx < sy).
    const sx = num(/scale\(([\d.]+),/, v.style.transform);
    const sy = num(/scale\([\d.]+,\s*([\d.]+)\)/, v.style.transform);
    expect(sy).toBeGreaterThan(1);
    expect(sy).toBeLessThanOrEqual(1.18); // max bounce +18%
    expect(sx).toBeGreaterThan(1);
    expect(sx).toBeLessThan(sy);
    expect(v.style.transformOrigin).toBe("left bottom"); // bottom-left pivot
  });

  it("composes the scale with the base transform (Bongo translateY preserved)", () => {
    const p = makePulse({ brightness: false, scale: true, brightnessIntensity: 1, scaleIntensity: 1 }, playingAt(75));
    const v = fakeVideo("translateY(17px)");
    p.attach(v);
    p.setTrack(120, 1);
    tick();
    expect(v.style.transform.startsWith("translateY(17px) scale(")).toBe(true);
    expect(v.style.filter).toBe(""); // brightness toggle independent + off
  });

  it("setPosition applies the offset immediately while resting (idle)", () => {
    const p = makePulse({ brightness: false, scale: false, brightnessIntensity: 1, scaleIntensity: 1 }, playingAt(250));
    const v = fakeVideo("");
    p.attach(v);
    p.setTrack(120, 1);
    tick(); // both toggles off → reset() → idle
    p.setPosition("translate(-55px, 0px)");
    expect(v.style.transform).toBe("translate(-55px, 0px)"); // live, no remount
  });

  it("setPosition offset survives the bounce (composed with the scale)", () => {
    const p = makePulse({ brightness: false, scale: true, brightnessIntensity: 1, scaleIntensity: 1 }, playingAt(75));
    const v = fakeVideo("");
    p.attach(v);
    p.setTrack(120, 1);
    p.setPosition("translate(-55px, 0px)");
    tick();
    expect(v.style.transform.startsWith("translate(-55px, 0px) scale(")).toBe(true);
  });

  it("rests (no effect) when both toggles are off", () => {
    const p = makePulse({ brightness: false, scale: false, brightnessIntensity: 1, scaleIntensity: 1 }, playingAt(250));
    const v = fakeVideo("translateY(17px)");
    p.attach(v);
    p.setTrack(120, 1);
    tick();
    expect(v.style.filter).toBe("");
    expect(v.style.transform).toBe("translateY(17px)");
  });

  it("rests while paused (play state pushed, not polled)", () => {
    const p = makePulse(
      { brightness: true, scale: true, brightnessIntensity: 1, scaleIntensity: 1 },
      playingAt(250),
      false // paused
    );
    const v = fakeVideo();
    p.attach(v);
    p.setTrack(120, 1);
    tick();
    expect(v.style.filter).toBe("");
    expect(v.style.transform).toBe("");
  });

  it("drives a mirror in sync: same brightness, flipped bounce, locked playback", () => {
    const p = makePulse({ brightness: true, scale: true, brightnessIntensity: 1, scaleIntensity: 1 }, playingAt(75));
    const main = fakeVideo("");
    // Give the main playback fields for the mirror's rate/pause/drift sync.
    Object.assign(main as unknown as Record<string, unknown>, { currentTime: 0.12, playbackRate: 0.2, paused: false });
    const mirror = {
      style: { transform: "scaleX(-1)", transformOrigin: "", filter: "", willChange: "" },
      currentTime: 5, playbackRate: 1, paused: true, play: () => undefined, pause: () => undefined,
    } as unknown as HTMLVideoElement;
    p.attach(main);
    p.setMirror(mirror);
    p.setTrack(120, 1);
    tick();
    expect(mirror.style.filter).toBe(main.style.filter); // same brightness
    expect(mirror.style.transform.startsWith("scaleX(-1) scale(")).toBe(true); // flip + bounce
    expect(mirror.style.transformOrigin).toBe("center bottom"); // flip in place (no width shift)
    expect(mirror.playbackRate).toBe(0.2); // rate matched
    expect(mirror.currentTime).toBeCloseTo(0.12); // drift-corrected onto the main's frame
  });

  it("explicit onset spans override the beat clock (brightness flashes on the word)", () => {
    const p = makePulse(
      { brightness: true, scale: false, brightnessIntensity: 1, scaleIntensity: 1 },
      playingAt(1100) // shortly after the first word → flash near peak
    );
    const v = fakeVideo();
    p.attach(v);
    p.setTrack(120, 1);
    p.setOnsets([{ start: 1000, end: 1300 }, { start: 1500 }]);
    tick();
    // On the word, the flash releases to ~1 (natural, full detail).
    expect(num(/brightness\(([\d.]+)\)/, v.style.filter)).toBeGreaterThan(0.9);
  });
});
