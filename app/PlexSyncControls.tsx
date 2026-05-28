'use client';

import { useEffect, useRef, useState } from 'react';
import SyncButton from './SyncButton';
import type { PlexStatusResponse } from './api/plex-status/route';

/** Poll cadence for Plex /activities. 5s matches the recommended UX without
 *  spamming the local Plex server. */
const POLL_INTERVAL_MS = 5_000;

interface ActivitySummary {
  uuid: string;
  title: string;
  subtitle: string | null;
  progress: number | null;
}

interface State {
  /** True when at least one movie-library activity is in flight. */
  busy: boolean;
  activities: ActivitySummary[];
  /** Wall-clock time we first observed the current busy run, for the timer. */
  busyStartedAt: number | null;
  /** Last successful poll wall-clock time. */
  lastFetchAt: number | null;
  /** Last poll errored (Plex unreachable, etc.). Fail open: don't disable Sync. */
  reachable: boolean;
  error?: string;
}

function formatElapsed(ms: number): string {
  const total = Math.floor(ms / 1000);
  const m = Math.floor(total / 60);
  const s = total % 60;
  if (m === 0) return `${s}s`;
  return `${m}m ${s.toString().padStart(2, '0')}s`;
}

export default function PlexSyncControls() {
  const [state, setState] = useState<State>({
    busy: false,
    activities: [],
    busyStartedAt: null,
    lastFetchAt: null,
    reachable: true,
  });
  /** Tick once a second so the elapsed-time label updates between polls. */
  const [, setTick] = useState(0);
  const [scanActionPending, setScanActionPending] = useState<'start' | 'stop' | null>(null);
  const [scanActionMsg, setScanActionMsg] = useState<string | null>(null);
  const mountedRef = useRef(true);
  /** Force the next poll to fire immediately (used after a start/stop click
   *  so the pill updates without waiting up to 5s for the next interval). */
  const refreshSignalRef = useRef<() => void>(() => {});

  useEffect(() => {
    mountedRef.current = true;

    let timer: ReturnType<typeof setTimeout> | null = null;

    async function poll() {
      try {
        const res = await fetch('/api/plex-status', { cache: 'no-store' });
        const data: PlexStatusResponse = await res.json();
        if (!mountedRef.current) return;
        setState((prev) => {
          // Preserve the first-seen timestamp across polls so the timer keeps
          // counting from when the activity *started* (as we first saw it),
          // not from each poll.
          const nowBusy = data.busy;
          let busyStartedAt = prev.busyStartedAt;
          if (nowBusy && !prev.busy) busyStartedAt = Date.now();
          if (!nowBusy) busyStartedAt = null;
          return {
            busy: nowBusy,
            activities: data.activities.map((a) => ({
              uuid: a.uuid,
              title: a.title,
              subtitle: a.subtitle,
              progress: a.progress,
            })),
            busyStartedAt,
            lastFetchAt: Date.now(),
            reachable: data.ok,
            error: data.error,
          };
        });
      } catch (e) {
        if (!mountedRef.current) return;
        setState((prev) => ({
          ...prev,
          reachable: false,
          error: e instanceof Error ? e.message : String(e),
          lastFetchAt: Date.now(),
        }));
      } finally {
        if (mountedRef.current) {
          timer = setTimeout(poll, POLL_INTERVAL_MS);
        }
      }
    }

    poll(); // first call immediately
    // Expose a way for the start/stop handlers to trigger an immediate poll.
    refreshSignalRef.current = () => {
      if (timer) {
        clearTimeout(timer);
        timer = null;
      }
      poll();
    };
    const tickInterval = setInterval(() => setTick((t) => t + 1), 1000);

    return () => {
      mountedRef.current = false;
      if (timer) clearTimeout(timer);
      clearInterval(tickInterval);
      refreshSignalRef.current = () => {};
    };
  }, []);

  async function startScan() {
    setScanActionPending('start');
    setScanActionMsg(null);
    try {
      const res = await fetch('/api/plex-scan/start', { method: 'POST' });
      const data = await res.json();
      if (data.ok) {
        const n = data.started.length;
        setScanActionMsg(`Started scan on ${n} ${n === 1 ? 'library' : 'libraries'}.`);
      } else if (data.error) {
        setScanActionMsg(`Error: ${data.error}`);
      } else {
        const errCount = data.errors?.length ?? 0;
        setScanActionMsg(
          `Started ${data.started?.length ?? 0}, ${errCount} failed. Check terminal.`
        );
      }
    } catch (e) {
      setScanActionMsg(`Error: ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      setScanActionPending(null);
      refreshSignalRef.current();
    }
  }

  async function stopScan() {
    setScanActionPending('stop');
    setScanActionMsg(null);
    try {
      const res = await fetch('/api/plex-scan/stop', { method: 'POST' });
      const data = await res.json();
      if (data.ok) {
        const n = data.stopped.length;
        setScanActionMsg(`Cancelled scan on ${n} ${n === 1 ? 'library' : 'libraries'}.`);
      } else if (data.error) {
        setScanActionMsg(`Error: ${data.error}`);
      } else {
        const errCount = data.errors?.length ?? 0;
        setScanActionMsg(
          `Cancelled ${data.stopped?.length ?? 0}, ${errCount} failed. Check terminal.`
        );
      }
    } catch (e) {
      setScanActionMsg(`Error: ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      setScanActionPending(null);
      refreshSignalRef.current();
    }
  }

  // Only block Sync when we *know* Plex is busy. Unknown / unreachable → fail
  // open so a flaky /activities endpoint can't lock the user out of syncing.
  const syncDisabled = state.busy;
  const disabledReason = state.busy
    ? 'Plex is currently scanning a movie library — wait for it to finish to avoid contention.'
    : undefined;

  // Stop is offered only when Plex is actively busy (nothing to cancel
  // otherwise). Start is offered only when Plex is idle AND reachable
  // (no point queueing another scan into a running one).
  const showStop = state.busy && state.reachable;
  const showStart = !state.busy && state.reachable && !!state.lastFetchAt;

  return (
    <div className="flex flex-col items-end gap-1">
      <div className="flex items-center gap-3">
        <PlexStatusPill state={state} />
        {showStop && (
          <button
            onClick={stopScan}
            disabled={scanActionPending !== null}
            title="Cancel the in-flight Plex scan so you can sync without contention."
            className="px-2 py-1 rounded-md text-xs font-medium bg-zinc-200 dark:bg-zinc-800 text-zinc-700 dark:text-zinc-200 hover:bg-zinc-300 dark:hover:bg-zinc-700 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
          >
            {scanActionPending === 'stop' ? 'Stopping…' : 'Stop scan'}
          </button>
        )}
        {showStart && (
          <button
            onClick={startScan}
            disabled={scanActionPending !== null}
            title="Trigger a normal scan on every movie library."
            className="px-2 py-1 rounded-md text-xs font-medium bg-zinc-200 dark:bg-zinc-800 text-zinc-700 dark:text-zinc-200 hover:bg-zinc-300 dark:hover:bg-zinc-700 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
          >
            {scanActionPending === 'start' ? 'Starting…' : 'Start scan'}
          </button>
        )}
        <SyncButton disabled={syncDisabled} disabledReason={disabledReason} />
      </div>
      {scanActionMsg && (
        <span className="text-xs text-zinc-500 max-w-md truncate" title={scanActionMsg}>
          {scanActionMsg}
        </span>
      )}
    </div>
  );
}

function PlexStatusPill({ state }: { state: State }) {
  if (!state.lastFetchAt) {
    return (
      <span className="text-xs text-zinc-400" title="Checking Plex status…">
        Plex: …
      </span>
    );
  }
  if (!state.reachable) {
    return (
      <span
        className="text-xs text-zinc-400"
        title={state.error ? `Plex unreachable: ${state.error}` : 'Plex unreachable'}
      >
        Plex: status unavailable
      </span>
    );
  }
  if (!state.busy) {
    return (
      <span className="text-xs text-emerald-600 dark:text-emerald-400" title="Plex is idle — safe to sync.">
        Plex: idle
      </span>
    );
  }

  // Busy. Show the first activity's label + progress + elapsed timer.
  const a = state.activities[0];
  const elapsed = state.busyStartedAt ? formatElapsed(Date.now() - state.busyStartedAt) : '';
  const progressText = typeof a?.progress === 'number' ? ` (${a.progress}%)` : '';
  const label = a ? `${a.title}${a.subtitle ? ' — ' + a.subtitle : ''}${progressText}` : 'Plex is busy';
  return (
    <span
      className="inline-flex items-center gap-1 px-2 py-0.5 rounded-md bg-amber-100 dark:bg-amber-900/40 text-amber-800 dark:text-amber-300 text-xs font-medium"
      title={
        state.activities.length > 1
          ? state.activities
              .map((x) => `${x.title}${x.subtitle ? ' — ' + x.subtitle : ''}${typeof x.progress === 'number' ? ` (${x.progress}%)` : ''}`)
              .join('\n')
          : label
      }
    >
      <span className="inline-block w-1.5 h-1.5 rounded-full bg-amber-500 animate-pulse" />
      Plex: {label}
      {elapsed && <span className="text-amber-700/70 dark:text-amber-400/70 ml-1">· {elapsed}</span>}
    </span>
  );
}
