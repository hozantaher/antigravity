import * as cheerio from 'cheerio';
import { browserHeaders } from '../../../shared/fetch.js';
import { createRateLimiter } from '../../../shared/utils.js';
import type { ScraperDb } from '../../db.js';
import type { ScraperConfig, UrlInsert } from '../../types.js';
import { generateYearRanges } from '../../utils.js';

const BASE_URL = 'https://nalus.usoud.cz';
const SEARCH_URL = `${BASE_URL}/Search/Search.aspx`;
const RESULTS_URL = `${BASE_URL}/Search/Results.aspx`;

/**
 * USoud (nalus.usoud.cz) uses ASP.NET WebForms with session-based state.
 * Flow:
 *   1. GET /Search/Search.aspx → extract tokens + session cookie
 *   2. POST /Search/Search.aspx with tokens, checkboxes, date range → 302 redirect to /Search/Results.aspx
 *   3. GET /Search/Results.aspx → paginated results (10 per page, ?page=N zero-indexed)
 * Session cookies (ASP.NET_SessionId) are required for all requests.
 * At least one "forma rozhodnutí" checkbox must be checked (nalezy, usneseni, stanoviska_plena).
 */

export const extractFormTokens = (
  html: string,
): { viewState: string; viewStateGenerator: string; eventValidation: string } => {
  const $ = cheerio.load(html);
  return {
    viewState: ($('#__VIEWSTATE').val() as string) ?? '',
    viewStateGenerator: ($('#__VIEWSTATEGENERATOR').val() as string) ?? '',
    eventValidation: ($('#__EVENTVALIDATION').val() as string) ?? '',
  };
};

export const parseSearchResults = (html: string): { urls: UrlInsert[]; totalResults: number; totalPages: number } => {
  const $ = cheerio.load(html);
  const urls: UrlInsert[] = [];

  // Results button shows total: "Nalezené (301)"
  const resultsBtn = $('[id*="bResults"]').val() as string;
  const totalMatch = resultsBtn?.match?.(/\((\d+)\)/) ?? html.match(/cnt=(\d+)/);
  const totalResults = totalMatch ? parseInt(totalMatch[1], 10) : 0;

  // Parse result rows — alternating classes resultData0/resultData1
  $("tr[class^='resultData']").each((_, row) => {
    const $row = $(row);
    const link = $row.find("a[href*='ResultDetail']").first();
    if (!link.length) return;

    const href = link.attr('href') ?? '';
    const detailUrl = href.startsWith('http') ? href : `${BASE_URL}/Search/${href}`;

    // Extract ID from URL query param
    const idMatch = detailUrl.match(/[?&]id=(\d+)/i);
    const externalId = idMatch?.[1];

    // Column 1 contains: sp.zn + ECLI + soudce zpravodaj (separated by <br>)
    const col1 = $row.find('td').eq(1);
    const col1Html = col1.html() ?? '';
    const ecliMatch = col1Html.match(/ECLI:CZ:US:[\d.:A-Za-z]+/);

    // The sp.zn. is in the link text
    const spZnText = col1.find('a').first().text().trim();

    // Column 3 contains dates: datum rozhodnutí, (datum vyhlášení), datum podání, datum zpřístupnění
    const col3 = $row.find('td').eq(3).text().trim();
    const dateMatch = col3.match(/(\d{1,2}\.\s*\d{1,2}\.\s*\d{4})/);
    const datumVydani = dateMatch?.[1]?.replace(/\s/g, '') ?? undefined;

    urls.push({
      url: detailUrl,
      source: 'usoud',
      external_id: externalId,
      ecli: ecliMatch?.[0],
      jednaci_cislo: spZnText || undefined,
      soud: 'Ústavní soud',
      datum_vydani: datumVydani,
    });
  });

  // Calculate total pages (10 results per page)
  const totalPages = totalResults > 0 ? Math.ceil(totalResults / 10) : 0;

  return { urls, totalResults, totalPages };
};

/** Create a cookie-aware fetch function that maintains a cookie jar across requests */
const createCookieSession = () => {
  const cookies = new Map<string, string>();

  const parseSetCookies = (headers: Headers) => {
    const setCookies = headers.getSetCookie?.() ?? [];
    for (const sc of setCookies) {
      const match = sc.match(/^([^=]+)=([^;]*)/);
      if (match) cookies.set(match[1], match[2]);
    }
  };

  const cookieHeader = (): string =>
    Array.from(cookies.entries())
      .map(([k, v]) => `${k}=${v}`)
      .join('; ');

  const get = async (url: string): Promise<{ status: number; html: string }> => {
    const response = await fetch(url, {
      headers: {
        ...browserHeaders(),
        ...(cookies.size > 0 ? { Cookie: cookieHeader() } : {}),
        Referer: SEARCH_URL,
      },
      redirect: 'manual',
      signal: AbortSignal.timeout(30_000),
    });
    parseSetCookies(response.headers);

    // Follow redirects manually to preserve cookies
    if (response.status === 302 || response.status === 301) {
      const location = response.headers.get('location');
      if (location) {
        const redirectUrl = location.startsWith('http') ? location : `${BASE_URL}${location}`;
        return get(redirectUrl);
      }
    }
    const html = await response.text();
    return { status: response.status, html };
  };

  const post = async (url: string, body: string): Promise<{ status: number; html: string; redirected: boolean }> => {
    const response = await fetch(url, {
      method: 'POST',
      headers: {
        ...browserHeaders(),
        'Content-Type': 'application/x-www-form-urlencoded',
        Cookie: cookieHeader(),
        Referer: SEARCH_URL,
      },
      body,
      redirect: 'manual',
      signal: AbortSignal.timeout(30_000),
    });
    parseSetCookies(response.headers);

    const redirected = response.status === 302 || response.status === 301;
    if (redirected) {
      const location = response.headers.get('location');
      if (location) {
        const redirectUrl = location.startsWith('http') ? location : `${BASE_URL}${location}`;
        const result = await get(redirectUrl);
        return { ...result, redirected: true };
      }
    }
    const html = await response.text();
    return { status: response.status, html, redirected };
  };

  return { get, post };
};

const buildSearchFormData = (
  tokens: { viewState: string; viewStateGenerator: string; eventValidation: string },
  dateFrom: string,
  dateTo: string,
): string => {
  const params = new URLSearchParams();
  params.set('__VIEWSTATE', tokens.viewState);
  params.set('__VIEWSTATEGENERATOR', tokens.viewStateGenerator);
  params.set('__EVENTVALIDATION', tokens.eventValidation);

  // Required: at least one decision type checkbox
  params.set('ctl00$MainContent$nalezy', 'on');
  params.set('ctl00$MainContent$usneseni', 'on');
  params.set('ctl00$MainContent$stanoviska_plena', 'on');

  // Required search zones (checked by default in the form)
  params.set('ctl00$MainContent$naveti', 'on');
  params.set('ctl00$MainContent$vyrok', 'on');
  params.set('ctl00$MainContent$oduvodneni', 'on');
  params.set('ctl00$MainContent$odlisne_stanovisko', 'on');

  // Date range (DD.MM.YYYY format)
  params.set('ctl00$MainContent$decidedFrom', dateFrom);
  params.set('ctl00$MainContent$decidedTo', dateTo);

  // Submit button
  params.set('ctl00$MainContent$but_search', 'Vyhledat');

  return params.toString();
};

export const runDiscovery = async (db: ScraperDb, config: ScraperConfig, isShuttingDown: () => boolean) => {
  console.log('=== USoud Discovery Phase ===');
  console.log('Using date-range iteration with session cookies...');

  const rateLimiter = createRateLimiter(config.delay);
  const session = createCookieSession();
  let discovered = 0;

  const ranges = generateYearRanges(1993);

  for (const range of ranges) {
    if (isShuttingDown()) break;
    if (config.limit > 0 && discovered >= config.limit) break;

    try {
      // Step 1: Get fresh search page (tokens + session cookie)
      await rateLimiter.wait();
      const { status: initStatus, html: initHtml } = await session.get(SEARCH_URL);
      if (initStatus !== 200) {
        console.error(`  ${range.label}: Failed to load search page: HTTP ${initStatus}`);
        continue;
      }

      const tokens = extractFormTokens(initHtml);
      if (!tokens.viewState) {
        console.error(`  ${range.label}: Missing ViewState token`);
        continue;
      }

      // Step 2: Submit search form with date range
      await rateLimiter.wait();
      const formData = buildSearchFormData(tokens, range.from, range.to);
      const { status: searchStatus, html: searchHtml, redirected } = await session.post(SEARCH_URL, formData);

      if (!redirected && searchStatus !== 200) {
        console.error(`  ${range.label}: Search failed: HTTP ${searchStatus}`);
        continue;
      }

      // Step 3: Parse results (first page)
      const { urls, totalResults, totalPages } = parseSearchResults(searchHtml);

      if (urls.length > 0) {
        db.insertUrlBatch(urls);
        discovered += urls.length;
      }

      if (totalResults === 0) {
        console.log(`  ${range.label}: No results`);
        continue;
      }

      console.log(
        `  ${range.label}: ${totalResults.toLocaleString()} results, page 1/${totalPages} (${urls.length} URLs)`,
      );

      rateLimiter.onSuccess();

      // Step 4: Paginate through remaining pages (0-indexed, ?page=N)
      for (let page = 1; page < totalPages; page++) {
        if (isShuttingDown()) break;
        if (config.limit > 0 && discovered >= config.limit) break;

        await rateLimiter.wait();

        try {
          const { status: pageStatus, html: pageHtml } = await session.get(`${RESULTS_URL}?page=${page}`);

          if (pageStatus !== 200) {
            console.error(`  ${range.label} page ${page + 1}: HTTP ${pageStatus}`);
            break;
          }

          const pageResult = parseSearchResults(pageHtml);

          if (pageResult.urls.length === 0) break;

          db.insertUrlBatch(pageResult.urls);
          discovered += pageResult.urls.length;

          rateLimiter.onSuccess();

          if ((page + 1) % 10 === 0) {
            console.log(`  ${range.label}: page ${page + 1}/${totalPages}, ${discovered.toLocaleString()} total`);
          }
        } catch (error) {
          console.error(`  ${range.label} page ${page + 1}: ${(error as Error).message}`);
          break;
        }
      }
    } catch (error) {
      console.error(`  ${range.label}: ${(error as Error).message}`);
    }
  }

  const counts = db.getUrlCounts('usoud');
  console.log(
    `\nUSoud discovery complete. URLs in DB: ${counts.total.toLocaleString()} (${counts.pending.toLocaleString()} pending)`,
  );
};
