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

/** Per-worker pause between Plex cloud lookups. With CLOUD_CONCURRENCY workers
 *  this averages well under Plex's tolerance. Tune via env if needed. */
const CLOUD_REQUEST_DELAY_MS = Number(process.env.PLEX_CLOUD_DELAY_MS) || 150;
/** Number of in-flight Plex cloud lookups. SQLite isn't touched in this phase,
 *  so this only governs network. */
const CLOUD_CONCURRENCY = Number(process.env.PLEX_CLOUD_CONCURRENCY) || 4;
/** Yield to the event loop every N scanned Plex movies so unrelated requests
 *  (UI navigation, /api/* polls) aren't starved while we work. */
const SCAN_YIELD_EVERY = 100;
/** Log a heartbeat every N scanned movies so a hung sync is diagnosable from
 *  the terminal — you can see exactly where it stopped. */
const SCAN_HEARTBEAT_EVERY = 250;
/** Phase 3 writes candidates in chunks of this size. Each chunk is one
 *  transaction (one fsync, fast) and chunk boundaries release references so
 *  GC can reclaim PlexMovie objects mid-write — keeps peak memory bounded. */
const UPSERT_CHUNK_SIZE = 200;
/** If a sync would remove more than this fraction of the DB, skip removal and
 *  flag it instead. Prevents a transient Plex outage from nuking everything. */
const REMOVAL_SAFETY_THRESHOLD = 0.3;

function logPhase(label: string, extra?: Record<string, unknown>) {
  const ts = new Date().toISOString().slice(11, 23); // HH:MM:SS.mmm
  if (extra && Object.keys(extra).length > 0) {
    console.log(`[sync ${ts}] ${label}`, extra);
  } else {
    console.log(`[sync ${ts}] ${label}`);
  }
}

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
  /** Rows deleted because the Plex item exists but is no longer a WEBRip
   *  (i.e. the user upgraded to BluRay / web-dl / something else). */
  removedUpgraded: number;
  /** Rows deleted because the Plex item is gone entirely. */
  removedDeleted: number;
  /** True when the safety threshold tripped and removal was skipped. */
  removalSkipped: boolean;
  /** How many rows WOULD have been removed when the safety guard tripped. */
  wouldHaveRemoved: number;
}

function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}

function yieldToEventLoop() {
  return new Promise<void>((r) => setImmediate(r));
}

interface Candidate {
  movie: PlexMovie;
  part: { file: string; size: number };
  /** IMDb already known in our DB; non-null means we can skip resolution. */
  existingImdb: string | null;
  /** Filled in during the resolve phase. */
  resolvedImdb: string | null;
  didCloudLookup: boolean;
  cloudError: boolean;
}

/** Resolves IMDb ID from the cheapest local sources. Returns the cloud hash
 *  to look up if none of the local sources hit. */
function resolveLocal(movie: PlexMovie, existing: string | null): {
  imdb: string | null;
  cloudHash: string | null;
} {
  if (existing) return { imdb: existing, cloudHash: null };
  const fromArray = extractImdbId(movie);
  if (fromArray) return { imdb: fromArray, cloudHash: null };
  const fromLegacy = extractLegacyImdbId(movie);
  if (fromLegacy) return { imdb: fromLegacy, cloudHash: null };
  return { imdb: null, cloudHash: extractPlexCloudHash(movie) };
}

export async function runSync(): Promise<SyncResult> {
  const startedAt = Date.now();
  logPhase('start');
  const db = getDb();
  const now = Date.now();
  logPhase('fetching Plex libraries');
  const libraries = await listMovieLibraries();
  logPhase('libraries fetched', { count: libraries.length });

  // Snapshot current imdb_id values so we can skip cloud lookups for movies
  // we've already resolved on a previous sync.
  const existingImdb = new Map<string, string | null>();
  const existingRows = db
    .prepare(`SELECT plex_rating_key, imdb_id FROM movies`)
    .all() as { plex_rating_key: string; imdb_id: string | null }[];
  for (const r of existingRows) existingImdb.set(r.plex_rating_key, r.imdb_id);

  const result: SyncResult = {
    librariesScanned: libraries.length,
    totalScanned: 0,
    webripCount: 0,
    cloudLookups: 0,
    cloudResolved: 0,
    cloudFailures: 0,
    stillMissingImdb: 0,
    removedUpgraded: 0,
    removedDeleted: 0,
    removalSkipped: false,
    wouldHaveRemoved: 0,
  };

  // Track which Plex items we encountered, so we can detect rows in our DB
  // that are no longer represented in Plex at all (deleted) or no longer
  // qualify as WEBRips (upgraded to a better source).
  const seenAnyKey = new Set<string>();
  const seenWebripKey = new Set<string>();

  // ---------------------------------------------------------------
  // Phase 1: scan Plex, collect WEBRip candidates. Yield periodically
  // so unrelated requests can interleave.
  // ---------------------------------------------------------------
  const candidates: Candidate[] = [];
  let sinceYield = 0;
  let sinceHeartbeat = 0;
  for (const lib of libraries) {
    logPhase(`fetching library "${lib.title}" (${lib.key})`);
    const movies = await listMovies(lib.key);
    logPhase(`library "${lib.title}" fetched`, { movies: movies.length });
    for (const m of movies) {
      result.totalScanned++;
      seenAnyKey.add(m.ratingKey);
      const part = getFirstPart(m);
      if (part && isWebrip(part.file)) {
        result.webripCount++;
        seenWebripKey.add(m.ratingKey);
        candidates.push({
          movie: m,
          part,
          existingImdb: existingImdb.get(m.ratingKey) ?? null,
          resolvedImdb: null,
          didCloudLookup: false,
          cloudError: false,
        });
      }
      if (++sinceYield >= SCAN_YIELD_EVERY) {
        sinceYield = 0;
        await yieldToEventLoop();
      }
      if (++sinceHeartbeat >= SCAN_HEARTBEAT_EVERY) {
        sinceHeartbeat = 0;
        logPhase('scan progress', {
          scanned: result.totalScanned,
          webrips: result.webripCount,
        });
      }
    }
  }
  logPhase('scan complete', {
    scanned: result.totalScanned,
    webrips: result.webripCount,
  });

  // ---------------------------------------------------------------
  // Phase 2: resolve IMDb IDs. Local sources are free; only cloud
  // lookups go through a worker pool.
  // ---------------------------------------------------------------
  const needsCloud: { candidate: Candidate; hash: string }[] = [];
  for (const c of candidates) {
    const local = resolveLocal(c.movie, c.existingImdb);
    if (local.imdb) {
      c.resolvedImdb = local.imdb;
    } else if (local.cloudHash) {
      needsCloud.push({ candidate: c, hash: local.cloudHash });
    }
  }

  logPhase('resolve phase', {
    candidates: candidates.length,
    needsCloud: needsCloud.length,
  });

  if (needsCloud.length > 0) {
    let cursor = 0;
    const worker = async () => {
      while (true) {
        const i = cursor++;
        if (i >= needsCloud.length) return;
        const { candidate, hash } = needsCloud[i];
        candidate.didCloudLookup = true;
        try {
          const cloud = await lookupCloudGuids(hash);
          candidate.resolvedImdb = cloud.imdb;
        } catch (e) {
          candidate.cloudError = true;
          console.error(`Cloud lookup failed for ${candidate.movie.title} (${hash}):`, e);
        }
        if (CLOUD_REQUEST_DELAY_MS > 0) await sleep(CLOUD_REQUEST_DELAY_MS);
      }
    };
    const poolSize = Math.min(CLOUD_CONCURRENCY, needsCloud.length);
    await Promise.all(Array.from({ length: poolSize }, () => worker()));
    logPhase('cloud lookups complete');
  }

  for (const c of candidates) {
    if (c.didCloudLookup) {
      result.cloudLookups++;
      if (c.cloudError) result.cloudFailures++;
      else if (c.resolvedImdb) result.cloudResolved++;
    }
    if (!c.resolvedImdb) result.stillMissingImdb++;
  }

  // ---------------------------------------------------------------
  // Phase 3: write upserts in chunked transactions. Batching by
  // UPSERT_CHUNK_SIZE keeps the fsync win of a real transaction while
  // letting GC reclaim each chunk's PlexMovie objects as soon as it's
  // written — peak memory stays bounded regardless of library size.
  // ---------------------------------------------------------------
  logPhase('write phase', { rows: candidates.length, chunkSize: UPSERT_CHUNK_SIZE });
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

  const upsertChunk = db.transaction((rows: Candidate[]) => {
    for (const c of rows) {
      const m = c.movie;
      const fileName = c.part.file.split(/[\\/]/).pop() ?? c.part.file;
      upsert.run({
        plex_rating_key: m.ratingKey,
        title: m.title,
        year: m.year ?? null,
        imdb_id: c.resolvedImdb,
        file_path: c.part.file,
        file_name: fileName,
        resolution: m.Media?.[0]?.videoResolution ?? null,
        video_codec: m.Media?.[0]?.videoCodec ?? null,
        file_size: c.part.size || null,
        plex_added_at: m.addedAt ?? null,
        plex_updated_at: m.updatedAt ?? null,
        first_seen_at: now,
        last_synced_at: now,
      });
    }
  });

  let written = 0;
  while (candidates.length > 0) {
    // splice() removes the chunk from the array so its PlexMovie refs become
    // unreachable as soon as the transaction completes.
    const chunk = candidates.splice(0, UPSERT_CHUNK_SIZE);
    upsertChunk(chunk);
    written += chunk.length;
    // Yield between chunks so the event loop can service other requests and
    // V8 can run a short GC pass if it wants to.
    await yieldToEventLoop();
  }
  logPhase('write complete', { written });

  // ---------------------------------------------------------------
  // Cleanup pass: remove rows whose Plex item is gone or no longer a WEBRip.
  // ---------------------------------------------------------------
  const allDbRows = db
    .prepare(`SELECT id, plex_rating_key, title FROM movies`)
    .all() as { id: number; plex_rating_key: string; title: string }[];

  const toRemoveUpgraded: typeof allDbRows = [];
  const toRemoveDeleted: typeof allDbRows = [];
  for (const r of allDbRows) {
    if (!seenAnyKey.has(r.plex_rating_key)) {
      toRemoveDeleted.push(r);
    } else if (!seenWebripKey.has(r.plex_rating_key)) {
      toRemoveUpgraded.push(r);
    }
  }
  const toRemoveCount = toRemoveUpgraded.length + toRemoveDeleted.length;

  if (allDbRows.length > 0 && toRemoveCount / allDbRows.length > REMOVAL_SAFETY_THRESHOLD) {
    // Don't trust this sync — too many rows would disappear. Bail on cleanup
    // and surface the count so the user can investigate.
    result.removalSkipped = true;
    result.wouldHaveRemoved = toRemoveCount;
    console.warn(
      `Sync cleanup skipped: would remove ${toRemoveCount}/${allDbRows.length} rows (over ${Math.round(REMOVAL_SAFETY_THRESHOLD * 100)}% threshold). Investigate before forcing.`
    );
  } else if (toRemoveCount > 0) {
    const deleteStmt = db.prepare(`DELETE FROM movies WHERE id = ?`);
    const tx = db.transaction((rows: { id: number }[]) => {
      for (const r of rows) deleteStmt.run(r.id);
    });
    tx([...toRemoveUpgraded, ...toRemoveDeleted]);
    result.removedUpgraded = toRemoveUpgraded.length;
    result.removedDeleted = toRemoveDeleted.length;
    if (toRemoveUpgraded.length > 0) {
      console.log(
        `Removed ${toRemoveUpgraded.length} upgraded WEBRip(s): ${toRemoveUpgraded.map((r) => r.title).slice(0, 5).join(', ')}${toRemoveUpgraded.length > 5 ? '…' : ''}`
      );
    }
    if (toRemoveDeleted.length > 0) {
      console.log(
        `Removed ${toRemoveDeleted.length} deleted-from-Plex movie(s): ${toRemoveDeleted.map((r) => r.title).slice(0, 5).join(', ')}${toRemoveDeleted.length > 5 ? '…' : ''}`
      );
    }
  }

  logPhase('done', { elapsedMs: Date.now() - startedAt });
  return result;
}
