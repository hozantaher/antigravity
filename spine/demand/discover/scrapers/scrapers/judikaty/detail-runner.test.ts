import { runHtmlDetailPhase } from './detail-runner.js';
import type { DecisionData, UrlRow } from './types.js';

vi.mock('../../lib/fetch.js', async (importOriginal) => {
  const actual = (await importOriginal()) as Record<string, unknown>;
  return { ...actual, fetchPage: vi.fn() };
});

const makeUrlRow = (overrides: Partial<UrlRow> = {}): UrlRow => ({
  id: 1,
  url: 'https://example.test/detail/1',
  source: 'nsoud',
  external_id: 'external-from-url',
  ecli: 'ECLI:CZ:URL:2024:1',
  jednaci_cislo: '1 As 1/2024',
  soud: 'Soud z URL',
  datum_vydani: '01.01.2024',
  status: 'pending',
  attempts: 0,
  last_attempt_at: null,
  error_message: null,
  ...overrides,
});

const makeDb = () => ({
  getUrlCounts: vi.fn().mockReturnValue({ total: 1, pending: 1, failed: 0, scraped: 0, gone: 0 }),
  getPendingUrls: vi.fn().mockReturnValueOnce([makeUrlRow()]).mockReturnValueOnce([]),
  startRun: vi.fn().mockReturnValue(99),
  finishRun: vi.fn(),
  saveDecision: vi.fn(),
  markFailed: vi.fn(),
  markGone: vi.fn(),
});

describe('judikaty detail-runner', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('merges URL metadata and runs postProcess with custom fetchFn', async () => {
    const db = makeDb();
    const fetchFn = vi.fn().mockResolvedValue({ status: 200, html: '<html>detail</html>' });
    const postProcess = vi.fn(async (decision: DecisionData, fetchForPost: typeof fetchFn) => {
      expect(fetchForPost).toBe(fetchFn);
      decision.pravni_veta = 'enriched';
    });

    await runHtmlDetailPhase(
      db as any,
      { source: 'nsoud', phase: 'detail', concurrency: 1, delay: 0, maxRetries: 0, limit: 0, dbPath: '' },
      () => false,
      {
        source: 'nsoud',
        label: 'NSoud',
        referers: ['https://example.test/'],
        fetchFn,
        parsePage: () => ({ url: 'https://example.test/detail/1', source: 'nsoud' }),
        postProcess,
      },
    );

    expect(fetchFn).toHaveBeenCalledWith('https://example.test/detail/1', ['https://example.test/']);
    expect(postProcess).toHaveBeenCalledTimes(1);
    expect(db.saveDecision).toHaveBeenCalledTimes(1);
    const saved = db.saveDecision.mock.calls[0][0];
    expect(saved.external_id).toBe('external-from-url');
    expect(saved.ecli).toBe('ECLI:CZ:URL:2024:1');
    expect(saved.jednaci_cislo).toBe('1 As 1/2024');
    expect(saved.soud).toBe('Soud z URL');
    expect(saved.datum_vydani).toBe('01.01.2024');
    expect(saved.pravni_veta).toBe('enriched');
    expect(db.finishRun).toHaveBeenCalledWith(99, 1, 1, 0, 'completed');
  });

  it('does not override metadata already provided by parser', async () => {
    const db = makeDb();
    const fetchFn = vi.fn().mockResolvedValue({ status: 200, html: '<html>detail</html>' });

    await runHtmlDetailPhase(
      db as any,
      { source: 'nsoud', phase: 'detail', concurrency: 1, delay: 0, maxRetries: 0, limit: 0, dbPath: '' },
      () => false,
      {
        source: 'nsoud',
        label: 'NSoud',
        referers: ['https://example.test/'],
        fetchFn,
        parsePage: () => ({
          url: 'https://example.test/detail/1',
          source: 'nsoud',
          external_id: 'parser-external',
          ecli: 'ECLI:CZ:PARSER',
          jednaci_cislo: 'parser-jc',
          soud: 'Parser court',
          datum_vydani: '31.12.2025',
        }),
      },
    );

    const saved = db.saveDecision.mock.calls[0][0];
    expect(saved.external_id).toBe('parser-external');
    expect(saved.ecli).toBe('ECLI:CZ:PARSER');
    expect(saved.jednaci_cislo).toBe('parser-jc');
    expect(saved.soud).toBe('Parser court');
    expect(saved.datum_vydani).toBe('31.12.2025');
  });

  it('marks gone on 410 responses', async () => {
    const db = makeDb();
    const fetchFn = vi.fn().mockResolvedValue({ status: 410, html: '' });

    await runHtmlDetailPhase(
      db as any,
      { source: 'nsoud', phase: 'detail', concurrency: 1, delay: 0, maxRetries: 0, limit: 0, dbPath: '' },
      () => false,
      {
        source: 'nsoud',
        label: 'NSoud',
        referers: [],
        fetchFn,
        parsePage: () => ({ url: 'x', source: 'nsoud' }),
      },
    );

    expect(db.markGone).toHaveBeenCalledWith('https://example.test/detail/1');
    expect(db.saveDecision).not.toHaveBeenCalled();
    expect(db.finishRun).toHaveBeenCalledWith(99, 1, 0, 1, 'completed');
  });

  it('retries 429 and marks failed when retries are exhausted', async () => {
    const db = makeDb();
    const fetchFn = vi.fn().mockResolvedValue({ status: 429, html: '', retryAfter: 0 });
    const randomSpy = vi.spyOn(Math, 'random').mockReturnValue(0);

    try {
      await runHtmlDetailPhase(
        db as any,
        { source: 'nsoud', phase: 'detail', concurrency: 1, delay: 0, maxRetries: 1, limit: 0, dbPath: '' },
        () => false,
        {
          source: 'nsoud',
          label: 'NSoud',
          referers: [],
          fetchFn,
          parsePage: () => ({ url: 'x', source: 'nsoud' }),
        },
      );
    } finally {
      randomSpy.mockRestore();
    }

    expect(fetchFn).toHaveBeenCalledTimes(2);
    expect(db.markFailed).toHaveBeenCalledWith('https://example.test/detail/1', 'Rate limited (429)');
    expect(db.finishRun).toHaveBeenCalledWith(99, 1, 0, 1, 'completed');
  });

  it('marks failures on server and unexpected status codes', async () => {
    const db = {
      ...makeDb(),
      getUrlCounts: vi.fn().mockReturnValue({ total: 2, pending: 2, failed: 0, scraped: 0, gone: 0 }),
      getPendingUrls: vi
        .fn()
        .mockReturnValueOnce([makeUrlRow({ url: 'https://example.test/500' }), makeUrlRow({ id: 2, url: 'https://example.test/302' })])
        .mockReturnValueOnce([]),
    };
    const fetchFn = vi
      .fn()
      .mockResolvedValueOnce({ status: 500, html: '' })
      .mockResolvedValueOnce({ status: 302, html: '' });

    await runHtmlDetailPhase(
      db as any,
      { source: 'nsoud', phase: 'detail', concurrency: 1, delay: 0, maxRetries: 0, limit: 0, dbPath: '' },
      () => false,
      {
        source: 'nsoud',
        label: 'NSoud',
        referers: [],
        fetchFn,
        parsePage: () => ({ url: 'x', source: 'nsoud' }),
      },
    );

    expect(db.markFailed).toHaveBeenNthCalledWith(1, 'https://example.test/500', 'Server error (500)');
    expect(db.markFailed).toHaveBeenNthCalledWith(2, 'https://example.test/302', 'Unexpected status 302');
    expect(db.finishRun).toHaveBeenCalledWith(99, 2, 0, 2, 'completed');
  });

  it('returns early when there are no URLs to process', async () => {
    const db = {
      ...makeDb(),
      getUrlCounts: vi.fn().mockReturnValue({ total: 0, pending: 0, failed: 0, scraped: 0, gone: 0 }),
    };

    await runHtmlDetailPhase(
      db as any,
      { source: 'nsoud', phase: 'detail', concurrency: 1, delay: 0, maxRetries: 0, limit: 0, dbPath: '' },
      () => false,
      {
        source: 'nsoud',
        label: 'NSoud',
        referers: [],
        parsePage: () => ({ url: 'x', source: 'nsoud' }),
      },
    );

    expect(db.startRun).not.toHaveBeenCalled();
    expect(db.finishRun).not.toHaveBeenCalled();
  });

  it('handles interruption and empty batches', async () => {
    const dbInterrupted = makeDb();
    let shutdownCalls = 0;

    await runHtmlDetailPhase(
      dbInterrupted as any,
      { source: 'nsoud', phase: 'detail', concurrency: 1, delay: 0, maxRetries: 0, limit: 1, dbPath: '' },
      () => {
        shutdownCalls++;
        return shutdownCalls > 1;
      },
      {
        source: 'nsoud',
        label: 'NSoud',
        referers: [],
        fetchFn: vi.fn().mockResolvedValue({ status: 200, html: '<html></html>' }),
        parsePage: () => ({ url: 'x', source: 'nsoud' }),
      },
    );

    expect(dbInterrupted.finishRun).toHaveBeenCalledWith(99, 1, 0, 0, 'interrupted');

    const dbEmptyBatch = {
      ...makeDb(),
      getPendingUrls: vi.fn().mockReturnValueOnce([]),
    };
    await runHtmlDetailPhase(
      dbEmptyBatch as any,
      { source: 'nsoud', phase: 'detail', concurrency: 1, delay: 0, maxRetries: 0, limit: 1, dbPath: '' },
      () => false,
      {
        source: 'nsoud',
        label: 'NSoud',
        referers: [],
        fetchFn: vi.fn().mockResolvedValue({ status: 200, html: '<html></html>' }),
        parsePage: () => ({ url: 'x', source: 'nsoud' }),
      },
    );

    expect(dbEmptyBatch.finishRun).toHaveBeenCalledWith(99, 1, 0, 0, 'completed');
  });

  it('logs periodic progress report with delay', async () => {
    const db = makeDb();
    const fetchFn = vi.fn().mockResolvedValue({ status: 200, html: '<html>detail</html>' });
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const setIntervalSpy = vi.spyOn(globalThis, 'setInterval').mockImplementation((fn: TimerHandler) => {
      (fn as () => void)();
      return 789 as unknown as ReturnType<typeof setInterval>;
    });
    const clearIntervalSpy = vi.spyOn(globalThis, 'clearInterval').mockImplementation(() => {});

    try {
      await runHtmlDetailPhase(
        db as any,
        { source: 'nsoud', phase: 'detail', concurrency: 1, delay: 0, maxRetries: 0, limit: 0, dbPath: '' },
        () => false,
        {
          source: 'nsoud',
          label: 'NSoud',
          referers: [],
          fetchFn,
          parsePage: () => ({ url: 'https://example.test/detail/1', source: 'nsoud' }),
        },
      );

      expect(setIntervalSpy).toHaveBeenCalledWith(expect.any(Function), 30_000);
      expect(logSpy.mock.calls.some((call) => String(call[0]).includes('Delay: 0ms'))).toBe(true);
    } finally {
      logSpy.mockRestore();
      setIntervalSpy.mockRestore();
      clearIntervalSpy.mockRestore();
    }
  });

  it('stops before requesting another batch when limit is reached', async () => {
    const db = {
      ...makeDb(),
      getPendingUrls: vi.fn().mockReturnValueOnce([makeUrlRow()]),
    };
    const fetchFn = vi.fn().mockResolvedValue({ status: 200, html: '<html>detail</html>' });

    await runHtmlDetailPhase(
      db as any,
      { source: 'nsoud', phase: 'detail', concurrency: 1, delay: 0, maxRetries: 0, limit: 1, dbPath: '' },
      () => false,
      {
        source: 'nsoud',
        label: 'NSoud',
        referers: [],
        fetchFn,
        parsePage: () => ({ url: 'https://example.test/detail/1', source: 'nsoud' }),
      },
    );

    expect(db.getPendingUrls).toHaveBeenCalledTimes(1);
    expect(db.getPendingUrls).toHaveBeenCalledWith('nsoud', 0, 1);
    expect(db.finishRun).toHaveBeenCalledWith(99, 1, 1, 0, 'completed');
  });
});
