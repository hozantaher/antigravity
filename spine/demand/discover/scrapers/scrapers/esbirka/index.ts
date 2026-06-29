import { resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { createShutdownHandler } from '../../lib/utils.js';
import { createDb } from './db.js';
import { runDiscoveryPhase } from './discovery.js';
import { runDetailPhase } from './scraper.js';
import type { ScraperConfig } from './types.js';

const args = process.argv.slice(2).filter((a) => a !== '--');

const { values } = parseArgs({
  args,
  strict: false,
  options: {
    phase: { type: 'string', default: 'all' },
    collection: { type: 'string', default: 'all' },
    concurrency: { type: 'string', default: '5' },
    delay: { type: 'string', default: '200' },
    'max-retries': { type: 'string', default: '3' },
    limit: { type: 'string', default: '0' },
    db: { type: 'string', default: '' },
  },
});

const collectionArg = String(values.collection || 'all');
if (!['sb', 'sm', 'all'].includes(collectionArg)) {
  console.error('Invalid --collection. Use: sb, sm, or all');
  process.exit(1);
}

const config: ScraperConfig = {
  phase: (values.phase as ScraperConfig['phase']) ?? 'all',
  collection: collectionArg as ScraperConfig['collection'],
  concurrency: parseInt(String(values.concurrency ?? '5'), 10),
  delay: parseInt(String(values.delay ?? '200'), 10),
  maxRetries: parseInt(String(values['max-retries'] ?? '3'), 10),
  limit: parseInt(String(values.limit ?? '0'), 10),
  dbPath: String(values.db || '') || resolve('data', 'garaaage.db'),
};

console.log('e-Sbírka Scraper (Czech Legislation)');
console.log(
  `Phase: ${config.phase}, Collection: ${config.collection}, Concurrency: ${config.concurrency}, Delay: ${config.delay}ms`,
);
console.log(`DB: ${config.dbPath}`);
console.log('');

const shutdown = createShutdownHandler();
shutdown.setup();

const db = createDb(config.dbPath);
shutdown.onShutdown(() => {
  console.log('Closing database...');
  db.close();
});

const run = async () => {
  try {
    if (config.phase === 'all' || config.phase === 'discovery') {
      await runDiscoveryPhase(db, config, shutdown.isShuttingDown);
      if (shutdown.isShuttingDown()) return;
    }

    if (config.phase === 'all' || config.phase === 'detail') {
      if (config.phase === 'all') {
        console.log('Waiting 5s before detail phase...');
        await new Promise((resolve) => setTimeout(resolve, 5000));
      }
      await runDetailPhase(db, config, shutdown.isShuttingDown);
    }
  } catch (error) {
    console.error('Fatal error:', (error as Error).message);
    process.exitCode = 1;
  } finally {
    if (!shutdown.isShuttingDown()) {
      db.close();
    }
  }
};

run();
