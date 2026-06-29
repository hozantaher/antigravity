import { createProgressTracker, createRateLimiter, retry } from '../../lib/utils.js';
import { fetchFragments, fetchMetadata, fetchRelationships } from './api.js';
import type { ScraperDb } from './db.js';
import type { ActData, Fragment, ScraperConfig, Souvislost } from './types.js';

/** Assemble full XHTML text from all fragments, fetching all pages */
const fetchAllFragments = async (eli: string): Promise<{ text: string; count: number }> => {
  const allFragments: Fragment[] = [];
  let page = 0;

  while (true) {
    const response = await fetchFragments(eli, page);
    if (!response || !response.seznam || response.seznam.length === 0) break;
    allFragments.push(...response.seznam);
    page++;
  }

  // Assemble XHTML from fragments that have content
  const xhtmlParts = allFragments.filter((f) => f.xhtml).map((f) => f.xhtml!);

  return {
    text: xhtmlParts.join('\n'),
    count: allFragments.length,
  };
};

/** Extract relationship data */
const parseRelationships = (
  souvislosti: Souvislost[],
): Array<{
  typ: string;
  pocet: number;
  dokumenty: Array<{ citace: string; nazev: string; stav: string; url: string }>;
}> => {
  return souvislosti.map((s) => ({
    typ: s.typ,
    pocet: s.pocetDokumentuSbirky,
    dokumenty: s.dokumentySbirky.map((d) => ({
      citace: d.kodDokumentuSbirky,
      nazev: d.nazev,
      stav: d.stavDokumentuSbirky,
      url: d.staleUrl,
    })),
  }));
};

/** Scrape a single act: fetch metadata, fragments, and relationships */
const scrapeAct = async (eli: string): Promise<ActData> => {
  // Fetch metadata
  const meta = await fetchMetadata(eli);

  // Fetch all text fragments
  const { text, count } = await fetchAllFragments(eli);

  // Fetch relationships
  const relResponse = await fetchRelationships(eli);
  const relationships = parseRelationships(relResponse.souvislosti);

  return {
    eli,
    citace: meta.kodDokumentuSbirky,
    nazev: meta.nazev,
    typ_aktu: meta.typAktuKod,
    typ_zneni: meta.typZneni,
    datum_platnosti: meta.datumUcinnostiOd,
    datum_zruseni: undefined,
    full_text: text || undefined,
    fragment_count: count,
    relationships_json: JSON.stringify(relationships),
    raw_metadata_json: JSON.stringify(meta),
  };
};

export const runDetailPhase = async (db: ScraperDb, config: ScraperConfig, isShuttingDown: () => boolean) => {
  console.log('=== Detail Phase ===');
  console.log(`Concurrency: ${config.concurrency}, Delay: ${config.delay}ms, Max retries: ${config.maxRetries}`);

  const collection = config.collection === 'all' ? undefined : config.collection;
  const counts = db.getUrlCounts(collection);
  const totalPending = counts.pending + counts.failed;
  const effectiveTotal = config.limit > 0 ? Math.min(config.limit, totalPending) : totalPending;

  console.log(
    `Acts: ${counts.total.toLocaleString()} total, ${totalPending.toLocaleString()} to process${config.limit > 0 ? ` (limited to ${config.limit})` : ''}`,
  );

  if (effectiveTotal === 0) {
    console.log('No acts to process.');
    return;
  }

  const progress = createProgressTracker(effectiveTotal);
  const rateLimiter = createRateLimiter(config.delay);
  const runId = db.startRun('detail');
  const BATCH_SIZE = 100;

  let processedTotal = 0;

  const progressInterval = setInterval(() => {
    console.log(`${progress.report()} | Delay: ${rateLimiter.getDelay()}ms`);
  }, 30_000);

  try {
    while (!isShuttingDown()) {
      const remaining = config.limit > 0 ? config.limit - processedTotal : BATCH_SIZE;
      if (remaining <= 0) break;

      const batch = db.getPendingUrls(config.maxRetries, Math.min(BATCH_SIZE, remaining), collection);
      if (batch.length === 0) break;

      let batchIndex = 0;

      const worker = async () => {
        while (!isShuttingDown()) {
          const idx = batchIndex++;
          if (idx >= batch.length) break;

          const urlRow = batch[idx];

          await rateLimiter.wait();

          try {
            await retry(
              async () => {
                const actData = await scrapeAct(urlRow.eli);
                db.saveAct(actData);
                progress.increment();
                rateLimiter.onSuccess();
              },
              {
                maxRetries: config.maxRetries,
                baseDelay: config.delay,
                onRetry: (attempt, error) => {
                  console.log(`  Retry ${attempt} for ${urlRow.eli}: ${error.message}`);
                },
              },
            );
          } catch (error) {
            db.markFailed(urlRow.eli, (error as Error).message);
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
