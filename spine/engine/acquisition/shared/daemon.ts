import { Worker, Job } from 'bullmq';
import IORedis from 'ioredis';

export interface CommandPayload {
  target: string;
  phase: 'search' | 'detail' | 'sitemap' | 'all';
  concurrency?: number;
  limit?: number;
}

export const createCommandListener = (
  scraperId: string,
  onCommand: (payload: CommandPayload) => Promise<void>
) => {
  const connection = new IORedis(process.env.REDIS_URL || 'redis://127.0.0.1:6379', {
    maxRetriesPerRequest: null,
  });

  console.log(`[Daemon] 📡 ${scraperId} is listening for remote commands...`);

  const worker = new Worker(
    'antigravity-commands',
    async (job: Job<CommandPayload>) => {
      // Zpracováváme jen commandy určené pro tento scraper
      if (job.data.target !== scraperId && job.data.target !== 'all') {
        return { skipped: true, reason: 'Not targeted for this scraper' };
      }

      console.log(`\n[Daemon] ⚡ Received Remote Command: START ${job.data.phase.toUpperCase()}`);
      
      try {
        await onCommand(job.data);
        return { success: true };
      } catch (err) {
        console.error(`[Daemon] ❌ Command execution failed:`, err);
        throw err;
      }
    },
    { connection }
  );

  worker.on('failed', (job, err) => {
    console.error(`[Daemon] ❌ Job failed with error: ${err.message}`);
  });

  const stop = async () => {
    console.log(`[Daemon] Shutting down listener for ${scraperId}...`);
    await worker.close();
    await connection.quit();
  };

  return { stop };
};
