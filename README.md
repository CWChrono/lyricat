# 🐱 Lyricat

![preview](marketplace/preview.gif)

A Bongo Cat that jams next to your player **in sync with your music's BPM** — brightening and bouncing to the beat (or the lyrics). A Spicetify extension.

> ⚙ Settings live at the bottom of the regular Spotify settings, with a **Lyricat Library** panel below them for per-song BPM controls.

## Features 🎛️

- **Bongo Cat by default** — paws flapping in time with the beat. The classic Cat Jam and a custom webM URL are still selectable.
- **Beat- & lyric-synced pulse** — the cat brightens and bounces on the beat, scaled by the track's danceability (dancier = punchier, chill = subtle). With the [Spicy Lyrics](https://github.com/spikerko/spicy-lyrics) extension installed it can pulse per **syllable** instead of the beat.
- **Mirror cat** — an optional second, flipped cat mirrored across the play button; fully dynamic and flexes with the window.
- **Multi-source BPM detection**, cascading and cached per track with visible provenance (*"BPM from …"*):
  1. **ReccoBeats** by Spotify id — Spotify's catalog tempo
  2. **ReccoBeats by ISRC** — resolved via Spotify metadata or **MusicBrainz**
  3. **GetSongBPM** — optional, bring your own API key
  4. **30s preview scan** — ReccoBeats analysis, as a last resort

  Re-runnable from a per-song **Re-detect** menu.
- **Per-song controls** — manual BPM override, double-time toggle, sync-delay nudge, and position offsets, all remembered per track.

## Install 📦

Not on the Marketplace — install the built extension manually:

1. Copy [`marketplace/cat-jam.js`](marketplace/cat-jam.js) into your Spicetify `Extensions` folder ([finding it](https://spicetify.app/docs/advanced-usage/extensions/)).
2. Enable and apply:
   ```bash
   spicetify config extensions cat-jam.js
   spicetify apply
   ```

Or build from source: `npm install && npm run build` (via [spicetify-creator](https://github.com/spicetify/spicetify-creator)).

## Credits 🐈

- Original extension + cat video: **[BlafKing/spicetify-cat-jam-synced](https://github.com/BlafKing/spicetify-cat-jam-synced)**.
- Forked from **[caml07/spicetify-cat-jam-synced](https://github.com/caml07/spicetify-cat-jam-synced)** (modernized sync core, ReccoBeats tempo).
- Optional BPM data by **[GetSongBPM](https://getsongbpm.com/)**.
- MIT licensed.

# Changelog 📋

<h3>Lyricat (this fork)</h3>

- **Bongo Cat is now the default** video source.
- **Beat-synced pulse**: the cat brightens and bounces on the beat, scaled exponentially by danceability/energy; brightness and bounce toggle independently with their own intensity.
- **Lyric-synced pulse**: reads the [Spicy Lyrics](https://github.com/spikerko/spicy-lyrics) cache to pulse per syllable, with continuous polling so a cold track picks up sync mid-play; falls back to the beat when unavailable. When Spicy Lyrics is installed, its lyrics button replaces Spotify's.
- **Mirror cat**: an optional flipped clone mirrored across the play button, driven in lock-step (top-level overlay, so it never covers the player controls).
- **More BPM sources with provenance**: ISRC fallback via Spotify metadata / **MusicBrainz**, an optional **[GetSongBPM](https://getsongbpm.com/)** lookup (user API key), and a **Re-detect** menu to re-run a specific mechanism. Every detected value is saved tagged with where it came from and reused across plays.
- Performance + correctness: 30fps dirty-checked animator, resize/seek-aware clock, and a full unit-test suite.

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
