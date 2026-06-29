import { Queue, Worker, QueueEvents } from 'bullmq';
import IORedis from 'ioredis';

import { ArbitrageOpportunity } from '../../../domain/core-types/index';
// @vektor-link: core-types

// Připojení na Redis. Railway většinou předává Redis URL přes proces.env.REDIS_URL
const redisConnection = new IORedis(process.env.REDIS_URL || 'redis://127.0.0.1:6379', {
  maxRetriesPerRequest: null,
});

const QUEUE_NAME = 'SymphonyArbitrageQueue';

// Vytvoření BullMQ fronty
export const arbitrageQueue = new Queue<ArbitrageOpportunity>(QUEUE_NAME, {
  connection: redisConnection,
  defaultJobOptions: {
    attempts: 3,
    backoff: {
      type: 'exponential',
      delay: 2000,
    },
    removeOnComplete: true, // Čištění po úspěchu
  },
});

// Události pro logování / sledování (QueueEvents)
const queueEvents = new QueueEvents(QUEUE_NAME, { connection: redisConnection });
queueEvents.on('failed', ({ jobId, failedReason }) => {
  console.error(`[SymphonyQueue] Job ${jobId} failed. Reason: ${failedReason}`);
  // DLQ (Dead Letter Queue) logika může reagovat zde, nebo se job automaticky přesouvá do 'failed' stavu v BullMQ
});

export class SymphonyQueue {
  /**
   * Pravá hemisféra (Miner) volá tuto metodu pro zařazení příležitosti do fronty.
   */
  static async enqueue(opportunity: ArbitrageOpportunity) {
    console.log(`[SymphonyQueue] Enqueuing opportunity: ${opportunity.id} (Profit: ${opportunity.expectedProfit})`);
    
    // Uložíme do BullMQ
    await arbitrageQueue.add('arbitrage-deal', opportunity);
  }

  /**
   * Levá hemisféra (Broker) volá tuto metodu pro přihlášení k odběru a zpracování.
   * Využívá BullMQ Worker k asynchronnímu zpracování a vyvažování zátěže (backpressure).
   */
  static subscribe(handler: (op: ArbitrageOpportunity) => Promise<void>) {
    console.log(`[SymphonyQueue] Worker subscribing to queue ${QUEUE_NAME}...`);
    
    const worker = new Worker<ArbitrageOpportunity>(
      QUEUE_NAME,
      async (job) => {
        console.log(`[SymphonyQueue] Worker processing job ${job.id} for opportunity ${job.data.id}...`);
        await handler(job.data);
      },
      { 
        connection: redisConnection,
        concurrency: 5 // Řízení zátěže - kolik úloh se zpracovává naráz
      }
    );

    worker.on('completed', (job) => {
      console.log(`[SymphonyQueue] Opportunity ${job.data.id} processed successfully.`);
    });
    
    worker.on('error', (err) => {
      console.error(`[SymphonyQueue] Worker encountered error:`, err);
    });
  }
}
