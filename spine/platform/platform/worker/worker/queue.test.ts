import { QUEUE_NAME, createRedisConnection } from './queue.js';

vi.mock('ioredis', () => {
  const MockIORedis = vi.fn();
  return { default: MockIORedis };
});

describe('queue', () => {
  const originalEnv = process.env.REDIS_URL;

  afterEach(() => {
    process.env.REDIS_URL = originalEnv;
  });

  describe('QUEUE_NAME', () => {
    it('is rozporuj-pdf', () => {
      expect(QUEUE_NAME).toBe('rozporuj-pdf');
    });
  });

  describe('createRedisConnection', () => {
    it('throws when REDIS_URL is missing', () => {
      delete process.env.REDIS_URL;
      expect(() => createRedisConnection()).toThrow('REDIS_URL is required');
    });

    it('creates IORedis instance with correct URL', async () => {
      process.env.REDIS_URL = 'redis://localhost:6379';
      const { default: MockIORedis } = await import('ioredis');
      createRedisConnection();
      expect(MockIORedis).toHaveBeenCalledWith('redis://localhost:6379', { maxRetriesPerRequest: null });
    });
  });
});
