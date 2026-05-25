'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';

export default function SyncButton() {
  const [pending, setPending] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  const router = useRouter();

  async function sync() {
    setPending(true);
    setMsg(null);
    try {
      const res = await fetch('/api/sync', { method: 'POST' });
      const data = await res.json();
      if (data.ok) {
        const parts = [
          `Synced ${data.webripCount} WEBRips (scanned ${data.totalScanned} movies across ${data.librariesScanned} ${data.librariesScanned === 1 ? 'library' : 'libraries'})`,
        ];
        if (data.cloudLookups > 0) {
          parts.push(`Resolved ${data.cloudResolved}/${data.cloudLookups} IMDb IDs via Plex cloud${data.cloudFailures ? ` (${data.cloudFailures} failures)` : ''}.`);
        }
        if (data.stillMissingImdb > 0) {
          parts.push(`${data.stillMissingImdb} still missing IMDb.`);
        }
        setMsg(parts.join(' '));
        router.refresh();
      } else {
        setMsg(`Error: ${data.error}`);
      }
    } catch (e) {
      setMsg(`Error: ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      setPending(false);
    }
  }

  return (
    <div className="flex items-center gap-3">
      {msg && <span className="text-sm text-zinc-500 max-w-md truncate" title={msg}>{msg}</span>}
      <button
        onClick={sync}
        disabled={pending}
        className="px-4 py-2 rounded-md bg-blue-600 text-white text-sm font-medium hover:bg-blue-700 disabled:opacity-50 transition-colors"
      >
        {pending ? 'Syncing…' : 'Sync from Plex'}
      </button>
    </div>
  );
}
