import { getDb } from './db';
import { lookupByImdbId, summarize } from './yts';

/** Sleep between requests *within a single worker*. With 4 workers running
 *  this still averages to ~30–40 requests/sec — well within polite limits
 *  for the YTS API. Tune via env if you ever hit Cloudflare throttling. */
const REQUEST_DELAY_MS = Number(process.env.YTS_REQUEST_DELAY_MS) || 50;
/** Number of YTS lookups in flight at once. SQLite writes serialize naturally
 *  via better-sqlite3's synchronous API, so this only governs network. */
const CONCURRENCY = Number(process.env.YTS_CONCURRENCY) || 4;
const STALE_MS = 24 * 60 * 60 * 1000;

export interface YtsCheckResult {
  considered: number;     // movies with an IMDb ID
  skippedFresh: number;   // skipped because checked recently
  skippedNoImdb: number;  // skipped because no IMDb ID on file
  checked: number;        // YTS API calls actually made
  upgradesAvailable: number;
  errors: number;
}

export interface StartEvent {
  totalMovies: number;       // every movie in the library
  toCheck: number;           // how many will actually be hit against YTS
  skippedNoImdb: number;
  skippedFresh: number;
}

export type ProgressStatus = 'upgrade' | 'no_bluray' | 'not_on_yts' | 'error';

export interface ProgressEvent {
  index: number;             // 1-based, of toCheck
  total: number;             // same as start.toCheck
  movieId: number;
  imdbId: string;
  title: string;
  status: ProgressStatus;
  error?: string;
}

function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}

interface Candidate {
  id: number;
  title: string;
  imdb_id: string | null;
  checked_at: number | null;
}

export interface RunYtsCheckOptions {
  force?: boolean;
  /** Aborts the loop between movies. Used by the API route to halt work when
   *  the client disconnects (i.e. user clicks Pause). */
  signal?: AbortSignal;
  onStart?: (e: StartEvent) => void;
  onProgress?: (e: ProgressEvent) => void;
}

export async function runYtsCheck(opts: RunYtsCheckOptions = {}): Promise<YtsCheckResult> {
  const db = getDb();
  const now = Date.now();
  const force = opts.force === true;

  const rows = db
    .prepare(
      `SELECT m.id, m.title, m.imdb_id, c.checked_at
       FROM movies m
       LEFT JOIN yts_checks c ON c.movie_id = m.id
       ORDER BY m.title COLLATE NOCASE`
    )
    .all() as Candidate[];

  const upsert = db.prepare(`
    INSERT INTO yts_checks (
      movie_id, imdb_id, found, yts_id, yts_url, best_source, best_quality,
      has_bluray_upgrade, bluray_qualities, torrents_json, checked_at
    ) VALUES (
      @movie_id, @imdb_id, @found, @yts_id, @yts_url, @best_source, @best_quality,
      @has_bluray_upgrade, @bluray_qualities, @torrents_json, @checked_at
    )
    ON CONFLICT(movie_id) DO UPDATE SET
      imdb_id = excluded.imdb_id,
      found = excluded.found,
      yts_id = excluded.yts_id,
      yts_url = excluded.yts_url,
      best_source = excluded.best_source,
      best_quality = excluded.best_quality,
      has_bluray_upgrade = excluded.has_bluray_upgrade,
      bluray_qualities = excluded.bluray_qualities,
      torrents_json = excluded.torrents_json,
      checked_at = excluded.checked_at
  `);

  // Pre-compute the work plan so we can emit an accurate "start" event.
  const toCheck: Candidate[] = [];
  let skippedNoImdb = 0;
  let skippedFresh = 0;
  for (const row of rows) {
    if (!row.imdb_id) {
      skippedNoImdb++;
      continue;
    }
    if (!force && row.checked_at && now - row.checked_at < STALE_MS) {
      skippedFresh++;
      continue;
    }
    toCheck.push(row);
  }

  opts.onStart?.({
    totalMovies: rows.length,
    toCheck: toCheck.length,
    skippedNoImdb,
    skippedFresh,
  });

  const result: YtsCheckResult = {
    considered: rows.length - skippedNoImdb,
    skippedFresh,
    skippedNoImdb,
    checked: 0,
    upgradesAvailable: 0,
    errors: 0,
  };

  // Shared cursor + completion counter. JS is single-threaded so these
  // pre/post-increments are race-free across the worker promises.
  let cursor = 0;
  let completed = 0;

  async function processOne(row: Candidate) {
    let status: ProgressStatus = 'no_bluray';
    let errorMessage: string | undefined;

    try {
      const lookup = await lookupByImdbId(row.imdb_id!);
      const summary = summarize(lookup.movie?.torrents);
      upsert.run({
        movie_id: row.id,
        imdb_id: row.imdb_id,
        found: lookup.found ? 1 : 0,
        yts_id: lookup.movie?.id ?? null,
        yts_url: lookup.movie?.url ?? null,
        best_source: summary.bestSource,
        best_quality: summary.bestQuality,
        has_bluray_upgrade: summary.hasBluray ? 1 : 0,
        bluray_qualities: summary.blurayQualities.join(',') || null,
        torrents_json: lookup.movie?.torrents ? JSON.stringify(lookup.movie.torrents) : null,
        checked_at: Date.now(),
      });
      result.checked++;
      if (!lookup.found) {
        status = 'not_on_yts';
      } else if (summary.hasBluray) {
        status = 'upgrade';
        result.upgradesAvailable++;
      } else {
        status = 'no_bluray';
      }
    } catch (e) {
      result.errors++;
      status = 'error';
      errorMessage = e instanceof Error ? e.message : String(e);
      console.error(`YTS check failed for ${row.imdb_id}:`, e);
    }

    completed++;
    opts.onProgress?.({
      index: completed,
      total: toCheck.length,
      movieId: row.id,
      imdbId: row.imdb_id!,
      title: row.title,
      status,
      error: errorMessage,
    });
  }

  async function worker() {
    while (true) {
      if (opts.signal?.aborted) return;
      const i = cursor++;
      if (i >= toCheck.length) return;
      await processOne(toCheck[i]);
      if (REQUEST_DELAY_MS > 0) await sleep(REQUEST_DELAY_MS);
    }
  }

  const poolSize = Math.min(CONCURRENCY, toCheck.length || 1);
  await Promise.all(Array.from({ length: poolSize }, () => worker()));

  return result;
}
