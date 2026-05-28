import { NextResponse } from 'next/server';
import {
  getActivities,
  getMovieLibrarySectionIds,
  isMovieLibraryActivity,
  type PlexActivity,
} from '@/lib/plex';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

// Polled every 5s by the dashboard. Keep response tiny and never block long —
// the lib/plex helpers already cap requests at 60s, but at this cadence even
// that is too long. We fail open: if Plex is unreachable, the dashboard treats
// it as "unknown" and keeps Sync enabled.
export const maxDuration = 15;

export interface PlexStatusResponse {
  ok: boolean;
  /** True when at least one in-flight activity is touching a movie library. */
  busy: boolean;
  /** Activities affecting our tracked movie libraries (filtered). */
  activities: Array<{
    uuid: string;
    type: string;
    title: string;
    subtitle: string | null;
    progress: number | null;
    librarySectionID: string | null;
  }>;
  /** Populated when the Plex call itself failed. */
  error?: string;
}

export async function GET() {
  try {
    // Both calls are quick. Run them in parallel.
    const [activities, movieSectionIds] = await Promise.all([
      getActivities(),
      getMovieLibrarySectionIds(),
    ]);
    const filtered = activities.filter((a: PlexActivity) =>
      isMovieLibraryActivity(a, movieSectionIds)
    );
    const body: PlexStatusResponse = {
      ok: true,
      busy: filtered.length > 0,
      activities: filtered.map((a) => ({
        uuid: a.uuid,
        type: a.type,
        title: a.title,
        subtitle: a.subtitle ?? null,
        progress: typeof a.progress === 'number' ? a.progress : null,
        librarySectionID: a.Context?.librarySectionID ?? null,
      })),
    };
    return NextResponse.json(body);
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    const body: PlexStatusResponse = {
      ok: false,
      busy: false,
      activities: [],
      error: message,
    };
    return NextResponse.json(body, { status: 200 });
  }
}
