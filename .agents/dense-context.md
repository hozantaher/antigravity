# 🧠 Antigravity Dense Context Bundle
## 📜 Core Types (Byznysový slovník)
### `spine/domain/core-types/index.ts`
```typescript
export * from './schemas';
export * from './listing.dto';
```
### `spine/domain/core-types/listing.dto.ts`
```typescript
import { z } from 'zod';
export const RawListingSchema = z.object({
  id: z.string().min(1),
  title: z.string().min(3, "Název inzerátu musí mít alespoň 3 znaky"),
  price: z.number().nonnegative("Cena nesmí být záporná"),
  sourceUrl: z.string().url("Neplatná URL inzerátu"),
  // Volitelná pole pro extrakci z LLM
  make: z.string().optional(),
  model: z.string().optional(),
  mileage: z.number().optional(),
  year: z.number().optional(),
});
export type RawListing = z.infer<typeof RawListingSchema>;
```
### `spine/domain/core-types/schemas.ts`
```typescript
import { z } from 'zod';
/**
 * @terminology ArbitrageOpportunity
 * Reprezentuje nalezenou příležitost na trhu (inzerát), kde 
 * odhadovaná hodnota od LLM je výrazně vyšší než nabízená cena.
 */
export const ArbitrageOpportunitySchema = z.object({
  id: z.string().describe("Interní unikátní ID v systému"),
  assetId: z.string().describe("Původní ID na inzertním portálu"),
  price: z.number().positive().describe("Aktuální cena inzerátu v CZK"),
  estimatedValue: z.number().positive().describe("Odhadovaná tržní hodnota od AI v CZK"),
  expectedProfit: z.number().describe("Očekávaný hrubý zisk v CZK"),
  metadata: z.record(z.string(), z.any()).describe("Doplňující data o inzerátu (url, title, atd.)")
});
export type ArbitrageOpportunity = z.infer<typeof ArbitrageOpportunitySchema>;
/**
 * @terminology Vehicle
 * Normalizovaná reprezentace stroje v našem katalogu.
 */
export const VehicleSchema = z.object({
  vin: z.string().length(17, "VIN musí mít 17 znaků").optional(),
  make: z.string().min(1, "Značka je povinná"),
  model: z.string().min(1, "Model je povinný"),
  year: z.number().int().min(1900).max(new Date().getFullYear() + 1),
  mileage: z.number().nonnegative(),
});
export type Vehicle = z.infer<typeof VehicleSchema>;
/**
 * @terminology Lead
 * Datový payload, který jde ze scrapingu (Deep Inventory) směrem do Arbitrage Mineru.
 */
export const LeadSchema = z.object({
  url: z.string().url(),
  source: z.enum(['mobile-de', 'mascus', 'firmy-cz', 'manual']),
  vehicle: VehicleSchema,
  dealerContact: z.string().email().optional(),
});
export type Lead = z.infer<typeof LeadSchema>;
/**
 * @terminology ShadowDraft
 * Rozpracovaný, neviditelný návrh inzerátu vytvořený naší Levou hemisférou.
 * Prodejce ho uvidí až po kliknutí na Magic Link.
 */
export const ShadowDraftSchema = z.object({
  draftId: z.string().uuid(),
  contactEmail: z.string().email(),
  opportunityId: z.string(),
  createdAt: z.string().datetime(),
  status: z.enum(['pending', 'claimed', 'expired'])
});
export type ShadowDraft = z.infer<typeof ShadowDraftSchema>;
```
## 🔌 Veřejné kontrakty uzlů (Node Boundaries)
### `spine/acquisition/scrapers/scrapers/autoline/index.ts`
```typescript
import { resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { createShutdownHandler } from '../../lib/utils.js';
import { createDb } from './db.js';
import { runDetailPhase } from './scraper.js';
import { runSitemapPhase } from './sitemap.js';
import type { ScraperConfig } from './types.js';
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
console.log('Autoline.cz Scraper');
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
const run = async () => {
  try {
    if (config.phase === 'all' || config.phase === 'sitemap') {
      await runSitemapPhase(db, shutdown.isShuttingDown);
      if (shutdown.isShuttingDown()) return;
    }
    if (config.phase === 'all' || config.phase === 'detail') {
      // Pause before detail phase to let any residual rate limiting expire
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
```
### `spine/acquisition/scrapers/scrapers/esbirka/index.ts`
```typescript
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
```
### `spine/acquisition/scrapers/scrapers/firmy-cz/index.ts`
```typescript
import { resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { createShutdownHandler } from '../../lib/utils.js';
import { createDb } from './db.js';
import { runDetailPhase } from './scraper.js';
import { runSitemapPhase } from './sitemap.js';
import type { ScraperConfig } from './types.js';
const args = process.argv.slice(2).filter((a) => a !== '--');
const { values } = parseArgs({
  args,
  strict: false,
  options: {
    phase: { type: 'string', default: 'all' },
    concurrency: { type: 'string', default: '3' },
    delay: { type: 'string', default: '2000' },
    'max-retries': { type: 'string', default: '3' },
    limit: { type: 'string', default: '0' },
    db: { type: 'string', default: '' },
  },
});
const config: ScraperConfig = {
  phase: (values.phase as ScraperConfig['phase']) ?? 'all',
  concurrency: parseInt(String(values.concurrency ?? '3'), 10),
  delay: parseInt(String(values.delay ?? '2000'), 10),
  maxRetries: parseInt(String(values['max-retries'] ?? '3'), 10),
  limit: parseInt(String(values.limit ?? '0'), 10),
  dbPath: String(values.db || '') || resolve('data', 'garaaage.db'),
};
console.log('Firmy.cz Scraper');
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
const run = async () => {
  try {
    if (config.phase === 'all' || config.phase === 'sitemap') {
      await runSitemapPhase(db, shutdown.isShuttingDown);
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
```
### `spine/acquisition/scrapers/scrapers/judikaty/index.ts`
```typescript
import { resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { createShutdownHandler } from '../../lib/utils.js';
import { createDb } from './db.js';
import { setupLogging } from './logger.js';
import type { ScraperConfig, Source, SourceModule } from './types.js';
const args = process.argv.slice(2).filter((a) => a !== '--');
const { values } = parseArgs({
  args,
  strict: false,
  options: {
    source: { type: 'string', default: '' },
    phase: { type: 'string', default: 'all' },
    concurrency: { type: 'string', default: '5' },
    delay: { type: 'string', default: '100' },
    'max-retries': { type: 'string', default: '3' },
    limit: { type: 'string', default: '0' },
    db: { type: 'string', default: '' },
    'log-file': { type: 'string', default: '' },
  },
});
const sourceArg = String(values.source || '');
if (!sourceArg || !['justice', 'usoud', 'nssoud', 'nsoud', 'all'].includes(sourceArg)) {
  console.error('Usage: scrape:judikaty -- --source=<justice|usoud|nssoud|nsoud|all> [--phase=all] [options]');
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
// vyhledavac.nssoud.cz has no robots.txt (nssoud.cz has Crawl-delay: 10 but that's the TYPO3 site, not the search app)
const logFile = String(values['log-file'] || '') || undefined;
setupLogging(logFile);
console.log('Czech Court Decisions Scraper (Judikáty)');
console.log(
  `Source: ${config.source}, Phase: ${config.phase}, Concurrency: ${config.concurrency}, Delay: ${config.delay}ms`,
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
const loadSource = async (source: Source): Promise<SourceModule> => {
  switch (source) {
    case 'justice': {
      const discovery = await import('./sources/justice/discovery.js');
      const scraper = await import('./sources/justice/scraper.js');
      return { runDiscovery: discovery.runDiscovery, runDetail: scraper.runDetail };
    }
    case 'usoud': {
      const discovery = await import('./sources/usoud/discovery.js');
      const scraper = await import('./sources/usoud/scraper.js');
      return { runDiscovery: discovery.runDiscovery, runDetail: scraper.runDetail };
    }
    case 'nssoud': {
      const discovery = await import('./sources/nssoud/discovery.js');
      const scraper = await import('./sources/nssoud/scraper.js');
      return { runDiscovery: discovery.runDiscovery, runDetail: scraper.runDetail };
    }
    case 'nsoud': {
      const discovery = await import('./sources/nsoud/discovery.js');
      const scraper = await import('./sources/nsoud/scraper.js');
      return { runDiscovery: discovery.runDiscovery, runDetail: scraper.runDetail };
    }
  }
};
const runSource = async (source: Source) => {
  if (shutdown.isShuttingDown()) return;
  const sourceConfig: ScraperConfig = { ...config, source };
  console.log(`\n${'='.repeat(60)}`);
  console.log(`Source: ${source}`);
  console.log('='.repeat(60));
  const mod = await loadSource(source);
  if (config.phase === 'all' || config.phase === 'discovery') {
    await mod.runDiscovery(db, sourceConfig, shutdown.isShuttingDown);
    if (shutdown.isShuttingDown()) return;
  }
  if (config.phase === 'all' || config.phase === 'detail') {
    if (config.phase === 'all') {
      console.log('Waiting 5s before detail phase...');
      await new Promise((resolve) => setTimeout(resolve, 5000));
    }
    await mod.runDetail(db, sourceConfig, shutdown.isShuttingDown);
  }
};
const ALL_SOURCES: Source[] = ['justice', 'usoud', 'nssoud', 'nsoud'];
const run = async () => {
  try {
    const sources = config.source === 'all' ? ALL_SOURCES : [config.source as Source];
    for (const source of sources) {
      if (shutdown.isShuttingDown()) break;
      await runSource(source);
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
```
### `spine/acquisition/scrapers/scrapers/mascus-cz/index.ts`
```typescript
import { resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { createShutdownHandler } from '../../lib/utils.js';
import { createDb } from './db.js';
import { runDetailPhase } from './scraper.js';
import { runSitemapPhase } from './sitemap.js';
import type { ScraperConfig } from './types.js';
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
console.log('Mascus.cz Scraper');
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
const run = async () => {
  try {
    if (config.phase === 'all' || config.phase === 'sitemap') {
      await runSitemapPhase(db, shutdown.isShuttingDown);
      if (shutdown.isShuttingDown()) return;
    }
    if (config.phase === 'all' || config.phase === 'detail') {
      // Pause before detail phase to let any residual rate limiting expire
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
```
### `spine/acquisition/scrapers/scrapers/mobile-de/index.ts`
```typescript
import { resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { createShutdownHandler } from '../../lib/utils.js';
import { closeBrowser, createBrowserContext, launchBrowser } from './browser.js';
import { createDb } from './db.js';
import { runDetailPhase } from './scraper.js';
import { runSearchPhase } from './search.js';
import type { ScraperConfig, VehicleCategory } from './types.js';
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
console.log('mobile.de/cz Scraper');
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
const run = async () => {
  let browser: Awaited<ReturnType<typeof launchBrowser>> | null = null;
  try {
    browser = await launchBrowser(config.headless);
    shutdown.onShutdown(async () => {
      console.log('Closing browser...');
      await closeBrowser(browser);
    });
    const context = await createBrowserContext(browser);
    if (config.phase === 'all' || config.phase === 'search') {
      await runSearchPhase(context, db, config, shutdown.isShuttingDown);
      if (shutdown.isShuttingDown()) return;
    }
    if (config.phase === 'all' || config.phase === 'detail') {
      // Pause before detail phase if running both phases
      if (config.phase === 'all') {
        console.log('Waiting 5s before detail phase...');
        await new Promise((resolve) => setTimeout(resolve, 5000));
      }
      await runDetailPhase(context, db, config, shutdown.isShuttingDown);
    }
  } catch (error) {
    console.error('Fatal error:', (error as Error).message);
    process.exitCode = 1;
  } finally {
    if (!shutdown.isShuttingDown()) {
      await closeBrowser(browser);
      db.close();
    }
  }
};
run();
```
### `spine/acquisition/scrapers/src/index.ts`
```typescript
import 'dotenv/config';
import type { Server } from 'http';
import { logger } from '../lib/logger.js';
import { startWorker, stopWorker } from './queue/scrape-worker.js';
import { startHealthServer } from '../lib/health.js';
const worker = startWorker();
// Spustit health server (default port 8090 dle konvence)
const healthPort = parseInt(process.env.HEALTH_PORT || '8090', 10);
const healthServer: Server = startHealthServer(healthPort, 'scrapers');
const shutdown = async () => {
  logger.info('scrape-worker: received shutdown signal');
  // Zavřít health server
  await new Promise<void>((resolve) => {
    healthServer.close(() => {
      resolve();
    });
  });
  await stopWorker();
  process.exit(0);
};
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
logger.info({ pid: process.pid, healthPort }, 'garaaage-scrapers worker running');
// Keep the process alive — BullMQ worker maintains its own event loop.
export { worker, healthServer };
```
### `spine/demand/acquisition/deep-inventory/index.ts`
```typescript
export * from './scraper';
export * from './queue';
export * from './worker';
export * from './scheduler';
export * from './delta-engine';
```
### `spine/engine/automation/rule-registry/index.ts`
```typescript
export { RuleRegistry } from './cache';
```
### `spine/engine/automation/symphony-queue/index.ts`
```typescript
export { SymphonyQueue } from './logic';
export type { ArbitrageOpportunity } from '../../../domain/core-types/index';
```
### `spine/engine/intelligence/arbitrage-miner/index.ts`
```typescript
export { ArbitrageMiner } from './miner';
```
### `spine/engine/intelligence/parser-compiler/index.ts`
```typescript
export { CheerioCompiler } from './compiler';
```
### `spine/engine/intelligence/relay/index.ts`
```typescript
export * from './logic';
```
### `spine/engine/learn/index.ts`
```typescript
export * from './self-healing';
```
### `spine/platform/mcp/mcp-server/index.ts`
```typescript
import './sentry.js';
import { parseArgs } from 'util';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { registerTools, registerResources, initSources } from './tools.js';
import { VERSION } from './version.js';
import { logger } from '../lib/logger.js';
const { values } = parseArgs({
  args: process.argv.slice(2).filter((a) => a !== '--'),
  options: {
    mode: { type: 'string', default: 'stdio' },
  },
  strict: false,
});
if (values.mode === 'http') {
  const port = parseInt(process.env.MCP_PORT || '3000', 10);
  const issuerUrl = process.env.MCP_ISSUER_URL;
  const secret = process.env.MCP_SECRET;
  if (!issuerUrl || !secret) {
    logger.fatal('HTTP mode requires MCP_ISSUER_URL and MCP_SECRET environment variables');
    process.exit(1);
  }
  const { startHttpServer } = await import('./http.js');
  const { createRedisStore, createMemoryStore } = await import('./auth.js');
  let store;
  if (process.env.REDIS_URL) {
    const ioredis = await import('ioredis');
    const RedisClient = ioredis.default ?? ioredis;
    const redis = new (RedisClient as any)(process.env.REDIS_URL, { maxRetriesPerRequest: 3, lazyConnect: true });
    redis.on('error', (err: unknown) => logger.warn({ err }, 'Redis client error'));
    try {
      await redis.connect();
      store = createRedisStore(redis);
      logger.info('OAuth store: Redis');
    } catch (e) {
      logger.warn({ err: e }, 'Redis connection failed, falling back to in-memory');
      store = createMemoryStore();
    }
  } else {
    store = createMemoryStore();
    logger.info('OAuth store: in-memory (set REDIS_URL for persistence)');
  }
  const sourceNames = await initSources();
  logger.info({ sources: sourceNames }, 'Sources discovered');
  startHttpServer(port, issuerUrl, secret, store);
} else {
  const sourceNames = await initSources();
  logger.info({ sources: sourceNames }, 'Sources discovered');
  const server = new McpServer({
    name: 'garaaage-scrapers',
    version: VERSION,
  });
  registerTools(server);
  registerResources(server);
  const transport = new StdioServerTransport();
  await server.connect(transport);
}
```
### `spine/platform/security/privacy-gateway/index.ts`
```typescript
export * from './logic';
```
### `spine/platform/worker/worker/index.ts`
```typescript
import 'dotenv/config';
import './sentry.js';
import { Worker, type Job } from 'bullmq';
import type { Redis as RedisClient } from 'ioredis';
import type { Server } from 'http';
import { createRedisConnection, QUEUE_NAME, type PdfJobData, type PdfJobResult } from './queue.js';
import {
  downloadFiles,
  uploadResults,
  uploadFile,
  fileExists,
  getSignedUrl,
} from './firebase.js';
import { generateOdpor, closeMcp } from './generate-odpor.js';
import { markdownToDocx } from '../scripts/lib/docx-writer.js';
import { docxToPdf } from './pdf.js';
import { sendResultEmail } from './email.js';
import { logger as baseLogger } from '../lib/logger.js';
import { startHealthServer } from '../lib/health.js';
const logger = baseLogger.child({ service: 'rozporuj-worker' });
// Paths written under results/<sessionId>/ by a successful run. Used to
// short-circuit an idempotent retry without re-running Claude.
const resultPaths = (sessionId: string) => ({
  pdf: `results/${sessionId}/odpor.pdf`,
  docx: `results/${sessionId}/odpor.docx`,
  conversation: `results/${sessionId}/conversation.md`,
});
/** H7 — idempotent short-circuit. If a prior run of this sessionId already
 *  uploaded results/<sessionId>/odpor.pdf, we re-issue signed URLs and resend
 *  the email without re-running Claude / LibreOffice. Matches the CLAUDE.md
 *  rule "All job handlers must be idempotent". */
export const maybeShortCircuit = async (
  sessionId: string,
): Promise<{
  outputPath: string;
  downloadUrl: string;
  docxUrl: string;
  conversationUrl: string;
} | null> => {
  const paths = resultPaths(sessionId);
  const pdfExists = await fileExists(paths.pdf).catch(() => false);
  if (!pdfExists) return null;
  const [downloadUrl, docxUrl, conversationUrl] = await Promise.all([
    getSignedUrl(paths.pdf),
    getSignedUrl(paths.docx).catch(() => ''),
    getSignedUrl(paths.conversation).catch(() => ''),
  ]);
  return { outputPath: paths.pdf, downloadUrl, docxUrl, conversationUrl };
};
export const processJob = async (job: Job<PdfJobData>): Promise<PdfJobResult> => {
  const { sessionId, email, firstName, lastName } = job.data;
  const log = logger.child({ jobId: job.id, sessionId });
  log.info('Job started');
  // H7 idempotency — short-circuit if results already uploaded.
  const cached = await maybeShortCircuit(sessionId);
  if (cached) {
    log.info({ outputPath: cached.outputPath }, 'Idempotent replay: result already exists, resending email only');
    await job.updateProgress(95);
    await sendResultEmail({ to: email, firstName, downloadUrl: cached.downloadUrl, docxUrl: cached.docxUrl });
    await job.updateProgress(100);
    return {
      downloadUrl: cached.downloadUrl,
      docxUrl: cached.docxUrl,
      conversationUrl: cached.conversationUrl,
      outputPath: cached.outputPath,
    };
  }
  // 1. Download uploaded files from Firebase
  await job.updateProgress(10);
  log.info('Downloading files from Firebase...');
  const files = await downloadFiles(sessionId);
  if (files.length === 0) throw new Error(`No files found for session ${sessionId}`);
  log.info({ fileCount: files.length }, 'Files downloaded');
  // 2. Generate legal analysis via Claude API + MCP tools
  await job.updateProgress(20);
  const { markdown, conversationLog } = await generateOdpor(files, { firstName, lastName, prompt: job.data.prompt, userNotes: job.data.userNotes }, (msg) => {
    log.info(msg);
  });
  log.info({ length: markdown.length }, 'Legal analysis generated');
  // 3. Markdown → DOCX
  await job.updateProgress(70);
  log.info('Converting markdown to DOCX...');
  const docxBuffer = await markdownToDocx(markdown, `Odpor proti pokutě — ${firstName} ${lastName}`, {
    style: 'legal',
    showTitle: false,
    headerText: 'Rozporuj.com',
  });
  // 4. DOCX → PDF
  await job.updateProgress(80);
  log.info('Converting DOCX to PDF...');
  const pdfBuffer = await docxToPdf(docxBuffer);
  log.info({ pdfSize: pdfBuffer.length }, 'PDF generated');
  // 5. Upload PDF + DOCX + conversation log to Firebase
  await job.updateProgress(90);
  log.info('Uploading results to Firebase...');
  const [{ outputPath, downloadUrl, docxUrl }, conversationUrl] = await Promise.all([
    uploadResults(sessionId, pdfBuffer, docxBuffer),
    uploadFile(`results/${sessionId}/conversation.md`, Buffer.from(conversationLog, 'utf-8'), 'text/markdown'),
  ]);
  // 6. Send email
  await job.updateProgress(95);
  log.info('Sending result email...');
  await sendResultEmail({ to: email, firstName, downloadUrl, docxUrl });
  await job.updateProgress(100);
  log.info({ outputPath }, 'Job completed successfully');
  return { downloadUrl, docxUrl, conversationUrl, outputPath };
};
// --- Worker setup ---
const CONCURRENCY = parseInt(process.env.WORKER_CONCURRENCY || '2', 10);
// Hard ceiling on the full shutdown sequence. Railway typically sends SIGKILL
// ~30s after SIGTERM; we bound the graceful path inside that window.
export const SHUTDOWN_TIMEOUT_MS = parseInt(process.env.WORKER_SHUTDOWN_TIMEOUT_MS || '30000', 10);
// M6: Without removeOnComplete / removeOnFail, BullMQ keeps every job record in
// Redis forever — a long-lived worker accumulates thousands of entries and
// eventually exceeds the Railway Redis memory ceiling. These defaults are
// exported so tests can assert the values and callers can override per-queue.
export const REMOVE_ON_COMPLETE: { count: number } = { count: 100 };
export const REMOVE_ON_FAIL: { count: number } = { count: 200 };
// M4: Per-job wallclock budget. Exposed for tests.
export const MAX_ITER_BUDGET_MS = parseInt(process.env.WORKER_MAX_ITER_BUDGET_MS || '300000', 10); // 5 min default
/**
 * H1/H5 — ordered, bounded graceful shutdown.
 *
 * Order: worker.close() (BullMQ drains in-flight jobs) → connection.quit()
 * (ioredis flushes + quits) → closeMcp() (release MCP singleton).
 *
 * Each step is awaited. The entire sequence is bounded by SHUTDOWN_TIMEOUT_MS
 * via Promise.race — if any step hangs (e.g. Redis partition) we still
 * terminate instead of being SIGKILLed by Railway.
 *
 * Exit code is 0 only if every step completed cleanly. On any error or
 * timeout we exit 1 so Railway / systemd can distinguish a drained shutdown
 * from a failed one.
 */
export const runShutdown = async (deps: {
  worker: Pick<Worker, 'close'>;
  connection: Pick<RedisClient, 'quit'>;
  closeMcpClient: () => void;
  healthServer?: Server;
  log: Pick<typeof logger, 'info' | 'error' | 'warn'>;
  timeoutMs: number;
}): Promise<number> => {
  const { worker, connection, closeMcpClient, healthServer, log, timeoutMs } = deps;
  const drain = (async () => {
    // Step 1: close health server if present
    if (healthServer) {
      log.info('Closing health server...');
      await new Promise<void>((resolve) => {
        healthServer.close(() => {
          resolve();
        });
      });
    }
    // Step 2: drain BullMQ worker. `worker.close()` awaits active jobs,
    // stops the queue consumer, and releases locks.
    log.info('Draining BullMQ worker (waits for in-flight jobs)...');
    await worker.close();
    // Step 3: quit ioredis. `quit()` sends QUIT and waits for server ack,
    // unlike `disconnect()` which rips the socket.
    log.info('Closing Redis connection...');
    try {
      await connection.quit();
    } catch (e) {
      // ioredis rejects quit() if the connection is already closed — not fatal.
      log.warn({ err: e instanceof Error ? e.message : String(e) }, 'Redis quit raised (likely already closed)');
    }
    // Step 4: release MCP singleton. No network handle to close; this just
    // clears the process-global reference so GC can reclaim it.
    log.info('Releasing MCP client...');
    closeMcpClient();
  })();
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<'timeout'>((resolve) => {
    timer = setTimeout(() => resolve('timeout'), timeoutMs);
  });
  try {
    const result = await Promise.race([drain.then(() => 'ok' as const), timeout]);
    if (result === 'timeout') {
      log.error({ timeoutMs }, 'Shutdown timed out — forcing exit(1)');
      return 1;
    }
    log.info('Graceful shutdown complete');
    return 0;
  } catch (e) {
    log.error({ err: e instanceof Error ? e.message : String(e) }, 'Shutdown failed — exit(1)');
    return 1;
  } finally {
    if (timer) clearTimeout(timer);
  }
};
/** Wire process-level error handlers and signal handlers. Exported for tests. */
export const installProcessHandlers = (handlers: {
  onShutdown: (signal: string) => Promise<void>;
  onFatal: (origin: string, err: unknown) => void;
  processRef?: NodeJS.Process;
}): void => {
  const proc = handlers.processRef ?? process;
  // H6 — without these, a detached promise throw (e.g. from onProgress) kills
  // the worker silently. We log + trigger shutdown + mark exit code 1.
  proc.on('uncaughtException', (err) => handlers.onFatal('uncaughtException', err));
  proc.on('unhandledRejection', (err) => handlers.onFatal('unhandledRejection', err));
  proc.on('SIGTERM', () => {
    void handlers.onShutdown('SIGTERM');
  });
  proc.on('SIGINT', () => {
    void handlers.onShutdown('SIGINT');
  });
};
// --- Bootstrap (skipped under test via NODE_ENV === 'test' or VITEST) ---
const isTest = process.env.NODE_ENV === 'test' || process.env.VITEST === 'true' || !!process.env.VITEST;
if (!isTest) {
  const connection = createRedisConnection();
  // Spustit health server (default port 8090 dle konvence)
  const healthPort = parseInt(process.env.HEALTH_PORT || '8090', 10);
  const healthServer: Server = startHealthServer(healthPort, 'worker');
  const worker = new Worker<PdfJobData, PdfJobResult>(QUEUE_NAME, processJob, {
    connection,
    concurrency: CONCURRENCY,
    limiter: { max: 10, duration: 60_000 },
    // M6: cap stored job records so Redis doesn't grow unbounded.
    removeOnComplete: REMOVE_ON_COMPLETE,
    removeOnFail: REMOVE_ON_FAIL,
  });
  worker.on('completed', (job) => {
    logger.info({ jobId: job.id, sessionId: job.data.sessionId }, 'Job completed');
  });
  worker.on('failed', (job, err) => {
    logger.error({ jobId: job?.id, sessionId: job?.data.sessionId, err }, 'Job failed');
  });
  worker.on('error', (err) => {
    logger.error({ error: err.message }, 'Worker error');
  });
  logger.info({ concurrency: CONCURRENCY, queue: QUEUE_NAME, healthPort }, 'Worker started');
  let shuttingDown = false;
  const shutdown = async (signal: string) => {
    if (shuttingDown) {
      logger.warn({ signal }, 'Shutdown already in progress');
      return;
    }
    shuttingDown = true;
    logger.info({ signal }, 'Shutdown signal received');
    const code = await runShutdown({
      worker,
      connection,
      closeMcpClient: closeMcp,
      healthServer,
      log: logger,
      timeoutMs: SHUTDOWN_TIMEOUT_MS,
    });
    process.exit(code);
  };
  const onFatal = (origin: string, err: unknown) => {
    logger.error(
      { origin, err: err instanceof Error ? { message: err.message, stack: err.stack } : err },
      'Fatal error — initiating shutdown',
    );
    // Schedule shutdown; do not block the handler itself.
    void (async () => {
      const code = await runShutdown({
        worker,
        connection,
        closeMcpClient: closeMcp,
        healthServer,
        log: logger,
        timeoutMs: SHUTDOWN_TIMEOUT_MS,
      });
      // Any fatal always yields exit 1, even if shutdown itself was clean —
      // the originating error is the signal.
      process.exit(code === 0 ? 1 : code);
    })();
  };
  installProcessHandlers({ onShutdown: shutdown, onFatal });
}
```

