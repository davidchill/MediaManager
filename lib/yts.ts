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

const QUALITY_RANK: Record<string, number> = {
  '480p': 1,
  '720p': 2,
  '1080p': 3,
  '1080p.x265': 3,
  '2160p': 4,
  '2160p.x265': 4,
};

function rankQuality(q: string): number {
  return QUALITY_RANK[q.toLowerCase()] ?? 0;
}

export interface YtsSummary {
  bestSource: string | null;
  bestQuality: string | null;
  hasBluray: boolean;
  blurayQualities: string[];
}

export function summarize(torrents: YtsTorrent[] | undefined): YtsSummary {
  if (!torrents || torrents.length === 0) {
    return { bestSource: null, bestQuality: null, hasBluray: false, blurayQualities: [] };
  }

  const blurayTorrents = torrents.filter((t) => t.type?.toLowerCase() === 'bluray');
  const blurayQualities = Array.from(new Set(blurayTorrents.map((t) => t.quality)))
    .sort((a, b) => rankQuality(b) - rankQuality(a));

  // best overall = highest-ranked quality, tie-broken by source preference (bluray > web > webrip).
  const sourceRank: Record<string, number> = { bluray: 3, web: 2, webrip: 1 };
  const sorted = [...torrents].sort((a, b) => {
    const q = rankQuality(b.quality) - rankQuality(a.quality);
    if (q !== 0) return q;
    return (sourceRank[b.type?.toLowerCase()] ?? 0) - (sourceRank[a.type?.toLowerCase()] ?? 0);
  });
  const best = sorted[0];

  return {
    bestSource: best.type ?? null,
    bestQuality: best.quality ?? null,
    hasBluray: blurayTorrents.length > 0,
    blurayQualities,
  };
}
