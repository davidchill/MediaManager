# MediaManager

A personal dashboard for tracking WEBRip movies in a local Plex library and flagging titles where YTS has a BluRay version available for download.

**Current version: v0.1.3**

## How it works

1. Connects to your local Plex server and pulls every movie.
2. Filters to files whose filename contains `WEBRip` (case-insensitive).
3. Stores them in a local SQLite database at `./data/mediamanager.db`.
4. For each movie with an IMDb ID, queries the YTS API and flags an upgrade based on a ranked tier system (see below).
5. Renders everything in a dashboard at `http://localhost:3000`. Movies with available upgrades sort to the top, each with a green badge naming the recommended tier (`BluRay 1080p`, `BluRay 720p`, `WEB 1080p x265`, or `WEB 1080p`) and linking to the YTS page.

A live Plex activity pill next to the Sync button shows whether Plex is currently scanning, with a progress percentage and an elapsed timer. The Sync button auto-disables while a scan is in flight; contextual **Start scan** / **Stop scan** buttons let you manually drive Plex from the dashboard.

Everything runs locally on the same machine as your Plex server. No data leaves your network.

## Upgrade tiers

The "Upgrade" badge fires only when YTS has a *strictly better* version than what you already have on disk. Tiers, highest priority first:

1. **BluRay @ 1080p**
2. **BluRay @ 720p**
3. **WEB @ 1080p.x265** (HEVC / x265)
4. **WEB @ 1080p** (h264 / other)

YTS's `web` and `webrip` types are treated as the same source. Anything outside these four tiers (2160p, 480p, etc.) is ignored. Your current file's tier is derived from Plex's resolution + codec fields; anything below 1080p counts as "below tracked tiers" and any of T1–T4 is an upgrade.

Example: a 1080p h264 WEBRip on disk → tier 4. YTS has the same movie as a 1080p x265 WEB torrent → tier 3 → upgrade flagged. YTS has only another 1080p h264 → no upgrade.

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

1. Watch the **Plex status pill** next to the Sync button. If it's amber (`Updating Library — Movies (XX%)`) Plex is mid-scan and the Sync button is disabled. Either wait for it to finish or click **Stop scan** to cancel.
2. Click **Sync from Plex** — pulls your WEBRip files into the local DB. The terminal prints heartbeat lines (`[sync HH:MM:SS.mmm] scan progress { scanned: 250, webrips: 18 }`) so you can see exactly what phase it's in.
3. Click **Check YTS** — looks up every movie with an IMDb ID against YTS and applies the tier-based upgrade rule. Takes ~10 seconds for several hundred movies with the default 4-worker pool. A progress bar shows the live status. Click **Pause** to stop mid-run; already-checked movies persist and are skipped when you resume.
4. The dashboard reloads with upgrade badges naming the recommended tier. Click any green badge to open the YTS page in a new tab.
5. (Optional) After the sync, click **Start scan** to ask Plex to resume scanning your libraries.

## Project structure

```
site/
├── app/
│   ├── api/
│   │   ├── sync/route.ts             # POST /api/sync - pulls Plex into DB
│   │   ├── check-yts/route.ts        # POST /api/check-yts - streams NDJSON progress
│   │   ├── plex-status/route.ts      # GET  /api/plex-status - polled every 5s by the dashboard
│   │   └── plex-scan/
│   │       ├── start/route.ts        # POST - trigger scan on every movie library
│   │       └── stop/route.ts         # POST - cancel in-flight scans on every movie library
│   ├── page.tsx                      # Dashboard (Server Component, reads from DB)
│   ├── PlexSyncControls.tsx          # Client: status pill + Start/Stop + Sync (polls /api/plex-status)
│   ├── SyncButton.tsx                # Client component for Plex sync (accepts disabled prop)
│   ├── CheckYtsButton.tsx            # Client component for YTS check + progress bar
│   └── layout.tsx
├── lib/
│   ├── db.ts                         # SQLite setup, schema, auto-migration
│   ├── plex.ts                       # Plex API client (fetch + commands + activities)
│   ├── sync.ts                       # Plex -> DB orchestration (heartbeats + chunked writes)
│   ├── yts.ts                        # YTS API client + tier-based upgrade logic
│   └── yts-check.ts                  # YTS check orchestration with progress callbacks
├── scripts/
│   └── test-yts.ts                   # Debug script: hit YTS for one movie + tier comparison
├── data/                             # Local SQLite DB (gitignored)
├── .env.local                        # Plex token (gitignored)
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

## Known limitations

- **IMDb-only matching.** No title + year fallback yet. Movies that Plex cloud cannot resolve to an IMDb ID are skipped permanently from YTS checks.
- **Plex bulk fetch is unbounded.** `/library/sections/{key}/all` returns the entire library as one JSON blob. For ~3k+ movie libraries this can be tens of MB; v0.1.3 added a 60-second timeout so a stuck Plex surfaces a clean error, but a streaming JSON parser would be more robust.
- **Schema migrations use drop-and-recreate** for the `yts_checks` cache table. Safe today because it's a cache; real `ALTER TABLE` migration tooling will be needed before anything stateful is added.
- **Single user, local only.** No auth, no multi-user, no deployment story. Runs on `localhost`.
- **Elapsed timer is observation-based.** Plex doesn't expose activity start times in `/activities`, so the elapsed timer on the status pill counts from when the dashboard first noticed the activity — reload mid-scan and the timer restarts from 0.

## Tech stack

- Next.js 16 (App Router, Turbopack)
- TypeScript
- Tailwind CSS v4
- better-sqlite3
- The Plex local HTTP API (no SDK; plain `fetch`)
- The YTS public API (`/api/v2/movie_details.json`)

See [CHANGELOG.md](CHANGELOG.md) for release history.
