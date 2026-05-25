/**
 * Verifies the Plex cloud-GUID resolution on a handful of movies that
 * currently have no imdb_id in the DB. Does NOT write to the DB — just prints.
 *
 *   npx --yes tsx --env-file=.env.local scripts/verify-cloud-lookup.ts
 */

import Database from 'better-sqlite3';
import path from 'node:path';
import { lookupCloudGuids } from '../lib/plex';

const PLEX_URL = (process.env.PLEX_URL || 'http://localhost:32400').replace(/\/$/, '');
const PLEX_TOKEN = process.env.PLEX_TOKEN!;

async function plexFetch(p: string) {
  const res = await fetch(`${PLEX_URL}${p}`, {
    headers: { 'X-Plex-Token': PLEX_TOKEN, Accept: 'application/json' },
    cache: 'no-store',
  });
  if (!res.ok) throw new Error(`${res.status} for ${p}`);
  return res.json();
}

async function main() {
  const db = new Database(path.join(process.cwd(), 'data', 'mediamanager.db'), { readonly: true });
  const rows = db
    .prepare(
      `SELECT plex_rating_key, title, year FROM movies
       WHERE imdb_id IS NULL
       ORDER BY title COLLATE NOCASE LIMIT 5`
    )
    .all() as { plex_rating_key: string; title: string; year: number | null }[];
  db.close();

  console.log(`Testing cloud lookup on ${rows.length} movies with no imdb_id:\n`);

  for (const r of rows) {
    // Re-fetch the local entry to get its singular guid.
    const meta = (await plexFetch(`/library/metadata/${r.plex_rating_key}`)) as {
      MediaContainer: { Metadata?: Array<{ guid?: string }> };
    };
    const guid = meta.MediaContainer.Metadata?.[0]?.guid ?? null;
    const m = guid ? /^plex:\/\/movie\/([0-9a-f]+)/.exec(guid) : null;
    const hash = m ? m[1] : null;

    if (!hash) {
      console.log(`✗ ${r.title} (${r.year ?? '?'}) — no plex://movie/<hash> guid (got: ${guid})`);
      continue;
    }

    try {
      const cloud = await lookupCloudGuids(hash);
      const tag = cloud.imdb ? `✓ imdb=${cloud.imdb}` : '✗ no imdb in cloud response';
      console.log(`${tag.startsWith('✓') ? '✓' : '✗'} ${r.title} (${r.year ?? '?'}) — ${tag}${cloud.tmdb ? ` tmdb=${cloud.tmdb}` : ''}`);
    } catch (e) {
      console.log(`! ${r.title} (${r.year ?? '?'}) — ERROR: ${e instanceof Error ? e.message : String(e)}`);
    }
  }
}

main().catch((e) => {
  console.error('FAILED:', e);
  process.exit(1);
});
