import * as cheerio from 'cheerio';
import { fetchPage } from '../../lib/fetch.js';
import { createProgressTracker, createRateLimiter, retry } from '../../lib/utils.js';
import type { ScraperDb } from './db.js';
import type { ListingData, ScraperConfig } from './types.js';

const REFERERS = [
  'https://www.google.com/',
  'https://www.google.cz/',
  'https://www.seznam.cz/',
  'https://autoline.cz/',
  'https://www.bing.com/',
  '',
];

// Extract autoline ID from URL (the part after --)
const extractAutolineId = (url: string): string | undefined => {
  const match = url.match(/--(\d+)$/);
  return match?.[1];
};

// Parse all JSON-LD blocks from HTML
const parseJsonLd = ($: cheerio.CheerioAPI): Record<string, unknown>[] => {
  const blocks: Record<string, unknown>[] = [];
  $('script[type="application/ld+json"]').each((_, el) => {
    try {
      const text = $(el).text().trim();
      if (text) blocks.push(JSON.parse(text));
    } catch (err) {
      // Malformed JSON-LD — skip block but log for data-quality visibility
      console.debug('[autoline] Malformed JSON-LD block skipped', err);
    }
  });
  return blocks;
};

// Extract data from Product/Vehicle JSON-LD
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
  }

  const images = jsonld.image;
  if (Array.isArray(images)) {
    data.image_urls = JSON.stringify(images);
    data.image_count = images.length;
  }

  // Aggregate rating
  const aggregateRating = jsonld.aggregateRating as Record<string, unknown> | undefined;
  if (aggregateRating) {
    data.aggregate_rating = parseFloat(aggregateRating.ratingValue as string);
    data.review_count = parseInt(aggregateRating.reviewCount as string, 10);
  }

  return data;
};

// Extract data from ImageObject JSON-LD
const extractImageObjectData = (jsonld: Record<string, unknown>): Partial<ListingData> => {
  const data: Partial<ListingData> = {};
  data.seller_name = jsonld.author as string;
  data.content_location = jsonld.contentLocation as string;
  data.date_published = jsonld.datePublished as string;
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

// Spec field name mapping (Czech -> DB column), organized by block data-id
const FIELD_MAP: Record<string, Record<string, string>> = {
  main: {
    'Typ:': 'vehicle_type',
    'Rok výroby:': 'first_registration',
    'První registrace:': 'first_registration',
    'Najeto:': 'mileage',
    'Objem:': 'volume',
    'Užitečné zatížení:': 'payload',
    'Celková hmotnost:': 'gross_weight',
    'Identifikační číslo dealeru:': 'dealer_id',
    'Identifikační číslo dealera:': 'dealer_id',
    'Datum zanesení:': 'listing_date',
  },
  engine: {
    'Výkon:': 'engine_power',
    'Palivo:': 'fuel_type',
    'Objem:': 'engine_displacement',
  },
  description: {
    'Palivová nádrž:': 'fuel_tank',
  },
  gearbox: {
    'Typ:': 'transmission',
  },
  axles: {
    'Počet náprav:': 'axle_count',
    'Konfigurace nápravy:': 'axle_configuration',
    'Rozvor náprav:': 'wheelbase',
  },
  condition: {
    'Stav:': 'condition',
    'VIN:': 'vin',
  },
  'description-additional': {
    'Barva:': 'color',
    'Rozměry karosérie:': 'body_dimensions',
  },
  'additional-options': {
    'Klimatizace:': 'air_conditioning',
  },
};

// Parse HTML specs section
const parseHtmlSpecs = (
  $: cheerio.CheerioAPI,
): {
  mapped: Partial<ListingData>;
  rawSpecs: Record<string, Record<string, string>>;
  features: string[];
} => {
  const mapped: Partial<ListingData> = {};
  const rawSpecs: Record<string, Record<string, string>> = {};
  const features: string[] = [];

  // Process each block with data-id
  $('div.block[data-id]').each((_, blockEl) => {
    const blockId = $(blockEl).attr('data-id') ?? 'unknown';
    rawSpecs[blockId] = {};

    $(blockEl)
      .find('.item')
      .each((__, itemEl) => {
        const $item = $(itemEl);
        const fieldText = $item.find('.field').text().trim();
        const valueText = $item.find('.value').text().trim();

        // Store raw spec
        if (fieldText) {
          rawSpecs[blockId][fieldText.replace(/:$/, '')] = valueText;
        }

        // Items with tick/empty-tick are boolean features
        if ($item.hasClass('with-tick') || $item.hasClass('with-empty-tick')) {
          const featureName = fieldText.replace(/:$/, '');
          if (featureName) {
            if (valueText) {
              features.push(`${featureName}: ${valueText}`);
            } else {
              features.push(featureName);
            }
          }
          return;
        }

        // Map known fields
        const blockMap = FIELD_MAP[blockId];
        if (blockMap && fieldText in blockMap) {
          const dbField = blockMap[fieldText] as keyof ListingData;
          (mapped as Record<string, unknown>)[dbField] = valueText;
        }
      });
  });

  // Extract location from main block
  const locCountry = $('.block[data-id="main"] .loc-country').first().text().trim();
  const locCity = $('.block[data-id="main"] .loc-city').first().text().trim();
  if (locCountry) mapped.location_country = locCountry;
  if (locCity) mapped.location_city = locCity;

  // Parse mileage_km from mileage string
  if (mapped.mileage) {
    const kmMatch = (mapped.mileage as string).replace(/\s/g, '').match(/(\d+)/);
    if (kmMatch) mapped.mileage_km = parseInt(kmMatch[1], 10);
  }

  return { mapped, rawSpecs, features };
};

// Parse a single detail page
export const parseDetailPage = (html: string, url: string): ListingData => {
  const $ = cheerio.load(html);
  const jsonldBlocks = parseJsonLd($);

  const data: ListingData = { url, autoline_id: extractAutolineId(url) };

  // Process JSON-LD blocks
  for (const block of jsonldBlocks) {
    const types = Array.isArray(block['@type']) ? block['@type'] : [block['@type']];

    if (types.includes('Product') || types.includes('Vehicle')) {
      Object.assign(data, extractProductData(block));
    } else if (types.includes('ImageObject')) {
      Object.assign(data, extractImageObjectData(block));
    } else if (types.includes('BreadcrumbList')) {
      Object.assign(data, extractBreadcrumbData(block));
    }
  }

  // Process HTML specs
  const { mapped, rawSpecs, features } = parseHtmlSpecs($);
  Object.assign(data, mapped);

  if (features.length > 0) {
    data.features = JSON.stringify(features);
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
