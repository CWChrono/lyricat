import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  CatJamController,
  CatJamConfig,
  AnalysisResult,
  PlaybackState,
} from "./controller";

const CONFIG: CatJamConfig = { videoUrl: "http://x/cat.webm", defaultBpm: 135.48 };
const PLAYING: PlaybackState = { progressMs: 0, isPlaying: true };

function fakeVideo() {
  return {
    playbackRate: 1,
    currentTime: 1,
    play: vi.fn().mockResolvedValue(undefined),
    pause: vi.fn(),
    isConnected: true,
  } as any;
}

function deferred<T>() {
  let resolve!: (v: T) => void;
  const promise = new Promise<T>((r) => (resolve = r));
  return { promise, resolve };
}

describe("CatJamController", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  function makeController(fetchAnalysis: (uri: string) => Promise<AnalysisResult | null>) {
    return new CatJamController({ getConfig: () => CONFIG, fetchAnalysis });
  }

  function pulseMock() {
    return {
      attach: vi.fn(),
      setTrack: vi.fn(),
      setOnsets: vi.fn(), setMirrorOnsets: vi.fn(),
      setSyllableFrames: vi.fn(),
      setFrames: vi.fn(),
      setConfig: vi.fn(),
      setPosition: vi.fn(),
      setMirror: vi.fn(),
      setPlaying: vi.fn(),
      stop: vi.fn(),
    } as any;
  }

  it("an image source (Pop) keeps the clip paused and drives the syllable frame", () => {
    const pulse = pulseMock();
    const c = new CatJamController({
      getConfig: () => ({ videoUrl: "c", defaultBpm: 300, frames: { closed: "c", open: "o" }, syllableFrames: true }),
      fetchAnalysis: () => Promise.resolve({ tempoBpm: 120 }),
      pulse,
    });
    const video = fakeVideo();
    c.setVideo(video);
    c.onSongChange("spotify:track:A", PLAYING);
    expect(pulse.setSyllableFrames).toHaveBeenCalledWith(true); // Pop → syllable driver
    expect(video.play).not.toHaveBeenCalled(); // pulse owns the (paused) frame
    expect(video.pause).toHaveBeenCalled();
  });

  it("an image source (Bongo) pauses the clip but uses the beat driver", () => {
    const pulse = pulseMock();
    const c = new CatJamController({
      getConfig: () => ({ videoUrl: "c", defaultBpm: 600, frames: { closed: "c", open: "o" } }),
      fetchAnalysis: () => Promise.resolve({ tempoBpm: 120 }),
      pulse,
    });
    const video = fakeVideo();
    c.setVideo(video);
    c.onSongChange("spotify:track:A", PLAYING);
    expect(pulse.setSyllableFrames).toHaveBeenCalledWith(false); // Bongo → beat driver
    expect(video.play).not.toHaveBeenCalled();
    expect(video.pause).toHaveBeenCalled();
  });

  it("a video source (no frames) plays the looping clip", () => {
    const c = new CatJamController({
      getConfig: () => ({ videoUrl: "x", defaultBpm: 135 }),
      fetchAnalysis: () => Promise.resolve({ tempoBpm: 120 }),
    });
    const video = fakeVideo();
    c.setVideo(video);
    c.onSongChange("spotify:track:A", PLAYING);
    expect(video.play).toHaveBeenCalled();
  });

  it("stale analysis result cannot overwrite a newer track", async () => {
    const pendingA = deferred<AnalysisResult | null>();
    const c = makeController((uri) =>
      uri === "spotify:track:A" ? pendingA.promise : Promise.resolve({ tempoBpm: 67.74 })
    );
    const video = fakeVideo();
    c.setVideo(video);

    c.onSongChange("spotify:track:A", PLAYING);
    await vi.advanceTimersByTimeAsync(0);
    expect(video.playbackRate).toBeCloseTo(1);

    c.onSongChange("spotify:track:B", PLAYING);
    await vi.advanceTimersByTimeAsync(0);
    expect(video.playbackRate).toBeCloseTo(0.5); // 67.74 / 135.48

    pendingA.resolve({ tempoBpm: 200 }); // late result for the OLD track
    await vi.advanceTimersByTimeAsync(0);
    expect(video.playbackRate).toBeCloseTo(0.5); // unchanged by stale A
  });

  it("applies a manual meter divisor on reload", async () => {
    let override: number | undefined = undefined;
    const c = new CatJamController({
      getConfig: () => CONFIG,
      fetchAnalysis: () => Promise.resolve({ tempoBpm: 140 }),
      getDoubleTime: () => override,
    });
    const video = fakeVideo();
    c.setVideo(video);

    c.onSongChange("spotify:track:A", PLAYING);
    await vi.advanceTimersByTimeAsync(0);
    expect(video.playbackRate).toBeCloseTo(140 / 135.48); // 140 < 150, auto keeps it

    override = 2; // user cuts it to half-time
    c.onSongChange("spotify:track:A", PLAYING); // reload picks up the override
    await vi.advanceTimersByTimeAsync(0);
    expect(video.playbackRate).toBeCloseTo(70 / 135.48); // halved
  });

  it("holds the first frame for the manual sync delay, then plays", async () => {
    const c = new CatJamController({
      getConfig: () => CONFIG,
      fetchAnalysis: () => Promise.resolve({ tempoBpm: 120 }), // no beats
      getDelayMs: () => 200,
    });
    const video = fakeVideo();
    c.setVideo(video);

    c.onSongChange("spotify:track:A", PLAYING);
    await vi.advanceTimersByTimeAsync(0);
    expect(video.pause).toHaveBeenCalled(); // held at frame 0
    const playsBefore = video.play.mock.calls.length;

    video.currentTime = 7;
    vi.advanceTimersByTime(200);
    expect(video.currentTime).toBe(0); // restarted after the delay
    expect(video.play.mock.calls.length).toBe(playsBefore + 1);
  });

  it("song change cancels pending beat timers of the previous track", async () => {
    const neverResolves = new Promise<AnalysisResult | null>(() => {});
    let track = "A";
    const c = makeController(() =>
      track === "A"
        ? Promise.resolve({ tempoBpm: 135.48, beats: [{ start: 10 }] })
        : neverResolves
    );
    const video = fakeVideo();
    c.setVideo(video);

    c.onSongChange("spotify:track:A", PLAYING);
    await vi.advanceTimersByTimeAsync(0); // A's beat timer armed ~10s out

    track = "B";
    c.onSongChange("spotify:track:B", PLAYING);
    await vi.advanceTimersByTimeAsync(0);
    const playsNow = video.play.mock.calls.length;

    await vi.advanceTimersByTimeAsync(60_000);
    expect(video.play.mock.calls.length).toBe(playsNow); // A's stale timer never fired
  });

  it("pause clears pending timers and pauses video", async () => {
    const c = makeController(() =>
      Promise.resolve({ tempoBpm: 135.48, beats: [{ start: 5 }] })
    );
    const video = fakeVideo();
    c.setVideo(video);

    c.onSongChange("spotify:track:A", PLAYING);
    await vi.advanceTimersByTimeAsync(0);
    c.onPlayPause({ progressMs: 0, isPlaying: false });

    const plays = video.play.mock.calls.length;
    vi.advanceTimersByTime(60_000);
    expect(video.play.mock.calls.length).toBe(plays);
    expect(video.pause).toHaveBeenCalled();
  });

  it("resumes, resets alignment and resyncs on play", async () => {
    const c = makeController(() =>
      Promise.resolve({ tempoBpm: 135.48, beats: [{ start: 2 }] })
    );
    const video = fakeVideo();
    c.setVideo(video);
    c.onSongChange("spotify:track:A", PLAYING);
    await vi.advanceTimersByTimeAsync(0);

    c.onPlayPause({ progressMs: 0, isPlaying: false });
    video.currentTime = 1;
    c.onPlayPause({ progressMs: 0, isPlaying: true });
    vi.advanceTimersByTime(2_000);
    expect(video.currentTime).toBe(0); // beat timer fired after resume
  });

  it("coalesces progress events: normal ticks keep state, seeks resync once", async () => {
    const c = makeController(() =>
      Promise.resolve({ tempoBpm: 135.48, beats: [{ start: 30 }] })
    );
    const video = fakeVideo();
    c.setVideo(video);
    c.onSongChange("spotify:track:A", PLAYING);
    await vi.advanceTimersByTimeAsync(0);
    expect(vi.getTimerCount()).toBe(1); // one pending beat timer

    c.onProgress({ progressMs: 1_000, isPlaying: true });
    c.onProgress({ progressMs: 1_250, isPlaying: true });
    c.onProgress({ progressMs: 1_500, isPlaying: true });
    expect(vi.getTimerCount()).toBe(1); // ticks did not pile up timers

    c.onProgress({ progressMs: 40_000, isPlaying: true }); // seek past every known beat
    expect(vi.getTimerCount()).toBe(0); // stale beat timer dropped, none scheduled
  });

  it("seek with no upcoming beat restarts the loop aligned at zero", async () => {
    const c = makeController(() => Promise.resolve(null)); // no beats available
    const video = fakeVideo();
    video.currentTime = 3;
    c.setVideo(video);

    c.onProgress({ progressMs: 40_000, isPlaying: true });
    expect(video.currentTime).toBe(0);
    expect(video.play).toHaveBeenCalled();
  });

  it("falls back safely when analysis is unavailable", async () => {
    const c = makeController(() => Promise.resolve(null));
    const video = fakeVideo();
    c.setVideo(video);

    c.onSongChange("spotify:track:A", PLAYING);
    await vi.advanceTimersByTimeAsync(0);
    expect(video.playbackRate).toBeCloseTo(1);
    expect(video.play).toHaveBeenCalled(); // cat keeps dancing without analysis
  });

  it("safePlay swallows play() rejections", async () => {
    const c = makeController(() => Promise.resolve({ tempoBpm: 135.48 }));
    const video = fakeVideo();
    video.play.mockRejectedValue(new Error("NotAllowedError"));
    c.setVideo(video);

    c.onSongChange("spotify:track:A", PLAYING);
    await vi.advanceTimersByTimeAsync(0); // no unhandled rejection escapes
    expect(video.play).toHaveBeenCalled();
  });

  it("feeds the pulse the felt tempo and danceability-scaled depth", async () => {
    const pulse = { attach: vi.fn(), setTrack: vi.fn(), setOnsets: vi.fn(), setMirrorOnsets: vi.fn(), setSyllableFrames: vi.fn(), setFrames: vi.fn(), setLoudness: vi.fn(), setConfig: vi.fn(), setPosition: vi.fn(), setMirror: vi.fn(), setPlaying: vi.fn(), stop: vi.fn() };
    const c = new CatJamController({
      getConfig: () => CONFIG,
      fetchAnalysis: () => Promise.resolve({ tempoBpm: 120, danceability: 0.9, energy: 0.7 }),
      pulse,
    });
    c.setVideo(fakeVideo());

    c.onSongChange("spotify:track:A", PLAYING);
    await vi.advanceTimersByTimeAsync(0);

    // depthFromStats(0.9, 0.7) = 0.75*0.9 + 0.25*0.7 = 0.85; felt tempo = 120 (< 150).
    const [bpm, depth] = pulse.setTrack.mock.lastCall!;
    expect(bpm).toBeCloseTo(120);
    expect(depth).toBeCloseTo(0.85);
  });

  it("rests the pulse (depth 0) for non-track uris", async () => {
    const pulse = { attach: vi.fn(), setTrack: vi.fn(), setOnsets: vi.fn(), setMirrorOnsets: vi.fn(), setSyllableFrames: vi.fn(), setFrames: vi.fn(), setLoudness: vi.fn(), setConfig: vi.fn(), setPosition: vi.fn(), setMirror: vi.fn(), setPlaying: vi.fn(), stop: vi.fn() };
    const c = new CatJamController({
      getConfig: () => CONFIG,
      fetchAnalysis: () => Promise.resolve({ tempoBpm: 120, danceability: 0.9 }),
      pulse,
    });
    c.setVideo(fakeVideo());

    c.onSongChange(undefined, PLAYING); // podcast / local file / nothing playing
    expect(pulse.setTrack).toHaveBeenLastCalledWith(undefined, 0, 0);
  });

  it("passes the manual sync delay through to the pulse", async () => {
    const pulse = { attach: vi.fn(), setTrack: vi.fn(), setOnsets: vi.fn(), setMirrorOnsets: vi.fn(), setSyllableFrames: vi.fn(), setFrames: vi.fn(), setLoudness: vi.fn(), setConfig: vi.fn(), setPosition: vi.fn(), setMirror: vi.fn(), setPlaying: vi.fn(), stop: vi.fn() };
    const c = new CatJamController({
      getConfig: () => CONFIG,
      fetchAnalysis: () => Promise.resolve({ tempoBpm: 120 }),
      getDelayMs: () => 90,
      pulse,
    });
    c.setVideo(fakeVideo());
    c.onSongChange("spotify:track:A", PLAYING);
    await vi.advanceTimersByTimeAsync(0);
    expect(pulse.setTrack.mock.lastCall![2]).toBe(90); // delay ms is the 3rd arg
  });

  it("applies fetched onsets to the pulse, guarding against a stale track", async () => {
    const pulse = { attach: vi.fn(), setTrack: vi.fn(), setOnsets: vi.fn(), setMirrorOnsets: vi.fn(), setSyllableFrames: vi.fn(), setFrames: vi.fn(), setLoudness: vi.fn(), setConfig: vi.fn(), setPosition: vi.fn(), setMirror: vi.fn(), setPlaying: vi.fn(), stop: vi.fn() };
    const pendingA = deferred<{ start: number }[] | null>();
    const c = new CatJamController({
      getConfig: () => CONFIG,
      fetchAnalysis: () => Promise.resolve({ tempoBpm: 120 }),
      pulse,
      fetchOnsets: (uri) =>
        uri === "spotify:track:A" ? pendingA.promise : Promise.resolve([{ start: 10 }, { start: 20 }]),
    });
    c.setVideo(fakeVideo());

    c.onSongChange("spotify:track:A", PLAYING);
    c.onSongChange("spotify:track:B", PLAYING); // switch before A's onsets resolve
    await vi.advanceTimersByTimeAsync(0);
    expect(pulse.setOnsets).toHaveBeenLastCalledWith([{ start: 10 }, { start: 20 }]); // B's

    pulse.setOnsets.mockClear();
    pendingA.resolve([{ start: 999 }, { start: 1000 }]); // late result for the OLD track
    await vi.advanceTimersByTimeAsync(0);
    expect(pulse.setOnsets).not.toHaveBeenCalled(); // stale A dropped
  });

  it("feeds background onsets to the MIRROR cat, clearing them on each song change", async () => {
    const pulse = { attach: vi.fn(), setTrack: vi.fn(), setOnsets: vi.fn(), setMirrorOnsets: vi.fn(), setSyllableFrames: vi.fn(), setFrames: vi.fn(), setLoudness: vi.fn(), setConfig: vi.fn(), setPosition: vi.fn(), setMirror: vi.fn(), setPlaying: vi.fn(), stop: vi.fn() };
    const c = new CatJamController({
      getConfig: () => CONFIG,
      fetchAnalysis: () => Promise.resolve({ tempoBpm: 120 }),
      pulse,
      fetchOnsets: () => Promise.resolve([{ start: 10 }]),
      fetchSecondaryOnsets: () => Promise.resolve([{ start: 50 }, { start: 90 }]),
    });
    c.setVideo(fakeVideo());

    c.onSongChange("spotify:track:A", PLAYING);
    expect(pulse.setMirrorOnsets).toHaveBeenCalledWith(null); // cleared synchronously first
    await vi.advanceTimersByTimeAsync(0);
    expect(pulse.setMirrorOnsets).toHaveBeenLastCalledWith([{ start: 50 }, { start: 90 }]); // the bg onsets
  });

  it("no-ops safely without a mounted video", async () => {
    const c = makeController(() => Promise.resolve({ tempoBpm: 180 }));
    expect(() => {
      c.onSongChange("spotify:track:A", PLAYING);
      c.onPlayPause(PLAYING);
      c.onProgress(PLAYING);
    }).not.toThrow();
    await vi.advanceTimersByTimeAsync(0);
  });
});

import { singleFlight } from "./controller";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe("singleFlight", () => {
  afterEach(() => vi.useRealTimers());

  it("concurrent calls share one invocation", async () => {
    let calls = 0;
    const mount = singleFlight(async () => {
      calls++;
      await sleep(10);
      return "video";
    });
    const [a, b] = [mount(), mount()];
    expect(calls).toBe(1);
    expect(await a).toBe("video");
    expect(await b).toBe("video");
  });

  it("allows a new invocation after settling", async () => {
    let calls = 0;
    const mount = singleFlight(async () => {
      calls++;
      return calls;
    });
    await mount();
    expect(await mount()).toBe(2);
  });

  it("re-arms after rejection", async () => {
    let fail = true;
    const mount = singleFlight(async () => {
      if (fail) throw new Error("boom");
      return "ok";
    });
    await expect(mount()).rejects.toThrow("boom");
    fail = false;
    expect(await mount()).toBe("ok");
  });
});
