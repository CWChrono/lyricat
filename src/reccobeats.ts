import { AnalysisResult } from "./controller";

// Spotify removed its own audio-analysis / audio-features endpoints in Nov 2024
// (getAudioData now fails with "Resolver not found"). ReccoBeats is a free,
// Spotify-shaped stand-in: it takes a Spotify track id directly and returns
// tempo (plus other features). It has no per-beat timestamps, so we get rate
// sync but not beat-phase alignment — the controller handles absent beats.
const AUDIO_FEATURES_ENDPOINT = "https://api.reccobeats.com/v1/audio-features";
const ANALYSIS_ENDPOINT = "https://api.reccobeats.com/v1/analysis/audio-features";

/** Minimal shape of the Fetch API we depend on (injected so it can be tested). */
export type FetchLike = (
  url: string
) => Promise<{ ok: boolean; status: number; json(): Promise<unknown> }>;

/** Pull the base-62 id out of a `spotify:track:<id>` uri; null for anything else. */
export function spotifyIdFromUri(uri: string | undefined): string | null {
  if (!uri) return null;
  const [scheme, kind, id] = uri.split(":");
  return scheme === "spotify" && kind === "track" && id ? id : null;
}

/** Extract a usable BPM from a ReccoBeats audio-features response, else null. */
export function parseTempo(body: unknown): number | null {
  const tempo = (body as { content?: Array<{ tempo?: unknown }> })?.content?.[0]?.tempo;
  return typeof tempo === "number" && Number.isFinite(tempo) && tempo > 0 ? tempo : null;
}

/** Read a normalized [0,1] feature (danceability/energy) from a features response. */
export function parseFeature(body: unknown, key: "danceability" | "energy"): number | undefined {
  const v = (body as { content?: Array<Record<string, unknown>> })?.content?.[0]?.[key];
  return typeof v === "number" && Number.isFinite(v) && v >= 0 && v <= 1 ? v : undefined;
}

/** Assemble an AnalysisResult from a features response, attaching stats when present. */
function toAnalysis(body: unknown, tempoBpm: number): AnalysisResult {
  const result: AnalysisResult = { tempoBpm };
  const danceability = parseFeature(body, "danceability");
  const energy = parseFeature(body, "energy");
  if (danceability !== undefined) result.danceability = danceability;
  if (energy !== undefined) result.energy = energy;
  return result;
}

/**
 * Builds the `fetchAnalysis(uri)` the controller depends on, backed by
 * ReccoBeats. Definitive answers — a tempo, or a "server answered but the track
 * isn't in its DB" miss — are cached per uri so replays and seeks don't refetch.
 * Transient failures (network error, 5xx) are left uncached so a later play retries.
 */
export function createAnalysisFetcher(
  fetchFn: FetchLike,
  sleep: (ms: number) => Promise<void>,
  attempts = 3
): (uri: string) => Promise<AnalysisResult | null> {
  const cache = new Map<string, AnalysisResult | null>();

  return async (uri: string): Promise<AnalysisResult | null> => {
    if (cache.has(uri)) return cache.get(uri) ?? null;

    const id = spotifyIdFromUri(uri);
    if (!id) return null; // podcasts, local files, etc. — no tempo to fetch

    const url = `${AUDIO_FEATURES_ENDPOINT}?ids=${encodeURIComponent(id)}`;
    for (let attempt = 0; attempt < attempts; attempt++) {
      try {
        const res = await fetchFn(url);
        if (res.ok) {
          const body = await res.json();
          const tempo = parseTempo(body);
          const result = tempo !== null ? toAnalysis(body, tempo) : null;
          cache.set(uri, result); // definitive
          return result;
        }
        if (res.status < 500) {
          cache.set(uri, null); // 4xx (bad id / not found): don't hammer
          return null;
        }
        // 5xx: fall through and retry
      } catch {
        // network error: fall through and retry
      }
      await sleep(200);
    }
    return null; // transient failure — uncached, a future play may succeed
  };
}

// --- Preview-based fallback -------------------------------------------------
// When ReccoBeats has no id-keyed features for a track, its tempo can still be
// derived by uploading audio to the analysis endpoint. The only non-DRM audio
// available is Spotify's 30s preview clip, found on the public embed page.

/** Pull the preview mp3 url out of a track's embed page HTML, else null. */
export function parsePreviewUrl(embedHtml: string): string | null {
  const field = embedHtml.match(/"audioPreview":\s*\{\s*"url":\s*"([^"]+)"/);
  if (field) return field[1];
  const bare = embedHtml.match(/https:\/\/p\.scdn\.co\/mp3-preview\/[A-Za-z0-9]+/);
  return bare ? bare[0] : null;
}

/** Extract a usable tempo from the analysis endpoint's (flat) response. */
export function parseAnalysisTempo(body: unknown): number | null {
  const tempo = (body as { tempo?: unknown })?.tempo;
  return typeof tempo === "number" && Number.isFinite(tempo) && tempo > 0 ? tempo : null;
}

/** Transports for the preview fallback, injected so the flow stays testable. */
export interface PreviewDeps {
  /** Resolve a track's preview mp3 url (client metadata, embed page, etc.). */
  getPreviewUrl(id: string): Promise<string | null>;
  /** GET the preview bytes (p.scdn.co allows CORS, so plain fetch works). */
  fetchBlob(url: string): Promise<Blob>;
  /** POST the multipart form to the analysis endpoint, returning parsed JSON. */
  postForm(url: string, form: FormData): Promise<unknown>;
}

/**
 * Resolve a track's tempo by analysing its 30s preview clip. The audio is used
 * only for the request and never stored: the Blob is passed straight into the
 * upload and discarded (no object URL, no caching). Returns null if the track
 * has no preview or the analysis fails; each failing stage is logged so the
 * hop that breaks in-app is visible in the console.
 */
export async function fetchTempoViaPreview(
  id: string,
  deps: PreviewDeps
): Promise<number | null> {
  try {
    const previewUrl = await deps.getPreviewUrl(id);
    if (!previewUrl) {
      console.warn(`[CAT-JAM] preview analysis: no preview url for ${id}`);
      return null;
    }
    const audio = await deps.fetchBlob(previewUrl);
    const form = new FormData();
    form.append("audioFile", audio, "preview.mp3");
    const tempo = parseAnalysisTempo(await deps.postForm(ANALYSIS_ENDPOINT, form));
    if (tempo === null) console.warn(`[CAT-JAM] preview analysis: no tempo returned for ${id}`);
    return tempo;
  } catch (err) {
    console.warn(`[CAT-JAM] preview analysis failed for ${id}:`, err);
    return null;
  }
}
