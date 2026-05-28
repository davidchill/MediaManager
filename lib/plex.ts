const PLEX_URL = process.env.PLEX_URL || 'http://localhost:32400';
const PLEX_TOKEN = process.env.PLEX_TOKEN;
const PLEX_CLOUD_URL = 'https://metadata.provider.plex.tv';

/** Local Plex requests can stall indefinitely if the server is mid-scan or a
 *  worker thread is wedged. Cap the wait so a stuck Plex turns into a clear
 *  error instead of a permanent server hang. */
const PLEX_LOCAL_TIMEOUT_MS = 60_000;
/** Cloud lookups go over the public internet; shorter ceiling since each call
 *  is small and we'd rather skip a movie than block the whole sync. */
const PLEX_CLOUD_TIMEOUT_MS = 30_000;

export interface PlexLibrary {
  key: string;
  title: string;
  type: string;
}

export interface PlexMovie {
  ratingKey: string;
  title: string;
  year?: number;
  /** Singular GUID. For modern Plex Movie agent: "plex://movie/<hash>". For
   *  legacy agents: e.g. "com.plexapp.agents.imdb://tt0115433?lang=en". */
  guid?: string;
  /** External-ID array (imdb / tmdb / tvdb). Often null in local bulk responses
   *  even with includeGuids=1; the new agent stores externals in Plex cloud. */
  Guid?: { id: string }[];
  addedAt?: number;
  updatedAt?: number;
  Media?: {
    videoResolution?: string;
    videoCodec?: string;
    Part?: { file: string; size: number }[];
  }[];
}

async function plexFetch<T>(pathAndQuery: string): Promise<T> {
  if (!PLEX_TOKEN) {
    throw new Error('PLEX_TOKEN is not set. Add it to site/.env.local.');
  }
  const url = `${PLEX_URL.replace(/\/$/, '')}${pathAndQuery}`;
  try {
    const res = await fetch(url, {
      headers: {
        'X-Plex-Token': PLEX_TOKEN,
        Accept: 'application/json',
      },
      cache: 'no-store',
      signal: AbortSignal.timeout(PLEX_LOCAL_TIMEOUT_MS),
    });
    if (!res.ok) {
      throw new Error(`Plex request failed (${res.status} ${res.statusText}) for ${pathAndQuery}`);
    }
    return (await res.json()) as T;
  } catch (e) {
    // AbortSignal.timeout throws a DOMException with name 'TimeoutError'.
    if (e instanceof DOMException && e.name === 'TimeoutError') {
      throw new Error(
        `Plex request timed out after ${PLEX_LOCAL_TIMEOUT_MS / 1000}s for ${pathAndQuery}. Plex may be mid-scan or unresponsive.`
      );
    }
    throw e;
  }
}

/** Like plexFetch, but for endpoints that return an empty body (scan triggers
 *  and cancels). Also supports DELETE for /library/sections/.../refresh. */
async function plexCommand(
  pathAndQuery: string,
  method: 'GET' | 'DELETE' = 'GET'
): Promise<void> {
  if (!PLEX_TOKEN) {
    throw new Error('PLEX_TOKEN is not set. Add it to site/.env.local.');
  }
  const url = `${PLEX_URL.replace(/\/$/, '')}${pathAndQuery}`;
  try {
    const res = await fetch(url, {
      method,
      headers: {
        'X-Plex-Token': PLEX_TOKEN,
        Accept: 'application/json',
      },
      cache: 'no-store',
      signal: AbortSignal.timeout(PLEX_LOCAL_TIMEOUT_MS),
    });
    if (!res.ok) {
      throw new Error(
        `Plex ${method} failed (${res.status} ${res.statusText}) for ${pathAndQuery}`
      );
    }
    // Drain so the connection can close cleanly even if Plex sent bytes.
    await res.arrayBuffer();
  } catch (e) {
    if (e instanceof DOMException && e.name === 'TimeoutError') {
      throw new Error(
        `Plex ${method} timed out after ${PLEX_LOCAL_TIMEOUT_MS / 1000}s for ${pathAndQuery}.`
      );
    }
    throw e;
  }
}

export async function listMovieLibraries(): Promise<PlexLibrary[]> {
  const data = await plexFetch<{ MediaContainer: { Directory?: PlexLibrary[] } }>('/library/sections');
  const dirs = data.MediaContainer.Directory ?? [];
  return dirs.filter((d) => d.type === 'movie');
}

export async function listMovies(sectionKey: string): Promise<PlexMovie[]> {
  const data = await plexFetch<{ MediaContainer: { Metadata?: PlexMovie[] } }>(
    `/library/sections/${encodeURIComponent(sectionKey)}/all?includeGuids=1`
  );
  return data.MediaContainer.Metadata ?? [];
}

/** Reads the new-agent external-ID array; usually empty in local responses. */
export function extractImdbId(movie: PlexMovie): string | null {
  if (!movie.Guid) return null;
  for (const g of movie.Guid) {
    if (g.id?.startsWith('imdb://')) return g.id.slice('imdb://'.length);
  }
  return null;
}

/** Pulls an IMDb ID directly out of a legacy-agent singular guid, if present.
 *  Example: "com.plexapp.agents.imdb://tt0115433?lang=en" -> "tt0115433". */
export function extractLegacyImdbId(movie: PlexMovie): string | null {
  if (!movie.guid) return null;
  const m = /^com\.plexapp\.agents\.imdb:\/\/(tt\d+)/.exec(movie.guid);
  return m ? m[1] : null;
}

/** Pulls the cloud hash out of a new-agent singular guid, if present.
 *  Example: "plex://movie/5d9f34ffb0262f001f6e9703" -> the hex hash. */
export function extractPlexCloudHash(movie: PlexMovie): string | null {
  if (!movie.guid) return null;
  const m = /^plex:\/\/movie\/([0-9a-f]+)/.exec(movie.guid);
  return m ? m[1] : null;
}

export interface CloudGuids {
  imdb: string | null;
  tmdb: string | null;
  tvdb: string | null;
}

/** Hits Plex's cloud metadata service to resolve external IDs for a movie
 *  whose local Guid[] array is empty. The new Plex Movie agent stores
 *  external IDs in the cloud, not locally — this is the canonical way to
 *  recover them. Returns { imdb: null, ... } on a 404. */
export async function lookupCloudGuids(hash: string): Promise<CloudGuids> {
  if (!PLEX_TOKEN) {
    throw new Error('PLEX_TOKEN is not set. Add it to site/.env.local.');
  }
  const url = `${PLEX_CLOUD_URL}/library/metadata/${encodeURIComponent(hash)}`;
  let res: Response;
  try {
    res = await fetch(url, {
      headers: { 'X-Plex-Token': PLEX_TOKEN, Accept: 'application/json' },
      cache: 'no-store',
      signal: AbortSignal.timeout(PLEX_CLOUD_TIMEOUT_MS),
    });
  } catch (e) {
    if (e instanceof DOMException && e.name === 'TimeoutError') {
      throw new Error(
        `Plex cloud lookup timed out after ${PLEX_CLOUD_TIMEOUT_MS / 1000}s for hash ${hash}.`
      );
    }
    throw e;
  }
  if (res.status === 404) return { imdb: null, tmdb: null, tvdb: null };
  if (!res.ok) {
    throw new Error(`Plex cloud lookup failed (${res.status} ${res.statusText}) for hash ${hash}`);
  }
  const data = (await res.json()) as {
    MediaContainer?: { Metadata?: Array<{ Guid?: Array<{ id: string }> }> };
  };
  const guids = data.MediaContainer?.Metadata?.[0]?.Guid ?? [];
  const result: CloudGuids = { imdb: null, tmdb: null, tvdb: null };
  for (const g of guids) {
    if (g.id.startsWith('imdb://')) result.imdb = g.id.slice('imdb://'.length);
    else if (g.id.startsWith('tmdb://')) result.tmdb = g.id.slice('tmdb://'.length);
    else if (g.id.startsWith('tvdb://')) result.tvdb = g.id.slice('tvdb://'.length);
  }
  return result;
}

export function getFirstPart(movie: PlexMovie): { file: string; size: number } | null {
  const part = movie.Media?.[0]?.Part?.[0];
  if (!part?.file) return null;
  return { file: part.file, size: part.size ?? 0 };
}

export function isWebrip(filePath: string): boolean {
  return /webrip/i.test(filePath);
}

// ---------------------------------------------------------------------------
// Plex activity status (for the dashboard's "is Plex busy?" indicator).
// ---------------------------------------------------------------------------

export interface PlexActivity {
  uuid: string;
  type: string;            // e.g. "library.update.section", "library.refresh.items"
  cancellable: boolean;
  title: string;           // e.g. "Updating Library"
  subtitle?: string;       // e.g. "Movies"
  progress?: number;       // 0–100
  Context?: {
    librarySectionID?: string;
    [k: string]: unknown;
  };
}

/** Fetches in-flight Plex activities. Short timeout so a busy Plex doesn't
 *  block the polling loop. Returns [] on any error (caller decides what to do). */
export async function getActivities(): Promise<PlexActivity[]> {
  const data = await plexFetch<{ MediaContainer: { Activity?: PlexActivity[] } }>('/activities');
  return data.MediaContainer.Activity ?? [];
}

/** Set of section IDs that are movie libraries — used to filter activities
 *  down to "things that affect our sync." */
export async function getMovieLibrarySectionIds(): Promise<Set<string>> {
  const libs = await listMovieLibraries();
  return new Set(libs.map((l) => l.key));
}

/** True when the activity is a scan/refresh against one of our movie libraries.
 *  Filters out unrelated tasks (transcoding, deep analysis on other libraries,
 *  subscription processing, etc.). */
export function isMovieLibraryActivity(
  activity: PlexActivity,
  movieSectionIds: Set<string>
): boolean {
  // Only consider library-scoped tasks.
  if (!activity.type.startsWith('library.')) return false;
  const sectionId = activity.Context?.librarySectionID;
  if (!sectionId) return false;
  return movieSectionIds.has(sectionId);
}

/** Triggers a (normal) scan on the given library section. Force mode re-reads
 *  every file's metadata, useful for testing but otherwise unnecessary. */
export async function startLibraryScan(sectionKey: string, force = false): Promise<void> {
  const q = force ? '?force=1' : '';
  await plexCommand(`/library/sections/${encodeURIComponent(sectionKey)}/refresh${q}`);
}

/** Cancels any in-flight or queued scan on the given library section. Plex's
 *  DELETE-on-refresh endpoint covers both. */
export async function cancelLibraryScan(sectionKey: string): Promise<void> {
  await plexCommand(
    `/library/sections/${encodeURIComponent(sectionKey)}/refresh`,
    'DELETE'
  );
}
