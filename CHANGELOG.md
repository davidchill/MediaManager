# Changelog

All notable changes to MediaManager will be documented in this file.

## v0.1.3 – 2026-05-27

Three independent threads landed this release: a tier-based redefinition of "upgrade available," sync-pipeline hardening to address a permanent server hang that required a hard reset, and live Plex activity visibility with manual scan controls on the dashboard.

### Added

- **Plex activity status pill** (`app/PlexSyncControls.tsx`, `app/api/plex-status/route.ts`). The dashboard polls Plex's `/activities` endpoint every 5 seconds and shows one of three states next to the Sync button:
  - **Plex: idle** — green.
  - **Plex: Updating Library — Movies (42%) · 1m 23s** — amber pill with pulsing dot, activity label, Plex-reported progress percentage, and an observation-elapsed timer that ticks once per second.
  - **Plex: status unavailable** — gray; appears when `/activities` errors. Fails open (does not gate Sync).
  - Filters to activities scoped to a movie library (`activity.type` starts with `library.` AND `Context.librarySectionID` is in our movie-libraries set). Ignores transcoding, deep analysis on TV libraries, subscription processing, etc.
- **Sync button auto-disables while Plex is busy.** Tooltip explains why ("Plex is currently scanning a movie library — wait for it to finish to avoid contention."). Re-enables automatically when Plex goes idle.
- **Start scan / Stop scan buttons** (`app/api/plex-scan/start/route.ts`, `app/api/plex-scan/stop/route.ts`). Contextual: **Stop** appears only when Plex is busy; **Start** appears only when Plex is idle and reachable. Both act on every movie library at once and force an immediate status re-poll on click so the pill updates within ~1 second instead of waiting up to 5 s for the next interval. Status line below the buttons reports `Started scan on N libraries.` / `Cancelled scan on N libraries.` / errors.
- **Tier-based upgrade detection** (`lib/yts.ts`). Replaces the v0.1.0–0.1.2 "any BluRay torrent flags an upgrade" rule with a ranked tier system:
  1. BluRay @ 1080p
  2. BluRay @ 720p
  3. WEB @ 1080p.x265
  4. WEB @ 1080p
  - `classifyTorrent()` maps a YTS torrent to one of those tiers or null (anything else is ignored). `web` and `webrip` are treated as the same source per project spec.
  - `classifyCurrentFile(resolution, codec)` maps the file already on disk into a tier (or `'below'` for sub-1080p).
  - `isStrictUpgrade(current, best)` returns true only when YTS's best matching tier is strictly higher-priority than the file on disk. A 1080p hevc WEBRip is not "upgraded" by another 1080p WEB torrent.
- **Heartbeat logs in `runSync()`.** New `logPhase()` helper prints `[sync HH:MM:SS.mmm] <label>` at every phase boundary (start, libraries fetched, per-library fetch begin/end, scan progress every 250 movies, resolve, cloud lookups complete, write begin/end, done with `elapsedMs`). Makes a future hang diagnosable from the terminal — you can see exactly which call stopped advancing.
- **Plex fetch timeouts** (`lib/plex.ts`). All local-Plex requests now use `AbortSignal.timeout(60_000)`; cloud-metadata lookups use `AbortSignal.timeout(30_000)`. A stuck Plex socket now surfaces as a clear `Error` ("Plex request timed out after 60s for /library/sections/... Plex may be mid-scan or unresponsive.") instead of an indefinite hang. This addresses the v0.1.2 failure mode where Plex going silent mid-response would block `runSync()` forever.
- **`plexCommand()` helper** (`lib/plex.ts`). Companion to `plexFetch()` for endpoints that don't return JSON. Supports `GET` and `DELETE`. Used by the new scan start/cancel functions.

### Changed

- **Phase 3 upsert is now chunked** (`lib/sync.ts`). Replaces v0.1.2's "buffer every candidate, write in one giant transaction" approach with `splice()`-and-write batches of 200 candidates each. Each batch is one transaction (still gets the fsync win), then the chunk's references are released so GC can reclaim each `PlexMovie` mid-write. Peak memory stays bounded regardless of library size. `await yieldToEventLoop()` between chunks lets unrelated requests interleave. Addresses the memory pressure that turned a 30-second hang into a swap-thrashed system freeze on a ~3k-movie library.
- **`yts_checks` schema** dropped `has_bluray_upgrade` and `bluray_qualities`, added `has_upgrade`, `upgrade_tier`, and `current_tier`. Migration uses the existing drop-and-recreate path; `yts_checks` is a cache so no data loss. `movies` table is untouched.
- **Dashboard upgrade column** ("YTS Upgrade" → "Upgrade") shows the recommended tier label (`BluRay 1080p`, `BluRay 720p`, `WEB 1080p x265`, or `WEB 1080p`) instead of a generic "BluRay" pill. Tooltip shows `Current: X → Upgrade to Y`. Header copy is now "N upgrades available" (no longer BluRay-specific).
- **`SyncButton` accepts `disabled` and `disabledReason` props** so the status pill wrapper can gate it.
- **`scripts/test-yts.ts`** prints the tier comparison (`current tier`, `best on YTS`, and the would-be `has_upgrade` value).

### Fixed

- **Permanent server hang on Sync from Plex** for users with mid-scan Plex servers. Two contributing causes: (a) `fetch()` to `/library/sections/{key}/all` had no timeout, so a Plex bulk endpoint stalled by an in-flight library scan would block forever; (b) the `runSync()` rewrite for v0.1.3 had been holding all candidate `PlexMovie` objects in memory through three phases, pushing peak heap into swap territory on a ~3k-movie library. Both are now addressed (fetch timeouts + chunked transactions).
- **Stale `bluray_qualities` tooltip** that showed the available BluRay qualities is gone, replaced by the tier comparison tooltip.

## v0.1.2 – 2026-05-25

Adds automatic cleanup of upgraded/deleted movies during sync, and parallelizes the YTS check now that the dev-server overhead is no longer the bottleneck. Roughly 10x faster "Force all" runs.

### Added

- **Automatic removal on sync** (`lib/sync.ts`). During each sync we now track every Plex `ratingKey` we encounter (across all movie libraries) and classify them into two sets: all-seen vs. WEBRip-seen. After the sync pass, rows in the DB whose `ratingKey` is no longer in either set are deleted:
  - **Removed (upgraded):** Plex still has the movie but the file is no longer a WEBRip — i.e. you replaced it with BluRay / WEB-DL / etc.
  - **Removed (deleted):** Plex no longer has the movie at all.
  - Both cases cascade to the `yts_checks` row via the existing foreign key.
- **30% removal safety guard.** If a single sync would remove more than 30% of the DB, the cleanup is aborted and the count is reported as `wouldHaveRemoved` instead. Prevents a transient Plex outage or temporarily unmounted library from nuking everything.
- **Sync result schema additions:** `removedUpgraded`, `removedDeleted`, `removalSkipped`, `wouldHaveRemoved`.
- **Sync UI message** now includes removal counts when nonzero, e.g. *"Removed 3 upgraded, 1 deleted from Plex."* When the safety guard trips, the message shows a ⚠ warning instead.

### Changed

- **YTS check parallelized.** Replaced the sequential loop with a 4-worker pool that pulls from a shared cursor. SQLite writes still serialize via better-sqlite3's synchronous API. Abort signal still respected per-iteration.
- **Per-request delay dropped** from 250 ms to 50 ms (per worker). Now configurable via `YTS_REQUEST_DELAY_MS` env var.
- **Concurrency configurable** via `YTS_CONCURRENCY` env var (default 4).
- **Removed the 50-movie / 1.5-second breathing pause.** It existed to protect the dev server's per-request overhead; with production mode the breathing pause is unnecessary.
- For a ~322-movie "Force all" run: **~89 s → ~10 s** in our testing.

## v0.1.1 – 2026-05-25

Fixes the IMDb-ID resolution gap that left ~80% of the library unchecked in v0.1.0, plus performance and UX work on the YTS check so long runs don't bog the host machine down.

### Added

- **Plex cloud GUID resolution** (`lib/plex.ts`). For movies whose local Plex API response returns `Guid: null` (the case for libraries matched by the new Plex Movie agent — most libraries), the sync now extracts the hash from the singular `guid` field (`plex://movie/<hash>`) and queries `https://metadata.provider.plex.tv/library/metadata/<hash>` to resolve external IMDb / TMDb / TVDB IDs. Resolves the IMDb ID for nearly every matched movie.
- **Legacy-agent IMDb parser** (`extractLegacyImdbId`). Also recovers IMDb IDs from libraries still using the legacy `com.plexapp.agents.imdb://tt...?lang=en` guid format.
- **Pause / Resume on YTS check**. Mid-run, the Check YTS / Force all buttons swap out for a **Pause** button. Clicking it aborts the fetch via `AbortController`; the server's orchestrator watches `request.signal` and exits cleanly between movies. Already-completed work persists. Click **Check YTS** again to resume — the 24-hour stale gate skips everything already done.
- **Periodic breathing pauses.** Every 50 movies the YTS orchestrator sleeps an extra 1.5 seconds. Adds ~10 seconds to a full run but lets the OS scheduler breathe so the host machine stays responsive.
- **Throttled progress UI.** The progress bar coalesces re-renders to at most one every 250 ms regardless of incoming event rate, reducing React work during long runs without losing visual smoothness.
- **Production-mode documentation** in the README. Explains `npm run build && npm start` as a low-overhead alternative to `npm run dev` for long operations — the dev server's per-request instrumentation (HMR, tracing, source maps) was responsible for most of the observed slowdown during full library checks.
- **Diagnostic scripts**:
  - `scripts/inspect-plex.ts` — probes multiple Plex endpoint variants on a single movie to find which (if any) returns external IDs. Used to diagnose the v0.1.0 IMDb gap.
  - `scripts/verify-cloud-lookup.ts` — runs cloud-GUID resolution on 5 unresolved movies and prints the results without touching the DB.

### Changed

- **Sync result schema and message.** `runSync()` now returns `cloudLookups`, `cloudResolved`, `cloudFailures`, and `stillMissingImdb` in addition to the existing fields. The Sync from Plex button reports these so you can see how many IMDb IDs were resolved on the run.
- **Sync UPSERT** now uses `COALESCE(excluded.imdb_id, movies.imdb_id)` so a transient cloud lookup failure on a later sync cannot blank out a previously-resolved IMDb ID.
- **`/api/sync` route** sets `maxDuration = 300` since the first sync resolves hundreds of IMDb IDs sequentially.
- **`/api/check-yts` route** now pipes `request.signal` into the orchestrator and tolerates `controller.enqueue` failures after the consumer (browser) has aborted.

### Fixed

- "Force all" effectively did nothing for movies without IMDb IDs in v0.1.0. With v0.1.1's cloud resolution, the YTS check now covers nearly the entire library on the first sync.

## v0.1.0 – 2026-05-25

Initial release. Pulls the WEBRip subset of a local Plex library into a SQLite-backed dashboard and cross-references each title against YTS to flag movies where a BluRay version is available for download.

### Added

- **Next.js 16.2.6 + TypeScript + Tailwind v4 scaffold** in `site/`, App Router, using Turbopack for dev.
- **SQLite layer** (`lib/db.ts`) via `better-sqlite3`. Stored at `data/mediamanager.db` (gitignored). WAL mode enabled. Two tables: `movies` and `yts_checks`. Schema auto-migrates the `yts_checks` shape on load when columns are missing.
- **Plex client** (`lib/plex.ts`). Talks to the local Plex server at `http://localhost:32400`, authenticates with `X-Plex-Token`. Lists movie libraries, fetches each library's movies (`?includeGuids=1`), extracts IMDb IDs from the `Guid[]` array, and reads the first `Media.Part` file path. Filters to filenames containing `WEBRip` (case-insensitive).
- **YTS client** (`lib/yts.ts`). Hits `movie_details.json?imdb_id=...` against a configurable API base (defaults to `https://yts.bz/api/v2` because `yts.mx` is DNS-blocked by many ISPs including AT&T). Summarizes torrents into `bestSource`, `bestQuality`, `hasBluray`, and `blurayQualities[]`.
- **Sync orchestrator** (`lib/sync.ts`). Walks every movie library, filters to WEBRips, UPSERTs into `movies` keyed on `plex_rating_key`.
- **YTS check orchestrator** (`lib/yts-check.ts`). Iterates movies with IMDb IDs, calls YTS with a 250 ms request delay, skips movies checked within the last 24 hours (override with `?force=1`), and emits per-movie progress via `onStart` / `onProgress` callbacks.
- **API routes**:
  - `POST /api/sync` — runs the Plex sync, returns a summary JSON.
  - `POST /api/check-yts` — streams an `application/x-ndjson` response with one event per movie (`start`, `progress`, `done`) so the UI can render live progress.
- **Dashboard** (`app/page.tsx`). Server Component that reads directly from SQLite and renders a table sorted by upgrade-available-first, then alphabetical. Columns: title, year, resolution, codec, size, IMDb link, **YTS Upgrade** badge with link to the YTS movie page, file name.
- **Client controls**:
  - `SyncButton` — triggers `/api/sync` and refreshes the page.
  - `CheckYtsButton` — triggers `/api/check-yts`, reads the NDJSON stream with `response.body.getReader()`, and renders a live progress bar with the current title, status icon (`⬆ · ✕ !`), and a running upgrade count.
- **Debug script** (`scripts/test-yts.ts`). Runs a one-off YTS lookup against the first DB movie or against a CLI-supplied IMDb ID. Useful for diagnosing the YTS path without running the full UI flow.
- **Env config**:
  - `PLEX_TOKEN` (required) — local Plex token.
  - `PLEX_URL` (default `http://localhost:32400`).
  - `YTS_API_BASE` (default `https://yts.bz/api/v2`).
- **`AGENTS.md` / `CLAUDE.md`** generated by `create-next-app` — directs AI agents to read version-matched docs at `node_modules/next/dist/docs/` before writing code (Next.js 16 ships its own docs in-tree).

### Known limitations (deferred to a future release)

- Plex's bulk `/library/sections/{key}/all` endpoint does not reliably populate `Guid[]` for every movie. In testing, 321 of 390 movies in the library had no IMDb ID stored and were skipped by the YTS check. A future release will add per-item metadata fetches (`/library/metadata/{ratingKey}`) and parse the legacy `guid` (singular) field to recover IMDb IDs.
- YTS check is IMDb-ID-only. Title + year fallback via `list_movies.json` is a possible future addition for movies that lack IMDb IDs.
- Schema migrations are handled by drop-and-recreate (safe only while tables are empty). Real `ALTER TABLE` migration tooling will be needed once the app accumulates persistent state.
- No scheduled background re-checks. User must click **Check YTS** manually.
