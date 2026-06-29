import * as cheerio from 'cheerio';
import { browserHeaders } from '../../../shared/fetch.js';
import { createRateLimiter } from '../../../shared/utils.js';
import type { ScraperDb } from '../../db.js';
import type { ScraperConfig, UrlInsert } from '../../types.js';
import { generateYearRanges } from '../../utils.js';

const BASE_URL = 'https://vyhledavac.nssoud.cz';

/**
 * NSSoud (vyhledavac.nssoud.cz) uses an ASP.NET Core MVC form with anti-forgery tokens.
 * Flow:
 *   1. GET / → get the full search form HTML and __RequestVerificationToken
 *   2. Parse all form fields from <form id="findform">
 *   3. Fill in date range fields and submit via POST with btSubmit
 *   4. Response includes results in <table class="infinite-scroll"> and currParams for pagination
 *   5. Load more results via POST /Home/MyResTRowsCont with vyhledavaciPodminky, pageNum, etc.
 */

/** Parse the #findform and extract all input fields as key-value pairs */
const serializeForm = (html: string, dateFrom?: string, dateTo?: string): string => {
  const $ = cheerio.load(html);
  const params: Array<[string, string]> = [];

  const form = $('form#findform');
  if (!form.length) throw new Error('Form #findform not found');

  form.find('input').each((_, el) => {
    const name = $(el).attr('name');
    if (!name) return;

    const type = ($(el).attr('type') ?? 'text').toLowerCase();
    if (['submit', 'button', 'image', 'reset'].includes(type)) return;
    if (['checkbox', 'radio'].includes(type) && !$(el).is(':checked')) return;

    let val = $(el).val() as string | undefined;

    // Fill in date fields if provided
    if (
      dateFrom &&
      name.includes('vyhledavaciPodminka[0]') &&
      name.includes('HodnotaDatumACasOd') &&
      name.includes('vyhledavaciSekce[1]')
    ) {
      val = dateFrom;
    } else if (
      dateTo &&
      name.includes('vyhledavaciPodminka[0]') &&
      name.includes('HodnotaDatumACasDo') &&
      name.includes('vyhledavaciSekce[1]')
    ) {
      val = dateTo;
    }

    params.push([name, val ?? '']);
  });

  // Include the anti-forgery token from outside the form if needed
  const antiForgery = $('input[name="__RequestVerificationToken"]').val() as string | undefined;
  if (antiForgery && !params.some(([n]) => n === '__RequestVerificationToken')) {
    params.push(['__RequestVerificationToken', antiForgery]);
  }

  // Add submit button
  params.push(['btSubmit', '']);

  return new URLSearchParams(params).toString();
};

export const parseResultRows = (html: string): UrlInsert[] => {
  const $ = cheerio.load(html);
  const urls: UrlInsert[] = [];

  // Result rows are <tr> in the infinite-scroll table (or in AJAX response HTML)
  // Each row has: #, checkbox, date, case number, senate, form, result, ..., links
  $('tr').each((_, row) => {
    const $row = $(row);

    // Skip header rows
    if ($row.find('th').length > 0) return;

    // Find document links — /DokumentOriginal/Index/{id} or /DokumentOriginal/Text/{id}
    const link = $row.find('a[href*="/DokumentOriginal/"]').first();
    if (!link.length) return;

    const href = link.attr('href') ?? '';

    // Extract document ID from URL (works for both /Index/{id} and /Text/{id})
    const idMatch = href.match(/\/DokumentOriginal\/(?:Index|Text)\/(\d+)/);
    const docId = idMatch?.[1];

    // Always store the HTML (Text) URL, even if the page links to /Index/ (PDF)
    const textPath = docId ? `/DokumentOriginal/Text/${docId}` : href;
    const detailUrl = href.startsWith('http')
      ? href.replace(/\/DokumentOriginal\/Index\//, '/DokumentOriginal/Text/')
      : `${BASE_URL}${textPath}`;
    const externalId = docId;

    // Also get the hidden field ID: ZobrazeneVysledky[N].ID
    const hiddenId = $row.find('input[name$=".ID"]').val() as string | undefined;

    // Extract data from table cells
    const cells = $row.find('td');
    const datumText = cells.eq(2).text().trim(); // Column 2: date
    const spZnText = cells.eq(3).text().trim(); // Column 3: case number (e.g. "1 As 262/2023 - 19")

    // Clean up case number — remove non-breaking spaces
    const spZn = spZnText
      .replace(/\u00a0/g, ' ')
      .replace(/\s+-\s+\d+$/, '')
      .trim();

    urls.push({
      url: detailUrl,
      source: 'nssoud',
      external_id: hiddenId ?? externalId,
      soud: 'Nejvyšší správní soud',
      datum_vydani: datumText || undefined,
      jednaci_cislo: spZn || undefined,
    });
  });

  return urls;
};

export const runDiscovery = async (db: ScraperDb, config: ScraperConfig, isShuttingDown: () => boolean) => {
  console.log('=== NSSoud Discovery Phase ===');
  console.log(`Delay: ${config.delay}ms`);
  console.log('Using date-range iteration with form submission...');

  const rateLimiter = createRateLimiter(config.delay);
  let discovered = 0;

  const ranges = generateYearRanges(2003);

  for (const range of ranges) {
    if (isShuttingDown()) break;
    if (config.limit > 0 && discovered >= config.limit) break;

    try {
      // Step 1: GET the search page (fresh form + tokens)
      await rateLimiter.wait();
      const pageResponse = await fetch(`${BASE_URL}/`, {
        headers: {
          ...browserHeaders(),
          Referer: `${BASE_URL}/`,
        },
        signal: AbortSignal.timeout(30_000),
      });

      if (!pageResponse.ok) {
        console.error(`  ${range.label}: Failed to load page: HTTP ${pageResponse.status}`);
        continue;
      }

      const pageHtml = await pageResponse.text();
      // Extract cookies for the session
      const setCookies = pageResponse.headers.getSetCookie?.() ?? [];
      const cookieStr = setCookies.map((c) => c.split(';')[0]).join('; ');

      // Step 2: Serialize form with date range and submit
      await rateLimiter.wait();
      const formBody = serializeForm(pageHtml, range.from, range.to);

      const searchResponse = await fetch(`${BASE_URL}/`, {
        method: 'POST',
        headers: {
          ...browserHeaders(),
          'Content-Type': 'application/x-www-form-urlencoded',
          Referer: `${BASE_URL}/`,
          ...(cookieStr ? { Cookie: cookieStr } : {}),
        },
        body: formBody,
        signal: AbortSignal.timeout(60_000),
      });

      if (!searchResponse.ok) {
        console.error(`  ${range.label}: Search failed: HTTP ${searchResponse.status}`);
        continue;
      }

      const resultHtml = await searchResponse.text();

      // Step 3: Parse results from initial page
      const urls = parseResultRows(resultHtml);
      if (urls.length > 0) {
        db.insertUrlBatch(urls);
        discovered += urls.length;
      }

      // Extract pagination params from the page
      const currParamsMatch = resultHtml.match(/var currParams = '([^']*)';/);
      const currViewIdMatch = resultHtml.match(/var currViewId = '([^']*)';/);
      const currSortMatch = resultHtml.match(/var currSort = '([^']*)';/);

      const currParams = currParamsMatch?.[1]?.replace(/\\u0022/g, '"') ?? '[]';
      const currViewId = currViewIdMatch?.[1] ?? '1';
      const currSort = currSortMatch?.[1] ?? '';

      // No results or no search params means empty search
      if (currParams === '[]' || urls.length === 0) {
        console.log(`  ${range.label}: ${urls.length} results`);
        rateLimiter.onSuccess();
        continue;
      }

      console.log(`  ${range.label}: ${urls.length} initial results, loading more...`);
      rateLimiter.onSuccess();

      // Step 4: Load more via infinite scroll (POST /Home/MyResTRowsCont)
      // Update cookies from the search response
      const searchCookies = searchResponse.headers.getSetCookie?.() ?? [];
      const allCookies = [...setCookies, ...searchCookies].map((c) => c.split(';')[0]).join('; ');

      let pageNum = 1;
      let hasMore = urls.length >= 20; // Initial page typically has ~40 rows

      while (hasMore && !isShuttingDown()) {
        if (config.limit > 0 && discovered >= config.limit) break;

        await rateLimiter.wait();

        try {
          const moreResponse = await fetch(`${BASE_URL}/Home/MyResTRowsCont`, {
            method: 'POST',
            headers: {
              ...browserHeaders(),
              Accept: '*/*',
              'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8',
              'X-Requested-With': 'XMLHttpRequest',
              Referer: `${BASE_URL}/`,
              ...(allCookies ? { Cookie: allCookies } : {}),
            },
            body: new URLSearchParams({
              vyhledavaciPodminky: currParams,
              zobrazeniVysledkuId: currViewId,
              pageNum: String(pageNum),
              resultOrder: currSort,
            }).toString(),
            signal: AbortSignal.timeout(30_000),
          });

          if (!moreResponse.ok) {
            hasMore = false;
            break;
          }

          const moreHtml = await moreResponse.text();

          // Response is HTML table rows (not JSON)
          if (!moreHtml || moreHtml.length <= 5) {
            hasMore = false;
            break;
          }

          const moreUrls = parseResultRows(moreHtml);
          if (moreUrls.length === 0) {
            hasMore = false;
            break;
          }

          db.insertUrlBatch(moreUrls);
          discovered += moreUrls.length;
          pageNum++;

          rateLimiter.onSuccess();

          if (pageNum % 5 === 0) {
            console.log(`  ${range.label}: page ${pageNum}, ${discovered.toLocaleString()} total`);
          }
        } catch (error) {
          console.error(`  ${range.label} page ${pageNum}: ${(error as Error).message}`);
          hasMore = false;
        }
      }

      console.log(`  ${range.label}: done, ${discovered.toLocaleString()} total URLs`);
    } catch (error) {
      console.error(`  ${range.label}: ${(error as Error).message}`);
    }
  }

  const counts = db.getUrlCounts('nssoud');
  console.log(
    `\nNSSoud discovery complete. URLs in DB: ${counts.total.toLocaleString()} (${counts.pending.toLocaleString()} pending)`,
  );
};
