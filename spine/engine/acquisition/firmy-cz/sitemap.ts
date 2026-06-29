import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { gunzipSync } from 'node:zlib';
import { createFileCache } from '../shared/cache.js';
import { parseSitemapIndex } from '../shared/sitemap.js';
import { XMLParser } from 'fast-xml-parser';
import type { ScraperDb } from './db.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const cache = createFileCache(resolve(__dirname, '.sitemap-cache'));

export const BOT_UA = 'Mozilla/5.0 (compatible; SeznamBot/4.0; +http://napoveda.seznam.cz/seznambot-intro/)';

const SITEMAP_INDEX_URL = 'https://www.firmy.cz/sitemap.xml';

const DETAIL_PATTERN = /\/detail\/\d+-/;
const UNVERIFIED_PATTERN = /\/neoverena-firma\/\d+-/;

const parser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: '@_',
});

/**
 * Fetch timeout for sitemap index + sub-sitemap downloads. firmy.cz sitemaps
 * are small (<5 MB each) and usually respond in <2s; 30s is a generous
 * ceiling that still guarantees the cron job finishes in a bounded time
 * if the server hangs. Matches lib/fetch.ts convention. (SEND debt H1)
 */
const SITEMAP_FETCH_TIMEOUT_MS = 30_000;

/** Fetch with bot UA, handle gzip, cache to disk */
const fetchWithCache = async (url: string, cacheKey: string): Promise<{ content: string; fromCache: boolean }> => {
  const cached = cache.get(cacheKey);
  if (cached) return { content: cached, fromCache: true };

  const res = await fetch(url, {
    headers: { 'User-Agent': BOT_UA, Accept: 'application/xml, text/xml, */*' },
    signal: AbortSignal.timeout(SITEMAP_FETCH_TIMEOUT_MS),
  });

  if (!res.ok) throw new Error(`Failed to fetch ${url}: HTTP ${res.status}`);

  let content: string;
  if (url.endsWith('.gz') || (res.headers.get('content-type') || '').includes('gzip')) {
    const buffer = Buffer.from(await res.arrayBuffer());
    content = gunzipSync(buffer).toString('utf-8');
  } else {
    content = await res.text();
  }

  cache.set(cacheKey, content);
  return { content, fromCache: false };
};

/** Parse sitemap XML → list of URL strings */
const parseSitemapUrlStrings = (xml: string): string[] => {
  const parsed = parser.parse(xml);
  const urls = parsed?.urlset?.url;
  if (!urls) return [];
  const list = Array.isArray(urls) ? urls : [urls];
  return list.map((u: { loc: string }) => u.loc).filter(Boolean);
};

const isBusinessUrl = (url: string): boolean => {
  return DETAIL_PATTERN.test(url) || UNVERIFIED_PATTERN.test(url);
};

export const runSitemapPhase = async (db: ScraperDb, onShuttingDown: () => boolean) => {
  console.log('=== Sitemap Phase ===');
  console.log(`Fetching sitemap index: ${SITEMAP_INDEX_URL}`);

  const { content: indexXml } = await fetchWithCache(SITEMAP_INDEX_URL, 'sitemap-index.xml');
  const sitemapUrls = parseSitemapIndex(indexXml);

  console.log(`Found ${sitemapUrls.length} sitemap files`);

  let totalUrls = 0;
  let totalBusiness = 0;
  let cachedCount = 0;

  for (let i = 0; i < sitemapUrls.length; i++) {
    if (onShuttingDown()) {
      console.log('Shutdown requested, stopping sitemap phase');
      break;
    }

    const sitemapUrl = sitemapUrls[i];
    const fileName = sitemapUrl.split('/').pop() ?? sitemapUrl;
    const cacheKey = fileName.replace(/\.gz$/, '');

    try {
      const { content, fromCache } = await fetchWithCache(sitemapUrl, cacheKey);
      if (fromCache) cachedCount++;

      const urls = parseSitemapUrlStrings(content);
      totalUrls += urls.length;

      const businessUrls = urls.filter(isBusinessUrl);
      totalBusiness += businessUrls.length;

      if (businessUrls.length > 0) {
        db.insertUrlBatch(businessUrls, fileName);
      }

      const tag = fromCache ? 'cached' : 'fetched';
      console.log(
        `  [${i + 1}/${sitemapUrls.length}] ${cacheKey}: ${urls.length} URLs, ${businessUrls.length} businesses [${tag}] (total: ${totalBusiness.toLocaleString()})`,
      );
      if (!fromCache && i < sitemapUrls.length - 1) {
        await new Promise((r) => setTimeout(r, 1000));
      }
    } catch (error) {
      console.error(`  [${i + 1}/${sitemapUrls.length}] ${fileName}: ERROR - ${(error as Error).message}`);
    }
  }

  if (cachedCount > 0) console.log(`Used cache for ${cachedCount}/${sitemapUrls.length} sitemaps`);

  const counts = db.getUrlCounts();
  console.log(
    `\nSitemap phase complete. URLs: ${totalUrls.toLocaleString()} total, ${totalBusiness.toLocaleString()} businesses.`,
  );
  console.log(`DB: ${counts.total.toLocaleString()} URLs (${counts.pending.toLocaleString()} pending)`);

  return counts;
};
