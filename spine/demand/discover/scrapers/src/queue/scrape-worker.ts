import { resolve } from 'node:path';
import { Worker, type Job } from 'bullmq';
import pg from 'pg';
import { logger } from '../../lib/logger.js';
import { rateLimit } from '../util/rate-limiter.js';
import { connection, QUEUE_NAME, type ScrapeJobData, type ScrapeJobResult } from './scrape-queue.js';

// ---------------------------------------------------------------------------
// PostgreSQL pool — results/runs are written here after each job completes.
// ---------------------------------------------------------------------------

const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });

async function recordJobResult(result: ScrapeJobResult): Promise<void> {
  await pool.query(
    `INSERT INTO scrape_runs
       (scraper_type, phase, scraped, failed, duration_ms, completed_at)
     VALUES ($1, $2, $3, $4, $5, NOW())
     ON CONFLICT DO NOTHING`,
    [result.scraperType, result.phase, result.scraped, result.failed, result.durationMs],
  );
}

// ---------------------------------------------------------------------------
// Domain → canonical hostname for rate-limiting purposes.
// ---------------------------------------------------------------------------

const SCRAPER_DOMAIN: Record<ScrapeJobData['type'], string> = {
  autoline: 'autoline.cz',
  mascus: 'mascus.cz',
  'mobile-de': 'mobile.de',
  firmy: 'firmy.cz',
  judikaty: 'justice.cz',
  esbirka: 'api.eselektron.cz',
};

// ---------------------------------------------------------------------------
// Per-scraper runner functions.
// Each function creates its own SQLite db, runs the phases, then closes.
// ---------------------------------------------------------------------------

async function runAutoline(params: ScrapeJobData['params'], isShuttingDown: () => boolean): Promise<{ scraped: number; failed: number }> {
  const { createDb } = await import('../../scrapers/autoline/db.js');
  const { runDetailPhase } = await import('../../scrapers/autoline/scraper.js');
  const { runSitemapPhase } = await import('../../scrapers/autoline/sitemap.js');

  const dbPath = params.dbPath ?? resolve('data', 'garaaage.db');
  const config = buildConfig(params);
  const db = createDb(dbPath);

  try {
    if (config.phase === 'all' || config.phase === 'sitemap') {
      await runSitemapPhase(db, isShuttingDown);
    }
    if (!isShuttingDown() && (config.phase === 'all' || config.phase === 'detail')) {
      await runDetailPhase(db, config, isShuttingDown);
    }
  } finally {
    db.close();
  }

  return { scraped: 0, failed: 0 }; // scrapers track stats internally via console output
}

async function runMascus(params: ScrapeJobData['params'], isShuttingDown: () => boolean): Promise<{ scraped: number; failed: number }> {
  const { createDb } = await import('../../scrapers/mascus-cz/db.js');
  const { runDetailPhase } = await import('../../scrapers/mascus-cz/scraper.js');
  const { runSitemapPhase } = await import('../../scrapers/mascus-cz/sitemap.js');

  const dbPath = params.dbPath ?? resolve('data', 'garaaage.db');
  const config = buildConfig(params);
  const db = createDb(dbPath);

  try {
    if (config.phase === 'all' || config.phase === 'sitemap') {
      await runSitemapPhase(db, isShuttingDown);
    }
    if (!isShuttingDown() && (config.phase === 'all' || config.phase === 'detail')) {
      await runDetailPhase(db, config, isShuttingDown);
    }
  } finally {
    db.close();
  }

  return { scraped: 0, failed: 0 };
}

async function runMobileDe(params: ScrapeJobData['params'], isShuttingDown: () => boolean): Promise<{ scraped: number; failed: number }> {
  const { createDb } = await import('../../scrapers/mobile-de/db.js');
  const { runDetailPhase } = await import('../../scrapers/mobile-de/scraper.js');
  const { runSearchPhase } = await import('../../scrapers/mobile-de/search.js');
  const { launchBrowser, createBrowserContext, closeBrowser } = await import('../../scrapers/mobile-de/browser.js');

  const dbPath = params.dbPath ?? resolve('data', 'garaaage.db');
  const db = createDb(dbPath);

  const mobileConfig = {
    ...buildConfig(params),
    phase: (params.phase ?? 'all') as 'all' | 'search' | 'detail',
    categories: (['Car', 'Motorbike', 'Truck', 'MotorHome'] as const).slice(),
    headless: true,
  };

  const browser = await launchBrowser(mobileConfig.headless);
  const context = await createBrowserContext(browser);

  try {
    if (mobileConfig.phase === 'all' || mobileConfig.phase === 'search') {
      await runSearchPhase(context, db, mobileConfig, isShuttingDown);
    }
    if (!isShuttingDown() && (mobileConfig.phase === 'all' || mobileConfig.phase === 'detail')) {
      await runDetailPhase(context, db, mobileConfig, isShuttingDown);
    }
  } finally {
    await closeBrowser(browser);
    db.close();
  }

  return { scraped: 0, failed: 0 };
}

async function runFirmy(params: ScrapeJobData['params'], isShuttingDown: () => boolean): Promise<{ scraped: number; failed: number }> {
  const { createDb } = await import('../../scrapers/firmy-cz/db.js');
  const { runDetailPhase } = await import('../../scrapers/firmy-cz/scraper.js');
  const { runSitemapPhase } = await import('../../scrapers/firmy-cz/sitemap.js');

  const dbPath = params.dbPath ?? resolve('data', 'garaaage.db');
  const config = buildConfig(params);
  const db = createDb(dbPath);

  try {
    if (config.phase === 'all' || config.phase === 'sitemap') {
      await runSitemapPhase(db, isShuttingDown);
    }
    if (!isShuttingDown() && (config.phase === 'all' || config.phase === 'detail')) {
      await runDetailPhase(db, config, isShuttingDown);
    }
  } finally {
    db.close();
  }

  return { scraped: 0, failed: 0 };
}

async function runJudikaty(params: ScrapeJobData['params'], isShuttingDown: () => boolean): Promise<{ scraped: number; failed: number }> {
  const { createDb } = await import('../../scrapers/judikaty/db.js');
  const { setupLogging } = await import('../../scrapers/judikaty/logger.js');

  setupLogging(undefined);

  const dbPath = params.dbPath ?? resolve('data', 'garaaage.db');
  const db = createDb(dbPath);

  const source = (params.source ?? 'all') as 'justice' | 'usoud' | 'nssoud' | 'nsoud' | 'all';
  const judikatyConfig = {
    ...buildConfig(params),
    source,
    phase: (params.phase ?? 'all') as 'all' | 'discovery' | 'detail',
  };

  const ALL_SOURCES = ['justice', 'usoud', 'nssoud', 'nsoud'] as const;
  const sources = source === 'all' ? [...ALL_SOURCES] : [source as (typeof ALL_SOURCES)[number]];

  try {
    for (const src of sources) {
      if (isShuttingDown()) break;

      const srcConfig = { ...judikatyConfig, source: src };

      const discovery = await import(`../../scrapers/judikaty/sources/${src}/discovery.js`);
      const scraper = await import(`../../scrapers/judikaty/sources/${src}/scraper.js`);

      if (srcConfig.phase === 'all' || srcConfig.phase === 'discovery') {
        await discovery.runDiscovery(db, srcConfig, isShuttingDown);
      }
      if (!isShuttingDown() && (srcConfig.phase === 'all' || srcConfig.phase === 'detail')) {
        await scraper.runDetail(db, srcConfig, isShuttingDown);
      }
    }
  } finally {
    db.close();
  }

  return { scraped: 0, failed: 0 };
}

async function runEsbirka(params: ScrapeJobData['params'], isShuttingDown: () => boolean): Promise<{ scraped: number; failed: number }> {
  const { createDb } = await import('../../scrapers/esbirka/db.js');
  const { runDiscoveryPhase } = await import('../../scrapers/esbirka/discovery.js');
  const { runDetailPhase } = await import('../../scrapers/esbirka/scraper.js');

  const dbPath = params.dbPath ?? resolve('data', 'garaaage.db');
  const esbirkaConfig = {
    ...buildConfig(params),
    collection: (params.collection ?? 'all') as 'sb' | 'sm' | 'all',
    phase: (params.phase ?? 'all') as 'all' | 'discovery' | 'detail',
  };
  const db = createDb(dbPath);

  try {
    if (esbirkaConfig.phase === 'all' || esbirkaConfig.phase === 'discovery') {
      await runDiscoveryPhase(db, esbirkaConfig, isShuttingDown);
    }
    if (!isShuttingDown() && (esbirkaConfig.phase === 'all' || esbirkaConfig.phase === 'detail')) {
      await runDetailPhase(db, esbirkaConfig, isShuttingDown);
    }
  } finally {
    db.close();
  }

  return { scraped: 0, failed: 0 };
}

// ---------------------------------------------------------------------------
// Shared config builder — fills in defaults.
// ---------------------------------------------------------------------------

function buildConfig(params: ScrapeJobData['params']) {
  return {
    phase: (params.phase ?? 'all') as 'all' | 'sitemap' | 'detail',
    concurrency: params.concurrency ?? 3,
    delay: params.delay ?? 2000,
    maxRetries: params.maxRetries ?? 3,
    limit: params.limit ?? 0,
    dbPath: params.dbPath ?? resolve('data', 'garaaage.db'),
  };
}

// ---------------------------------------------------------------------------
// Job processor — dispatches to correct scraper, enforces rate limit.
// ---------------------------------------------------------------------------

async function processJob(job: Job<ScrapeJobData, ScrapeJobResult>): Promise<ScrapeJobResult> {
  const { type, params } = job.data;
  const domain = SCRAPER_DOMAIN[type];
  const phase = params.phase ?? 'all';

  logger.info({ jobId: job.id, type, phase, domain }, 'scrape-worker: job started');

  await rateLimit(domain);

  let shuttingDown = false;
  const isShuttingDown = () => shuttingDown;

  const t0 = Date.now();
  let stats: { scraped: number; failed: number } = { scraped: 0, failed: 0 };

  switch (type) {
    case 'autoline':
      stats = await runAutoline(params, isShuttingDown);
      break;
    case 'mascus':
      stats = await runMascus(params, isShuttingDown);
      break;
    case 'mobile-de':
      stats = await runMobileDe(params, isShuttingDown);
      break;
    case 'firmy':
      stats = await runFirmy(params, isShuttingDown);
      break;
    case 'judikaty':
      stats = await runJudikaty(params, isShuttingDown);
      break;
    case 'esbirka':
      stats = await runEsbirka(params, isShuttingDown);
      break;
    default: {
      const exhaustive: never = type;
      throw new Error(`Unknown scraper type: ${String(exhaustive)}`);
    }
  }

  const result: ScrapeJobResult = {
    scraperType: type,
    phase,
    scraped: stats.scraped,
    failed: stats.failed,
    durationMs: Date.now() - t0,
  };

  logger.info({ jobId: job.id, ...result }, 'scrape-worker: job completed');

  if (process.env.DATABASE_URL) {
    try {
      await recordJobResult(result);
    } catch (err) {
      logger.warn({ err }, 'scrape-worker: failed to record job result to PostgreSQL');
    }
  }

  return result;
}

// ---------------------------------------------------------------------------
// Worker start — exported so src/index.ts can start it.
// ---------------------------------------------------------------------------

let worker: Worker<ScrapeJobData, ScrapeJobResult> | null = null;

export function startWorker(): Worker<ScrapeJobData, ScrapeJobResult> {
  if (worker) return worker;

  worker = new Worker<ScrapeJobData, ScrapeJobResult>(QUEUE_NAME, processJob, {
    connection,
    concurrency: 1, // one scrape job at a time to avoid overlapping domain rate limits
  });

  worker.on('failed', (job, err) => {
    logger.error(
      { jobId: job?.id, type: job?.data?.type, err: err.message, stack: err.stack },
      'scrape-worker: job failed',
    );
  });

  worker.on('error', (err) => {
    logger.error({ err: err.message }, 'scrape-worker: worker error');
  });

  logger.info({ queue: QUEUE_NAME }, 'scrape-worker: started');
  return worker;
}

export async function stopWorker(): Promise<void> {
  if (worker) {
    await worker.close();
    worker = null;
    logger.info('scrape-worker: stopped');
  }
  await pool.end();
}
