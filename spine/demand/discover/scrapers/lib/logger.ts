import pino from 'pino';

const transports: pino.TransportTargetOptions[] = [];

if (process.env.LOKI_URL) {
  transports.push({
    target: 'pino-loki',
    options: {
      host: process.env.LOKI_URL,
      labels: { service: 'mcp-server', env: process.env.NODE_ENV || 'development' },
      batching: true,
      interval: 5,
    },
    level: 'info',
  });
}

// stdout: pino-pretty in dev, raw JSON in production
if (process.env.NODE_ENV === 'production' || process.env.CI) {
  transports.push({ target: 'pino/file', options: { destination: 1 }, level: 'debug' });
} else {
  transports.push({ target: 'pino-pretty', options: { colorize: true }, level: 'debug' });
}

export const logger = pino({
  level: process.env.LOG_LEVEL || 'info',
  transport: { targets: transports },
});
