import { runDiscoveryPhase } from './discovery.js';
import { fetchAllActs, fetchMetadata } from './api.js';

vi.mock('./api.js', () => ({
  fetchAllActs: vi.fn(),
  fetchMetadata: vi.fn(),
}));

describe('esbirka runDiscoveryPhase', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('inserts only valid AKTUALNI acts and skips invalid references', async () => {
    vi.mocked(fetchAllActs).mockResolvedValue({
      head: { vars: ['s', 'citace'] },
      results: {
        bindings: [
          {
            s: { type: 'uri', value: 'https://opendata.eselpoint.cz/esel-esb/eli/cz/sb/2012/89' },
            citace: { type: 'literal', value: '89/2012 Sb.' },
          },
          {
            s: { type: 'uri', value: 'https://opendata.eselpoint.cz/esel-esb/eli/cz/sb/2020/15' },
            citace: { type: 'literal', value: '15/2020 Sb.' },
          },
          {
            s: { type: 'uri', value: 'https://opendata.eselpoint.cz/esel-esb/eli/cz/sb/2012/not-valid' },
            citace: { type: 'literal', value: '12/2012 Sb.' },
          },
          {
            s: { type: 'uri', value: 'https://opendata.eselpoint.cz/esel-esb/eli/cz/sb/2018/42' },
            citace: { type: 'literal', value: 'invalid citation' },
          },
        ],
      },
    } as any);

    vi.mocked(fetchMetadata).mockImplementation(async (eli: string) => {
      if (eli.endsWith('/89')) {
        return {
          nazev: 'Občanský zákoník',
          typAktuKod: 'ZAKON',
          typZneni: 'AKTUALNI',
          datumUcinnostiOd: '2014-01-01',
          dokumentBaseId: 9001,
        } as any;
      }
      return {
        nazev: 'Neaktuální předpis',
        typAktuKod: 'ZAKON',
        typZneni: 'HISTORICKE',
        datumUcinnostiOd: '2020-01-01',
        dokumentBaseId: 9002,
      } as any;
    });

    const db = {
      insertUrlBatch: vi.fn(),
      getUrlCounts: vi.fn().mockReturnValue({ total: 1, pending: 1, scraped: 0, failed: 0, gone: 0 }),
    };

    const result = await runDiscoveryPhase(
      db as any,
      {
        phase: 'discovery',
        collection: 'sb',
        concurrency: 1,
        delay: 0,
        maxRetries: 0,
        limit: 0,
        dbPath: '',
      },
      () => false,
    );

    expect(fetchAllActs).toHaveBeenCalledWith('sb');
    expect(fetchMetadata).toHaveBeenCalledTimes(2);
    expect(db.insertUrlBatch).toHaveBeenCalledTimes(1);

    const inserted = db.insertUrlBatch.mock.calls[0][0] as Array<Record<string, unknown>>;
    expect(inserted).toHaveLength(1);
    expect(inserted[0]).toMatchObject({
      eli: '/eli/cz/sb/2012/89',
      cislo: '89',
      rok: 2012,
      sbirka: 'sb',
      typ_zneni: 'AKTUALNI',
    });

    expect(result).toEqual({ total: 1, pending: 1, scraped: 0, failed: 0, gone: 0 });
  });

  it('runs both collections when collection=all and applies per-collection limit', async () => {
    vi.mocked(fetchAllActs)
      .mockResolvedValueOnce({
        head: { vars: ['s', 'citace'] },
        results: {
          bindings: [
            {
              s: { type: 'uri', value: 'https://opendata.eselpoint.cz/esel-esb/eli/cz/sb/2012/89' },
              citace: { type: 'literal', value: '89/2012 Sb.' },
            },
            {
              s: { type: 'uri', value: 'https://opendata.eselpoint.cz/esel-esb/eli/cz/sb/2012/90' },
              citace: { type: 'literal', value: '90/2012 Sb.' },
            },
          ],
        },
      } as any)
      .mockResolvedValueOnce({
        head: { vars: ['s', 'citace'] },
        results: {
          bindings: [
            {
              s: { type: 'uri', value: 'https://opendata.eselpoint.cz/esel-esb/eli/cz/sm/2022/11' },
              citace: { type: 'literal', value: '11/2022 Sb.' },
            },
            {
              s: { type: 'uri', value: 'https://opendata.eselpoint.cz/esel-esb/eli/cz/sm/2022/12' },
              citace: { type: 'literal', value: '12/2022 Sb.' },
            },
          ],
        },
      } as any);

    vi.mocked(fetchMetadata).mockResolvedValue({
      nazev: 'Aktuální předpis',
      typAktuKod: 'ZAKON',
      typZneni: 'AKTUALNI',
      datumUcinnostiOd: '2022-01-01',
      dokumentBaseId: 100,
    } as any);

    const db = {
      insertUrlBatch: vi.fn(),
      getUrlCounts: vi.fn().mockReturnValue({ total: 2, pending: 2, scraped: 0, failed: 0, gone: 0 }),
    };

    await runDiscoveryPhase(
      db as any,
      {
        phase: 'discovery',
        collection: 'all',
        concurrency: 1,
        delay: 0,
        maxRetries: 0,
        limit: 1,
        dbPath: '',
      },
      () => false,
    );

    expect(fetchAllActs).toHaveBeenNthCalledWith(1, 'sb');
    expect(fetchAllActs).toHaveBeenNthCalledWith(2, 'sm');
    expect(fetchMetadata).toHaveBeenCalledTimes(2);
    expect(db.insertUrlBatch).toHaveBeenCalledTimes(2);
    expect((db.insertUrlBatch.mock.calls[0][0] as unknown[]).length).toBe(1);
    expect((db.insertUrlBatch.mock.calls[1][0] as unknown[]).length).toBe(1);
  });

  it('returns early when SPARQL result has no bindings', async () => {
    vi.mocked(fetchAllActs).mockResolvedValue({
      head: { vars: ['s', 'citace'] },
      results: { bindings: [] },
    } as any);

    const db = {
      insertUrlBatch: vi.fn(),
      getUrlCounts: vi.fn().mockReturnValue({ total: 0, pending: 0, scraped: 0, failed: 0, gone: 0 }),
    };

    await runDiscoveryPhase(
      db as any,
      {
        phase: 'discovery',
        collection: 'sb',
        concurrency: 1,
        delay: 0,
        maxRetries: 0,
        limit: 0,
        dbPath: '',
      },
      () => false,
    );

    expect(fetchMetadata).not.toHaveBeenCalled();
    expect(db.insertUrlBatch).not.toHaveBeenCalled();
  });

  it('does not insert batch when all fetched acts are non-current', async () => {
    vi.mocked(fetchAllActs).mockResolvedValue({
      head: { vars: ['s', 'citace'] },
      results: {
        bindings: [
          {
            s: { type: 'uri', value: 'https://opendata.eselpoint.cz/esel-esb/eli/cz/sb/2021/1' },
            citace: { type: 'literal', value: '1/2021 Sb.' },
          },
        ],
      },
    } as any);

    vi.mocked(fetchMetadata).mockResolvedValue({
      nazev: 'Neaktuální předpis',
      typAktuKod: 'ZAKON',
      typZneni: 'HISTORICKE',
      datumUcinnostiOd: '2021-01-01',
      dokumentBaseId: 200,
    } as any);

    const db = {
      insertUrlBatch: vi.fn(),
      getUrlCounts: vi.fn().mockReturnValue({ total: 0, pending: 0, scraped: 0, failed: 0, gone: 0 }),
    };

    await runDiscoveryPhase(
      db as any,
      {
        phase: 'discovery',
        collection: 'sb',
        concurrency: 1,
        delay: 0,
        maxRetries: 0,
        limit: 0,
        dbPath: '',
      },
      () => false,
    );

    expect(fetchMetadata).toHaveBeenCalledTimes(1);
    expect(db.insertUrlBatch).not.toHaveBeenCalled();
  });

  it('stops before processing collections when shutdown is already requested', async () => {
    const db = {
      insertUrlBatch: vi.fn(),
      getUrlCounts: vi.fn().mockReturnValue({ total: 7, pending: 3, scraped: 2, failed: 1, gone: 1 }),
    };

    const result = await runDiscoveryPhase(
      db as any,
      {
        phase: 'discovery',
        collection: 'all',
        concurrency: 1,
        delay: 0,
        maxRetries: 0,
        limit: 0,
        dbPath: '',
      },
      () => true,
    );

    expect(fetchAllActs).not.toHaveBeenCalled();
    expect(result).toEqual({ total: 7, pending: 3, scraped: 2, failed: 1, gone: 1 });
  });

  it('logs periodic progress, retries transient metadata failure, and continues after exhausted retries', async () => {
    vi.mocked(fetchAllActs).mockResolvedValue({
      head: { vars: ['s', 'citace'] },
      results: {
        bindings: [
          {
            s: { type: 'uri', value: 'https://opendata.eselpoint.cz/esel-esb/eli/cz/sb/2012/89' },
            citace: { type: 'literal', value: '89/2012 Sb.' },
          },
          {
            s: { type: 'uri', value: 'https://opendata.eselpoint.cz/esel-esb/eli/cz/sb/2012/90' },
            citace: { type: 'literal', value: '90/2012 Sb.' },
          },
        ],
      },
    } as any);

    vi.mocked(fetchMetadata)
      .mockRejectedValueOnce(new Error('temporary fail'))
      .mockResolvedValueOnce({
        nazev: 'Aktuální předpis',
        typAktuKod: 'ZAKON',
        typZneni: 'AKTUALNI',
        datumUcinnostiOd: '2024-01-01',
        dokumentBaseId: 1,
      } as any)
      .mockRejectedValueOnce(new Error('fatal fail'))
      .mockRejectedValueOnce(new Error('fatal fail'));

    const db = {
      insertUrlBatch: vi.fn(),
      getUrlCounts: vi.fn().mockReturnValue({ total: 1, pending: 1, scraped: 0, failed: 0, gone: 0 }),
    };

    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const randomSpy = vi.spyOn(Math, 'random').mockReturnValue(0);
    const setIntervalSpy = vi.spyOn(globalThis, 'setInterval').mockImplementation((fn: TimerHandler) => {
      (fn as () => void)();
      return 123 as unknown as ReturnType<typeof setInterval>;
    });
    const clearIntervalSpy = vi.spyOn(globalThis, 'clearInterval').mockImplementation(() => {});

    try {
      await runDiscoveryPhase(
        db as any,
        {
          phase: 'discovery',
          collection: 'sb',
          concurrency: 1,
          delay: 0,
          maxRetries: 1,
          limit: 0,
          dbPath: '',
        },
        () => false,
      );

      expect(setIntervalSpy).toHaveBeenCalledWith(expect.any(Function), 30_000);
      expect(logSpy.mock.calls.some((call) => String(call[0]).includes('Inserted:'))).toBe(true);
      expect(logSpy.mock.calls.some((call) => String(call[0]).includes('Retry 1 for /eli/cz/sb/2012/89'))).toBe(true);
      expect(errSpy.mock.calls.some((call) => String(call[0]).includes('Failed /eli/cz/sb/2012/90: fatal fail'))).toBe(true);
    } finally {
      logSpy.mockRestore();
      errSpy.mockRestore();
      randomSpy.mockRestore();
      setIntervalSpy.mockRestore();
      clearIntervalSpy.mockRestore();
    }

    expect(db.insertUrlBatch).toHaveBeenCalledTimes(1);
    expect((db.insertUrlBatch.mock.calls[0][0] as unknown[]).length).toBe(1);
  });
});
