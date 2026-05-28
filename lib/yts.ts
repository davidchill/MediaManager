// Mirror selection: yts.mx (the canonical host) is blocked by many ISPs at the
// DNS level. yts.bz resolves through Cloudflare and serves the same API. Allow
// override via env so we can swap mirrors without code changes.
const YTS_API = (process.env.YTS_API_BASE || 'https://yts.bz/api/v2').replace(/\/$/, '');

export interface YtsTorrent {
  url: string;
  hash: string;
  quality: string; // "480p" | "720p" | "1080p" | "1080p.x265" | "2160p" | ...
  type: string;    // "bluray" | "web" | "webrip" | ...
  seeds: number;
  peers: number;
  size: string;
  size_bytes: number;
  date_uploaded_unix: number;
}

export interface YtsMovie {
  id: number;
  url: string;
  imdb_code: string;
  title: string;
  year: number;
  torrents?: YtsTorrent[];
}

export interface YtsLookupResult {
  found: boolean;
  movie: YtsMovie | null;
}

export async function lookupByImdbId(imdbId: string): Promise<YtsLookupResult> {
  const url = `${YTS_API}/movie_details.json?imdb_id=${encodeURIComponent(imdbId)}`;
  const res = await fetch(url, {
    headers: { Accept: 'application/json' },
    cache: 'no-store',
  });
  if (!res.ok) {
    throw new Error(`YTS request failed (${res.status} ${res.statusText}) for ${imdbId}`);
  }
  const data = (await res.json()) as {
    status: string;
    data?: { movie?: YtsMovie };
  };
  const movie = data?.data?.movie;
  // YTS returns id=0 when nothing matched the IMDb ID.
  if (!movie || !movie.id || movie.id === 0) {
    return { found: false, movie: null };
  }
  return { found: true, movie };
}

// ---------------------------------------------------------------------------
// Tier-based upgrade detection.
//
// David's library is entirely WEB(Rip) files. An "upgrade" is a torrent on YTS
// whose tier is strictly higher-priority than the file already on disk. Four
// tiers are ranked, anything else on YTS is ignored.
//
// Priority order (1 = best):
//   1. bluray @ 1080p
//   2. bluray @ 720p
//   3. web/webrip @ 1080p.x265
//   4. web/webrip @ 1080p
// ---------------------------------------------------------------------------

export type UpgradeTier =
  | 'bluray-1080p'
  | 'bluray-720p'
  | 'web-1080p.x265'
  | 'web-1080p';

export const TIER_RANK: Record<UpgradeTier, number> = {
  'bluray-1080p': 1,
  'bluray-720p': 2,
  'web-1080p.x265': 3,
  'web-1080p': 4,
};

export const TIER_LABEL: Record<UpgradeTier, string> = {
  'bluray-1080p': 'BluRay 1080p',
  'bluray-720p': 'BluRay 720p',
  'web-1080p.x265': 'WEB 1080p x265',
  'web-1080p': 'WEB 1080p',
};

/** Classify a single YTS torrent into one of our four tracked tiers, or null
 *  if it isn't one of them. `web` and `webrip` are treated as the same
 *  source per project spec. */
export function classifyTorrent(t: YtsTorrent): UpgradeTier | null {
  const type = t.type?.toLowerCase();
  const quality = t.quality?.toLowerCase();
  if (type === 'bluray' && quality === '1080p') return 'bluray-1080p';
  if (type === 'bluray' && quality === '720p') return 'bluray-720p';
  if ((type === 'web' || type === 'webrip') && quality === '1080p.x265') return 'web-1080p.x265';
  if ((type === 'web' || type === 'webrip') && quality === '1080p') return 'web-1080p';
  return null;
}

/** Map the file already on disk (always a WEB(Rip)) to one of our tiers, or
 *  `'below'` if it's lower than every tracked tier (e.g. 720p WEBRip). */
export function classifyCurrentFile(
  resolution: string | null,
  codec: string | null
): UpgradeTier | 'below' {
  const res = (resolution ?? '').toLowerCase();
  const cod = (codec ?? '').toLowerCase();
  // Plex sends "1080" for 1080p content; accept "1080p" too defensively.
  if (res === '1080' || res === '1080p') {
    if (cod === 'hevc' || cod === 'h265' || cod === 'x265') return 'web-1080p.x265';
    return 'web-1080p';
  }
  return 'below';
}

/** True when `best` is strictly higher-priority than `current`. */
export function isStrictUpgrade(
  current: UpgradeTier | 'below',
  best: UpgradeTier | null
): boolean {
  if (!best) return false;
  if (current === 'below') return true;
  return TIER_RANK[best] < TIER_RANK[current];
}

export interface YtsSummary {
  /** Highest-priority tier available on YTS, or null if none of the 4 exist. */
  bestTier: UpgradeTier | null;
  /** The torrent at that tier — used as the canonical link for the upgrade. */
  bestTorrent: YtsTorrent | null;
  /** All tracked tiers present on YTS, highest-priority first. Diagnostic. */
  availableTiers: UpgradeTier[];
}

export function summarize(torrents: YtsTorrent[] | undefined): YtsSummary {
  if (!torrents || torrents.length === 0) {
    return { bestTier: null, bestTorrent: null, availableTiers: [] };
  }
  const tagged: { tier: UpgradeTier; torrent: YtsTorrent }[] = [];
  for (const t of torrents) {
    const tier = classifyTorrent(t);
    if (tier) tagged.push({ tier, torrent: t });
  }
  if (tagged.length === 0) {
    return { bestTier: null, bestTorrent: null, availableTiers: [] };
  }
  tagged.sort((a, b) => TIER_RANK[a.tier] - TIER_RANK[b.tier]);
  const seen = new Set<UpgradeTier>();
  const availableTiers: UpgradeTier[] = [];
  for (const x of tagged) {
    if (!seen.has(x.tier)) {
      seen.add(x.tier);
      availableTiers.push(x.tier);
    }
  }
  return {
    bestTier: tagged[0].tier,
    bestTorrent: tagged[0].torrent,
    availableTiers,
  };
}
