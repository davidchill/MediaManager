/**
 * Debug script: pick a movie from the local DB and run a YTS lookup against it.
 *
 * Run with:
 *   npx --yes tsx --env-file=.env.local scripts/test-yts.ts
 *
 * Optional: pass an IMDb ID directly to bypass the DB:
 *   npx --yes tsx --env-file=.env.local scripts/test-yts.ts tt0468569
 */

import Database from 'better-sqlite3';
import path from 'node:path';
import {
  lookupByImdbId,
  summarize,
  classifyCurrentFile,
  isStrictUpgrade,
  TIER_LABEL,
} from '../lib/yts';

interface MovieRow {
  id: number;
  title: string;
  year: number | null;
  imdb_id: string | null;
  resolution: string | null;
  video_codec: string | null;
  file_name: string | null;
}

function openDb() {
  const dbPath = path.join(process.cwd(), 'data', 'mediamanager.db');
  return new Database(dbPath, { readonly: true });
}

function pickMovie(): MovieRow | null {
  const db = openDb();
  // First by alphabetical title — matches what the UI shows at the top.
  const row = db
    .prepare(
      `SELECT id, title, year, imdb_id, resolution, video_codec, file_name
       FROM movies
       ORDER BY title COLLATE NOCASE
       LIMIT 1`
    )
    .get() as MovieRow | undefined;
  db.close();
  return row ?? null;
}

function printDivider(label: string) {
  console.log('\n' + '='.repeat(60));
  console.log(label);
  console.log('='.repeat(60));
}

async function main() {
  const cliImdb = process.argv[2];

  let imdbId: string;
  let movieLabel: string;
  let row: MovieRow | null = null;

  if (cliImdb) {
    imdbId = cliImdb;
    movieLabel = `(from CLI) ${imdbId}`;
  } else {
    row = pickMovie();
    if (!row) {
      console.error('No movies in the database. Run a Plex sync first.');
      process.exit(1);
    }
    printDivider('First movie in DB');
    console.log(JSON.stringify(row, null, 2));

    if (!row.imdb_id) {
      console.error(
        '\n⚠ This movie has no IMDb ID stored — that is why YTS skipped it.'
      );
      console.error(
        '   Run with an explicit IMDb ID to test the YTS path:'
      );
      console.error(
        '   npx --yes tsx --env-file=.env.local scripts/test-yts.ts tt0468569'
      );
      process.exit(0);
    }
    imdbId = row.imdb_id;
    movieLabel = `${row.title} (${row.year ?? '?'}) — ${imdbId}`;
  }

  printDivider(`YTS lookup: ${movieLabel}`);
  const result = await lookupByImdbId(imdbId);

  if (!result.found || !result.movie) {
    console.log('Not found on YTS.');
    return;
  }

  console.log('Found on YTS:');
  console.log(`  Title:    ${result.movie.title}`);
  console.log(`  Year:     ${result.movie.year}`);
  console.log(`  YTS ID:   ${result.movie.id}`);
  console.log(`  YTS URL:  ${result.movie.url}`);
  console.log(`  Torrents: ${result.movie.torrents?.length ?? 0}`);

  if (result.movie.torrents?.length) {
    printDivider('Raw torrents');
    for (const t of result.movie.torrents) {
      console.log(
        `  [${t.type}] ${t.quality.padEnd(12)} ${t.size.padEnd(12)} seeds=${t.seeds} peers=${t.peers}`
      );
    }
  }

  printDivider('Our summary');
  const summary = summarize(result.movie.torrents);
  console.log(JSON.stringify(summary, null, 2));

  // Tier comparison only meaningful when we picked a real DB row.
  if (row) {
    const currentTier = classifyCurrentFile(row.resolution, row.video_codec);
    const upgrade = isStrictUpgrade(currentTier, summary.bestTier);
    printDivider('Upgrade decision');
    const currentLabel =
      currentTier === 'below' ? 'below tracked tiers' : TIER_LABEL[currentTier];
    const bestLabel = summary.bestTier ? TIER_LABEL[summary.bestTier] : '—';
    console.log(`  current tier: ${currentLabel}`);
    console.log(`  best on YTS:  ${bestLabel}`);
    console.log(`  → has_upgrade would be set to: ${upgrade ? 1 : 0}`);
  } else {
    printDivider('Upgrade decision');
    console.log('  (skipped — no DB row, run without --imdb to test tier compare)');
  }
}

main().catch((e) => {
  console.error('FAILED:', e);
  process.exit(1);
});
