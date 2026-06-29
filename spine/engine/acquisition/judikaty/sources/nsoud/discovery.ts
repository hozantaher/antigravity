import { XMLParser } from 'fast-xml-parser';
import { fetchPage } from '../../../shared/fetch.js';
import { createRateLimiter } from '../../../shared/utils.js';
import type { ScraperDb } from '../../db.js';
import type { ScraperConfig, UrlInsert } from '../../types.js';

const parser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: '@_',
});

const SITEMAP_URL = 'https://sbirka.nsoud.cz/sitemap.xml';

const REFERERS = ['https://www.google.com/', 'https://www.google.cz/', 'https://www.seznam.cz/', ''];

export const parseSitemapIndex = (xml: string): string[] => {
  const parsed = parser.parse(xml);
  const sitemaps = parsed?.sitemapindex?.sitemap;
  if (!sitemaps) return [];

  const list = Array.isArray(sitemaps) ? sitemaps : [sitemaps];
  return list.map((s: { loc?: string }) => s.loc).filter((loc?: string): loc is string => !!loc);
};

export const parseSitemapUrls = (xml: string): string[] => {
  const parsed = parser.parse(xml);
  const urls = parsed?.urlset?.url;
  if (!urls) return [];

  const list = Array.isArray(urls) ? urls : [urls];
  return list.map((u: { loc: string }) => u.loc).filter((loc: string) => /\/sbirka\/\d+/.test(loc));
};

export const extractIdFromUrl = (url: string): string | undefined => {
  const match = url.match(/\/sbirka\/(\d+)/);
  return match?.[1];
};

export const runDiscovery = async (db: ScraperDb, config: ScraperConfig, isShuttingDown: () => boolean) => {
  console.log('=== NSoud Discovery Phase ===');
  console.log(`Fetching sitemap: ${SITEMAP_URL}`);

  const rateLimiter = createRateLimiter(config.delay);

  await rateLimiter.wait();
  const { status, html: sitemapXml } = await fetchPage(SITEMAP_URL, REFERERS);
  if (status !== 200) {
    throw new Error(`Failed to fetch sitemap: HTTP ${status}`);
  }

  // Try as sitemap index first, then as plain urlset
  const childSitemaps = parseSitemapIndex(sitemapXml);
  let totalUrls = 0;

  if (childSitemaps.length > 0) {
    console.log(`Found ${childSitemaps.length} child sitemaps`);

    for (let i = 0; i < childSitemaps.length; i++) {
      if (isShuttingDown()) break;
      if (config.limit > 0 && totalUrls >= config.limit) break;

      await rateLimiter.wait();
      const { status: childStatus, html: childXml } = await fetchPage(childSitemaps[i], REFERERS);
      if (childStatus !== 200) {
        console.error(`  Failed to fetch child sitemap ${childSitemaps[i]}: HTTP ${childStatus}`);
        continue;
      }

      let urls = parseSitemapUrls(childXml);
      if (config.limit > 0) {
        urls = urls.slice(0, config.limit - totalUrls);
      }

      const urlInserts: UrlInsert[] = urls.map((url) => ({
        url,
        source: 'nsoud' as const,
        external_id: extractIdFromUrl(url),
      }));

      db.insertUrlBatch(urlInserts);
      totalUrls += urls.length;
      rateLimiter.onSuccess();

      console.log(`  [${i + 1}/${childSitemaps.length}] ${urls.length} URLs (total: ${totalUrls.toLocaleString()})`);
    }
  } else {
    // Direct urlset
    let urls = parseSitemapUrls(sitemapXml);
    if (config.limit > 0) urls = urls.slice(0, config.limit);
    const urlInserts: UrlInsert[] = urls.map((url) => ({
      url,
      source: 'nsoud' as const,
      external_id: extractIdFromUrl(url),
    }));

    db.insertUrlBatch(urlInserts);
    totalUrls = urls.length;
    console.log(`Found ${totalUrls} URLs in sitemap`);
  }

  const counts = db.getUrlCounts('nsoud');
  console.log(
    `\nNSoud discovery complete. URLs in DB: ${counts.total.toLocaleString()} (${counts.pending.toLocaleString()} pending)`,
  );
};
