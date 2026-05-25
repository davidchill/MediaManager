'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';

type ProgressStatus = 'upgrade' | 'no_bluray' | 'not_on_yts' | 'error';

interface ProgressState {
  index: number;
  total: number;
  title: string;
  status: ProgressStatus;
  upgradesSoFar: number;
}

interface DoneSummary {
  ok: boolean;
  error?: string;
  checked?: number;
  skippedFresh?: number;
  skippedNoImdb?: number;
  upgradesAvailable?: number;
  errors?: number;
}

export default function CheckYtsButton() {
  const [pending, setPending] = useState(false);
  const [progress, setProgress] = useState<ProgressState | null>(null);
  const [summary, setSummary] = useState<string | null>(null);
  const router = useRouter();

  async function check(force: boolean) {
    setPending(true);
    setProgress(null);
    setSummary(null);

    let upgradesSoFar = 0;

    try {
      const res = await fetch(`/api/check-yts${force ? '?force=1' : ''}`, { method: 'POST' });
      if (!res.body) throw new Error('No response body');

      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buffer = '';

      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split('\n');
        buffer = lines.pop() ?? '';

        for (const line of lines) {
          const trimmed = line.trim();
          if (!trimmed) continue;
          let event: { type: string } & Record<string, unknown>;
          try {
            event = JSON.parse(trimmed);
          } catch {
            continue;
          }

          if (event.type === 'start') {
            setProgress({
              index: 0,
              total: event.toCheck as number,
              title: '',
              status: 'no_bluray',
              upgradesSoFar: 0,
            });
            if (event.toCheck === 0) {
              setSummary(
                `Nothing to check. ${event.skippedFresh} fresh, ${event.skippedNoImdb} without IMDb ID. Use "Force all" to recheck.`
              );
            }
          } else if (event.type === 'progress') {
            if (event.status === 'upgrade') upgradesSoFar++;
            setProgress({
              index: event.index as number,
              total: event.total as number,
              title: event.title as string,
              status: event.status as ProgressStatus,
              upgradesSoFar,
            });
          } else if (event.type === 'done') {
            const d = event as unknown as DoneSummary;
            if (d.ok) {
              setSummary(
                `Done. Checked ${d.checked} (skipped ${d.skippedFresh} fresh, ${d.skippedNoImdb} without IMDb). ${d.upgradesAvailable} BluRay upgrade${d.upgradesAvailable === 1 ? '' : 's'} available.${d.errors ? ` ${d.errors} errors.` : ''}`
              );
              router.refresh();
            } else {
              setSummary(`Error: ${d.error ?? 'unknown'}`);
            }
          }
        }
      }
    } catch (e) {
      setSummary(`Error: ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      setPending(false);
      setProgress(null);
    }
  }

  const pct = progress && progress.total > 0 ? Math.round((progress.index / progress.total) * 100) : 0;

  return (
    <div className="flex flex-col items-end gap-2 min-w-[20rem]">
      <div className="flex items-center gap-3">
        {summary && !pending && (
          <span className="text-sm text-zinc-500 max-w-md truncate" title={summary}>
            {summary}
          </span>
        )}
        <button
          onClick={() => check(false)}
          disabled={pending}
          className="px-4 py-2 rounded-md bg-emerald-600 text-white text-sm font-medium hover:bg-emerald-700 disabled:opacity-50 transition-colors"
          title="Skips movies checked in the last 24 hours."
        >
          {pending ? 'Checking…' : 'Check YTS'}
        </button>
        <button
          onClick={() => check(true)}
          disabled={pending}
          className="px-3 py-2 rounded-md border border-zinc-300 dark:border-zinc-700 text-xs text-zinc-600 dark:text-zinc-300 hover:bg-zinc-100 dark:hover:bg-zinc-900 disabled:opacity-50 transition-colors"
          title="Force re-check every movie, ignoring the 24-hour skip."
        >
          Force all
        </button>
      </div>

      {pending && progress && (
        <div className="w-full max-w-md">
          <div className="flex justify-between text-xs text-zinc-500 mb-1 tabular-nums">
            <span>
              {progress.index} / {progress.total}
              {progress.upgradesSoFar > 0 && (
                <span className="text-emerald-600 dark:text-emerald-400 ml-2">
                  · {progress.upgradesSoFar} upgrade{progress.upgradesSoFar === 1 ? '' : 's'}
                </span>
              )}
            </span>
            <span>{pct}%</span>
          </div>
          <div className="h-2 w-full rounded-full bg-zinc-200 dark:bg-zinc-800 overflow-hidden">
            <div
              className="h-full bg-emerald-500 transition-all duration-150 ease-out"
              style={{ width: `${pct}%` }}
            />
          </div>
          {progress.title && (
            <div className="text-xs text-zinc-500 mt-1 truncate" title={progress.title}>
              {statusIcon(progress.status)} {progress.title}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function statusIcon(status: ProgressStatus): string {
  switch (status) {
    case 'upgrade':
      return '⬆';
    case 'no_bluray':
      return '·';
    case 'not_on_yts':
      return '✕';
    case 'error':
      return '!';
  }
}
