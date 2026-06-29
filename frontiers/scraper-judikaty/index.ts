import { resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { createShutdownHandler } from '../../spine/engine/acquisition/shared/utils.js';
import { createCommandListener } from '../../spine/engine/acquisition/shared/daemon.js';
import { createDb } from '../../spine/engine/acquisition/judikaty/db.js';
import { setupLogging } from '../../spine/engine/acquisition/judikaty/logger.js';
import type { ScraperConfig, Source, SourceModule } from '../../spine/engine/acquisition/judikaty/types.js';

const args = process.argv.slice(2).filter((a) => a !== '--');

const { values } = parseArgs({
  args,
  strict: false,
  options: {
    source: { type: 'string', default: 'all' },
    phase: { type: 'string', default: 'all' },
    concurrency: { type: 'string', default: '5' },
    delay: { type: 'string', default: '100' },
    'max-retries': { type: 'string', default: '3' },
    limit: { type: 'string', default: '0' },
    db: { type: 'string', default: '' },
    'log-file': { type: 'string', default: '' },
    daemon: { type: 'boolean', default: false },
  },
});

const sourceArg = String(values.source || '');
if (!sourceArg || !['justice', 'usoud', 'nssoud', 'nsoud', 'all'].includes(sourceArg)) {
  console.error('Usage: --source=<justice|usoud|nssoud|nsoud|all> [--phase=all] [options]');
  process.exit(1);
}

const config: ScraperConfig = {
  source: sourceArg as ScraperConfig['source'],
  phase: (values.phase as ScraperConfig['phase']) ?? 'all',
  concurrency: parseInt(String(values.concurrency ?? '5'), 10),
  delay: parseInt(String(values.delay ?? '500'), 10),
  maxRetries: parseInt(String(values['max-retries'] ?? '3'), 10),
  limit: parseInt(String(values.limit ?? '0'), 10),
  dbPath: String(values.db || '') || resolve('data', 'garaaage.db'),
};

const logFile = String(values['log-file'] || '') || undefined;
setupLogging(logFile);

console.log('Czech Court Decisions Scraper (Judikáty) [Running via Antigravity]');
console.log(`Source: ${config.source}, Phase: ${config.phase}, Concurrency: ${config.concurrency}, Delay: ${config.delay}ms`);
console.log(`DB: ${config.dbPath}`);
console.log('');

const shutdown = createShutdownHandler();
shutdown.setup();

const db = createDb(config.dbPath);
shutdown.onShutdown(() => {
  console.log('Closing database...');
  db.close();
});

const loadSource = async (source: Source): Promise<SourceModule> => {
  switch (source) {
    case 'justice': {
      const discovery = await import('../../spine/engine/acquisition/judikaty/sources/justice/discovery.js');
      const scraper = await import('../../spine/engine/acquisition/judikaty/sources/justice/scraper.js');
      return { runDiscovery: discovery.runDiscovery, runDetail: scraper.runDetail };
    }
    case 'usoud': {
      const discovery = await import('../../spine/engine/acquisition/judikaty/sources/usoud/discovery.js');
      const scraper = await import('../../spine/engine/acquisition/judikaty/sources/usoud/scraper.js');
      return { runDiscovery: discovery.runDiscovery, runDetail: scraper.runDetail };
    }
    case 'nssoud': {
      const discovery = await import('../../spine/engine/acquisition/judikaty/sources/nssoud/discovery.js');
      const scraper = await import('../../spine/engine/acquisition/judikaty/sources/nssoud/scraper.js');
      return { runDiscovery: discovery.runDiscovery, runDetail: scraper.runDetail };
    }
    case 'nsoud': {
      const discovery = await import('../../spine/engine/acquisition/judikaty/sources/nsoud/discovery.js');
      const scraper = await import('../../spine/engine/acquisition/judikaty/sources/nsoud/scraper.js');
      return { runDiscovery: discovery.runDiscovery, runDetail: scraper.runDetail };
    }
  }
};

const runSource = async (source: Source, phaseOverride?: string) => {
  if (shutdown.isShuttingDown()) return;

  const currentPhase = phaseOverride || config.phase;
  const sourceConfig: ScraperConfig = { ...config, source };

  console.log(`\n${'='.repeat(60)}`);
  console.log(`Source: ${source}`);
  console.log('='.repeat(60));

  const mod = await loadSource(source);

  if (currentPhase === 'all' || currentPhase === 'discovery') {
    await mod.runDiscovery(db, sourceConfig, shutdown.isShuttingDown);
    if (shutdown.isShuttingDown()) return;
  }

  if (currentPhase === 'all' || currentPhase === 'detail') {
    if (currentPhase === 'all') {
      console.log('Waiting 5s before detail phase...');
      await new Promise((resolve) => setTimeout(resolve, 5000));
    }
    await mod.runDetail(db, sourceConfig, shutdown.isShuttingDown);
  }
};

const ALL_SOURCES: Source[] = ['justice', 'usoud', 'nssoud', 'nsoud'];

const run = async (phaseOverride?: string) => {
  try {
    const sources = config.source === 'all' ? ALL_SOURCES : [config.source as Source];

    for (const source of sources) {
      if (shutdown.isShuttingDown()) break;
      await runSource(source, phaseOverride);
    }
  } catch (error) {
    console.error('Fatal error in run():', (error as Error).message);
  }
};

if (values.daemon) {
  console.log('Spouštím v DAEMON módu. Čekám na příkazy z Redisu...');
  const listener = createCommandListener('judikaty', async (payload) => {
    console.log(`Provádím příkaz: ${payload.phase}`);
    await run(payload.phase);
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
