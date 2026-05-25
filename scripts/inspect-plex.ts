/**
 * Diagnostic v2: try several Plex endpoint variants on a single movie to find
 * one that exposes external IDs (IMDb / TMDb / TVDB).
 *
 *   npx --yes tsx --env-file=.env.local scripts/inspect-plex.ts
 */

import Database from 'better-sqlite3';
import path from 'node:path';

const PLEX_URL = (process.env.PLEX_URL || 'http://localhost:32400').replace(/\/$/, '');
const PLEX_TOKEN = process.env.PLEX_TOKEN;

if (!PLEX_TOKEN) {
  console.error('PLEX_TOKEN is not set');
  process.exit(1);
}

async function plexFetch(pathAndQuery: string) {
  const res = await fetch(`${PLEX_URL}${pathAndQuery}`, {
    headers: { 'X-Plex-Token': PLEX_TOKEN!, Accept: 'application/json' },
    cache: 'no-store',
  });
  if (!res.ok) throw new Error(`${res.status} ${res.statusText} for ${pathAndQuery}`);
  return res.json();
}

function divider(label: string) {
  console.log('\n' + '='.repeat(70));
  console.log(label);
  console.log('='.repeat(70));
}

async function main() {
  const dbPath = path.join(process.cwd(), 'data', 'mediamanager.db');
  const db = new Database(dbPath, { readonly: true });
  const row = db
    .prepare(
      `SELECT id, plex_rating_key, title, year FROM movies
       WHERE imdb_id IS NULL ORDER BY title COLLATE NOCASE LIMIT 1`
    )
    .get() as { id: number; plex_rating_key: string; title: string; year: number | null } | undefined;
  db.close();

  if (!row) {
    console.log('No imdb_id-less movies. Nothing to test.');
    return;
  }
  console.log(`Test movie: ${row.title} (${row.year ?? '?'}) ratingKey=${row.plex_rating_key}`);

  const variants = [
    `/library/metadata/${row.plex_rating_key}`,
    `/library/metadata/${row.plex_rating_key}?includeGuids=1`,
    `/library/metadata/${row.plex_rating_key}?includeExternalMedia=1`,
    `/library/metadata/${row.plex_rating_key}?includeExternalMedia=1&includeGuids=1`,
    `/library/metadata/${row.plex_rating_key}/matches`,
    `/library/metadata/${row.plex_rating_key}/matches?manual=0`,
  ];

  for (const v of variants) {
    divider(v);
    try {
      const data = (await plexFetch(v)) as { MediaContainer?: Record<string, unknown> };
      const mc = data.MediaContainer;
      if (!mc) {
        console.log('  (no MediaContainer)');
        continue;
      }
      const metadata = (mc.Metadata as Array<Record<string, unknown>> | undefined) ?? [];
      const searchResult = (mc.SearchResult as Array<Record<string, unknown>> | undefined) ?? [];

      if (metadata.length > 0) {
        const m = metadata[0];
        console.log('  Metadata[0].guid    :', m.guid);
        console.log('  Metadata[0].Guid    :', JSON.stringify(m.Guid ?? null));
        console.log('  keys                :', Object.keys(m).filter((k) => /guid|imdb|tmdb|tvdb|match/i.test(k)).join(', ') || '(none guid-related)');
      }
      if (searchResult.length > 0) {
        console.log(`  SearchResult: ${searchResult.length} entries`);
        for (let i = 0; i < Math.min(3, searchResult.length); i++) {
          const s = searchResult[i];
          console.log(`    [${i}] guid=${s.guid} name=${s.name ?? s.title} year=${s.year} score=${s.score}`);
        }
      }
    } catch (e) {
      console.log(`  ERROR: ${e instanceof Error ? e.message : String(e)}`);
    }
  }
}

main().catch((e) => {
  console.error('FAILED:', e);
  process.exit(1);
});
