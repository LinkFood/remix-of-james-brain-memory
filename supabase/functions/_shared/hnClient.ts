/**
 * hnClient — Hacker News substrate via Algolia HN Search API.
 *
 * Class-kill for vendor-API-substrate-mismatch (sibling of Ship 10's UW
 * NBBO finding 2026-05-14). Tavily indexes web PAGES; for "top trending
 * HN stories" the indexed pages are marketing blogs, archived Ask HNs,
 * historical Kaggle datasets — not the live front page. The 5/14 morning
 * research run surfaced 8 sources, ZERO with real-time rankings.
 *
 * Algolia HN Search API (https://hn.algolia.com/api) is HN's official
 * search index; the `front_page` tag returns the live HN front page in
 * one call with structured fields (title, points, num_comments,
 * created_at, url, story_id). Public, no auth, no budget.
 *
 * Firebase API was the alternative (https://hacker-news.firebaseio.com)
 * but requires N+1 fetches (topstories.json → /item/{id}.json per item).
 * Algolia is one call. Picked Algolia.
 *
 * Routes from jac-research-agent based on intent detection
 * (isHackerNewsIntent) — non-HN queries continue through Tavily.
 */

const ALGOLIA_BASE = 'https://hn.algolia.com/api/v1';

export interface HackerNewsItem {
  title: string;
  url: string | null;
  points: number;
  num_comments: number;
  created_at: string;
  story_id: number;
  author: string;
  /** Direct link to the HN comment thread, regardless of whether url is set. */
  hn_url: string;
}

export interface HackerNewsResult {
  items: HackerNewsItem[];
  source: 'front_page' | 'search';
  query?: string;
  fetched_at: string;
}

/**
 * Heuristic intent detector. True if the query is asking for HN-specific
 * data ("top HN", "trending hacker news", "what's on HN today", etc.).
 * Conservative — favors Tavily on ambiguous queries since Tavily is the
 * general fallback. Case-insensitive.
 */
export function isHackerNewsIntent(query: string): boolean {
  if (!query) return false;
  const q = query.toLowerCase();
  // Direct mentions of HN as a source.
  if (/\bhacker\s*news\b/.test(q)) return true;
  if (/\bycombinator\b/.test(q)) return true;
  if (/\bnews\.ycombinator\b/.test(q)) return true;
  // Bare "HN" as a token (require word boundary so we don't match "phone").
  if (/\bhn\b/.test(q)) return true;
  return false;
}

/**
 * Fetch HN front page (default) or run a query against the search index.
 * `hitsPerPage` caps result count; default 10 (Algolia max 1000 but we
 * never need that many for a research synthesis).
 */
export async function searchHackerNews(opts: {
  query?: string;
  limit?: number;
} = {}): Promise<HackerNewsResult> {
  const limit = Math.max(1, Math.min(50, opts.limit ?? 10));
  const fetchedAt = new Date().toISOString();

  // No query → front page (live ranking). With query → search the HN index.
  const params = new URLSearchParams();
  params.set('hitsPerPage', String(limit));
  if (opts.query && opts.query.trim()) {
    params.set('query', opts.query.trim());
    params.set('tags', 'story');
  } else {
    params.set('tags', 'front_page');
  }

  const resp = await fetch(`${ALGOLIA_BASE}/search?${params.toString()}`);
  if (!resp.ok) {
    throw new Error(`Algolia HN ${resp.status}: ${await resp.text().catch(() => '')}`);
  }
  const data = await resp.json() as {
    hits: Array<{
      title?: string;
      url?: string | null;
      points?: number;
      num_comments?: number;
      created_at?: string;
      story_id?: number;
      objectID?: string;
      author?: string;
    }>;
  };

  const items: HackerNewsItem[] = (data.hits ?? []).map((h) => {
    const story_id = h.story_id ?? (h.objectID ? Number(h.objectID) : 0);
    return {
      title: h.title ?? '',
      url: h.url ?? null,
      points: h.points ?? 0,
      num_comments: h.num_comments ?? 0,
      created_at: h.created_at ?? '',
      story_id,
      author: h.author ?? '',
      hn_url: `https://news.ycombinator.com/item?id=${story_id}`,
    };
  });

  return {
    items,
    source: opts.query && opts.query.trim() ? 'search' : 'front_page',
    query: opts.query,
    fetched_at: fetchedAt,
  };
}

/**
 * Format a HackerNewsResult into the same shape jac-research-agent expects
 * from jac-web-search (contextForLLM string + sources array). Keeps the
 * downstream synthesis prompt identical regardless of substrate.
 */
export function formatHackerNewsForResearch(result: HackerNewsResult): {
  contextForLLM: string;
  sources: Array<{ title: string; url: string }>;
} {
  const header = result.source === 'front_page'
    ? `Hacker News front-page rankings (live via Algolia HN Search API, fetched ${result.fetched_at}). ${result.items.length} stories.`
    : `Hacker News search results for "${result.query}" (live via Algolia HN Search API, fetched ${result.fetched_at}). ${result.items.length} stories.`;

  const lines: string[] = [header, ''];
  for (let i = 0; i < result.items.length; i++) {
    const it = result.items[i];
    lines.push(
      `${i + 1}. [${it.points} pts · ${it.num_comments} comments · by ${it.author} · ${it.created_at}] ${it.title}`,
    );
    if (it.url) lines.push(`   URL: ${it.url}`);
    lines.push(`   HN thread: ${it.hn_url}`);
    lines.push('');
  }

  const sources = result.items.map((it) => ({
    title: it.title,
    // Prefer the original article URL; fall back to the HN thread.
    url: it.url ?? it.hn_url,
  }));

  return {
    contextForLLM: lines.join('\n'),
    sources,
  };
}
