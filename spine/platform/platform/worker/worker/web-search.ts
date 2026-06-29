const SEARXNG_URL = process.env.SEARXNG_URL;
const MAX_RESULTS = 5;
const TIMEOUT = 15_000;
const MAX_RETRIES = 2;

interface SearxResult {
  title: string;
  url: string;
  content?: string;
}

const isTransientError = (e: unknown): boolean =>
  e instanceof TypeError || // fetch network error (DNS, connection refused)
  (e instanceof DOMException && e.name === 'TimeoutError'); // AbortSignal.timeout

const fetchWithRetry = async (url: URL, retries: number): Promise<Response> => {
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(TIMEOUT) });
      if (res.ok) return res;
      if (res.status >= 500 && attempt < retries) {
        await new Promise((r) => setTimeout(r, 1000 * (attempt + 1)));
        continue;
      }
      throw new Error(`SearXNG HTTP ${res.status}`);
    } catch (e) {
      if (isTransientError(e) && attempt < retries) {
        await new Promise((r) => setTimeout(r, 1000 * (attempt + 1)));
        continue;
      }
      throw e;
    }
  }
  throw new Error('SearXNG: max retries exceeded');
};

/**
 * Search the web via SearXNG. Returns formatted results or a graceful
 * "not available" message — never throws, so Claude can continue without it.
 */
export const searchWeb = async (query: string): Promise<string> => {
  if (!SEARXNG_URL) {
    return 'Web search is not available (SEARXNG_URL not configured). Use database tools instead.';
  }

  try {
    const url = new URL('/search', SEARXNG_URL);
    url.searchParams.set('q', query);
    url.searchParams.set('format', 'json');
    url.searchParams.set('language', 'cs');
    url.searchParams.set('categories', 'general');

    const res = await fetchWithRetry(url, MAX_RETRIES);
    const data = (await res.json()) as { results?: SearxResult[] };
    const results = (data.results || []).slice(0, MAX_RESULTS);

    if (results.length === 0) return 'No web results found for this query.';

    return results
      .map((r, i) => `${i + 1}. ${r.title}\n   ${r.url}\n   ${r.content || ''}`)
      .join('\n\n');
  } catch {
    return 'Web search temporarily unavailable. Use database tools instead.';
  }
};
