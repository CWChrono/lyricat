# Cloud Sync — working notes & known limitations

> **Status:** temporary documentation (as of 2026-10-12). Describes how Drive sync behaves today,
> the multi-machine gotchas, and one known bug. Delete/supersede once the merge model is hardened.

## What it does
Mirrors your Cat-Jam data to **one Google Drive folder**:

```
<your Drive folder>/
  catjam-sync.json                                  ← settings + library (overrides + stars)
  lyrics/
    lrc/                                            ← the editable source lyrics (round-tripped)
      starred/     Song - Artist [trackId].lrc
      bookmarked/  Song - Artist [trackId].lrc
      normal/      Song - Artist [trackId].lrc
    ttml/                                           ← derived Apple-style word-timed TTML (export-only)
      starred/     Song - Artist [trackId].ttml
      bookmarked/  …
      normal/      …
```

Each song is written in **both** formats: `.lrc` (the editable source, round-tripped) and `.ttml`
(a derived word-timed export, regenerated from the LRC — **not** read back on download). Within each
format, songs are filed by precedence **starred > bookmarked > normal**; a status change **moves**
both files between subfolders on the next upload. Legacy layouts (flat `lyrics/*.lrc` or
`lyrics/<category>/*.lrc`) are auto-migrated into `lyrics/lrc/<category>/`. Matching is always by the
`[trackId]` in the filename, so the folders are purely for browsing. Download pulls only the `.lrc`.

- **Daily auto-sync** is **upload-only** (startup + every 6h, once per UTC day). It never auto-overwrites local; if the cloud moved, it only flags it.
- **Upload ↑** force-pushes. **Download ↓** backs up local first, then pulls. **Restore backup** undoes the last download.
- Auth: Google Drive OAuth refresh token. On a personal account the token expires every 7 days unless the OAuth app's publishing status is "In production"; otherwise use the panel's **⟳ Re-authorize** link when sync reports an expired token.

## The merge model (important for multi-machine use)
Sync is **per-file for lyrics** and **whole-blob last-writer-wins for the library** — it is *not* a full merge engine.

| Data | How it syncs | Concurrent edits on different machines |
|---|---|---|
| **Lyrics** (`.lrc` per song) | Per-file, incremental (by content hash on upload, by Drive `modifiedTime` on download) | **Preserved** — a song unchanged in the cloud is skipped on download, so each machine's edits to *different* songs survive |
| **Library** (BPM, meter, delay, **bookmarks**, **stars**, track names) | One JSON blob, replaced wholesale | **Clobbered** — last machine to sync wins the entire blob; the other machine's library edits are lost |
| **Settings** | Per-field upsert | Cloud wins field-by-field; local-only settings survive |

### What this means concretely
- Edit **lyrics** for different songs on two machines → both survive and converge (with the caveat below).
- Edit **a bookmark / BPM / star** on machine B, then sync after machine A synced → **B's library change is reverted** (download) or **A's is clobbered** (upload). The library is effectively single-source.

## Recommended workflow (until the merge model is hardened)
1. **Upload before you Download** on each machine — push your local changes first, then pull others'. This keeps lyric edits converging and avoids the bug below.
2. **Make library edits (bookmarks / BPM / meter / stars) on one "primary" machine.** Treat other machines as read-mostly for library data, or you'll lose changes to last-writer-wins.
3. The onset cache is **not** synced (it rebuilds from the lyrics automatically).

## Known bug — un-uploaded lyric edits can get stuck
If you **Download while holding un-uploaded lyric edits**, the edited songs are preserved locally (good) but get marked "already synced" — so a later Upload won't push them. They stay on that machine and won't reach the cloud/other machines.

- **Avoid it:** Upload before you Download (step 1 above).
- **If you hit it (edit won't propagate):** either make a fresh edit to that song (new content → re-uploads), or clear the sync bookkeeping key `catjam-cloudsync-state` in localStorage (forces a full re-evaluation; next Upload re-pushes everything).

## Other notes
- **Lyric filenames** embed the track id (`Song - Artist [id].lrc`) so downloads map back reliably. Don't manually delete the `[id]` tag in Drive, or that file can't be matched on download.
- **Scales fine:** folder listing paginates (no 1000-file cap); daily upload only sends changed files; download only fetches changed/missing files.
- **Open runtime risk:** CORS from the Spotify renderer to `googleapis.com` is untested with live creds. If Upload throws a network/CORS error, the HTTP calls need routing through a fallback transport.
- **Credentials** (client id/secret/refresh token) live only in the Cat-Jam settings fields and are **never** included in the synced bundle, so a download can't wipe them.
