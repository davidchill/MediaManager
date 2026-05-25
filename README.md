# MediaManager

A personal dashboard for tracking WEBRip movies in a local Plex library and flagging titles where YTS has a BluRay version available for download.

**Current version: v0.1.1**

## How it works

1. Connects to your local Plex server and pulls every movie.
2. Filters to files whose filename contains `WEBRip` (case-insensitive).
3. Stores them in a local SQLite database at `./data/mediamanager.db`.
4. For each movie with an IMDb ID, queries the YTS API and flags it if a BluRay torrent is available.
5. Renders everything in a dashboard at `http://localhost:3000` — movies with available BluRay upgrades sort to the top, with a green badge linking to the YTS page.

Everything runs locally on the same machine as your Plex server. No data leaves your network.

## Setup

### 1. Install dependencies

```bash
cd site
npm install
```

### 2. Get your Plex token

1. Open Plex Web (usually `http://localhost:32400/web`).
2. Open any movie -> three-dot (`...`) menu -> **Get Info** -> **View XML**.
3. The new browser tab's URL contains `X-Plex-Token=...` -- copy that value.

### 3. Configure environment

Open `site/.env.local` and paste the token:

```
PLEX_TOKEN=your_token_here
PLEX_URL=http://localhost:32400
YTS_API_BASE=https://yts.bz/api/v2
```

`YTS_API_BASE` defaults to `yts.bz` because the canonical `yts.mx` is DNS-blocked by many US ISPs (including AT&T). Both mirrors serve the same API; change this if your chosen mirror stops responding.

### 4. Run the app

For day-to-day editing, the dev server is fine:

```bash
npm run dev
```

For long-running operations (full library sync, "Force all" YTS check), the dev server's per-request instrumentation (HMR, tracing, source maps) adds noticeable CPU and memory overhead. If your PC starts feeling sluggish during those operations, switch to production mode:

```bash
npm run build   # one-time, produces an optimized .next/ build
npm start       # serves the build at http://localhost:3000
```

Production mode skips all dev instrumentation, so the app uses far less CPU and RAM. You'll need to re-run `npm run build` after any code changes; otherwise treat it like a normal server. Open [http://localhost:3000](http://localhost:3000).

### 5. First-run flow

1. Click **Sync from Plex** — pulls your WEBRip files into the local DB. Takes a few seconds.
2. Click **Check YTS** — looks up every movie with an IMDb ID against YTS and flags BluRay upgrades. Takes ~1–2 minutes for several hundred movies (250 ms between requests, plus a 1.5 s breathing pause every 50 movies to keep system load smooth). A progress bar shows the live status. Click **Pause** to stop mid-run; already-checked movies are persisted and will be skipped when you resume.
3. The dashboard reloads with upgrade badges. Click any green BluRay badge to open the YTS page in a new tab.

## Project structure

```
site/
├── app/
│   ├── api/
│   │   ├── sync/route.ts        # POST /api/sync - pulls Plex into DB
│   │   └── check-yts/route.ts   # POST /api/check-yts - streams NDJSON progress
│   ├── page.tsx                 # Dashboard (Server Component, reads from DB)
│   ├── SyncButton.tsx           # Client component for Plex sync
│   ├── CheckYtsButton.tsx       # Client component for YTS check + progress bar
│   └── layout.tsx
├── lib/
│   ├── db.ts                    # SQLite setup, schema, auto-migration
│   ├── plex.ts                  # Plex API client
│   ├── sync.ts                  # Plex -> DB orchestration
│   ├── yts.ts                   # YTS API client + summary logic
│   └── yts-check.ts             # YTS check orchestration with progress callbacks
├── scripts/
│   └── test-yts.ts              # Debug script: hit YTS for one movie
├── data/                        # Local SQLite DB (gitignored)
├── .env.local                   # Plex token (gitignored)
└── .env.example
```

## Debugging the YTS path

Run a one-off lookup against the first movie in your DB:

```bash
npx --yes tsx --env-file=.env.local scripts/test-yts.ts
```

Or test against a specific IMDb ID:

```bash
npx --yes tsx --env-file=.env.local scripts/test-yts.ts tt0468569
```

Prints the raw YTS torrent list and the summarized upgrade decision.

## Known limitations (v0.1.0)

- **IMDb ID coverage.** Plex's bulk listing endpoint does not reliably return the `Guid[]` array for every movie, so movies matched by older Plex agents (or otherwise missing the new GUID structure) get no IMDb ID and are skipped by the YTS check. A future release will fetch per-item metadata and parse the legacy `guid` field as a fallback.
- **IMDb-only matching.** No title + year fallback yet. Movies without an IMDb ID cannot be checked against YTS.
- **Single user, local only.** No auth, no multi-user, no deployment story. Runs on `localhost`.

## Tech stack

- Next.js 16 (App Router, Turbopack)
- TypeScript
- Tailwind CSS v4
- better-sqlite3
- The Plex local HTTP API (no SDK; plain `fetch`)
- The YTS public API (`/api/v2/movie_details.json`)

See [CHANGELOG.md](CHANGELOG.md) for release history.
