import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import pino from 'pino';

/**
 * Sets up file logging for the judikaty scraper.
 *
 * When a log file path is provided:
 *   - Console output stays human-readable (unchanged)
 *   - JSON structured logs are appended to the file with timestamps and levels
 *   - The logger instance is also returned for direct structured logging
 *
 * When no log file is provided, returns a no-op logger (console output only).
 */
export const setupLogging = (logFile?: string) => {
  if (!logFile) {
    // Return a disabled pino logger (no file logging)
    return pino({ enabled: false });
  }

  // Ensure log directory exists
  mkdirSync(dirname(logFile), { recursive: true });

  const logger = pino(
    {
      level: 'debug',
      timestamp: pino.stdTimeFunctions.isoTime,
    },
    pino.destination({ dest: logFile, append: true, sync: false }),
  );

  // Intercept console methods to also write to the log file
  const origLog = console.log;
  const origError = console.error;
  const origWarn = console.warn;

  console.log = (...args: unknown[]) => {
    origLog(...args);
    logger.info(formatArgs(args));
  };

  console.error = (...args: unknown[]) => {
    origError(...args);
    logger.error(formatArgs(args));
  };

  console.warn = (...args: unknown[]) => {
    origWarn(...args);
    logger.warn(formatArgs(args));
  };

  logger.info({ event: 'logging_started', logFile });

  return logger;
};

const formatArgs = (args: unknown[]): string => {
  return args.map((a) => (typeof a === 'string' ? a : JSON.stringify(a))).join(' ');
};
