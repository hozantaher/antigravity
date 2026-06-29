import express from 'express';
import { Queue } from 'bullmq';
import IORedis from 'ioredis';

// Singleton pro command queue, aby se neotevíralo spojení pro každý request
let commandQueue = null;

function getQueue() {
  if (!commandQueue) {
    const connection = new IORedis(process.env.REDIS_URL || 'redis://127.0.0.1:6379');
    commandQueue = new Queue('antigravity-commands', { connection });
  }
  return commandQueue;
}

export function mountScrapersRoutes(app) {
  const router = express.Router();

  // POST /api/scrapers/command
  // { target: 'mobile-de', phase: 'search' }
  router.post('/command', async (req, res) => {
    try {
      const { target, phase } = req.body;
      if (!target || !phase) {
        return res.status(400).json({ error: 'Missing target or phase' });
      }

      const queue = getQueue();
      const job = await queue.add('start-scraper', { target, phase });
      
      res.json({ success: true, jobId: job.id, message: `Command queued for ${target} [${phase}]` });
    } catch (err) {
      console.error('[Scrapers API] Failed to enqueue command:', err);
      res.status(500).json({ error: 'Failed to enqueue command' });
    }
  });

  app.use('/api/scrapers', router);
}
