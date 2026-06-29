import { Queue } from 'bullmq';
import Redis from 'ioredis';
// @ts-ignore
import RedisMock from 'ioredis-mock';

// Bezpečnostní vrstva: V testech nikdy nesaháme na reálný Redis.
const isTest = process.env.NODE_ENV === 'test';

export const redisConnection = isTest ? new RedisMock() : new Redis({
  host: process.env.REDIS_HOST || '127.0.0.1',
  port: parseInt(process.env.REDIS_PORT || '6379'),
  maxRetriesPerRequest: null
});

// Fronta pro Kognitivní vrstvu (Vysoká propustnost, škáluje horizontálně)
export const brainQueue = new Queue('Q_BRAIN', { connection: redisConnection });

// Fronta pro Exekuční vrstvu (Zde nastavíme přísnější Rate Limiting proti spamu)
export const handsQueue = new Queue('Q_HANDS', { 
  connection: redisConnection,
  defaultJobOptions: {
    attempts: 3,
    backoff: { type: 'exponential', delay: 1000 }
  }
});
