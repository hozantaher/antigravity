import * as cheerio from 'cheerio';
import { fetchPage } from '../shared/fetch.js';
import { createProgressTracker, createRateLimiter, retry } from '../shared/utils.js';
import type { ScraperDb } from './db.js';
import type { ListingData, ScraperConfig } from './types.js';

const REFERERS = [
  'https://www.google.com/',
  'https://www.google.cz/',
  'https://www.seznam.cz/',
  'https://www.mascus.cz/',
  'https://www.bing.com/',
  '',
];

// Extract mascus ID from URL (slug before .html)
const extractMascusId = (url: string): string | undefined => {
  const match = url.match(/\/([^/]+)\.html$/);
  return match?.[1];
};

// Parse all JSON-LD blocks from HTML (mascus wraps them in arrays)
const parseJsonLd = ($: cheerio.CheerioAPI): Record<string, unknown>[] => {
  const blocks: Record<string, unknown>[] = [];
  $('script[type="application/ld+json"]').each((_, el) => {
    try {
      const text = $(el).text().trim();
      if (!text) return;
      const parsed = JSON.parse(text);
      if (Array.isArray(parsed)) {
        for (const item of parsed) {
          if (item && typeof item === 'object') blocks.push(item);
        }
      } else if (parsed && typeof parsed === 'object') {
        blocks.push(parsed);
      }
    } catch {
      // Skip malformed JSON-LD
    }
  });
  return blocks;
};

// Extract data from Product JSON-LD
const extractProductData = (jsonld: Record<string, unknown>): Partial<ListingData> => {
  const data: Partial<ListingData> = {};

  data.name = jsonld.name as string;
  data.description = jsonld.description as string;
  data.sku = jsonld.sku as string;

  const brand = jsonld.brand as Record<string, unknown> | undefined;
  if (brand) data.brand = brand.name as string;

  data.model = jsonld.model as string;

  const offers = jsonld.offers as Record<string, unknown> | undefined;
  if (offers) {
    data.price = typeof offers.price === 'number' ? offers.price : parseFloat(offers.price as string);
    data.price_currency = offers.priceCurrency as string;
    data.item_condition = offers.itemCondition as string;
    data.availability = offers.availability as string;

    // Seller from offers
    const seller = offers.seller as Record<string, unknown> | undefined;
    if (seller) data.seller_name = seller.name as string;
  }

  return data;
};

// Extract data from BreadcrumbList JSON-LD
const extractBreadcrumbData = (jsonld: Record<string, unknown>): Partial<ListingData> => {
  const data: Partial<ListingData> = {};
  const items = jsonld.itemListElement as Array<Record<string, unknown>> | undefined;
  if (items && items.length > 0) {
    const names = items.map((i) => i.name as string);
    data.category_path = names.join(' > ');
    // Category is the second-to-last item (last is the listing itself)
    if (names.length >= 2) {
      data.category = names[names.length - 2];
    }
  }
  return data;
};

// Flat field name mapping (Czech label -> DB column)
const FIELD_MAP: Record<string, keyof ListingData> = {
  'Rok výroby': 'year_of_manufacture',
  'Najeté km': 'mileage',
  'Umístění stroje': 'location_city',
  Stát: 'location_country',
  'Rok registrace': 'first_registration',
  'Konfigurace náprav': 'axle_configuration',
  'Výrobní číslo (VIN)': 'vin',
  VIN: 'vin',
  'Registrační číslo': 'registration_number',
  'Třída emisí': 'emission_class',
  'Výkon motoru': 'engine_power',
  'Zdvihový objem motoru': 'engine_displacement',
  Převodovka: 'transmission',
  'Brutto hmotnost': 'gross_weight',
  'Celková hmotnost': 'gross_weight',
};

// Parse HTML specs section
const parseHtmlSpecs = (
  $: cheerio.CheerioAPI,
): {
  mapped: Partial<ListingData>;
  rawSpecs: Record<string, string>;
} => {
  const mapped: Partial<ListingData> = {};
  const rawSpecs: Record<string, string> = {};

  // Mascus uses .key-value-wrapper with .key-value-label + .key-value-value
  $('.key-value-wrapper').each((_, wrapperEl) => {
    const $wrapper = $(wrapperEl);
    const label = $wrapper.find('.key-value-label').text().trim().replace(/:$/, '');
    const value = $wrapper.find('.key-value-value').text().trim();

    if (!label) return;

    // Store raw spec
    rawSpecs[label] = value;

    // Map known fields
    if (label in FIELD_MAP) {
      const dbField = FIELD_MAP[label];
      (mapped as Record<string, unknown>)[dbField] = value;
    }
  });

  // Parse mileage_km from mileage string
  if (mapped.mileage) {
    const kmMatch = (mapped.mileage as string).replace(/\s/g, '').match(/(\d+)/);
    if (kmMatch) mapped.mileage_km = parseInt(kmMatch[1], 10);
  }

  return { mapped, rawSpecs };
};

// Parse image URLs from gallery thumbnails (slides use lazy-loaded placeholders)
const parseImageUrls = ($: cheerio.CheerioAPI): { imageUrls: string[]; imageCount: number } => {
  const imageUrls: string[] = [];

  $('.image-gallery-thumbnail-image').each((_, el) => {
    const src = $(el).attr('src');
    if (src && src.startsWith('http') && !imageUrls.includes(src)) {
      imageUrls.push(src);
    }
  });

  return { imageUrls, imageCount: imageUrls.length };
};

// Parse a single detail page
export const parseDetailPage = (html: string, url: string): ListingData => {
  const $ = cheerio.load(html);
  const jsonldBlocks = parseJsonLd($);

  const data: ListingData = { url, mascus_id: extractMascusId(url) };

  // Process JSON-LD blocks
  for (const block of jsonldBlocks) {
    const types = Array.isArray(block['@type']) ? block['@type'] : [block['@type']];

    if (types.includes('Product') || types.includes('Vehicle')) {
      Object.assign(data, extractProductData(block));
    } else if (types.includes('BreadcrumbList')) {
      Object.assign(data, extractBreadcrumbData(block));
    }
  }

  // Process HTML specs
  const { mapped, rawSpecs } = parseHtmlSpecs($);
  Object.assign(data, mapped);

  // Process images from HTML
  const { imageUrls, imageCount } = parseImageUrls($);
  if (imageCount > 0) {
    data.image_urls = JSON.stringify(imageUrls);
    data.image_count = imageCount;
  }

  data.raw_specs_json = JSON.stringify(rawSpecs);
  data.raw_jsonld = JSON.stringify(jsonldBlocks);

  return data;
};

// Run the detail scraping phase with worker pool
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

  // Report progress every 30 seconds
  const progressInterval = setInterval(() => {
    console.log(`${progress.report()} | Delay: ${rateLimiter.getDelay()}ms`);
  }, 30_000);

  try {
    while (!isShuttingDown()) {
      const remaining = config.limit > 0 ? config.limit - processedTotal : BATCH_SIZE;
      if (remaining <= 0) break;

      const batch = db.getPendingUrls(config.maxRetries, Math.min(BATCH_SIZE, remaining));
      if (batch.length === 0) break;

      // Process batch with worker pool
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
                // On 429 retry, wait through the rate limiter instead of firing immediately
                if (hitRateLimit) {
                  await rateLimiter.wait();
                }

                const { status, html, retryAfter } = await fetchPage(urlRow.url, REFERERS);

                if (status === 404 || status === 410) {
                  db.markGone(urlRow.url);
                  progress.incrementFailed();
                  return;
                }

                if (status === 429) {
                  // Only escalate delay once per URL, not per retry attempt
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

                const listing = parseDetailPage(html, urlRow.url);
                db.saveListing(listing);
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

      // Launch concurrent workers
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
