import * as cheerio from 'cheerio';
import { BlockType, detectBlock } from '../../lib/block-detector.js';
import { createProgressTracker, createRateLimiter, retry } from '../../lib/utils.js';
import { BOT_UA } from './sitemap.js';
import type { ScraperDb } from './db.js';
import type { BusinessData, ScraperConfig, UrlRow } from './types.js';

interface FetchDetailResult {
  status: number;
  html: string;
  retryAfter?: number;
  /** KT-A8 — semantic block classification of this fetch. Defaults to 'none'. */
  blockType: BlockType;
}

/** Fetch a page with bot UA to get SSR content */
const fetchDetailPage = async (url: string): Promise<FetchDetailResult> => {
  const res = await fetch(url, {
    headers: {
      'User-Agent': BOT_UA,
      Accept: 'text/html,application/xhtml+xml',
      'Accept-Encoding': 'gzip, deflate',
      'Accept-Language': 'cs,en;q=0.5',
    },
    redirect: 'follow',
    signal: AbortSignal.timeout(30_000),
  });

  const retryAfterHeader = res.headers.get('retry-after');
  const retryAfter = retryAfterHeader ? parseInt(retryAfterHeader, 10) : undefined;
  const html = await res.text();

  const blockType = detectBlock(res.status, res.headers, html);

  return { status: res.status, html, retryAfter, blockType };
};

/** Parse all JSON-LD blocks from HTML */
const parseJsonLd = ($: cheerio.CheerioAPI): Record<string, unknown>[] => {
  const blocks: Record<string, unknown>[] = [];
  $('script[type="application/ld+json"]').each((_, el) => {
    try {
      const text = $(el).text().trim();
      if (text) blocks.push(JSON.parse(text));
    } catch (err) {
      // Malformed JSON-LD — skip block but log for data-quality visibility
      console.debug('[firmy-cz] Malformed JSON-LD block skipped', err);
    }
  });
  return blocks;
};

/** Extract data from LocalBusiness JSON-LD */
const extractJsonLdData = (jsonld: Record<string, unknown>): Partial<BusinessData> => {
  const data: Partial<BusinessData> = {};

  data.name = jsonld.name as string;
  data.description = jsonld.description as string;
  data.website = jsonld.url as string;
  data.telephone = jsonld.telephone as string;

  // Geo
  const geo = jsonld.geo as Record<string, unknown> | undefined;
  if (geo) {
    const lat = parseFloat(String(geo.latitude));
    const lng = parseFloat(String(geo.longitude));
    if (!isNaN(lat)) data.latitude = lat;
    if (!isNaN(lng)) data.longitude = lng;
  }

  // Address
  const address = jsonld.address as Record<string, unknown> | undefined;
  if (address) {
    data.street_address = address.streetAddress as string;
    data.address_locality = address.addressLocality as string;
    data.postal_code = address.postalCode as string;
    data.address_country = address.addressCountry as string;
  }

  // Opening hours
  const hours = jsonld.openingHours;
  if (hours) {
    data.opening_hours = Array.isArray(hours) ? hours.join(', ') : String(hours);
  }

  // Rating
  const rating = jsonld.aggregateRating as Record<string, unknown> | undefined;
  if (rating) {
    const rv = parseFloat(String(rating.ratingValue));
    const rc = parseInt(String(rating.ratingCount), 10);
    if (!isNaN(rv)) data.rating_value = rv;
    if (!isNaN(rc)) data.rating_count = rc;
  }

  // Image
  const image = jsonld.image;
  if (typeof image === 'string') {
    data.primary_image = image;
  } else if (typeof image === 'object' && image !== null) {
    data.primary_image = (image as Record<string, unknown>).url as string;
  }

  // SameAs (social links)
  const sameAs = jsonld.sameAs;
  if (Array.isArray(sameAs)) {
    data.same_as_json = JSON.stringify(sameAs);
  }

  return data;
};

/** Extract additional data from HTML that's not in JSON-LD */
const extractHtmlData = ($: cheerio.CheerioAPI): Partial<BusinessData> => {
  const data: Partial<BusinessData> = {};

  // Email from mailto: links
  $('a[href^="mailto:"]').each((_, el) => {
    const href = $(el).attr('href');
    if (href) data.email = href.replace('mailto:', '').split('?')[0];
  });

  // Extract ICO (8-digit Czech business ID) from page text
  const bodyText = $('body').text();
  const icoMatch = bodyText.match(/IČO?:?\s*(\d{8})/i);
  if (icoMatch) data.ico = icoMatch[1];

  // Extract other structured fields from label-value pairs
  const labelValueSelectors = ['.detailInfo', '.detailBasicInfo', '.basicInfo', '[class*="info"]'];
  for (const sel of labelValueSelectors) {
    $(sel)
      .find('dt, .label, [class*="label"]')
      .each((_, el) => {
        const label = $(el).text().trim().toLowerCase();
        const value = $(el).next('dd, .value, [class*="value"]').text().trim() || $(el).next().text().trim();

        if (!value) return;

        if (label.includes('datová schránka') || label.includes('datova schranka')) {
          data.datova_schranka = value;
        } else if (label.includes('datum zápisu') || label.includes('datum zapisu')) {
          data.datum_zapisu = value;
        } else if (label.includes('právní forma') || label.includes('pravni forma')) {
          data.pravni_forma = value;
        } else if (label.includes('velikost firmy') || label.includes('velikost')) {
          data.velikost_firmy = value;
        }
      });
  }

  // Categories from breadcrumb or category links
  const categories: Array<{ name: string; url: string }> = [];
  $('a[href*="/firmy.cz/"]')
    .filter((_, el) => {
      const href = $(el).attr('href') || '';
      return !href.includes('/detail/') && !href.includes('/neoverena-firma/') && !href.includes('sitemap');
    })
    .each((_, el) => {
      const name = $(el).text().trim();
      const url = $(el).attr('href') || '';
      if (name && url && name.length < 100) {
        categories.push({ name, url });
      }
    });

  // Note: BreadcrumbList category_path is extracted from pre-parsed jsonldBlocks
  // in parseDetailPage, not here (avoid double JSON-LD parsing)

  if (categories.length > 0) {
    data.categories_json = JSON.stringify(categories.slice(0, 20));
  }

  // Opening hours detail from HTML
  const hoursLines: string[] = [];
  $('[class*="opening"], [class*="hours"], [class*="oteviraci"]')
    .find('tr, li, [class*="row"]')
    .each((_, el) => {
      const text = $(el).text().trim().replace(/\s+/g, ' ');
      if (text && text.length < 100) hoursLines.push(text);
    });
  if (hoursLines.length > 0) {
    data.opening_hours_detail = hoursLines.join('\n');
  }

  // Photos
  const imageUrls: string[] = [];
  $('img[src*="d48-a.sdn.cz"], img[src*="firmy.cz"], img[data-src]').each((_, el) => {
    const src = $(el).attr('src') || $(el).attr('data-src');
    if (src && src.startsWith('http') && !src.includes('logo') && !src.includes('icon')) {
      imageUrls.push(src);
    }
  });
  if (imageUrls.length > 0) {
    const uniqueImages = [...new Set(imageUrls)];
    data.image_urls = JSON.stringify(uniqueImages);
    data.image_count = uniqueImages.length;
  }

  // Filters/services (e.g., "Rozvoz", "Platba kartou")
  // Only take direct text of leaf elements to avoid concatenated parent text
  const filters: string[] = [];
  $('[class*="filter"], [class*="service"], [class*="tag"], [class*="badge"]').each((_, el) => {
    const $el = $(el);
    // Skip if element has child elements with text (parent would concatenate)
    if ($el.children().length > 0 && $el.children().text().trim()) return;
    const text = $el.text().trim();
    if (text && text.length > 1 && text.length < 50 && !text.includes('\n')) {
      filters.push(text);
    }
  });
  if (filters.length > 0) {
    data.filters_json = JSON.stringify([...new Set(filters)]);
  }

  return data;
};

/** Parse a single detail page. Uses UrlRow fields to avoid re-parsing the URL. */
export const parseDetailPage = (html: string, urlRow: UrlRow): BusinessData => {
  const $ = cheerio.load(html);
  const jsonldBlocks = parseJsonLd($);

  const data: BusinessData = {
    url: urlRow.url,
    firmy_id: urlRow.firmy_id ?? undefined,
    url_type: urlRow.url_type ?? undefined,
  };

  // Extract from JSON-LD
  for (const block of jsonldBlocks) {
    const types = Array.isArray(block['@type']) ? block['@type'] : [block['@type']];
    if (types.includes('LocalBusiness') || types.includes('Organization') || types.includes('Store')) {
      Object.assign(data, extractJsonLdData(block));
    } else if (types.includes('BreadcrumbList')) {
      const items = block.itemListElement as Array<{ name: string }> | undefined;
      if (items) {
        data.category_path = items.map((i) => i.name).join(' > ');
      }
    }
  }

  // Extract additional data from HTML
  Object.assign(data, extractHtmlData($));

  // Raw data for reprocessing
  data.raw_jsonld = JSON.stringify(jsonldBlocks);
  data.raw_html = html;

  return data;
};

/** Run the detail scraping phase with worker pool */
export const runDetailPhase = async (db: ScraperDb, config: ScraperConfig, isShuttingDown: () => boolean) => {
  console.log('=== Detail Phase ===');
  console.log(`Concurrency: ${config.concurrency}, Delay: ${config.delay}ms, Max retries: ${config.maxRetries}`);

  const counts = db.getUrlCounts();
  const totalPending = counts.pending + counts.failed;
  const effectiveTotal = config.limit > 0 ? Math.min(config.limit, totalPending) : totalPending;

  console.log(
    `URLs: ${counts.total.toLocaleString()} total, ${totalPending.toLocaleString()} to process${config.limit > 0 ? ` (limited to ${config.limit})` : ''}`,
  );

  if (effectiveTotal === 0) {
    console.log('No URLs to process.');
    return;
  }

  const progress = createProgressTracker(effectiveTotal);
  const rateLimiter = createRateLimiter(config.delay);
  const runId = db.startRun('detail');
  const BATCH_SIZE = 1000;

  let processedTotal = 0;

  const progressInterval = setInterval(() => {
    console.log(`${progress.report()} | Delay: ${rateLimiter.getDelay()}ms`);
  }, 30_000);

  try {
    while (!isShuttingDown()) {
      const remaining = config.limit > 0 ? config.limit - processedTotal : BATCH_SIZE;
      if (remaining <= 0) break;

      const batch = db.getPendingUrls(config.maxRetries, Math.min(BATCH_SIZE, remaining));
      if (batch.length === 0) break;

      let batchIndex = 0;

      const worker = async () => {
        while (!isShuttingDown()) {
          const idx = batchIndex++;
          if (idx >= batch.length) break;

          const urlRow = batch[idx];

          await rateLimiter.wait();

          try {
            let hitRateLimit = false;
            await retry(
              async () => {
                if (hitRateLimit) {
                  await rateLimiter.wait();
                }

                const { status, html, retryAfter, blockType } = await fetchDetailPage(urlRow.url);

                if (status === 404 || status === 410) {
                  db.markGone(urlRow.url);
                  progress.incrementFailed();
                  return;
                }

                // KT-A8 — semantic block detection. A Cloudflare challenge
                // served as HTTP 200 would otherwise sail past the 200-only
                // gate and write an empty BusinessData row. Detect first,
                // log uniformly, then re-throw so the existing retry layer
                // can react.
                if (blockType !== BlockType.None) {
                  // op tag matches the audit-friendly format used by the Go
                  // side (op="firmy_cz.detect_block").
                  console.warn(
                    JSON.stringify({
                      level: 'warn',
                      op: 'firmy_cz.detect_block',
                      message: 'firmy.cz: detekován blok upstream odpovědi',
                      block_type: blockType,
                      http_status: status,
                      target_url: urlRow.url,
                    }),
                  );
                  if (blockType === BlockType.RateLimit && !hitRateLimit) {
                    rateLimiter.onRateLimited(retryAfter);
                    hitRateLimit = true;
                  }
                  throw new Error(`Block detected (${blockType})`);
                }

                if (status === 429) {
                  if (!hitRateLimit) {
                    rateLimiter.onRateLimited(retryAfter);
                    hitRateLimit = true;
                  }
                  throw new Error('Rate limited (429)');
                }

                if (status >= 500) {
                  throw new Error(`Server error (${status})`);
                }

                if (status !== 200) {
                  throw new Error(`Unexpected status ${status}`);
                }

                const business = parseDetailPage(html, urlRow);
                db.saveBusiness(business);
                progress.increment();
                rateLimiter.onSuccess();
              },
              {
                maxRetries: config.maxRetries,
                baseDelay: config.delay,
                onRetry: (attempt, error) => {
                  console.log(`  Retry ${attempt} for ${urlRow.url}: ${error.message}`);
                },
              },
            );
          } catch (error) {
            db.markFailed(urlRow.url, (error as Error).message);
            progress.incrementFailed();
          }
        }
      };

      const workers = Array.from({ length: config.concurrency }, () => worker());
      await Promise.all(workers);

      processedTotal += batch.length;
      console.log(progress.report());
    }
  } finally {
    clearInterval(progressInterval);
    const stats = progress.getStats();
    const status = isShuttingDown() ? 'interrupted' : 'completed';
    db.finishRun(runId, effectiveTotal, stats.scraped, stats.failed, status);
    console.log(
      `\nDetail phase ${status}. Scraped: ${stats.scraped.toLocaleString()}, Failed: ${stats.failed.toLocaleString()}`,
    );
  }
};
