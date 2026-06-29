import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const originalEnv = { ...process.env };

async function loadLoggerWithEnv(env: Record<string, string | undefined>) {
  vi.resetModules();

  const setEnv = (key: string, value: string | undefined) => {
    if (value === undefined) {
      delete (process.env as Record<string, string | undefined>)[key];
    } else {
      process.env[key] = value;
    }
  };
  setEnv('NODE_ENV', env.NODE_ENV);
  setEnv('CI', env.CI);
  setEnv('LOKI_URL', env.LOKI_URL);
  setEnv('LOG_LEVEL', env.LOG_LEVEL);

  const pinoMock = vi.fn().mockReturnValue({ name: 'logger-instance' });
  vi.doMock('pino', () => ({
    default: pinoMock,
  }));

  const mod = await import('./logger');
  return { mod, pinoMock };
}

describe('logger', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    process.env = { ...originalEnv };
  });

  it('uses pretty stdout transport in development', async () => {
    const { mod, pinoMock } = await loadLoggerWithEnv({
      NODE_ENV: 'development',
      CI: undefined,
      LOKI_URL: undefined,
      LOG_LEVEL: undefined,
    });

    expect(mod.logger).toEqual({ name: 'logger-instance' });
    expect(pinoMock).toHaveBeenCalledTimes(1);

    const cfg = pinoMock.mock.calls[0][0];
    expect(cfg.level).toBe('info');
    expect(cfg.transport.targets).toEqual([
      { target: 'pino-pretty', options: { colorize: true }, level: 'debug' },
    ]);
  });

  it('adds Loki and raw file transport in production/CI', async () => {
    const { pinoMock } = await loadLoggerWithEnv({
      NODE_ENV: 'production',
      CI: '1',
      LOKI_URL: 'https://loki.example.com',
      LOG_LEVEL: 'debug',
    });

    const cfg = pinoMock.mock.calls[0][0];
    expect(cfg.level).toBe('debug');
    expect(cfg.transport.targets).toEqual([
      {
        target: 'pino-loki',
        options: {
          host: 'https://loki.example.com',
          labels: { service: 'mcp-server', env: 'production' },
          batching: true,
          interval: 5,
        },
        level: 'info',
      },
      { target: 'pino/file', options: { destination: 1 }, level: 'debug' },
    ]);
  });

  it('defaults Loki label env to development when NODE_ENV is unset', async () => {
    const { pinoMock } = await loadLoggerWithEnv({
      NODE_ENV: undefined,
      CI: undefined,
      LOKI_URL: 'https://loki.example.com',
      LOG_LEVEL: undefined,
    });

    const cfg = pinoMock.mock.calls[0][0];
    expect(cfg.transport.targets[0]).toMatchObject({
      target: 'pino-loki',
      options: {
        labels: { service: 'mcp-server', env: 'development' },
      },
    });
  });
});
