import type { BrowserContext, Page } from 'playwright';
import { createProgressTracker, createRateLimiter, retry } from '../../lib/utils.js';
import { handleCookieConsent } from './browser.js';
import type { ScraperDb } from './db.js';
import type { ListingData, ScraperConfig } from './types.js';

// Parse price text like "12 345 €" or "12.345 €" to number
export const parsePrice = (text: string): number | undefined => {
  if (!text) return undefined;
  const cleaned = text
    .replace(/[^\d,.]/g, '')
    .replace(/\./g, '')
    .replace(',', '.');
  const num = parseFloat(cleaned);
  return isNaN(num) ? undefined : num;
};

// Parse mileage text like "123 456 km" to number
export const parseMileageKm = (text: string): number | undefined => {
  if (!text) return undefined;
  const cleaned = text.replace(/[^\d]/g, '');
  const num = parseInt(cleaned, 10);
  return isNaN(num) ? undefined : num;
};

// Browser-side extraction script as a string to avoid tsx __name injection
/* v8 ignore start -- browser-executed JS, not testable from Node */
const EXTRACT_SCRIPT = `(() => {
  var getText = function(selector) {
    var el = document.querySelector(selector);
    return el ? el.textContent.trim() : null;
  };

  var getTestIdText = function(testId) {
    var el = document.querySelector('[data-testid="' + testId + '"]');
    return el ? el.textContent.trim() : null;
  };

  var getKeyFeatureValue = function(name) {
    var el = document.querySelector('[data-testid="vip-key-features-list-item-' + name + '"]');
    if (!el) return null;
    // Element has label span + value span; get the last child for the value
    var ch = el.children;
    if (ch.length >= 2) {
      return ch[ch.length - 1].textContent.trim() || el.textContent.trim();
    }
    // Fallback: try dd element inside
    var dd = el.querySelector('dd');
    if (dd) return dd.textContent.trim();
    return el.textContent.trim();
  };

  // Title from main-cta-box h2 or fallback to first h2/h1
  var title = getText('[data-testid="main-cta-box"] h2') || getText('h2') || getText('h1');

  // Price
  var priceLabel = getTestIdText('vip-price-label');
  var priceCzk = null;
  var priceEvaluation = null;
  var priceArea = document.querySelector('[data-testid="main-price-area"]');
  if (priceArea) {
    var children = priceArea.children;
    for (var i = 0; i < children.length; i++) {
      var text = children[i].textContent.trim();
      if (text.indexOf('Kč') !== -1) priceCzk = text;
    }
    if (priceLabel) {
      var fullText = priceArea.textContent.trim();
      var afterPrice = fullText.replace(priceLabel, '').replace(priceCzk || '', '').trim();
      if (afterPrice && afterPrice.indexOf('€') === -1 && afterPrice.indexOf('Kč') === -1) {
        priceEvaluation = afterPrice;
      }
    }
  }

  // Key features
  var mileageRaw = getKeyFeatureValue('mileage');
  var power = getKeyFeatureValue('power');
  var fuel = getKeyFeatureValue('fuel');
  var transmission = getKeyFeatureValue('transmission');
  var firstRegistration = getKeyFeatureValue('firstRegistration');
  var numOwnersRaw = getKeyFeatureValue('numberOfPreviousOwners');

  // Technical data
  var technicalData = {};
  var techBox = document.querySelector('[data-testid="vip-technical-data-box"]');
  if (techBox) {
    var dts = techBox.querySelectorAll('dt[data-testid]');
    for (var j = 0; j < dts.length; j++) {
      var dt = dts[j];
      var testId = dt.getAttribute('data-testid') || '';
      var key = testId.replace('-item', '');
      var dd = dt.nextElementSibling;
      if (dd && dd.tagName === 'DD') {
        technicalData[key] = dd.textContent.trim();
      }
    }
  }

  // Features
  var features = [];
  var featureItems = document.querySelectorAll('[data-testid="vip-features-list"] li');
  for (var k = 0; k < featureItems.length; k++) {
    var ft = featureItems[k].textContent.trim();
    if (ft) features.push(ft);
  }

  // Description
  var description = getTestIdText('vip-vehicle-description-text');

  // Seller name - the name is inside seller-title-address > first div > first div (title class)
  var sellerName = null;
  var sta = document.querySelector('[data-testid="seller-title-address"]');
  if (sta) {
    var firstDiv = sta.firstElementChild;
    if (firstDiv) {
      var titleDiv = firstDiv.firstElementChild;
      if (titleDiv) sellerName = titleDiv.textContent.trim();
    }
    if (!sellerName) sellerName = getText('[data-testid="vip-dealer-box-content"] h2');
  }
  var sellerAddress1 = getTestIdText('vip-dealer-box-seller-address1');
  var sellerAddress2 = getTestIdText('vip-dealer-box-seller-address2');

  var sellerRating = null;
  var sellerRatingCount = null;
  var ratingEl = document.querySelector('[data-testid="vip-dealer-box-rating"]');
  if (ratingEl) {
    var ratingText = ratingEl.textContent.trim();
    var ratingMatch = ratingText.match(/([\\d,]+)\\s*od\\s*5/);
    if (ratingMatch) sellerRating = ratingMatch[1];
    var countMatch = ratingText.match(/(\\d+)\\s*(?:hodnocení|recenz)/i);
    if (countMatch) sellerRatingCount = countMatch[1];
  }

  var sellerId = null;
  var dealerLink = document.querySelector('[data-testid="vip-dealer-box-dealer-homepage-link"]');
  if (dealerLink && dealerLink.href) {
    var idMatch = dealerLink.href.match(/customerId=(\\d+)/);
    if (idMatch) sellerId = idMatch[1];
  }

  // Images
  var imageUrls = [];
  var seenUrls = {};
  var galleryImgs = document.querySelectorAll('[data-testid="image-gallery"] img, [data-testid="thumbnail-gallery"] img');
  for (var m = 0; m < galleryImgs.length; m++) {
    var src = galleryImgs[m].src || galleryImgs[m].getAttribute('data-src');
    if (src && src.indexOf('placeholder') === -1 && !seenUrls[src]) {
      seenUrls[src] = true;
      imageUrls.push(src);
    }
  }

  var keyFeaturesBox = document.querySelector('[data-testid="vip-key-features-box"]');
  var rawKeyFeatures = keyFeaturesBox ? keyFeaturesBox.textContent.trim() : null;

  return {
    title: title,
    priceLabel: priceLabel,
    priceCzk: priceCzk,
    priceEvaluation: priceEvaluation,
    mileageRaw: mileageRaw,
    power: power,
    fuel: fuel,
    transmission: transmission,
    firstRegistration: firstRegistration,
    numOwnersRaw: numOwnersRaw,
    technicalData: technicalData,
    features: features,
    description: description,
    sellerName: sellerName,
    sellerAddress1: sellerAddress1,
    sellerAddress2: sellerAddress2,
    sellerRating: sellerRating,
    sellerRatingCount: sellerRatingCount,
    sellerId: sellerId,
    imageUrls: imageUrls,
    rawKeyFeatures: rawKeyFeatures
  };
})()`;

// Check if page is a valid listing
const IS_LISTING_SCRIPT = `(() => {
  return !!document.querySelector('[data-testid="vip-price-label"], [data-testid="vip-key-features-box"], h1');
})()`;
/* v8 ignore stop */

interface RawListingData {
  title: string | null;
  priceLabel: string | null;
  priceCzk: string | null;
  priceEvaluation: string | null;
  mileageRaw: string | null;
  power: string | null;
  fuel: string | null;
  transmission: string | null;
  firstRegistration: string | null;
  numOwnersRaw: string | null;
  technicalData: Record<string, string>;
  features: string[];
  description: string | null;
  sellerName: string | null;
  sellerAddress1: string | null;
  sellerAddress2: string | null;
  sellerRating: string | null;
  sellerRatingCount: string | null;
  sellerId: string | null;
  imageUrls: string[];
  rawKeyFeatures: string | null;
}

// Extract all listing data from a detail page
const extractListingData = async (page: Page, url: string, mobileId: string): Promise<ListingData> => {
  const rawData: RawListingData = await page.evaluate(EXTRACT_SCRIPT);

  const listing: ListingData = {
    url,
    mobile_id: mobileId,
    title: rawData.title ?? undefined,
    price_eur: parsePrice(rawData.priceLabel ?? ''),
    price_czk: parsePrice(rawData.priceCzk ?? ''),
    price_evaluation: rawData.priceEvaluation ?? undefined,
    mileage: rawData.technicalData?.mileage ?? rawData.mileageRaw ?? undefined,
    mileage_km: parseMileageKm(rawData.technicalData?.mileage ?? rawData.mileageRaw ?? ''),
    power: rawData.technicalData?.power ?? rawData.power ?? undefined,
    fuel: rawData.technicalData?.fuel ?? rawData.fuel ?? undefined,
    transmission: rawData.technicalData?.transmission ?? rawData.transmission ?? undefined,
    first_registration: rawData.technicalData?.firstRegistration ?? rawData.firstRegistration ?? undefined,
    num_owners: rawData.numOwnersRaw ? parseInt(rawData.numOwnersRaw.replace(/\D/g, ''), 10) || undefined : undefined,
    damage_condition: rawData.technicalData?.damageCondition ?? undefined,
    body_category: rawData.technicalData?.category ?? undefined,
    model_range: rawData.technicalData?.modelRange ?? undefined,
    trim_line: rawData.technicalData?.trimLine ?? undefined,
    cubic_capacity: rawData.technicalData?.cubicCapacity ?? undefined,
    engine_type: rawData.technicalData?.['envkv.engineType'] ?? undefined,
    energy_consumption: rawData.technicalData?.['envkv.energyConsumption'] ?? undefined,
    co2_emissions: rawData.technicalData?.['envkv.co2Emissions'] ?? undefined,
    co2_class: rawData.technicalData?.['envkv.co2Class'] ?? undefined,
    fuel_consumption: rawData.technicalData?.['envkv.consumptionDetails.fuel'] ?? undefined,
    num_seats: rawData.technicalData?.numSeats
      ? parseInt(rawData.technicalData.numSeats.replace(/\D/g, ''), 10) || undefined
      : undefined,
    door_count: rawData.technicalData?.doorCount ?? undefined,
    climatisation: rawData.technicalData?.climatisation ?? undefined,
    park_assists: rawData.technicalData?.parkAssists ?? undefined,
    airbag: rawData.technicalData?.airbag ?? undefined,
    manufacturer_color: rawData.technicalData?.manufacturerColorName ?? undefined,
    color: rawData.technicalData?.color ?? undefined,
    interior: rawData.technicalData?.interior ?? undefined,
    features: rawData.features.length > 0 ? JSON.stringify(rawData.features) : undefined,
    description: rawData.description ?? undefined,
    seller_name: rawData.sellerName ?? undefined,
    seller_address1: rawData.sellerAddress1 ?? undefined,
    seller_address2: rawData.sellerAddress2 ?? undefined,
    seller_rating: rawData.sellerRating ?? undefined,
    seller_rating_count: rawData.sellerRatingCount ?? undefined,
    seller_id: rawData.sellerId ?? undefined,
    image_urls: rawData.imageUrls.length > 0 ? JSON.stringify(rawData.imageUrls) : undefined,
    image_count: rawData.imageUrls.length || undefined,
    raw_technical_data:
      Object.keys(rawData.technicalData).length > 0 ? JSON.stringify(rawData.technicalData) : undefined,
    raw_key_features: rawData.rawKeyFeatures ?? undefined,
  };

  return listing;
};

// Run the detail scraping phase with worker pool
export const runDetailPhase = async (
  context: BrowserContext,
  db: ScraperDb,
  config: ScraperConfig,
  isShuttingDown: () => boolean,
) => {
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
  const BATCH_SIZE = 500;

  let processedTotal = 0;

  // Create worker pages
  const pages: Page[] = [];
  for (let i = 0; i < config.concurrency; i++) {
    const page = await context.newPage();
    pages.push(page);
  }

  // Accept cookies on first page to set context-wide cookie
  if (pages.length > 0) {
    try {
      await pages[0].goto('https://www.mobile.de/cz/', { waitUntil: 'domcontentloaded', timeout: 15000 });
      await handleCookieConsent(pages[0]);
    } catch {
      // Non-critical
    }
  }

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

      const worker = async (page: Page) => {
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

                const response = await page.goto(urlRow.url, {
                  waitUntil: 'domcontentloaded',
                  timeout: 30000,
                });

                const status = response?.status() ?? 0;

                if (status === 404 || status === 410) {
                  db.markGone(urlRow.url);
                  progress.incrementFailed();
                  return;
                }

                if (status === 429 || status === 403) {
                  if (!hitRateLimit) {
                    rateLimiter.onRateLimited();
                    hitRateLimit = true;
                  }
                  throw new Error(`Blocked (${status})`);
                }

                if (status >= 500) {
                  throw new Error(`Server error (${status})`);
                }

                // Wait for main content to render
                await page.waitForTimeout(1000 + Math.random() * 1000);

                // Check if page is a valid listing
                const isListing: boolean = await page.evaluate(IS_LISTING_SCRIPT);

                if (!isListing) {
                  const currentUrl = page.url();
                  if (!currentUrl.includes('podrobnosti') && !currentUrl.includes('details')) {
                    db.markGone(urlRow.url);
                    progress.incrementFailed();
                    return;
                  }
                }

                const listing = await extractListingData(page, urlRow.url, urlRow.mobile_id);

                // Get category from URL row
                if (urlRow.category) {
                  listing.category = urlRow.category;
                }

                // [ANTIGRAVITY FÁZE 3]: Přepojení DB na Symphony Queue
                // Namísto synchronního zápisu do SQLite, zkontrolujeme přes DeltaEngine
                const { DeltaEngine } = await import('../../../../demand/acquisition/deep-inventory/delta-engine.js');
                const { SymphonyQueue } = await import('../../../../engine/automation/symphony-queue/index.js');
                
                const isNewOrDiscounted = await DeltaEngine.evaluateOpportunity(
                  listing.mobile_id, 
                  listing.price_czk || listing.price_eur || 0
                );
                
                if (isNewOrDiscounted) {
                   await SymphonyQueue.enqueue({
                     id: `arb_${listing.mobile_id}`,
                     assetId: listing.mobile_id,
                     expectedProfit: (listing.price_czk || listing.price_eur || 0) * 0.15,
                     metadata: {
                       title: listing.title || 'Unknown',
                       price: listing.price_czk || listing.price_eur || 0,
                       url: listing.url
                     }
                   });
                }
                
                // Keep db.saveListing for legacy fallback if necessary, but we are effectively migrating.
                try { db.saveListing(listing); } catch(e) {}
                
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

      // Launch concurrent workers (each with its own Page)
      const workers = pages.slice(0, config.concurrency).map((page) => worker(page));
      await Promise.all(workers);

      processedTotal += batch.length;
      console.log(progress.report());
    }
  } finally {
    clearInterval(progressInterval);

    // Close worker pages
    for (const page of pages) {
      try {
        await page.close();
      } catch {
        /* already closed */
      }
    }

    const stats = progress.getStats();
    const status = isShuttingDown() ? 'interrupted' : 'completed';
    db.finishRun(runId, effectiveTotal, stats.scraped, stats.failed, status);
    console.log(
      `\nDetail phase ${status}. Scraped: ${stats.scraped.toLocaleString()}, Failed: ${stats.failed.toLocaleString()}`,
    );
  }
};
