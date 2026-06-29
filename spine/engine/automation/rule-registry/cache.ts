import IORedis from 'ioredis';

const redis = new IORedis(process.env.REDIS_URL || 'redis://127.0.0.1:6379', {
  maxRetriesPerRequest: null,
});

export class RuleRegistry {
  static async getRule(domain: string): Promise<string | null> {
    return await redis.get(`rule-registry:${domain}`);
  }

  static async saveRule(domain: string, code: string): Promise<void> {
    // Expirace po 7 dnech pro automatický re-compiler run
    await redis.set(`rule-registry:${domain}`, code, 'EX', 7 * 24 * 60 * 60);
  }
}
