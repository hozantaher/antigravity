/**
 * SCRAPE QUEUE — STATUS: DORMANT (as of 2026-04-22)
 *
 * This BullMQ queue was scaffolded for horizontal autoscaling of the 6
 * scrapers (firmy-cz / autoline / mascus / mobile-de / judikaty / esbirka).
 * The Worker consumer is wired (`scrape-worker.ts`) but no producer
 * (`scrapeQueue.add(...)`) is called anywhere in the codebase yet —
 * scrapers run as cron-triggered scripts directly (services/scrapers/scripts/).
 *
 * DO NOT remove without coordination: activating it later is a wire-up
 * task (call scrapeQueue.add() from the cron handler), not a rewrite.
 * Removing would require deleting both queue + worker files + updating
 * memory/project_scrapers_quality_debt.md (H2 entry).
 *
 * Audit trail: memory H2 — was "never enqueued"; reclassified as
 * documented-dormant 2026-04-22 after cross-service grep confirmed no
 * producer exists across services/scrapers, services/worker, modules/outreach.
 */
import { Queue } from 'bullmq';
import { Redis as IORedis } from 'ioredis';

export const connection = new IORedis(process.env.REDIS_URL ?? 'redis://localhost:6379', {
  maxRetriesPerRequest: null,
});

/**
 * Payload for a scrape job.
 *
 * `type` maps to one of the six scrapers:
 *   firmy      → scrapers/firmy-cz
 *   autoline   → scrapers/autoline
 *   mascus     → scrapers/mascus-cz
 *   mobile-de  → scrapers/mobile-de
 *   judikaty   → scrapers/judikaty
 *   esbirka    → scrapers/esbirka
 *
 * `params` carries optional overrides forwarded to the scraper run function.
 */
export interface ScrapeJobData {
  type: 'firmy' | 'autoline' | 'mascus' | 'mobile-de' | 'judikaty' | 'esbirka';
  params: {
    phase?: 'all' | 'sitemap' | 'detail';
    concurrency?: number;
    delay?: number;
    maxRetries?: number;
    limit?: number;
    dbPath?: string;
    /** judikaty only */
    source?: 'justice' | 'usoud' | 'nssoud' | 'nsoud' | 'all';
    [key: string]: unknown;
  };
}

export interface ScrapeJobResult {
  scraperType: ScrapeJobData['type'];
  phase: string;
  scraped: number;
  failed: number;
  durationMs: number;
}

export const QUEUE_NAME = 'scrape-jobs';

export const scrapeQueue = new Queue<ScrapeJobData, ScrapeJobResult>(QUEUE_NAME, { connection });
