import Database from 'better-sqlite3';
import path from 'node:path';
import fs from 'node:fs';

let db: Database.Database | null = null;

export function getDb(): Database.Database {
  if (db) return db;
  const dbPath = path.join(process.cwd(), 'data', 'mediamanager.db');
  fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  db = new Database(dbPath);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  initSchema(db);
  return db;
}

function initSchema(db: Database.Database) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS movies (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      plex_rating_key TEXT UNIQUE NOT NULL,
      title TEXT NOT NULL,
      year INTEGER,
      imdb_id TEXT,
      file_path TEXT,
      file_name TEXT,
      resolution TEXT,
      video_codec TEXT,
      file_size INTEGER,
      plex_added_at INTEGER,
      plex_updated_at INTEGER,
      first_seen_at INTEGER NOT NULL,
      last_synced_at INTEGER NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_movies_imdb ON movies(imdb_id);
    CREATE INDEX IF NOT EXISTS idx_movies_title ON movies(title);

    CREATE TABLE IF NOT EXISTS yts_checks (
      movie_id INTEGER PRIMARY KEY REFERENCES movies(id) ON DELETE CASCADE,
      imdb_id TEXT,
      found INTEGER NOT NULL DEFAULT 0,
      yts_id INTEGER,
      yts_url TEXT,
      best_source TEXT,
      best_quality TEXT,
      has_bluray_upgrade INTEGER NOT NULL DEFAULT 0,
      bluray_qualities TEXT,
      torrents_json TEXT,
      checked_at INTEGER NOT NULL
    );
  `);

  // v0.2.0: migrate older yts_checks shape if it exists with missing columns.
  // The table started empty in v0.1, so a clean recreate is safe.
  const cols = db
    .prepare(`PRAGMA table_info(yts_checks)`)
    .all() as { name: string }[];
  const required = ['found', 'best_source', 'bluray_qualities', 'yts_id'];
  const missing = required.some((c) => !cols.find((x) => x.name === c));
  if (missing) {
    db.exec(`DROP TABLE yts_checks;`);
    db.exec(`
      CREATE TABLE yts_checks (
        movie_id INTEGER PRIMARY KEY REFERENCES movies(id) ON DELETE CASCADE,
        imdb_id TEXT,
        found INTEGER NOT NULL DEFAULT 0,
        yts_id INTEGER,
        yts_url TEXT,
        best_source TEXT,
        best_quality TEXT,
        has_bluray_upgrade INTEGER NOT NULL DEFAULT 0,
        bluray_qualities TEXT,
        torrents_json TEXT,
        checked_at INTEGER NOT NULL
      );
    `);
  }
}
