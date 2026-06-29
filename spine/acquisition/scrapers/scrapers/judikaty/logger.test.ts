import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { mkdirSyncMock, destinationMock, pinoMock } = vi.hoisted(() => {
  const logger = { info: vi.fn(), error: vi.fn(), warn: vi.fn() };
  const destination = vi.fn().mockReturnValue('dest-stream');
  const pino = vi.fn().mockReturnValue(logger) as any;
  pino.stdTimeFunctions = { isoTime: 'iso-time' };
  pino.destination = destination;
  return {
    mkdirSyncMock: vi.fn(),
    destinationMock: destination,
    pinoMock: pino,
  };
});

vi.mock('node:fs', () => ({
  mkdirSync: mkdirSyncMock,
}));

vi.mock('pino', () => ({
  default: pinoMock,
}));

import { setupLogging } from './logger';

describe('judikaty logger', () => {
  const originalConsole = {
    log: console.log,
    warn: console.warn,
    error: console.error,
  };

  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    console.log = originalConsole.log;
    console.warn = originalConsole.warn;
    console.error = originalConsole.error;
  });

  it('returns disabled logger when no log file path is provided', () => {
    setupLogging();
    expect(pinoMock).toHaveBeenCalledWith({ enabled: false });
  });

  it('creates log directory, wires pino destination and mirrors console output', () => {
    const logger = setupLogging('/tmp/logs/judikaty.log') as any;

    expect(mkdirSyncMock).toHaveBeenCalledWith('/tmp/logs', { recursive: true });
    expect(destinationMock).toHaveBeenCalledWith({ dest: '/tmp/logs/judikaty.log', append: true, sync: false });
    expect(pinoMock).toHaveBeenCalledWith(
      {
        level: 'debug',
        timestamp: 'iso-time',
      },
      'dest-stream',
    );

    console.log('hello', { phase: 'detail' });
    console.warn('warn-msg');
    console.error('err-msg');

    expect(logger.info).toHaveBeenCalledWith('hello {"phase":"detail"}');
    expect(logger.warn).toHaveBeenCalledWith('warn-msg');
    expect(logger.error).toHaveBeenCalledWith('err-msg');
    expect(logger.info).toHaveBeenCalledWith({ event: 'logging_started', logFile: '/tmp/logs/judikaty.log' });
  });
});
