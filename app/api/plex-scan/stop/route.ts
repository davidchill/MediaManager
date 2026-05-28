import { NextResponse } from 'next/server';
import { listMovieLibraries, cancelLibraryScan } from '@/lib/plex';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 30;

export interface PlexScanStopResponse {
  ok: boolean;
  stopped: Array<{ key: string; title: string }>;
  errors: Array<{ key: string; title: string; message: string }>;
  error?: string;
}

export async function POST() {
  try {
    const libs = await listMovieLibraries();
    const stopped: PlexScanStopResponse['stopped'] = [];
    const errors: PlexScanStopResponse['errors'] = [];
    // DELETE per library covers both running and queued scans. Sequential for
    // clear per-library error attribution.
    for (const lib of libs) {
      try {
        await cancelLibraryScan(lib.key);
        stopped.push({ key: lib.key, title: lib.title });
      } catch (e) {
        errors.push({
          key: lib.key,
          title: lib.title,
          message: e instanceof Error ? e.message : String(e),
        });
      }
    }
    return NextResponse.json({
      ok: errors.length === 0,
      stopped,
      errors,
    } satisfies PlexScanStopResponse);
  } catch (e) {
    return NextResponse.json(
      {
        ok: false,
        stopped: [],
        errors: [],
        error: e instanceof Error ? e.message : String(e),
      } satisfies PlexScanStopResponse,
      { status: 500 }
    );
  }
}
