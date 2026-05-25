import { NextResponse } from 'next/server';
import { runSync } from '@/lib/sync';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
// First-run sync may resolve hundreds of IMDb IDs via Plex's cloud metadata
// service; allow up to 5 minutes.
export const maxDuration = 300;

export async function POST() {
  try {
    const result = await runSync();
    return NextResponse.json({ ok: true, ...result });
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    return NextResponse.json({ ok: false, error: message }, { status: 500 });
  }
}
