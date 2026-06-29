import { resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { createShutdownHandler } from '../../spine/engine/acquisition/shared/utils.js';
import { createCommandListener } from '../../spine/engine/acquisition/shared/daemon.js';
import { runCronScheduler } from '../../spine/engine/acquisition/firmy-cz/cron.js';
import { createDb } from '../../spine/engine/acquisition/firmy-cz/db.js';
import { runDetailPhase } from '../../spine/engine/acquisition/firmy-cz/scraper.js';
import { runSitemapPhase } from '../../spine/engine/acquisition/firmy-cz/sitemap.js';
import type { ScraperConfig } from '../../spine/engine/acquisition/firmy-cz/types.js';

// Filter out bare '--' injected by pnpm so parseArgs treats flags correctly
const args = process.argv.slice(2).filter((a) => a !== '--');

const { values } = parseArgs({
  args,
  strict: false,
  options: {
    phase: { type: 'string', default: 'all' },
    concurrency: { type: 'string', default: '10' },
    delay: { type: 'string', default: '500' },
    'max-retries': { type: 'string', default: '5' },
    limit: { type: 'string', default: '0' },
    db: { type: 'string', default: '' },
    cron: { type: 'boolean', default: false },
    daemon: { type: 'boolean', default: false },
  },
});

const config: ScraperConfig = {
  phase: (values.phase as ScraperConfig['phase']) ?? 'all',
  concurrency: parseInt(String(values.concurrency ?? '10'), 10),
  delay: parseInt(String(values.delay ?? '500'), 10),
  maxRetries: parseInt(String(values['max-retries'] ?? '5'), 10),
  limit: parseInt(String(values.limit ?? '0'), 10),
  dbPath: String(values.db || '') || resolve('data', 'garaaage.db'),
};

console.log('Firmy.cz Scraper [Running via Antigravity]');
console.log(`Phase: ${config.phase}, Concurrency: ${config.concurrency}, Delay: ${config.delay}ms`);
console.log(`Mode: ${values.cron ? 'CRON DAEMON' : 'ONE-OFF'}`);
console.log(`DB: ${config.dbPath}`);
console.log('');

const shutdown = createShutdownHandler();
shutdown.setup();

const db = createDb(config.dbPath);
shutdown.onShutdown(() => {
  console.log('Closing database...');
  db.close();
});

const run = async (overridePhase?: ScraperConfig['phase']) => {
  const currentPhase = overridePhase || config.phase;
  try {
    if (values.cron && !overridePhase) {
      await runCronScheduler(db, config, shutdown.isShuttingDown);
      return; // Cron scheduler keeps running until shutdown
    }

    if (currentPhase === 'all' || currentPhase === 'sitemap') {
      await runSitemapPhase(db, shutdown.isShuttingDown);
      if (shutdown.isShuttingDown()) return;
    }

    if (currentPhase === 'all' || currentPhase === 'detail') {
      if (currentPhase === 'all') {
        console.log('Waiting 5s before detail phase...');
        await new Promise((resolve) => setTimeout(resolve, 5000));
      }
      await runDetailPhase(db, config, shutdown.isShuttingDown);
    }
  } catch (error) {
    console.error('Fatal error in run():', (error as Error).message);
  }
};

if (values.daemon) {
  console.log('Spouštím v DAEMON módu. Čekám na příkazy z Redisu...');
  const listener = createCommandListener('firmy-cz', async (payload) => {
    console.log(`Provádím příkaz: ${payload.phase}`);
    await run(payload.phase as ScraperConfig['phase']);
    console.log(`Příkaz dokončen.`);
  });
  
  shutdown.onShutdown(async () => {
    await listener.stop();
    db.close();
  });
} else {
  run().then(() => {
    if (!shutdown.isShuttingDown()) {
      db.close();
    }
  });
}
