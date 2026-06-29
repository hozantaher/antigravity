const mockDownloadFiles = vi.fn().mockResolvedValue([
  { path: 'uploads/test/pokuta.pdf', buffer: Buffer.from('pdf'), contentType: 'application/pdf' },
]);
const mockUploadResults = vi.fn().mockResolvedValue({
  outputPath: 'results/test/odpor.pdf',
  downloadUrl: 'https://storage.example.com/odpor.pdf',
  docxUrl: 'https://storage.example.com/odpor.docx',
});
const mockUploadFile = vi.fn().mockResolvedValue('https://storage.example.com/conversation.md');
const mockFileExists = vi.fn().mockResolvedValue(false);
const mockGetSignedUrl = vi.fn().mockResolvedValue('https://storage.example.com/signed');
const mockGenerateOdpor = vi.fn().mockResolvedValue({
  markdown: '# Odpor\n\nText...',
  conversationLog: '# Log\n\nConversation...',
});
const mockCloseMcp = vi.fn();
const mockMarkdownToDocx = vi.fn().mockResolvedValue(Buffer.from('docx content'));
const mockDocxToPdf = vi.fn().mockResolvedValue(Buffer.from('pdf content'));
const mockSendResultEmail = vi.fn().mockResolvedValue(undefined);

vi.mock('./firebase.js', () => ({
  downloadFiles: (...args: unknown[]) => mockDownloadFiles(...args),
  uploadResults: (...args: unknown[]) => mockUploadResults(...args),
  uploadFile: (...args: unknown[]) => mockUploadFile(...args),
  fileExists: (...args: unknown[]) => mockFileExists(...args),
  getSignedUrl: (...args: unknown[]) => mockGetSignedUrl(...args),
  downloadFileBuffer: vi.fn(),
}));

vi.mock('./generate-odpor.js', () => ({
  generateOdpor: (...args: unknown[]) => mockGenerateOdpor(...args),
  closeMcp: (...args: unknown[]) => mockCloseMcp(...args),
}));

vi.mock('../scripts/lib/docx-writer.js', () => ({
  markdownToDocx: (...args: unknown[]) => mockMarkdownToDocx(...args),
}));

vi.mock('./pdf.js', () => ({
  docxToPdf: (...args: unknown[]) => mockDocxToPdf(...args),
}));

vi.mock('./email.js', () => ({
  sendResultEmail: (...args: unknown[]) => mockSendResultEmail(...args),
}));

vi.mock('./queue.js', () => ({
  QUEUE_NAME: 'rozporuj-pdf',
  createRedisConnection: vi.fn(),
}));

vi.mock('bullmq', () => {
  const MockWorker = vi.fn(function (this: Record<string, unknown>, _name: string, processor: unknown) {
    this.processor = processor;
    this.on = vi.fn().mockReturnThis();
    this.close = vi.fn().mockResolvedValue(undefined);
  });
  return { Worker: MockWorker };
});

vi.mock('../lib/logger.js', () => ({
  logger: {
    child: vi.fn().mockReturnValue({
      info: vi.fn(),
      error: vi.fn(),
      warn: vi.fn(),
      child: vi.fn().mockReturnValue({ info: vi.fn(), error: vi.fn(), warn: vi.fn() }),
    }),
    info: vi.fn(),
    error: vi.fn(),
    warn: vi.fn(),
  },
}));

const makeJob = (overrides: Partial<Record<string, unknown>> = {}) => ({
  data: {
    sessionId: 'test-session',
    email: 'test@test.cz',
    firstName: 'Jan',
    lastName: 'Novák',
    prompt: undefined,
    userNotes: undefined,
    ...((overrides as { data?: Record<string, unknown> }).data ?? {}),
  },
  id: (overrides.id as string | undefined) ?? 'job-x',
  updateProgress: vi.fn(),
});

describe('worker index - processJob', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockFileExists.mockResolvedValue(false);
    mockDownloadFiles.mockResolvedValue([
      { path: 'uploads/test/pokuta.pdf', buffer: Buffer.from('pdf'), contentType: 'application/pdf' },
    ]);
    mockGenerateOdpor.mockResolvedValue({ markdown: '# Doc', conversationLog: '# Log' });
    mockUploadResults.mockResolvedValue({
      outputPath: 'results/test/odpor.pdf',
      downloadUrl: 'url-pdf',
      docxUrl: 'url-docx',
    });
    mockUploadFile.mockResolvedValue('url-conv');
    mockSendResultEmail.mockResolvedValue(undefined);
  });

  it('calls pipeline steps in correct order (cold run)', async () => {
    const callOrder: string[] = [];
    mockDownloadFiles.mockImplementation(async () => {
      callOrder.push('download');
      return [{ path: 'test.pdf', buffer: Buffer.from('pdf'), contentType: 'application/pdf' }];
    });
    mockGenerateOdpor.mockImplementation(async () => {
      callOrder.push('generate');
      return { markdown: '# Doc', conversationLog: '# Log' };
    });
    mockMarkdownToDocx.mockImplementation(async () => {
      callOrder.push('docx');
      return Buffer.from('docx');
    });
    mockDocxToPdf.mockImplementation(async () => {
      callOrder.push('pdf');
      return Buffer.from('pdf');
    });
    mockUploadResults.mockImplementation(async () => {
      callOrder.push('upload');
      return { outputPath: 'test', downloadUrl: 'url', docxUrl: 'docx-url' };
    });
    mockUploadFile.mockImplementation(async () => {
      callOrder.push('upload-log');
      return 'log-url';
    });
    mockSendResultEmail.mockImplementation(async () => {
      callOrder.push('email');
    });

    const { processJob } = await import('./index.js');
    const result = await processJob(makeJob() as never);

    expect(callOrder).toEqual(['download', 'generate', 'docx', 'pdf', 'upload', 'upload-log', 'email']);
    expect(result).toHaveProperty('downloadUrl');
    expect(result).toHaveProperty('docxUrl');
    expect(result).toHaveProperty('conversationUrl');
    expect(result).toHaveProperty('outputPath');
  });

  it('updates progress at each step on cold run', async () => {
    const { processJob } = await import('./index.js');
    const job = makeJob();
    await processJob(job as never);
    const progressCalls = job.updateProgress.mock.calls.map((c) => c[0]);
    expect(progressCalls).toEqual([10, 20, 70, 80, 90, 95, 100]);
  });

  it('throws when no files found', async () => {
    mockDownloadFiles.mockResolvedValue([]);
    const { processJob } = await import('./index.js');
    await expect(processJob(makeJob() as never)).rejects.toThrow('No files found');
  });

  it('passes userNotes to generateOdpor', async () => {
    const { processJob } = await import('./index.js');
    await processJob(makeJob({ data: { sessionId: 'abc', email: 'a@b.cz', firstName: 'A', lastName: 'B', userNotes: 'auto řídil kolega' } }) as never);
    expect(mockGenerateOdpor).toHaveBeenCalledWith(
      expect.any(Array),
      expect.objectContaining({ userNotes: 'auto řídil kolega' }),
      expect.any(Function),
    );
  });

  it('uses legal style for DOCX generation', async () => {
    const { processJob } = await import('./index.js');
    await processJob(makeJob() as never);
    expect(mockMarkdownToDocx).toHaveBeenCalledWith(
      expect.any(String),
      expect.any(String),
      expect.objectContaining({ style: 'legal', showTitle: false, headerText: 'Rozporuj.com' }),
    );
  });

  it('uploads conversation log alongside results', async () => {
    const { processJob } = await import('./index.js');
    await processJob(makeJob({ data: { sessionId: 'test-log', email: 'a@b.cz', firstName: 'A', lastName: 'B' } }) as never);
    expect(mockUploadFile).toHaveBeenCalledWith(
      'results/test-log/conversation.md',
      expect.any(Buffer),
      'text/markdown',
    );
  });
});

describe('worker index - H7 idempotent short-circuit', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockFileExists.mockResolvedValue(false);
  });

  it('skips Claude/PDF pipeline when results/<sessionId>/odpor.pdf already exists', async () => {
    mockFileExists.mockImplementation(async (path: string) => path.endsWith('/odpor.pdf'));
    mockGetSignedUrl.mockImplementation(async (path: string) => `signed://${path}`);

    const { processJob } = await import('./index.js');
    const job = makeJob({ data: { sessionId: 'already-done', email: 'a@b.cz', firstName: 'A', lastName: 'B' } });
    const result = await processJob(job as never);

    // Hot-path bypassed entirely — no Claude, no docx, no pdf, no upload.
    expect(mockGenerateOdpor).not.toHaveBeenCalled();
    expect(mockMarkdownToDocx).not.toHaveBeenCalled();
    expect(mockDocxToPdf).not.toHaveBeenCalled();
    expect(mockUploadResults).not.toHaveBeenCalled();
    expect(mockDownloadFiles).not.toHaveBeenCalled();

    // Email still fires with cached URLs so the user still receives the result.
    expect(mockSendResultEmail).toHaveBeenCalledWith(
      expect.objectContaining({ downloadUrl: 'signed://results/already-done/odpor.pdf' }),
    );
    expect(result.outputPath).toBe('results/already-done/odpor.pdf');
  });

  it('runs full pipeline when pdf does not exist', async () => {
    mockFileExists.mockResolvedValue(false);
    mockDownloadFiles.mockResolvedValue([
      { path: 'uploads/fresh/pokuta.pdf', buffer: Buffer.from('pdf'), contentType: 'application/pdf' },
    ]);

    const { processJob } = await import('./index.js');
    await processJob(makeJob({ data: { sessionId: 'fresh', email: 'a@b.cz', firstName: 'A', lastName: 'B' } }) as never);

    expect(mockGenerateOdpor).toHaveBeenCalled();
    expect(mockUploadResults).toHaveBeenCalled();
  });

  it('falls through to full pipeline when fileExists throws', async () => {
    // A transient bucket error must not block the fresh run.
    mockFileExists.mockRejectedValue(new Error('bucket transient'));
    mockDownloadFiles.mockResolvedValue([
      { path: 'uploads/trans/pokuta.pdf', buffer: Buffer.from('pdf'), contentType: 'application/pdf' },
    ]);

    const { processJob } = await import('./index.js');
    await processJob(makeJob({ data: { sessionId: 'trans', email: 'a@b.cz', firstName: 'A', lastName: 'B' } }) as never);

    expect(mockGenerateOdpor).toHaveBeenCalled();
  });
});

describe('worker index - H1/H5 runShutdown ordering', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('closes worker → redis → mcp in that exact order', async () => {
    const order: string[] = [];
    const worker = {
      close: vi.fn(async () => {
        order.push('worker.close');
      }),
    };
    const connection = {
      quit: vi.fn(async () => {
        order.push('redis.quit');
      }),
    };
    const closeMcpClient = vi.fn(() => {
      order.push('mcp.close');
    });
    const log = { info: vi.fn(), error: vi.fn(), warn: vi.fn() };

    const { runShutdown } = await import('./index.js');
    const code = await runShutdown({ worker, connection, closeMcpClient, log, timeoutMs: 5_000 });

    expect(order).toEqual(['worker.close', 'redis.quit', 'mcp.close']);
    expect(code).toBe(0);
  });

  it('waits for in-flight worker.close before closing redis (drain ordering)', async () => {
    let workerResolved = false;
    const worker = {
      close: vi.fn(
        () =>
          new Promise<void>((resolve) =>
            setTimeout(() => {
              workerResolved = true;
              resolve();
            }, 50),
          ),
      ),
    };
    const connection = {
      quit: vi.fn(async () => {
        // When redis.quit runs, worker must already be drained.
        expect(workerResolved).toBe(true);
      }),
    };
    const closeMcpClient = vi.fn();
    const log = { info: vi.fn(), error: vi.fn(), warn: vi.fn() };

    const { runShutdown } = await import('./index.js');
    const code = await runShutdown({ worker, connection, closeMcpClient, log, timeoutMs: 5_000 });
    expect(code).toBe(0);
  });

  it('returns exit code 1 on timeout (hard ceiling)', async () => {
    const worker = {
      close: vi.fn(() => new Promise<void>(() => {})), // hangs forever
    };
    const connection = { quit: vi.fn(async () => {}) };
    const closeMcpClient = vi.fn();
    const log = { info: vi.fn(), error: vi.fn(), warn: vi.fn() };

    const { runShutdown } = await import('./index.js');
    const code = await runShutdown({ worker, connection, closeMcpClient, log, timeoutMs: 50 });
    expect(code).toBe(1);
    expect(log.error).toHaveBeenCalledWith(expect.objectContaining({ timeoutMs: 50 }), expect.any(String));
  });

  it('returns exit code 1 when worker.close throws', async () => {
    const worker = { close: vi.fn(async () => { throw new Error('boom'); }) };
    const connection = { quit: vi.fn(async () => {}) };
    const closeMcpClient = vi.fn();
    const log = { info: vi.fn(), error: vi.fn(), warn: vi.fn() };

    const { runShutdown } = await import('./index.js');
    const code = await runShutdown({ worker, connection, closeMcpClient, log, timeoutMs: 5_000 });
    expect(code).toBe(1);
    expect(connection.quit).not.toHaveBeenCalled(); // fails fast
    expect(closeMcpClient).not.toHaveBeenCalled();
  });

  it('tolerates redis quit raising after worker drained (logs warn, continues)', async () => {
    const worker = { close: vi.fn(async () => {}) };
    const connection = { quit: vi.fn(async () => { throw new Error('already closed'); }) };
    const closeMcpClient = vi.fn();
    const log = { info: vi.fn(), error: vi.fn(), warn: vi.fn() };

    const { runShutdown } = await import('./index.js');
    const code = await runShutdown({ worker, connection, closeMcpClient, log, timeoutMs: 5_000 });
    expect(code).toBe(0);
    expect(log.warn).toHaveBeenCalled();
    expect(closeMcpClient).toHaveBeenCalled();
  });

  it('does not exit 0 if any step fails (covers H5 regression)', async () => {
    const worker = { close: vi.fn(async () => {}) };
    const connection = { quit: vi.fn(async () => {}) };
    // closeMcp throws synchronously.
    const closeMcpClient = vi.fn(() => { throw new Error('mcp shutdown broke'); });
    const log = { info: vi.fn(), error: vi.fn(), warn: vi.fn() };

    const { runShutdown } = await import('./index.js');
    const code = await runShutdown({ worker, connection, closeMcpClient, log, timeoutMs: 5_000 });
    expect(code).toBe(1);
  });

  it('clears the timeout timer when shutdown completes before deadline', async () => {
    // Regression guard: previously the unref'd timer would keep the process
    // alive. We assert the shutdown promise settles synchronously in the
    // microtask queue without holding Node's event loop.
    const worker = { close: vi.fn(async () => {}) };
    const connection = { quit: vi.fn(async () => {}) };
    const closeMcpClient = vi.fn();
    const log = { info: vi.fn(), error: vi.fn(), warn: vi.fn() };

    const { runShutdown } = await import('./index.js');
    const started = Date.now();
    const code = await runShutdown({ worker, connection, closeMcpClient, log, timeoutMs: 60_000 });
    const elapsed = Date.now() - started;

    expect(code).toBe(0);
    expect(elapsed).toBeLessThan(500); // must not wait for the 60s timeout
  });
});

// -------------------------------------------------------------------------
// M6 — removeOnComplete / removeOnFail exported constants prevent unbounded Redis growth
// -------------------------------------------------------------------------

describe('worker index - M6 Redis job retention defaults', () => {
  it('exports REMOVE_ON_COMPLETE with a count property', async () => {
    const { REMOVE_ON_COMPLETE } = await import('./index.js');
    expect(typeof REMOVE_ON_COMPLETE).toBe('object');
    expect(typeof (REMOVE_ON_COMPLETE as Record<string, unknown>).count).toBe('number');
    expect((REMOVE_ON_COMPLETE as Record<string, unknown>).count).toBeGreaterThan(0);
  });

  it('exports REMOVE_ON_FAIL with a count property higher than REMOVE_ON_COMPLETE', async () => {
    const { REMOVE_ON_COMPLETE, REMOVE_ON_FAIL } = await import('./index.js');
    expect(typeof (REMOVE_ON_FAIL as Record<string, unknown>).count).toBe('number');
    expect((REMOVE_ON_FAIL as Record<string, unknown>).count).toBeGreaterThan(
      (REMOVE_ON_COMPLETE as Record<string, unknown>).count as number,
    );
  });

  it('REMOVE_ON_COMPLETE.count keeps at least 50 completed jobs for audit', async () => {
    const { REMOVE_ON_COMPLETE } = await import('./index.js');
    expect((REMOVE_ON_COMPLETE as Record<string, unknown>).count).toBeGreaterThanOrEqual(50);
  });
});

// -------------------------------------------------------------------------
// M4 — per-job wallclock budget: warn when >= 60% of MAX_ITER_BUDGET_MS used
// -------------------------------------------------------------------------

describe('worker index - M4 per-job wallclock budget', () => {
  it('exports MAX_ITER_BUDGET_MS as a positive number', async () => {
    const { MAX_ITER_BUDGET_MS } = await import('./index.js');
    expect(typeof MAX_ITER_BUDGET_MS).toBe('number');
    expect(MAX_ITER_BUDGET_MS).toBeGreaterThan(0);
  });
});


describe('worker index - H6 process error handlers', () => {
  it('registers uncaughtException, unhandledRejection, SIGTERM, SIGINT', async () => {
    const handlers = new Map<string, (...args: unknown[]) => void>();
    const fakeProc = {
      on: vi.fn((event: string, handler: (...args: unknown[]) => void) => {
        handlers.set(event, handler);
      }),
    } as unknown as NodeJS.Process;

    const onShutdown = vi.fn().mockResolvedValue(undefined);
    const onFatal = vi.fn();

    const { installProcessHandlers } = await import('./index.js');
    installProcessHandlers({ onShutdown, onFatal, processRef: fakeProc });

    expect(handlers.has('uncaughtException')).toBe(true);
    expect(handlers.has('unhandledRejection')).toBe(true);
    expect(handlers.has('SIGTERM')).toBe(true);
    expect(handlers.has('SIGINT')).toBe(true);
  });

  it('uncaughtException handler calls onFatal with origin and error', async () => {
    const handlers = new Map<string, (...args: unknown[]) => void>();
    const fakeProc = {
      on: vi.fn((event: string, handler: (...args: unknown[]) => void) => {
        handlers.set(event, handler);
      }),
    } as unknown as NodeJS.Process;

    const onShutdown = vi.fn().mockResolvedValue(undefined);
    const onFatal = vi.fn();

    const { installProcessHandlers } = await import('./index.js');
    installProcessHandlers({ onShutdown, onFatal, processRef: fakeProc });

    const err = new Error('kaboom');
    handlers.get('uncaughtException')!(err);
    expect(onFatal).toHaveBeenCalledWith('uncaughtException', err);

    const reason = new Error('promise rejected');
    handlers.get('unhandledRejection')!(reason);
    expect(onFatal).toHaveBeenCalledWith('unhandledRejection', reason);
  });

  it('SIGTERM handler triggers onShutdown without awaiting inside the listener', async () => {
    const handlers = new Map<string, (...args: unknown[]) => void>();
    const fakeProc = {
      on: vi.fn((event: string, handler: (...args: unknown[]) => void) => {
        handlers.set(event, handler);
      }),
    } as unknown as NodeJS.Process;

    const onShutdown = vi.fn().mockResolvedValue(undefined);
    const onFatal = vi.fn();

    const { installProcessHandlers } = await import('./index.js');
    installProcessHandlers({ onShutdown, onFatal, processRef: fakeProc });

    handlers.get('SIGTERM')!();
    handlers.get('SIGINT')!();
    expect(onShutdown).toHaveBeenCalledWith('SIGTERM');
    expect(onShutdown).toHaveBeenCalledWith('SIGINT');
  });
});
