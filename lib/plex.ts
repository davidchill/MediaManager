const PLEX_URL = process.env.PLEX_URL || 'http://localhost:32400';
const PLEX_TOKEN = process.env.PLEX_TOKEN;

export interface PlexLibrary {
  key: string;
  title: string;
  type: string;
}

export interface PlexMovie {
  ratingKey: string;
  title: string;
  year?: number;
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

export function extractImdbId(movie: PlexMovie): string | null {
  if (!movie.Guid) return null;
  for (const g of movie.Guid) {
    if (g.id?.startsWith('imdb://')) return g.id.slice('imdb://'.length);
  }
  return null;
}

export function getFirstPart(movie: PlexMovie): { file: string; size: number } | null {
  const part = movie.Media?.[0]?.Part?.[0];
  if (!part?.file) return null;
  return { file: part.file, size: part.size ?? 0 };
}

export function isWebrip(filePath: string): boolean {
  return /webrip/i.test(filePath);
}
