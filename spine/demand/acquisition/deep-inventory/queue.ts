import { Queue } from 'bullmq';
import IORedis from 'ioredis';

export const redisConnection = new IORedis(process.env.REDIS_URL || 'redis://127.0.0.1:6379', {
  maxRetriesPerRequest: null,
});

export const CRAWLER_QUEUE_NAME = 'DeepCrawlerQueue';

export const crawlerQueue = new Queue(CRAWLER_QUEUE_NAME, {
  // Přetypování kvůli nesouladu typů bullmq/ioredis
  connection: redisConnection as any,
  defaultJobOptions: {
    attempts: 3,
    backoff: {
      type: 'exponential',
      delay: 5000,
    },
    removeOnComplete: true,
  },
});
