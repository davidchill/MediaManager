import { getDb } from './db';
import {
  listMovieLibraries,
  listMovies,
  extractImdbId,
  extractLegacyImdbId,
  extractPlexCloudHash,
  getFirstPart,
  isWebrip,
  lookupCloudGuids,
  type PlexMovie,
} from './plex';

const CLOUD_REQUEST_DELAY_MS = 150;

export interface SyncResult {
  librariesScanned: number;
  totalScanned: number;
  webripCount: number;
  /** Movies we ran a cloud GUID lookup for (i.e. had no imdb_id yet). */
  cloudLookups: number;
  /** Of those, how many returned an IMDb ID. */
  cloudResolved: number;
  /** Of those, how many threw or returned no externals. */
  cloudFailures: number;
  /** Movies still missing an IMDb ID after the sync. */
  stillMissingImdb: number;
}

function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}

/** Resolves an IMDb ID for a Plex movie using the cheapest source first.
 *  Returns null if even the cloud lookup didn't find one. */
async function resolveImdbId(
  movie: PlexMovie,
  existingImdb: string | null
): Promise<{ imdb: string | null; didCloudLookup: boolean; cloudError: boolean }> {
  // 1. Already known in our DB.
  if (existingImdb) return { imdb: existingImdb, didCloudLookup: false, cloudError: false };

  // 2. New-agent Guid[] array on the local response (usually empty in practice).
  const fromArray = extractImdbId(movie);
  if (fromArray) return { imdb: fromArray, didCloudLookup: false, cloudError: false };

  // 3. Legacy agent guid string.
  const fromLegacy = extractLegacyImdbId(movie);
  if (fromLegacy) return { imdb: fromLegacy, didCloudLookup: false, cloudError: false };

  // 4. Plex cloud metadata service (the slow path).
  const hash = extractPlexCloudHash(movie);
  if (!hash) return { imdb: null, didCloudLookup: false, cloudError: false };

  try {
    const cloud = await lookupCloudGuids(hash);
    return { imdb: cloud.imdb, didCloudLookup: true, cloudError: false };
  } catch (e) {
    console.error(`Cloud lookup failed for ${movie.title} (${hash}):`, e);
    return { imdb: null, didCloudLookup: true, cloudError: true };
  }
}

export async function runSync(): Promise<SyncResult> {
  const db = getDb();
  const now = Date.now();
  const libraries = await listMovieLibraries();

  // Snapshot current imdb_id values so we can skip cloud lookups for movies
  // we've already resolved on a previous sync.
  const existingImdb = new Map<string, string | null>();
  const existingRows = db
    .prepare(`SELECT plex_rating_key, imdb_id FROM movies`)
    .all() as { plex_rating_key: string; imdb_id: string | null }[];
  for (const r of existingRows) existingImdb.set(r.plex_rating_key, r.imdb_id);

  const upsert = db.prepare(`
    INSERT INTO movies (
      plex_rating_key, title, year, imdb_id, file_path, file_name,
      resolution, video_codec, file_size, plex_added_at, plex_updated_at,
      first_seen_at, last_synced_at
    ) VALUES (
      @plex_rating_key, @title, @year, @imdb_id, @file_path, @file_name,
      @resolution, @video_codec, @file_size, @plex_added_at, @plex_updated_at,
      @first_seen_at, @last_synced_at
    )
    ON CONFLICT(plex_rating_key) DO UPDATE SET
      title = excluded.title,
      year = excluded.year,
      imdb_id = COALESCE(excluded.imdb_id, movies.imdb_id),
      file_path = excluded.file_path,
      file_name = excluded.file_name,
      resolution = excluded.resolution,
      video_codec = excluded.video_codec,
      file_size = excluded.file_size,
      plex_added_at = excluded.plex_added_at,
      plex_updated_at = excluded.plex_updated_at,
      last_synced_at = excluded.last_synced_at
  `);

  const result: SyncResult = {
    librariesScanned: libraries.length,
    totalScanned: 0,
    webripCount: 0,
    cloudLookups: 0,
    cloudResolved: 0,
    cloudFailures: 0,
    stillMissingImdb: 0,
  };

  for (const lib of libraries) {
    const movies = await listMovies(lib.key);
    for (const m of movies) {
      result.totalScanned++;
      const part = getFirstPart(m);
      if (!part) continue;
      if (!isWebrip(part.file)) continue;
      result.webripCount++;

      const known = existingImdb.get(m.ratingKey) ?? null;
      const resolution = await resolveImdbId(m, known);
      if (resolution.didCloudLookup) {
        result.cloudLookups++;
        if (resolution.cloudError) result.cloudFailures++;
        else if (resolution.imdb) result.cloudResolved++;
        // Be polite to Plex's cloud service.
        await sleep(CLOUD_REQUEST_DELAY_MS);
      }
      if (!resolution.imdb) result.stillMissingImdb++;

      const fileName = part.file.split(/[\\/]/).pop() ?? part.file;
      upsert.run({
        plex_rating_key: m.ratingKey,
        title: m.title,
        year: m.year ?? null,
        imdb_id: resolution.imdb,
        file_path: part.file,
        file_name: fileName,
        resolution: m.Media?.[0]?.videoResolution ?? null,
        video_codec: m.Media?.[0]?.videoCodec ?? null,
        file_size: part.size || null,
        plex_added_at: m.addedAt ?? null,
        plex_updated_at: m.updatedAt ?? null,
        first_seen_at: now,
        last_synced_at: now,
      });
    }
  }

  return result;
}
