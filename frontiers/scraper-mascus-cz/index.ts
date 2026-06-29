import { resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { createShutdownHandler } from '../../spine/engine/acquisition/shared/utils.js';
import { createCommandListener } from '../../spine/engine/acquisition/shared/daemon.js';
import { createDb } from '../../spine/engine/acquisition/mascus-cz/db.js';
import { runDetailPhase } from '../../spine/engine/acquisition/mascus-cz/scraper.js';
import { runSitemapPhase } from '../../spine/engine/acquisition/mascus-cz/sitemap.js';
import type { ScraperConfig } from '../../spine/engine/acquisition/mascus-cz/types.js';

// Filter out bare '--' injected by pnpm so parseArgs treats flags correctly
const args = process.argv.slice(2).filter((a) => a !== '--');

const { values } = parseArgs({
  args,
  strict: false,
  options: {
    phase: { type: 'string', default: 'all' },
    concurrency: { type: 'string', default: '5' },
    delay: { type: 'string', default: '1000' },
    'max-retries': { type: 'string', default: '3' },
    limit: { type: 'string', default: '0' },
    db: { type: 'string', default: '' },
    daemon: { type: 'boolean', default: false },
  },
});

const config: ScraperConfig = {
  phase: (values.phase as ScraperConfig['phase']) ?? 'all',
  concurrency: parseInt(String(values.concurrency ?? '5'), 10),
  delay: parseInt(String(values.delay ?? '1000'), 10),
  maxRetries: parseInt(String(values['max-retries'] ?? '3'), 10),
  limit: parseInt(String(values.limit ?? '0'), 10),
  dbPath: String(values.db || '') || resolve('data', 'garaaage.db'),
};

console.log('Mascus.cz Scraper [Running via Antigravity]');
console.log(`Phase: ${config.phase}, Concurrency: ${config.concurrency}, Delay: ${config.delay}ms`);
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
  const listener = createCommandListener('mascus-cz', async (payload) => {
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
