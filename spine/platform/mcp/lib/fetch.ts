export const USER_AGENTS = [
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:133.0) Gecko/20100101 Firefox/133.0',
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.2 Safari/605.1.15',
  'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36 Edg/131.0.0.0',
  'Mozilla/5.0 (X11; Linux x86_64; rv:133.0) Gecko/20100101 Firefox/133.0',
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36',
];

export const ACCEPT_LANGUAGES = [
  'cs,en;q=0.9',
  'cs-CZ,cs;q=0.9,en-US;q=0.8,en;q=0.7',
  'cs-CZ,cs;q=0.9,en;q=0.8',
  'cs,sk;q=0.9,en;q=0.8',
];

const DEFAULT_REFERERS = [
  'https://www.google.com/',
  'https://www.google.cz/',
  'https://www.seznam.cz/',
  'https://www.bing.com/',
  '',
];

export const randomFrom = <T>(arr: T[]): T => arr[Math.floor(Math.random() * arr.length)];

/** Minimal browser-like headers for custom fetch calls (e.g. cookie sessions) */
export const browserHeaders = (): Record<string, string> => ({
  'User-Agent': randomFrom(USER_AGENTS),
  Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
  'Accept-Language': randomFrom(ACCEPT_LANGUAGES),
});

// Fetch with rotated browser-like headers, no cookies, and timeout
export const fetchPage = async (
  url: string,
  referers?: string[],
): Promise<{ status: number; html: string; retryAfter?: number }> => {
  const referer = randomFrom(referers ?? DEFAULT_REFERERS);
  const response = await fetch(url, {
    redirect: 'follow',
    credentials: 'omit',
    headers: {
      ...browserHeaders(),
      Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8',
      'Accept-Encoding': 'gzip, deflate, br',
      'Cache-Control': 'no-cache',
      'Sec-Fetch-Dest': 'document',
      'Sec-Fetch-Mode': 'navigate',
      'Sec-Fetch-Site': 'none',
      'Sec-Fetch-User': '?1',
      'Upgrade-Insecure-Requests': '1',
      ...(referer ? { Referer: referer } : {}),
    },
    signal: AbortSignal.timeout(30_000),
  });
  const html = await response.text();
  const retryAfterHeader = response.headers.get('retry-after');
  const retryAfter = retryAfterHeader ? parseInt(retryAfterHeader, 10) || undefined : undefined;
  return { status: response.status, html, retryAfter };
};
