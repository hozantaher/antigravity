import { resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { createShutdownHandler } from '../../spine/engine/acquisition/shared/utils.js';
import { createCommandListener } from '../../spine/engine/acquisition/shared/daemon.js';
import { closeBrowser, createBrowserContext, launchBrowser } from '../../spine/engine/acquisition/mobile-de/browser.js';
import { createDb } from '../../spine/engine/acquisition/mobile-de/db.js';
import { runDetailPhase } from '../../spine/engine/acquisition/mobile-de/scraper.js';
import { runSearchPhase } from '../../spine/engine/acquisition/mobile-de/search.js';
import type { ScraperConfig, VehicleCategory } from '../../spine/engine/acquisition/mobile-de/types.js';

const ALL_CATEGORIES: VehicleCategory[] = ['Car', 'Motorbike', 'Truck', 'MotorHome'];

// Filter out bare '--' injected by pnpm so parseArgs treats flags correctly
const args = process.argv.slice(2).filter((a) => a !== '--');

const { values } = parseArgs({
  args,
  strict: false,
  options: {
    phase: { type: 'string', default: 'all' },
    concurrency: { type: 'string', default: '2' },
    delay: { type: 'string', default: '3000' },
    'max-retries': { type: 'string', default: '3' },
    limit: { type: 'string', default: '0' },
    categories: { type: 'string', default: '' },
    headless: { type: 'string', default: 'true' },
    db: { type: 'string', default: '' },
    'reset-search': { type: 'boolean', default: false },
    daemon: { type: 'boolean', default: false },
  },
});

const parseCategories = (input: string): VehicleCategory[] => {
  if (!input) return ALL_CATEGORIES;
  return input
    .split(',')
    .map((c) => c.trim())
    .filter((c) => ALL_CATEGORIES.includes(c as VehicleCategory)) as VehicleCategory[];
};

const config: ScraperConfig = {
  phase: (values.phase as ScraperConfig['phase']) ?? 'all',
  concurrency: parseInt(String(values.concurrency ?? '2'), 10),
  delay: parseInt(String(values.delay ?? '3000'), 10),
  maxRetries: parseInt(String(values['max-retries'] ?? '3'), 10),
  limit: parseInt(String(values.limit ?? '0'), 10),
  categories: parseCategories(String(values.categories ?? '')),
  headless: values.headless !== 'false',
  dbPath: String(values.db || '') || resolve('data', 'garaaage.db'),
};

console.log('mobile.de/cz Scraper [Running via Antigravity]');
console.log(`Phase: ${config.phase}, Concurrency: ${config.concurrency}, Delay: ${config.delay}ms`);
console.log(`Categories: ${config.categories.join(', ')}`);
console.log(`Headless: ${config.headless}`);
console.log(`DB: ${config.dbPath}`);
console.log('');

const shutdown = createShutdownHandler();
shutdown.setup();

const db = createDb(config.dbPath);
shutdown.onShutdown(() => {
  console.log('Closing database...');
  db.close();
});

if (values['reset-search']) {
  console.log('Resetting search segments and progress...');
  db.resetSearch();
  console.log('Search data cleared.\n');
}

const run = async (overridePhase?: ScraperConfig['phase']) => {
  let browser: Awaited<ReturnType<typeof launchBrowser>> | null = null;
  const currentPhase = overridePhase || config.phase;

  try {
    browser = await launchBrowser(config.headless);
    
    // Nemůžeme vázat closeBrowser na shutdown v daemon módu vícekrát,
    // to zajistíme jinak, pro teď prostě zavřeme na konci run bloku.

    const context = await createBrowserContext(browser);

    if (currentPhase === 'all' || currentPhase === 'search') {
      await runSearchPhase(context, db, config, shutdown.isShuttingDown);
      if (shutdown.isShuttingDown()) return;
    }

    if (currentPhase === 'all' || currentPhase === 'detail') {
      if (currentPhase === 'all') {
        console.log('Waiting 5s before detail phase...');
        await new Promise((resolve) => setTimeout(resolve, 5000));
      }
      await runDetailPhase(context, db, config, shutdown.isShuttingDown);
    }
  } catch (error) {
    console.error('Fatal error in run():', (error as Error).message);
  } finally {
    if (browser) {
      await closeBrowser(browser);
    }
  }
};

if (values.daemon) {
  console.log('Spouštím v DAEMON módu. Čekám na příkazy z Redisu...');
  const listener = createCommandListener('mobile-de', async (payload) => {
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
