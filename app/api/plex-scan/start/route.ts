import { NextResponse } from 'next/server';
import { listMovieLibraries, startLibraryScan } from '@/lib/plex';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 30;

export interface PlexScanStartResponse {
  ok: boolean;
  started: Array<{ key: string; title: string }>;
  errors: Array<{ key: string; title: string; message: string }>;
  error?: string;
}

export async function POST() {
  try {
    const libs = await listMovieLibraries();
    const started: PlexScanStartResponse['started'] = [];
    const errors: PlexScanStartResponse['errors'] = [];
    // Trigger sequentially — Plex queues these instantly and we want clear
    // per-library error attribution rather than a Promise.allSettled blob.
    for (const lib of libs) {
      try {
        await startLibraryScan(lib.key);
        started.push({ key: lib.key, title: lib.title });
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
      started,
      errors,
    } satisfies PlexScanStartResponse);
  } catch (e) {
    return NextResponse.json(
      {
        ok: false,
        started: [],
        errors: [],
        error: e instanceof Error ? e.message : String(e),
      } satisfies PlexScanStartResponse,
      { status: 500 }
    );
  }
}
