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
