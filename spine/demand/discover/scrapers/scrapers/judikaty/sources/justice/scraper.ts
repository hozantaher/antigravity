import { createProgressTracker, createRateLimiter, retry } from '../../../../lib/utils.js';
import type { ScraperDb } from '../../db.js';
import type { DecisionData, ScraperConfig } from '../../types.js';
import type { DetailResponse } from './api.js';
import { fetchDetail } from './api.js';

const formatCaseNumber = (cn?: DetailResponse['metadata']['caseNumber']): string | undefined => {
  if (!cn) return undefined;
  const parts = [cn.senate, cn.registry, cn.index ? `${cn.index}/${cn.year}` : undefined].filter(Boolean);
  const base = parts.length > 0 ? parts.join(' ') : undefined;
  if (!base) return undefined;
  return cn.pageNumber ? `${base}-${cn.pageNumber}` : base;
};

const formatSolver = (s?: DetailResponse['metadata']['solver']): string | undefined => {
  if (!s) return undefined;
  const parts = [s.titlesBefore, s.firstName, s.lastName, s.titlesAfter].filter(Boolean);
  return parts.length > 0 ? parts.join(' ') : undefined;
};

/** Replace NBSP (U+00A0) with regular space — justice API returns HTML with &nbsp; */
const cleanNbsp = (s: string | undefined): string | undefined => s?.replace(/\u00a0/g, ' ');

export const parseDetail = (raw: DetailResponse, url: string): DecisionData => {
  const m = raw.metadata ?? {};
  return {
    url,
    source: 'justice',
    external_id: raw.uuid,
    ecli: m.ecli,
    jednaci_cislo: formatCaseNumber(m.caseNumber),
    soud: m.courtCode,
    autor: formatSolver(m.solver),
    datum_vydani: m.decisionAt,
    datum_zverejneni: m.publishedAt,
    typ_rozhodnuti: m.type,
    predmet_rizeni: m.caseSubject,
    klicova_slova: m.flags && m.flags.length > 0 ? JSON.stringify(m.flags) : undefined,
    zminena_ustanoveni: m.regulations && m.regulations.length > 0 ? JSON.stringify(m.regulations) : undefined,
    vyrok: cleanNbsp(raw.verdictText) || undefined,
    oduvodneni: cleanNbsp(raw.justificationText) || undefined,
    raw_json: JSON.stringify(raw),
  };
};

export const runDetail = async (db: ScraperDb, config: ScraperConfig, isShuttingDown: () => boolean) => {
  console.log('=== Justice Detail Phase ===');
  console.log(`Concurrency: ${config.concurrency}, Delay: ${config.delay}ms, Max retries: ${config.maxRetries}`);

  const counts = db.getUrlCounts('justice');
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
  const runId = db.startRun('justice-detail');
  const BATCH_SIZE = 1000;

  let processedTotal = 0;

  const progressInterval = setInterval(() => {
    console.log(`${progress.report()} | Delay: ${rateLimiter.getDelay()}ms`);
  }, 30_000);

  try {
    while (!isShuttingDown()) {
      const remaining = config.limit > 0 ? config.limit - processedTotal : BATCH_SIZE;
      if (remaining <= 0) break;

      const batch = db.getPendingUrls('justice', config.maxRetries, Math.min(BATCH_SIZE, remaining));
      if (batch.length === 0) break;

      let batchIndex = 0;

      const worker = async () => {
        while (!isShuttingDown()) {
          const idx = batchIndex++;
          if (idx >= batch.length) break;

          const urlRow = batch[idx];
          const uuid = urlRow.external_id ?? urlRow.url.split('/').pop() ?? '';

          await rateLimiter.wait();

          try {
            await retry(
              async () => {
                const detail = await fetchDetail(uuid);
                const decision = parseDetail(detail, urlRow.url);
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
      `\nJustice detail phase ${status}. Scraped: ${stats.scraped.toLocaleString()}, Failed: ${stats.failed.toLocaleString()}`,
    );
  }
};
