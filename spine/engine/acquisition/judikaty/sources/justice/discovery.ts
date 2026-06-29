import { createProgressTracker } from '../../../shared/utils.js';
import type { ScraperDb } from '../../db.js';
import type { ScraperConfig, UrlInsert } from '../../types.js';
import { fetchDayPage, fetchYears } from './api.js';

const daysInMonth = (year: number, month: number): number => new Date(year, month, 0).getDate();

/** Fetch all pages for a single day, returning discovered URLs */
const fetchDay = async (year: number, month: number, day: number): Promise<UrlInsert[]> => {
  const allUrls: UrlInsert[] = [];
  let page = 0;
  let totalPages = 1;

  while (page < totalPages) {
    const response = await fetchDayPage(year, month, day, page);
    totalPages = response.totalPages;
    if (response.items.length === 0) break;

    for (const item of response.items) {
      allUrls.push({
        url: item.odkaz,
        source: 'justice' as const,
        external_id: item.odkaz.split('/').pop() ?? item.odkaz,
        ecli: item.ecli,
        jednaci_cislo: item.jednaciCislo,
        soud: item.soud,
        datum_vydani: item.datumVydani,
      });
    }
    page++;
  }

  return allUrls;
};

export const runDiscovery = async (db: ScraperDb, config: ScraperConfig, isShuttingDown: () => boolean) => {
  console.log('=== Justice Discovery Phase ===');
  console.log('Fetching year index from rozhodnuti.justice.cz...');

  const years = await fetchYears();
  const totalDecisions = years.reduce((sum, y) => sum + y.pocet, 0);
  console.log(`Found ${years.length} years, ~${totalDecisions.toLocaleString()} decisions total`);

  const progress = createProgressTracker(config.limit > 0 ? config.limit : totalDecisions);
  let discovered = 0;

  const progressInterval = setInterval(() => {
    console.log(progress.report());
  }, 30_000);

  try {
    for (const { rok } of years) {
      if (isShuttingDown()) break;
      if (config.limit > 0 && discovered >= config.limit) break;

      for (let month = 1; month <= 12; month++) {
        if (isShuttingDown()) break;
        if (config.limit > 0 && discovered >= config.limit) break;

        // Fetch all days in the month concurrently (public REST API, no rate limits)
        const days = daysInMonth(rok, month);
        const dayPromises = Array.from({ length: days }, (_, i) => fetchDay(rok, month, i + 1));
        const results = await Promise.allSettled(dayPromises);

        for (const result of results) {
          if (config.limit > 0 && discovered >= config.limit) break;
          if (result.status !== 'fulfilled' || result.value.length === 0) continue;

          let urls = result.value;
          if (config.limit > 0) {
            const remaining = config.limit - discovered;
            urls = urls.slice(0, remaining);
          }

          db.insertUrlBatch(urls);
          discovered += urls.length;
          urls.forEach(() => progress.increment());
        }
      }

      console.log(`  Year ${rok}: ${discovered.toLocaleString()} URLs discovered so far`);
    }
  } finally {
    clearInterval(progressInterval);
  }

  const counts = db.getUrlCounts('justice');
  console.log(
    `\nJustice discovery complete. URLs in DB: ${counts.total.toLocaleString()} (${counts.pending.toLocaleString()} pending)`,
  );
};
