# 🐱 Lyricat

![preview](marketplace/preview.gif)

A **Bongo Cat** (or **Pop Cat**) that pops along to your music — on the **beat**, or word-by-word with the **lyrics** — plus a word-timed **lyric editor**, built-in **romanization**, and **Google Drive cloud sync**. A Spicetify extension.

> ⚙ Open **Lyricat** from the sidebar link / topbar button. Settings and a **Lyricat Library** panel (per-song controls, the lyric editor, and cloud sync) live there.

## Features 🎛️

### 🎵 The cat pops on the lyrics
- **Word-timed sync** — instead of only bouncing on the beat, the cat pops its mouth **per word / syllable**, in time with the vocals.
- **Lyric source chain** — onsets resolve down a cascade and are cached per track:
  1. **[Spicy Lyrics](https://github.com/spikerko/spicy-lyrics)** — word-synced lyrics (best)
  2. **[LRCLIB](https://lrclib.net)** — free, no-auth line-synced lyrics
  3. **Heuristic** — syllable estimation spread across each line's play time
- **Loudness onsets** — taps Spotify's own internal audio-analysis (the desktop client's authenticated channel) to time pops to the actual loudness envelope, and to drive the pulse.
- **Next-track prefetch** — the upcoming song's analysis + onsets are warmed so skips stay in sync instantly.

### 🐾 Cats & motion
- **Bongo Cat** (default), the classic **Cat Jam**, a frame-animated **Pop Cat**, or a **custom webM URL** — selectable per source.
- **Beat- & lyric-synced pulse** — the cat brightens and bounces, scaled by the track's danceability (dancier = punchier, chill = subtle). Brightness and bounce toggle independently with their own intensity.
- **Mirror cat** — an optional second, flipped cat mirrored across the play button; fully dynamic and flexes with the window.
- **Duet voices** — words can be routed to two voices (default **Mittens** / **Biscuit**, renameable per track) plus a background lane, so a line's lead and backing vocals can drive **two separate cats**.

### 🎹 Lyric editor
A built-in editor (open the **Advanced editor** from the Library panel) to make any song pop perfectly:
- **Word mode** — retime, split/merge, and assign each word's voice + background lane.
- **Line mode** — text-edit a whole line (type `/` or `-` to split CJK into singable units); timing is preserved where possible.
- **Plotting mode** — tap words into place against the playing track.
- **Upload raw lyrics** to start from scratch, **autosaves every 30s**, with undo/redo.
- **Export** — write word-timed **TTML** (Apple-style), or push edited lyrics straight into **Spicy Lyrics'** own library so they show in its panel (**Spicy Sync**).

### 🔤 Romanization
- **Built-in, bundled** romanization — **Korean** (Revised Romanization via [es-hangul](https://github.com/toss/es-hangul)) and **Chinese** (toneless pinyin via [pinyin-pro](https://github.com/zh-lx/pinyin-pro)) — synchronous, cached, no network.
- **Japanese** via a separate, crash-isolated companion extension ([kuroshiro](https://github.com/hexenq/kuroshiro) + [kuromoji](https://github.com/takuyaa/kuromoji.js)) that downloads its dictionary once (~10MB).
- **Romanize all** fills every word from the detected language; hand-tune afterward.

### 🥁 BPM detection
Multi-source, cascading, and cached per track with visible provenance (*"BPM from …"*), re-runnable from a per-song **Re-detect** menu:
1. **[ReccoBeats](https://reccobeats.com)** by Spotify id — Spotify's catalog tempo
2. **ReccoBeats by ISRC** — resolved via Spotify metadata or **[MusicBrainz](https://musicbrainz.org)**
3. **[GetSongBPM](https://getsongbpm.com/)** — optional, bring your own API key
4. **30s preview scan** — ReccoBeats analysis, as a last resort

Plus per-song **manual BPM override**, **double-time** toggle, **sync-delay** nudge, and position offsets — all remembered per track. Free-tier providers are kept under **daily rate-limit budgets** that survive restarts.

### ☁️ Cloud sync
- **Google Drive sync** of your settings, song library, and one browsable `.lrc` per saved song (hand-editable in Drive).
- Optional **daily auto-sync** (upload-only) plus manual **Upload ↑ / Download** with conflict detection and a backup on download.

## Install 📦

Not on the Marketplace — install the built extension manually:

1. Copy [`marketplace/cat-jam.js`](marketplace/cat-jam.js) into your Spicetify `Extensions` folder ([finding it](https://spicetify.app/docs/advanced-usage/extensions/)).
2. Enable and apply:
   ```bash
   spicetify config extensions cat-jam.js
   spicetify apply
   ```

Or build from source: `npm install && npm run build` (via [spicetify-creator](https://github.com/spicetify/spicetify-creator)).

## Optional setup 🔧

- **Word-synced lyrics** — install **[Spicy Lyrics](https://github.com/spikerko/spicy-lyrics)** for the best onset source (Lyricat falls back to LRCLIB / heuristics without it).
- **Japanese romanization** — enable the companion `catjam-ja-romanizer` extension (built alongside `cat-jam.js`) so Japanese tracks romanize; it's isolated on purpose so its dictionary can't crash the main extension.
- **Google Drive sync** — create a Desktop-app OAuth client, run `node drive-auth.mjs <client_id> <client_secret>` once to mint a refresh token, then paste the client id/secret/refresh-token + target folder id into the Library panel's sync section.

## Credits 🐈

- Original extension + cat video: **[BlafKing/spicetify-cat-jam-synced](https://github.com/BlafKing/spicetify-cat-jam-synced)**.
- Forked from **[caml07/spicetify-cat-jam-synced](https://github.com/caml07/spicetify-cat-jam-synced)** (modernized sync core, ReccoBeats tempo).
- Lyrics: **[Spicy Lyrics](https://github.com/spikerko/spicy-lyrics)** (word-synced source + panel integration) and **[LRCLIB](https://lrclib.net)** (open synced-lyrics database).
- Tempo & metadata: **[ReccoBeats](https://reccobeats.com)**, **[MusicBrainz](https://musicbrainz.org)**, and BPM data by **[GetSongBPM](https://getsongbpm.com/)**.
- Romanization: **[es-hangul](https://github.com/toss/es-hangul)** (Korean), **[pinyin-pro](https://github.com/zh-lx/pinyin-pro)** (Chinese), **[kuroshiro](https://github.com/hexenq/kuroshiro)** + **[kuromoji](https://github.com/takuyaa/kuromoji.js)** (Japanese).
- Built with **[spicetify-creator](https://github.com/spicetify/spicetify-creator)**.
- MIT licensed.

# Changelog 📋

<h3>Lyricat (this fork)</h3>

- **Word-timed lyric sync**: the cat pops per word/syllable, with onsets resolved Spicy Lyrics → LRCLIB → heuristic, timed against Spotify's internal audio-analysis loudness envelope, and cached + prefetched for instant skips.
- **Lyric editor**: a VSCode-style advanced panel (word / line / plotting modes) with raw-lyrics upload, undo/redo, autosave, duet-voice + background-lane assignment, TTML export, and write-back into Spicy Lyrics' own library.
- **Romanization**: bundled Korean (es-hangul) + Chinese (pinyin-pro), with Japanese handled by a separate crash-isolated extension (kuroshiro/kuromoji).
- **Pop Cat** source (frame-animated, pops per syllable) and a mirror cat that can sing the backing vocals.
- **Beat- & lyric-synced pulse**: brightens and bounces, scaled exponentially by danceability/energy; brightness and bounce toggle independently.
- **Google Drive cloud sync** of settings, song library, and per-song `.lrc` files.
- **More BPM sources with provenance**: ISRC fallback via Spotify metadata / MusicBrainz, optional GetSongBPM (user API key), per-provider daily rate limits, and a Re-detect menu.
- Performance + correctness: dirty-checked animator, resize/seek-aware clock, and a full unit-test suite.

<h3>v1.4.0</h3>

- Tempo now comes from [ReccoBeats](https://reccobeats.com) instead of `getAudioData` — Spotify removed its `audio-analysis` / `audio-features` endpoints in Nov 2024, which broke BPM sync entirely. ReccoBeats is keyed by Spotify track id, needs no API key, and requires no downgrade.
- Slow songs that beat detectors report at double-time (e.g. an 85 BPM track detected as 170) are folded back to the felt tempo, so the cat no longer jams twice as fast on them.
- Added a **Check BPM** button that reports the current song's detected tempo and the cat's resulting playback rate.
- Added a per-song **double-time** toggle to manually override the automatic detection; the choice is remembered per track.
- For tracks ReccoBeats doesn't have, BPM is recovered by analysing the 30s preview clip (uploaded to ReccoBeats' analysis endpoint, never stored) and cached per track.
- Added a per-song **manual sync delay** slider (0–500 ms) to nudge the cat into alignment; remembered per track.
- Added a **Bongo Cat** video option alongside the default cat and custom webM URL, selectable from a new source dropdown.

<h3>v1.3.0</h3>

- Rewritten synchronization core: a single controller owns track identity, audio analysis, beat timers and the video element.
- Fixed race where analysis of the previous song could override the current one (results are guarded by track generation).
- Pending beat timers are now cancelled on track change, pause and seek; progress events are coalesced so only real seeks resync.
- BPM sync now uses only the track's real tempo (`getAudioData`), clamped to half/double speed, with a safe fallback to normal speed when no analysis is available.
- Removed the deprecated Spotify `audio-features` endpoint and the danceability/energy based BPM methods (those two settings dropdowns are gone).
- Video autoplay/load errors are handled silently; the extension disables itself cleanly if Spotify's UI changes shape.
- Default webM asset is pinned to an immutable commit URL.

<h3>v1.2.5</h3>

- Added better BPM calculation for songs based on songs danceability and energy.
- Can be toggled from the settings.
- Fixed minor bugs.

<h3>v1.2.0</h3>

- Added ability to position and resize webM video to the left library.
- Changed "Reload" button label to a "Save and reload".

<h4>Dev changes </h4>

- Changed from npm to yarn.

<h3>v1.1</h3>

- Added ability to select custom webM link and default BPM in the spotify settings tab.

---

<h3>v1.0</h3>

- Initial release

---

## Made with Spicetify Creator

- https://github.com/spicetify/spicetify-creator
