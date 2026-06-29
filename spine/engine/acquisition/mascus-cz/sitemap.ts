import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createFileCache } from '../shared/cache.js';
import { fetchPage } from '../shared/fetch.js';
import { parseSitemapIndex, parseSitemapUrls } from '../shared/sitemap.js';
import type { ScraperDb } from './db.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const cache = createFileCache(resolve(__dirname, '.sitemap-cache'));

const REFERERS = [
  'https://www.google.com/',
  'https://www.google.cz/',
  'https://www.seznam.cz/',
  'https://www.mascus.cz/',
  'https://www.bing.com/',
  '',
];

const SITEMAP_INDEX_URL = 'https://www.mascus.cz/sitemap_index_cz.xml';

const fetchWithCache = async (url: string, cacheKey: string): Promise<{ content: string; fromCache: boolean }> => {
  const cached = cache.get(cacheKey);
  if (cached) return { content: cached, fromCache: true };

  const { status, html } = await fetchPage(url, REFERERS);
  if (status !== 200) throw new Error(`Failed to fetch ${url}: HTTP ${status}`);

  cache.set(cacheKey, html);
  return { content: html, fromCache: false };
};

export const runSitemapPhase = async (db: ScraperDb, onShuttingDown: () => boolean) => {
  console.log('=== Sitemap Phase ===');
  console.log(`Fetching sitemap index: ${SITEMAP_INDEX_URL}`);

  const { content: indexXml } = await fetchWithCache(SITEMAP_INDEX_URL, 'sitemap-index.xml');
  const sitemapUrls = parseSitemapIndex(indexXml, (url) => url.includes('_local_ads'));

  console.log(`Found ${sitemapUrls.length} advert sitemap files`);

  let totalUrls = 0;
  let cachedCount = 0;

  for (let i = 0; i < sitemapUrls.length; i++) {
    if (onShuttingDown()) {
      console.log('Shutdown requested, stopping sitemap phase');
      break;
    }

    const sitemapUrl = sitemapUrls[i];
    const fileName = sitemapUrl.split('/').pop() ?? sitemapUrl;
    let fromCache = false;

    try {
      const result = await fetchWithCache(sitemapUrl, fileName);
      fromCache = result.fromCache;
      const urls = parseSitemapUrls(result.content);

      db.insertUrlBatch(urls, fileName);
      totalUrls += urls.length;
      if (fromCache) cachedCount++;

      const tag = fromCache ? 'cached' : 'fetched';
      console.log(
        `  [${i + 1}/${sitemapUrls.length}] ${fileName}: ${urls.length} URLs [${tag}] (total: ${totalUrls.toLocaleString()})`,
      );
    } catch (error) {
      console.error(`  [${i + 1}/${sitemapUrls.length}] ${fileName}: ERROR - ${(error as Error).message}`);
    }

    if (!fromCache && i < sitemapUrls.length - 1) {
      await new Promise((resolve) => setTimeout(resolve, 500));
    }
  }

  if (cachedCount > 0) console.log(`Used cache for ${cachedCount}/${sitemapUrls.length} sitemaps`);

  const counts = db.getUrlCounts();
  console.log(
    `\nSitemap phase complete. Total URLs in DB: ${counts.total.toLocaleString()} (${counts.pending.toLocaleString()} pending)`,
  );

  return counts;
};
