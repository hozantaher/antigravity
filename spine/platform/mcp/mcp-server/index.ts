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
