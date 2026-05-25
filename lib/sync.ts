import { getDb } from './db';
import {
  listMovieLibraries,
  listMovies,
  extractImdbId,
  getFirstPart,
  isWebrip,
} from './plex';

export interface SyncResult {
  librariesScanned: number;
  totalScanned: number;
  webripCount: number;
}

export async function runSync(): Promise<SyncResult> {
  const db = getDb();
  const now = Date.now();
  const libraries = await listMovieLibraries();

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
      imdb_id = excluded.imdb_id,
      file_path = excluded.file_path,
      file_name = excluded.file_name,
      resolution = excluded.resolution,
      video_codec = excluded.video_codec,
      file_size = excluded.file_size,
      plex_added_at = excluded.plex_added_at,
      plex_updated_at = excluded.plex_updated_at,
      last_synced_at = excluded.last_synced_at
  `);

  let totalScanned = 0;
  let webripCount = 0;

  for (const lib of libraries) {
    const movies = await listMovies(lib.key);
    for (const m of movies) {
      totalScanned++;
      const part = getFirstPart(m);
      if (!part) continue;
      if (!isWebrip(part.file)) continue;
      webripCount++;
      const fileName = part.file.split(/[\\/]/).pop() ?? part.file;
      upsert.run({
        plex_rating_key: m.ratingKey,
        title: m.title,
        year: m.year ?? null,
        imdb_id: extractImdbId(m),
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

  return { librariesScanned: libraries.length, totalScanned, webripCount };
}
