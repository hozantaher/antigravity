import type { BrowserContext, Page } from 'playwright';
import { handleCookieConsent } from './browser.js';
import type { ScraperDb } from './db.js';
import type { ScraperConfig, SearchSegmentRow, VehicleCategory } from './types.js';

// Search URL base — uses the unified search endpoint with vc= param for category
const SEARCH_BASE = 'https://www.mobile.de/cz/vozidel/vyhled%C3%A1v%C3%A1n%C3%AD.html';

// mobile.de price breakpoints from filter dropdown
const PRICE_BREAKPOINTS = [
  0, 500, 1000, 1500, 2000, 2500, 3000, 3500, 4000, 4500, 5000, 6000, 7000, 8000, 9000, 10000, 11000, 12000, 13000,
  14000, 15000, 17500, 20000, 22500, 25000, 27500, 30000, 35000, 40000, 45000, 50000, 55000, 60000, 70000, 80000, 90000,
];

const MAX_PAGES = 50;

export const buildSearchUrl = (category: VehicleCategory, priceFrom: number, priceTo: number): string => {
  let url = `${SEARCH_BASE}?isSearchRequest=true&s=${category}&vc=${category}&sb=rel`;

  // Build price param: p=MIN:MAX
  // priceFrom=0 means no lower bound, priceTo=0 means no upper bound
  if (priceFrom > 0 && priceTo > 0) {
    url += `&p=${priceFrom}:${priceTo}`;
  } else if (priceFrom > 0) {
    url += `&p=${priceFrom}:`;
  } else if (priceTo > 0) {
    url += `&p=:${priceTo}`;
  }

  return url;
};

// Generate initial price segments from breakpoints
export const generateInitialSegments = (
  category: string,
): Array<{ category: string; price_from: number; price_to: number }> => {
  const segments: Array<{ category: string; price_from: number; price_to: number }> = [];

  for (let i = 0; i < PRICE_BREAKPOINTS.length - 1; i++) {
    segments.push({
      category,
      price_from: PRICE_BREAKPOINTS[i],
      price_to: PRICE_BREAKPOINTS[i + 1],
    });
  }

  // Last segment: 90000+ (no upper bound, represented as 0)
  segments.push({
    category,
    price_from: PRICE_BREAKPOINTS[PRICE_BREAKPOINTS.length - 1],
    price_to: 0,
  });

  return segments;
};

// Browser-side scripts as strings to avoid tsx __name injection
/* v8 ignore start -- browser-executed JS, not testable from Node */
const EXTRACT_LISTING_URLS_SCRIPT = `(() => {
  var results = [];
  var links = document.querySelectorAll('a[data-testid$="-link"][href*="/podrobnosti.html"]');
  var seen = {};
  for (var i = 0; i < links.length; i++) {
    var href = links[i].href;
    if (!href) continue;
    try {
      var url = new URL(href);
      var id = url.searchParams.get('id');
      if (id && !seen[id]) {
        seen[id] = true;
        results.push({ url: url.origin + url.pathname + '?id=' + id, mobile_id: id });
      }
    } catch (e) {}
  }
  return results;
})()`;

const EXTRACT_TOTAL_RESULTS_SCRIPT = `(() => {
  var h1 = document.querySelector('h1');
  if (h1 && h1.textContent) {
    var cleaned = h1.textContent.replace(/\\s/g, '');
    var match = cleaned.match(/^(\\d+)/);
    if (match) return match[1];
  }
  return null;
})()`;

const EXTRACT_PAGINATION_SCRIPT = `(() => {
  var pagDiv = document.querySelector('[data-testid="srp-pagination"]');
  if (!pagDiv) return { currentPage: 1, maxPage: 1 };
  var buttons = pagDiv.querySelectorAll('button');
  var maxPage = 1;
  var currentPage = 1;
  for (var i = 0; i < buttons.length; i++) {
    var text = buttons[i].textContent ? buttons[i].textContent.trim() : '';
    var num = parseInt(text, 10);
    if (!isNaN(num)) {
      if (num > maxPage) maxPage = num;
      if (buttons[i].disabled && num > 0) currentPage = num;
    }
  }
  return { currentPage: currentPage, maxPage: maxPage };
})()`;
/* v8 ignore stop */

const extractListingUrls = async (page: Page): Promise<Array<{ url: string; mobile_id: string }>> => {
  return page.evaluate(EXTRACT_LISTING_URLS_SCRIPT);
};

const extractTotalResults = async (page: Page): Promise<number | undefined> => {
  try {
    const countText: string | null = await page.evaluate(EXTRACT_TOTAL_RESULTS_SCRIPT);
    if (countText) {
      const num = parseInt(countText, 10);
      return isNaN(num) ? undefined : num;
    }
  } catch {
    // Could not extract count
  }
  return undefined;
};

const extractPaginationInfo = async (page: Page): Promise<{ currentPage: number; maxPage: number }> => {
  return page.evaluate(EXTRACT_PAGINATION_SCRIPT);
};

const clickNextPage = async (page: Page): Promise<boolean> => {
  try {
    const nextBtn = page.locator('[data-testid="pagination:next"]');
    if ((await nextBtn.isVisible({ timeout: 2000 })) && (await nextBtn.isEnabled())) {
      await nextBtn.click();
      await page.waitForTimeout(2000);
      return true;
    }
  } catch {
    // No next button or not clickable
  }
  return false;
};

const formatPriceRange = (segment: SearchSegmentRow): string => {
  const from = segment.price_from > 0 ? `${segment.price_from}` : '0';
  const to = segment.price_to > 0 ? `${segment.price_to}` : '\u221E';
  return `${from}-${to}\u20AC`;
};

// Split a segment in half and create sub-segments
const splitSegment = (db: ScraperDb, segment: SearchSegmentRow) => {
  const { category, price_from, price_to } = segment;

  // Mark current segment as split
  db.updateSegment({ id: segment.id, last_page_scraped: 0, status: 'split' });

  if (price_to === 0) {
    // Open-ended segment (e.g. 90000+): split at price_from * 2
    const mid = price_from + Math.max(Math.floor(price_from / 2), 5000);
    db.insertSegments([
      { category, price_from, price_to: mid },
      { category, price_from: mid, price_to: 0 },
    ]);
    console.log(`    Split ${formatPriceRange(segment)} -> ${price_from}-${mid}\u20AC + ${mid}-\u221E\u20AC`);
  } else {
    const mid = Math.floor((price_from + price_to) / 2);
    // Avoid creating zero-width segments
    if (mid <= price_from || mid >= price_to) {
      console.log(
        `    Cannot split ${formatPriceRange(segment)} further (range too narrow). Will scrape first ${MAX_PAGES} pages.`,
      );
      // Revert to pending — scrape what we can
      db.updateSegment({ id: segment.id, last_page_scraped: 0, status: 'pending' });
      return;
    }
    db.insertSegments([
      { category, price_from, price_to: mid },
      { category, price_from: mid, price_to },
    ]);
    console.log(`    Split ${formatPriceRange(segment)} -> ${price_from}-${mid}\u20AC + ${mid}-${price_to}\u20AC`);
  }
};

// Scrape a single search segment
const scrapeSegment = async (
  page: Page,
  db: ScraperDb,
  segment: SearchSegmentRow,
  config: ScraperConfig,
  isShuttingDown: () => boolean,
): Promise<void> => {
  const category = segment.category as VehicleCategory;
  const rangeLabel = formatPriceRange(segment);
  const startPage = segment.last_page_scraped + 1;

  // Navigate to search page for this segment
  const searchUrl = buildSearchUrl(category, segment.price_from, segment.price_to);
  const pageUrl = startPage > 1 ? `${searchUrl}&pageNumber=${startPage}` : searchUrl;

  await page.goto(pageUrl, { waitUntil: 'domcontentloaded', timeout: 30000 });
  await handleCookieConsent(page);
  await page.waitForTimeout(2000);

  // Extract total results and pagination info
  const totalResults = await extractTotalResults(page);
  const { maxPage } = await extractPaginationInfo(page);

  console.log(`  [${category}] ${rangeLabel}: ${totalResults?.toLocaleString() ?? '?'} results, ${maxPage} pages`);

  // Update segment with discovered info
  db.updateSegment({
    id: segment.id,
    total_results: totalResults,
    last_page_scraped: startPage - 1,
    total_pages: maxPage,
    status: 'in_progress',
  });

  // If too many pages, split this segment
  if (maxPage > MAX_PAGES) {
    console.log(`    Too many pages (${maxPage} > ${MAX_PAGES}), splitting...`);
    splitSegment(db, segment);
    return;
  }

  // If no results at all, mark completed
  if (totalResults === 0 || maxPage === 0) {
    db.updateSegment({ id: segment.id, last_page_scraped: 0, total_pages: 0, status: 'completed' });
    return;
  }

  let totalCollected = 0;

  for (let pageNum = startPage; pageNum <= maxPage; pageNum++) {
    if (isShuttingDown()) break;

    const listings = await extractListingUrls(page);

    if (listings.length === 0) {
      console.log(`    ${rangeLabel} p${pageNum}: No listings found, stopping segment.`);
      break;
    }

    const inserted = db.insertUrlBatch(listings.map((l) => ({ url: l.url, mobile_id: l.mobile_id, category })));

    totalCollected += listings.length;
    console.log(`    ${rangeLabel} p${pageNum}/${maxPage}: ${listings.length} URLs (${inserted} new)`);

    db.updateSegment({
      id: segment.id,
      last_page_scraped: pageNum,
      status: pageNum >= maxPage ? 'completed' : 'in_progress',
    });

    if (pageNum < maxPage) {
      const delay = config.delay + Math.random() * config.delay;
      await page.waitForTimeout(delay);

      const navigated = await clickNextPage(page);
      if (!navigated) {
        const nextUrl = `${searchUrl}&pageNumber=${pageNum + 1}`;
        await page.goto(nextUrl, { waitUntil: 'domcontentloaded', timeout: 30000 });
        await page.waitForTimeout(2000);
      }
    }
  }

  if (!isShuttingDown()) {
    db.updateSegment({
      id: segment.id,
      last_page_scraped: maxPage,
      status: 'completed',
    });
  }

  console.log(`    ${rangeLabel} done. Collected ${totalCollected} URLs.`);
};

// Process all segments for a category
const processCategory = async (
  context: BrowserContext,
  db: ScraperDb,
  category: VehicleCategory,
  config: ScraperConfig,
  isShuttingDown: () => boolean,
) => {
  // Initialize segments if none exist
  const existingCount = db.getSegmentCountForCategory(category);
  if (existingCount === 0) {
    const segments = generateInitialSegments(category);
    db.insertSegments(segments);
    console.log(`  [${category}] Created ${segments.length} initial price segments`);
  } else {
    const stats = db.getSegmentStats(category);
    console.log(`  [${category}] Resuming. Segments: ${JSON.stringify(stats)}`);
  }

  const page = await context.newPage();

  try {
    // Process segments in a loop — new segments may be added by splitting
    let iteration = 0;
    while (!isShuttingDown()) {
      const pending = db.getPendingSegments(category);
      if (pending.length === 0) break;

      iteration++;
      if (iteration > 1) {
        console.log(`  [${category}] Pass ${iteration}: ${pending.length} segments remaining`);
      }

      for (const segment of pending) {
        if (isShuttingDown()) break;
        await scrapeSegment(page, db, segment, config, isShuttingDown);
      }
    }

    const stats = db.getSegmentStats(category);
    console.log(`  [${category}] Finished. Segment stats: ${JSON.stringify(stats)}`);
  } finally {
    await page.close();
  }
};

// Run the search phase for all categories
export const runSearchPhase = async (
  context: BrowserContext,
  db: ScraperDb,
  config: ScraperConfig,
  isShuttingDown: () => boolean,
) => {
  console.log('=== Search Phase (Adaptive Price-Range Segmentation) ===');
  console.log(`Categories: ${config.categories.join(', ')}`);

  const runId = db.startRun('search');
  let totalUrls = 0;

  try {
    for (const category of config.categories) {
      if (isShuttingDown()) break;

      console.log(`\nProcessing category: ${category}`);
      await processCategory(context, db, category, config, isShuttingDown);

      const counts = db.getUrlCounts();
      totalUrls = counts.total;
      console.log(`  Total URLs in DB so far: ${totalUrls.toLocaleString()}`);
    }

    const counts = db.getUrlCounts();
    const status = isShuttingDown() ? 'interrupted' : 'completed';
    db.finishRun(runId, counts.total, counts.total, 0, status);
    console.log(`\nSearch phase ${status}. Total URLs in DB: ${counts.total.toLocaleString()}`);
  } catch (error) {
    db.finishRun(runId, totalUrls, 0, 0, 'failed');
    throw error;
  }
};
