# Changelog

All notable changes to MediaManager will be documented in this file.

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
