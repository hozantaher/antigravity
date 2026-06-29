import 'dotenv/config';
import './sentry.js';
import { Worker, type Job } from 'bullmq';
import type { Redis as RedisClient } from 'ioredis';
import type { Server } from 'http';
import { createRedisConnection, QUEUE_NAME, type PdfJobData, type PdfJobResult } from './queue.js';
import {
  downloadFiles,
  uploadResults,
  uploadFile,
  fileExists,
  getSignedUrl,
} from './firebase.js';
import { generateOdpor, closeMcp } from './generate-odpor.js';
import { markdownToDocx } from '../scripts/lib/docx-writer.js';
import { docxToPdf } from './pdf.js';
import { sendResultEmail } from './email.js';
import { logger as baseLogger } from '../lib/logger.js';
import { startHealthServer } from '../lib/health.js';

const logger = baseLogger.child({ service: 'rozporuj-worker' });

// Paths written under results/<sessionId>/ by a successful run. Used to
// short-circuit an idempotent retry without re-running Claude.
const resultPaths = (sessionId: string) => ({
  pdf: `results/${sessionId}/odpor.pdf`,
  docx: `results/${sessionId}/odpor.docx`,
  conversation: `results/${sessionId}/conversation.md`,
});

/** H7 — idempotent short-circuit. If a prior run of this sessionId already
 *  uploaded results/<sessionId>/odpor.pdf, we re-issue signed URLs and resend
 *  the email without re-running Claude / LibreOffice. Matches the CLAUDE.md
 *  rule "All job handlers must be idempotent". */
export const maybeShortCircuit = async (
  sessionId: string,
): Promise<{
  outputPath: string;
  downloadUrl: string;
  docxUrl: string;
  conversationUrl: string;
} | null> => {
  const paths = resultPaths(sessionId);
  const pdfExists = await fileExists(paths.pdf).catch(() => false);
  if (!pdfExists) return null;

  const [downloadUrl, docxUrl, conversationUrl] = await Promise.all([
    getSignedUrl(paths.pdf),
    getSignedUrl(paths.docx).catch(() => ''),
    getSignedUrl(paths.conversation).catch(() => ''),
  ]);

  return { outputPath: paths.pdf, downloadUrl, docxUrl, conversationUrl };
};

export const processJob = async (job: Job<PdfJobData>): Promise<PdfJobResult> => {
  const { sessionId, email, firstName, lastName } = job.data;
  const log = logger.child({ jobId: job.id, sessionId });

  log.info('Job started');

  // H7 idempotency — short-circuit if results already uploaded.
  const cached = await maybeShortCircuit(sessionId);
  if (cached) {
    log.info({ outputPath: cached.outputPath }, 'Idempotent replay: result already exists, resending email only');
    await job.updateProgress(95);
    await sendResultEmail({ to: email, firstName, downloadUrl: cached.downloadUrl, docxUrl: cached.docxUrl });
    await job.updateProgress(100);
    return {
      downloadUrl: cached.downloadUrl,
      docxUrl: cached.docxUrl,
      conversationUrl: cached.conversationUrl,
      outputPath: cached.outputPath,
    };
  }

  // 1. Download uploaded files from Firebase
  await job.updateProgress(10);
  log.info('Downloading files from Firebase...');
  const files = await downloadFiles(sessionId);
  if (files.length === 0) throw new Error(`No files found for session ${sessionId}`);
  log.info({ fileCount: files.length }, 'Files downloaded');

  // 2. Generate legal analysis via Claude API + MCP tools
  await job.updateProgress(20);
  const { markdown, conversationLog } = await generateOdpor(files, { firstName, lastName, prompt: job.data.prompt, userNotes: job.data.userNotes }, (msg) => {
    log.info(msg);
  });
  log.info({ length: markdown.length }, 'Legal analysis generated');

  // 3. Markdown → DOCX
  await job.updateProgress(70);
  log.info('Converting markdown to DOCX...');
  const docxBuffer = await markdownToDocx(markdown, `Odpor proti pokutě — ${firstName} ${lastName}`, {
    style: 'legal',
    showTitle: false,
    headerText: 'Rozporuj.com',
  });

  // 4. DOCX → PDF
  await job.updateProgress(80);
  log.info('Converting DOCX to PDF...');
  const pdfBuffer = await docxToPdf(docxBuffer);
  log.info({ pdfSize: pdfBuffer.length }, 'PDF generated');

  // 5. Upload PDF + DOCX + conversation log to Firebase
  await job.updateProgress(90);
  log.info('Uploading results to Firebase...');
  const [{ outputPath, downloadUrl, docxUrl }, conversationUrl] = await Promise.all([
    uploadResults(sessionId, pdfBuffer, docxBuffer),
    uploadFile(`results/${sessionId}/conversation.md`, Buffer.from(conversationLog, 'utf-8'), 'text/markdown'),
  ]);

  // 6. Send email
  await job.updateProgress(95);
  log.info('Sending result email...');
  await sendResultEmail({ to: email, firstName, downloadUrl, docxUrl });

  await job.updateProgress(100);
  log.info({ outputPath }, 'Job completed successfully');

  return { downloadUrl, docxUrl, conversationUrl, outputPath };
};

// --- Worker setup ---

const CONCURRENCY = parseInt(process.env.WORKER_CONCURRENCY || '2', 10);

// Hard ceiling on the full shutdown sequence. Railway typically sends SIGKILL
// ~30s after SIGTERM; we bound the graceful path inside that window.
export const SHUTDOWN_TIMEOUT_MS = parseInt(process.env.WORKER_SHUTDOWN_TIMEOUT_MS || '30000', 10);

// M6: Without removeOnComplete / removeOnFail, BullMQ keeps every job record in
// Redis forever — a long-lived worker accumulates thousands of entries and
// eventually exceeds the Railway Redis memory ceiling. These defaults are
// exported so tests can assert the values and callers can override per-queue.
export const REMOVE_ON_COMPLETE: { count: number } = { count: 100 };
export const REMOVE_ON_FAIL: { count: number } = { count: 200 };

// M4: Per-job wallclock budget. Exposed for tests.
export const MAX_ITER_BUDGET_MS = parseInt(process.env.WORKER_MAX_ITER_BUDGET_MS || '300000', 10); // 5 min default

/**
 * H1/H5 — ordered, bounded graceful shutdown.
 *
 * Order: worker.close() (BullMQ drains in-flight jobs) → connection.quit()
 * (ioredis flushes + quits) → closeMcp() (release MCP singleton).
 *
 * Each step is awaited. The entire sequence is bounded by SHUTDOWN_TIMEOUT_MS
 * via Promise.race — if any step hangs (e.g. Redis partition) we still
 * terminate instead of being SIGKILLed by Railway.
 *
 * Exit code is 0 only if every step completed cleanly. On any error or
 * timeout we exit 1 so Railway / systemd can distinguish a drained shutdown
 * from a failed one.
 */
export const runShutdown = async (deps: {
  worker: Pick<Worker, 'close'>;
  connection: Pick<RedisClient, 'quit'>;
  closeMcpClient: () => void;
  healthServer?: Server;
  log: Pick<typeof logger, 'info' | 'error' | 'warn'>;
  timeoutMs: number;
}): Promise<number> => {
  const { worker, connection, closeMcpClient, healthServer, log, timeoutMs } = deps;

  const drain = (async () => {
    // Step 1: close health server if present
    if (healthServer) {
      log.info('Closing health server...');
      await new Promise<void>((resolve) => {
        healthServer.close(() => {
          resolve();
        });
      });
    }

    // Step 2: drain BullMQ worker. `worker.close()` awaits active jobs,
    // stops the queue consumer, and releases locks.
    log.info('Draining BullMQ worker (waits for in-flight jobs)...');
    await worker.close();

    // Step 3: quit ioredis. `quit()` sends QUIT and waits for server ack,
    // unlike `disconnect()` which rips the socket.
    log.info('Closing Redis connection...');
    try {
      await connection.quit();
    } catch (e) {
      // ioredis rejects quit() if the connection is already closed — not fatal.
      log.warn({ err: e instanceof Error ? e.message : String(e) }, 'Redis quit raised (likely already closed)');
    }

    // Step 4: release MCP singleton. No network handle to close; this just
    // clears the process-global reference so GC can reclaim it.
    log.info('Releasing MCP client...');
    closeMcpClient();
  })();

  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<'timeout'>((resolve) => {
    timer = setTimeout(() => resolve('timeout'), timeoutMs);
  });

  try {
    const result = await Promise.race([drain.then(() => 'ok' as const), timeout]);
    if (result === 'timeout') {
      log.error({ timeoutMs }, 'Shutdown timed out — forcing exit(1)');
      return 1;
    }
    log.info('Graceful shutdown complete');
    return 0;
  } catch (e) {
    log.error({ err: e instanceof Error ? e.message : String(e) }, 'Shutdown failed — exit(1)');
    return 1;
  } finally {
    if (timer) clearTimeout(timer);
  }
};

/** Wire process-level error handlers and signal handlers. Exported for tests. */
export const installProcessHandlers = (handlers: {
  onShutdown: (signal: string) => Promise<void>;
  onFatal: (origin: string, err: unknown) => void;
  processRef?: NodeJS.Process;
}): void => {
  const proc = handlers.processRef ?? process;
  // H6 — without these, a detached promise throw (e.g. from onProgress) kills
  // the worker silently. We log + trigger shutdown + mark exit code 1.
  proc.on('uncaughtException', (err) => handlers.onFatal('uncaughtException', err));
  proc.on('unhandledRejection', (err) => handlers.onFatal('unhandledRejection', err));
  proc.on('SIGTERM', () => {
    void handlers.onShutdown('SIGTERM');
  });
  proc.on('SIGINT', () => {
    void handlers.onShutdown('SIGINT');
  });
};

// --- Bootstrap (skipped under test via NODE_ENV === 'test' or VITEST) ---

const isTest = process.env.NODE_ENV === 'test' || process.env.VITEST === 'true' || !!process.env.VITEST;

if (!isTest) {
  const connection = createRedisConnection();

  // Spustit health server (default port 8090 dle konvence)
  const healthPort = parseInt(process.env.HEALTH_PORT || '8090', 10);
  const healthServer: Server = startHealthServer(healthPort, 'worker');

  const worker = new Worker<PdfJobData, PdfJobResult>(QUEUE_NAME, processJob, {
    connection,
    concurrency: CONCURRENCY,
    limiter: { max: 10, duration: 60_000 },
    // M6: cap stored job records so Redis doesn't grow unbounded.
    removeOnComplete: REMOVE_ON_COMPLETE,
    removeOnFail: REMOVE_ON_FAIL,
  });

  worker.on('completed', (job) => {
    logger.info({ jobId: job.id, sessionId: job.data.sessionId }, 'Job completed');
  });

  worker.on('failed', (job, err) => {
    logger.error({ jobId: job?.id, sessionId: job?.data.sessionId, err }, 'Job failed');
  });

  worker.on('error', (err) => {
    logger.error({ error: err.message }, 'Worker error');
  });

  logger.info({ concurrency: CONCURRENCY, queue: QUEUE_NAME, healthPort }, 'Worker started');

  let shuttingDown = false;

  const shutdown = async (signal: string) => {
    if (shuttingDown) {
      logger.warn({ signal }, 'Shutdown already in progress');
      return;
    }
    shuttingDown = true;
    logger.info({ signal }, 'Shutdown signal received');

    const code = await runShutdown({
      worker,
      connection,
      closeMcpClient: closeMcp,
      healthServer,
      log: logger,
      timeoutMs: SHUTDOWN_TIMEOUT_MS,
    });
    process.exit(code);
  };

  const onFatal = (origin: string, err: unknown) => {
    logger.error(
      { origin, err: err instanceof Error ? { message: err.message, stack: err.stack } : err },
      'Fatal error — initiating shutdown',
    );
    // Schedule shutdown; do not block the handler itself.
    void (async () => {
      const code = await runShutdown({
        worker,
        connection,
        closeMcpClient: closeMcp,
        healthServer,
        log: logger,
        timeoutMs: SHUTDOWN_TIMEOUT_MS,
      });
      // Any fatal always yields exit 1, even if shutdown itself was clean —
      // the originating error is the signal.
      process.exit(code === 0 ? 1 : code);
    })();
  };

  installProcessHandlers({ onShutdown: shutdown, onFatal });
}
