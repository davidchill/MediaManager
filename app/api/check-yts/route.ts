import { type NextRequest } from 'next/server';
import { runYtsCheck } from '@/lib/yts-check';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 300;

export async function POST(request: NextRequest) {
  const force = request.nextUrl.searchParams.get('force') === '1';
  const encoder = new TextEncoder();

  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      let consumerGone = false;
      const send = (obj: unknown) => {
        if (consumerGone) return;
        try {
          controller.enqueue(encoder.encode(JSON.stringify(obj) + '\n'));
        } catch {
          // Stream closed by consumer (Pause). Stop trying to write.
          consumerGone = true;
        }
      };

      try {
        const result = await runYtsCheck({
          force,
          signal: request.signal,
          onStart: (e) => send({ type: 'start', ...e }),
          onProgress: (e) => send({ type: 'progress', ...e }),
        });
        send({ type: 'done', ok: true, ...result });
      } catch (e) {
        const message = e instanceof Error ? e.message : String(e);
        send({ type: 'done', ok: false, error: message });
      } finally {
        try {
          controller.close();
        } catch {
          // Already closed.
        }
      }
    },
    cancel() {
      // Consumer aborted. The orchestrator is watching request.signal and will
      // exit between movies on its own, so there is nothing to do here.
    },
  });

  return new Response(stream, {
    headers: {
      'Content-Type': 'application/x-ndjson; charset=utf-8',
      'Cache-Control': 'no-store, no-transform',
      'X-Accel-Buffering': 'no',
    },
  });
}
