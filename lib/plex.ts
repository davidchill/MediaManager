const PLEX_URL = process.env.PLEX_URL || 'http://localhost:32400';
const PLEX_TOKEN = process.env.PLEX_TOKEN;
const PLEX_CLOUD_URL = 'https://metadata.provider.plex.tv';

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
  const res = await fetch(url, {
    headers: {
      'X-Plex-Token': PLEX_TOKEN,
      Accept: 'application/json',
    },
    cache: 'no-store',
  });
  if (!res.ok) {
    throw new Error(`Plex request failed (${res.status} ${res.statusText}) for ${pathAndQuery}`);
  }
  return res.json() as Promise<T>;
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
  const res = await fetch(url, {
    headers: { 'X-Plex-Token': PLEX_TOKEN, Accept: 'application/json' },
    cache: 'no-store',
  });
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
