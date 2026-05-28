import { getDb } from '@/lib/db';
import PlexSyncControls from './PlexSyncControls';
import CheckYtsButton from './CheckYtsButton';
import { TIER_LABEL, type UpgradeTier } from '@/lib/yts';

export const dynamic = 'force-dynamic';

type Row = {
  id: number;
  title: string;
  year: number | null;
  imdb_id: string | null;
  file_name: string;
  resolution: string | null;
  video_codec: string | null;
  file_size: number | null;
  yts_found: number | null;
  yts_url: string | null;
  has_upgrade: number | null;
  upgrade_tier: UpgradeTier | null;
  current_tier: UpgradeTier | null;
  best_source: string | null;
  best_quality: string | null;
  checked_at: number | null;
};

function formatSize(bytes: number | null): string {
  if (!bytes) return '—';
  const gb = bytes / 1024 ** 3;
  if (gb >= 1) return `${gb.toFixed(2)} GB`;
  const mb = bytes / 1024 ** 2;
  return `${mb.toFixed(0)} MB`;
}

export default function Home() {
  const db = getDb();
  const movies = db
    .prepare(
      `SELECT
         m.id, m.title, m.year, m.imdb_id, m.file_name, m.resolution, m.video_codec, m.file_size,
         c.found AS yts_found, c.yts_url, c.has_upgrade, c.upgrade_tier, c.current_tier,
         c.best_source, c.best_quality, c.checked_at
       FROM movies m
       LEFT JOIN yts_checks c ON c.movie_id = m.id
       ORDER BY
         CASE WHEN c.has_upgrade = 1 THEN 0 ELSE 1 END,
         m.title COLLATE NOCASE`
    )
    .all() as Row[];

  const upgradeCount = movies.filter((m) => m.has_upgrade === 1).length;
  const checkedCount = movies.filter((m) => m.checked_at !== null).length;

  return (
    <div className="min-h-full bg-zinc-50 dark:bg-zinc-950 text-zinc-900 dark:text-zinc-100">
      <header className="border-b border-zinc-200 dark:border-zinc-800 px-6 py-4 flex flex-wrap items-center justify-between gap-4">
        <div>
          <h1 className="text-xl font-semibold">MediaManager — WEBRip Library</h1>
          <p className="text-sm text-zinc-500">
            {movies.length} tracked · {checkedCount} checked on YTS ·{' '}
            <span className={upgradeCount > 0 ? 'text-emerald-600 dark:text-emerald-400 font-medium' : ''}>
              {upgradeCount} {upgradeCount === 1 ? 'upgrade' : 'upgrades'} available
            </span>
          </p>
        </div>
        <div className="flex items-center gap-3 flex-wrap">
          <PlexSyncControls />
          <CheckYtsButton />
        </div>
      </header>
      <main className="px-6 py-6">
        {movies.length === 0 ? (
          <p className="text-zinc-500">
            No movies synced yet. Click <strong>Sync from Plex</strong> to pull your WEBRip library.
          </p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead className="text-left text-zinc-500 border-b border-zinc-200 dark:border-zinc-800">
                <tr>
                  <th className="py-2 pr-4 font-medium">Title</th>
                  <th className="py-2 pr-4 font-medium">Year</th>
                  <th className="py-2 pr-4 font-medium">Resolution</th>
                  <th className="py-2 pr-4 font-medium">Codec</th>
                  <th className="py-2 pr-4 font-medium">Size</th>
                  <th className="py-2 pr-4 font-medium">IMDb</th>
                  <th className="py-2 pr-4 font-medium">Upgrade</th>
                  <th className="py-2 pr-4 font-medium">File</th>
                </tr>
              </thead>
              <tbody>
                {movies.map((m) => (
                  <tr key={m.id} className="border-b border-zinc-100 dark:border-zinc-900">
                    <td className="py-2 pr-4 font-medium">{m.title}</td>
                    <td className="py-2 pr-4">{m.year ?? '—'}</td>
                    <td className="py-2 pr-4">{m.resolution ?? '—'}</td>
                    <td className="py-2 pr-4">{m.video_codec ?? '—'}</td>
                    <td className="py-2 pr-4">{formatSize(m.file_size)}</td>
                    <td className="py-2 pr-4">
                      {m.imdb_id ? (
                        <a
                          className="text-blue-600 hover:underline"
                          href={`https://www.imdb.com/title/${m.imdb_id}`}
                          target="_blank"
                          rel="noopener noreferrer"
                        >
                          {m.imdb_id}
                        </a>
                      ) : (
                        '—'
                      )}
                    </td>
                    <td className="py-2 pr-4">
                      <UpgradeCell row={m} />
                    </td>
                    <td className="py-2 pr-4 text-zinc-500 truncate max-w-[24rem]" title={m.file_name}>
                      {m.file_name}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </main>
    </div>
  );
}

function UpgradeCell({ row }: { row: Row }) {
  if (!row.imdb_id) {
    return <span className="text-zinc-400 text-xs">no IMDb ID</span>;
  }
  if (row.checked_at === null) {
    return <span className="text-zinc-400 text-xs">not checked</span>;
  }
  if (row.yts_found === 0) {
    return <span className="text-zinc-400 text-xs">not on YTS</span>;
  }
  if (row.has_upgrade === 1 && row.upgrade_tier && row.yts_url) {
    const currentLabel = row.current_tier ? TIER_LABEL[row.current_tier] : 'below tracked tiers';
    return (
      <a
        href={row.yts_url}
        target="_blank"
        rel="noopener noreferrer"
        className="inline-flex items-center gap-1 px-2 py-0.5 rounded-md bg-emerald-100 dark:bg-emerald-900/40 text-emerald-700 dark:text-emerald-300 text-xs font-medium hover:bg-emerald-200 dark:hover:bg-emerald-900/60"
        title={`Current: ${currentLabel} → Upgrade to ${TIER_LABEL[row.upgrade_tier]}`}
      >
        {TIER_LABEL[row.upgrade_tier]}
      </a>
    );
  }
  return (
    <span
      className="text-zinc-400 text-xs"
      title={`Best on YTS: ${row.best_source ?? '—'} ${row.best_quality ?? ''}`}
    >
      no upgrade
    </span>
  );
}
