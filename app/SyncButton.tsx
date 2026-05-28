'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';

interface SyncButtonProps {
  /** External gate (e.g. Plex is mid-scan). Composes with internal pending. */
  disabled?: boolean;
  /** Tooltip explaining why the button is externally disabled. */
  disabledReason?: string;
}

export default function SyncButton({ disabled = false, disabledReason }: SyncButtonProps = {}) {
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
          `Synced ${data.webripCount} WEBRips (scanned ${data.totalScanned} movies across ${data.librariesScanned} ${data.librariesScanned === 1 ? 'library' : 'libraries'}).`,
        ];
        if (data.cloudLookups > 0) {
          parts.push(`Resolved ${data.cloudResolved}/${data.cloudLookups} IMDb IDs via Plex cloud${data.cloudFailures ? ` (${data.cloudFailures} failures)` : ''}.`);
        }
        if (data.stillMissingImdb > 0) {
          parts.push(`${data.stillMissingImdb} still missing IMDb.`);
        }
        if (data.removalSkipped) {
          parts.push(`⚠ Cleanup skipped: would have removed ${data.wouldHaveRemoved} rows (>30% of DB). Investigate before re-syncing.`);
        } else if (data.removedUpgraded > 0 || data.removedDeleted > 0) {
          const bits: string[] = [];
          if (data.removedUpgraded > 0) bits.push(`${data.removedUpgraded} upgraded`);
          if (data.removedDeleted > 0) bits.push(`${data.removedDeleted} deleted from Plex`);
          parts.push(`Removed ${bits.join(', ')}.`);
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
        disabled={pending || disabled}
        title={disabled ? disabledReason : undefined}
        className="px-4 py-2 rounded-md bg-blue-600 text-white text-sm font-medium hover:bg-blue-700 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
      >
        {pending ? 'Syncing…' : 'Sync from Plex'}
      </button>
    </div>
  );
}
