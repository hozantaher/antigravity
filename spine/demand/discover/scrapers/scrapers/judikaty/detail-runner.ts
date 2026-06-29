import { fetchPage } from '../../lib/fetch.js';
import { createProgressTracker, createRateLimiter, retry } from '../../lib/utils.js';
import type { ScraperDb } from './db.js';
import type { DecisionData, ScraperConfig, Source, UrlRow } from './types.js';

export type FetchFn = (
  url: string,
  referers: string[],
) => Promise<{ status: number; html: string; retryAfter?: number }>;

interface HtmlDetailOptions {
  source: Source;
  label: string;
  referers: string[];
  parsePage: (html: string, url: string) => DecisionData;
  /** Override the default fetchPage — useful for non-UTF-8 encodings or cookie sessions */
  fetchFn?: FetchFn;
  /** Optional async post-processor to enrich decision with additional fetches (e.g. text sub-page) */
  postProcess?: (decision: DecisionData, fetchFn: FetchFn) => Promise<void>;
}

/** Copy metadata from URL row into decision for fields the parser didn't extract */
const mergeUrlMetadata = (decision: DecisionData, urlRow: UrlRow) => {
  if (!decision.ecli && urlRow.ecli) decision.ecli = urlRow.ecli;
  if (!decision.jednaci_cislo && urlRow.jednaci_cislo) decision.jednaci_cislo = urlRow.jednaci_cislo;
  if (!decision.soud && urlRow.soud) decision.soud = urlRow.soud;
  if (!decision.datum_vydani && urlRow.datum_vydani) decision.datum_vydani = urlRow.datum_vydani;
  if (!decision.external_id && urlRow.external_id) decision.external_id = urlRow.external_id;
};

export const runHtmlDetailPhase = async (
  db: ScraperDb,
  config: ScraperConfig,
  isShuttingDown: () => boolean,
  opts: HtmlDetailOptions,
) => {
  console.log(`=== ${opts.label} Detail Phase ===`);
  console.log(`Concurrency: ${config.concurrency}, Delay: ${config.delay}ms, Max retries: ${config.maxRetries}`);

  const counts = db.getUrlCounts(opts.source);
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
  const runId = db.startRun(`${opts.source}-detail`);
  const BATCH_SIZE = 1000;

  let processedTotal = 0;

  const progressInterval = setInterval(() => {
    console.log(`${progress.report()} | Delay: ${rateLimiter.getDelay()}ms`);
  }, 30_000);

  try {
    while (!isShuttingDown()) {
      const remaining = config.limit > 0 ? config.limit - processedTotal : BATCH_SIZE;
      if (remaining <= 0) break;

      const batch = db.getPendingUrls(opts.source, config.maxRetries, Math.min(BATCH_SIZE, remaining));
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
                if (hitRateLimit) await rateLimiter.wait();

                const fetch_ = opts.fetchFn ?? fetchPage;
                const { status, html, retryAfter } = await fetch_(urlRow.url, opts.referers);

                if (status === 404 || status === 410) {
                  db.markGone(urlRow.url);
                  progress.incrementFailed();
                  return;
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

                const decision = opts.parsePage(html, urlRow.url);

                // Merge metadata from URL row (populated during discovery)
                mergeUrlMetadata(decision, urlRow);

                // Optional post-processing (e.g. fetch a linked text sub-page)
                if (opts.postProcess) {
                  await rateLimiter.wait();
                  await opts.postProcess(decision, fetch_);
                }

                db.saveDecision(decision);
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
      `\n${opts.label} detail phase ${status}. Scraped: ${stats.scraped.toLocaleString()}, Failed: ${stats.failed.toLocaleString()}`,
    );
  }
};
