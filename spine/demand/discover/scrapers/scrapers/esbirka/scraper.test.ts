import { runDetailPhase } from './scraper.js';
import { fetchFragments, fetchMetadata, fetchRelationships } from './api.js';

vi.mock('./api.js', () => ({
  fetchMetadata: vi.fn(),
  fetchFragments: vi.fn(),
  fetchRelationships: vi.fn(),
}));

const makeConfig = () => ({
  phase: 'detail' as const,
  collection: 'sb' as const,
  concurrency: 1,
  delay: 0,
  maxRetries: 0,
  limit: 0,
  dbPath: '',
});

describe('esbirka runDetailPhase', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('scrapes metadata, fragments and relationships and saves act', async () => {
    vi.mocked(fetchMetadata).mockResolvedValue({
      kodDokumentuSbirky: '89/2012 Sb.',
      nazev: 'Občanský zákoník',
      typAktuKod: 'ZAKON',
      typZneni: 'AKTUALNI',
      datumUcinnostiOd: '2014-01-01',
    } as any);

    vi.mocked(fetchFragments)
      .mockResolvedValueOnce({
        seznam: [
          { id: 1, xhtml: '<p>A</p>' },
          { id: 2, xhtml: '<p>B</p>' },
        ],
      } as any)
      .mockResolvedValueOnce({ seznam: [] } as any);

    vi.mocked(fetchRelationships).mockResolvedValue({
      souvislosti: [
        {
          typ: 'novelizuje',
          pocetDokumentuSbirky: 1,
          dokumentySbirky: [
            {
              kodDokumentuSbirky: '1/2000 Sb.',
              nazev: 'Starší předpis',
              stavDokumentuSbirky: 'účinný',
              staleUrl: 'https://example.test/1-2000',
            },
          ],
        },
      ],
    } as any);

    const db = {
      getUrlCounts: vi.fn().mockReturnValue({ total: 1, pending: 1, failed: 0, scraped: 0, gone: 0 }),
      getPendingUrls: vi
        .fn()
        .mockReturnValueOnce([
          {
            id: 1,
            eli: '/eli/cz/sb/2012/89',
            status: 'pending',
            attempts: 0,
          },
        ])
        .mockReturnValueOnce([]),
      startRun: vi.fn().mockReturnValue(101),
      saveAct: vi.fn(),
      markFailed: vi.fn(),
      finishRun: vi.fn(),
    };

    await runDetailPhase(db as any, makeConfig(), () => false);

    expect(db.saveAct).toHaveBeenCalledTimes(1);
    const saved = db.saveAct.mock.calls[0][0] as Record<string, unknown>;

    expect(saved.eli).toBe('/eli/cz/sb/2012/89');
    expect(saved.citace).toBe('89/2012 Sb.');
    expect(saved.fragment_count).toBe(2);
    expect(saved.full_text).toBe('<p>A</p>\n<p>B</p>');
    expect(JSON.parse(saved.relationships_json as string)).toEqual([
      {
        typ: 'novelizuje',
        pocet: 1,
        dokumenty: [
          {
            citace: '1/2000 Sb.',
            nazev: 'Starší předpis',
            stav: 'účinný',
            url: 'https://example.test/1-2000',
          },
        ],
      },
    ]);

    expect(db.markFailed).not.toHaveBeenCalled();
    expect(db.finishRun).toHaveBeenCalledWith(101, 1, 1, 0, 'completed');
  });

  it('marks URL as failed when scrape throws', async () => {
    vi.mocked(fetchMetadata).mockRejectedValue(new Error('metadata fetch failed'));

    const db = {
      getUrlCounts: vi.fn().mockReturnValue({ total: 1, pending: 1, failed: 0, scraped: 0, gone: 0 }),
      getPendingUrls: vi
        .fn()
        .mockReturnValueOnce([
          {
            id: 1,
            eli: '/eli/cz/sb/2012/90',
            status: 'pending',
            attempts: 0,
          },
        ])
        .mockReturnValueOnce([]),
      startRun: vi.fn().mockReturnValue(202),
      saveAct: vi.fn(),
      markFailed: vi.fn(),
      finishRun: vi.fn(),
    };

    await runDetailPhase(
      db as any,
      {
        ...makeConfig(),
        maxRetries: 0,
      },
      () => false,
    );

    expect(db.saveAct).not.toHaveBeenCalled();
    expect(db.markFailed).toHaveBeenCalledTimes(1);
    expect(db.markFailed.mock.calls[0][0]).toBe('/eli/cz/sb/2012/90');
    expect(String(db.markFailed.mock.calls[0][1])).toContain('metadata fetch failed');
    expect(db.finishRun).toHaveBeenCalledWith(202, 1, 0, 1, 'completed');
  });

  it('uses collection=all, honors limit, and stores undefined full_text when fragments are empty', async () => {
    vi.mocked(fetchMetadata).mockResolvedValue({
      kodDokumentuSbirky: '1/2020 Sb.',
      nazev: 'Test',
      typAktuKod: 'ZAKON',
      typZneni: 'AKTUALNI',
      datumUcinnostiOd: '2020-01-01',
    } as any);

    vi.mocked(fetchFragments)
      .mockResolvedValueOnce({
        seznam: [{ id: 1 }, { id: 2, xhtml: '' }],
      } as any)
      .mockResolvedValueOnce({ seznam: [] } as any);

    vi.mocked(fetchRelationships).mockResolvedValue({ souvislosti: [] } as any);

    const db = {
      getUrlCounts: vi.fn().mockReturnValue({ total: 2, pending: 2, failed: 0, scraped: 0, gone: 0 }),
      getPendingUrls: vi.fn().mockReturnValueOnce([
        {
          id: 11,
          eli: '/eli/cz/sb/2020/1',
          status: 'pending',
          attempts: 0,
        },
      ]),
      startRun: vi.fn().mockReturnValue(303),
      saveAct: vi.fn(),
      markFailed: vi.fn(),
      finishRun: vi.fn(),
    };

    await runDetailPhase(
      db as any,
      {
        ...makeConfig(),
        collection: 'all',
        limit: 1,
      } as any,
      () => false,
    );

    expect(db.getUrlCounts).toHaveBeenCalledWith(undefined);
    expect(db.getPendingUrls).toHaveBeenCalledWith(0, 1, undefined);
    expect(db.saveAct).toHaveBeenCalledTimes(1);
    const saved = db.saveAct.mock.calls[0][0] as Record<string, unknown>;
    expect(saved.full_text).toBeUndefined();
    expect(db.finishRun).toHaveBeenCalledWith(303, 1, 1, 0, 'completed');
  });

  it('returns early when there are no pending or failed acts', async () => {
    const db = {
      getUrlCounts: vi.fn().mockReturnValue({ total: 0, pending: 0, failed: 0, scraped: 0, gone: 0 }),
      getPendingUrls: vi.fn(),
      startRun: vi.fn(),
      saveAct: vi.fn(),
      markFailed: vi.fn(),
      finishRun: vi.fn(),
    };

    await runDetailPhase(db as any, makeConfig(), () => false);

    expect(db.startRun).not.toHaveBeenCalled();
    expect(db.getPendingUrls).not.toHaveBeenCalled();
    expect(db.finishRun).not.toHaveBeenCalled();
  });

  it('finishes run as interrupted when shutdown is requested before processing starts', async () => {
    const db = {
      getUrlCounts: vi.fn().mockReturnValue({ total: 1, pending: 1, failed: 0, scraped: 0, gone: 0 }),
      getPendingUrls: vi.fn(),
      startRun: vi.fn().mockReturnValue(404),
      saveAct: vi.fn(),
      markFailed: vi.fn(),
      finishRun: vi.fn(),
    };

    await runDetailPhase(db as any, makeConfig(), () => true);

    expect(db.getPendingUrls).not.toHaveBeenCalled();
    expect(db.finishRun).toHaveBeenCalledWith(404, 1, 0, 0, 'interrupted');
  });

  it('logs periodic progress and retries transient scrape errors before succeeding', async () => {
    vi.mocked(fetchMetadata)
      .mockRejectedValueOnce(new Error('transient metadata issue'))
      .mockResolvedValueOnce({
        kodDokumentuSbirky: '2/2020 Sb.',
        nazev: 'Test retry',
        typAktuKod: 'ZAKON',
        typZneni: 'AKTUALNI',
        datumUcinnostiOd: '2020-01-01',
      } as any);
    vi.mocked(fetchFragments)
      .mockResolvedValueOnce({ seznam: [{ id: 1, xhtml: '<p>Retry</p>' }] } as any)
      .mockResolvedValueOnce({ seznam: [] } as any);
    vi.mocked(fetchRelationships).mockResolvedValue({ souvislosti: [] } as any);

    const db = {
      getUrlCounts: vi.fn().mockReturnValue({ total: 1, pending: 1, failed: 0, scraped: 0, gone: 0 }),
      getPendingUrls: vi
        .fn()
        .mockReturnValueOnce([
          {
            id: 1,
            eli: '/eli/cz/sb/2020/2',
            status: 'pending',
            attempts: 0,
          },
        ])
        .mockReturnValueOnce([]),
      startRun: vi.fn().mockReturnValue(505),
      saveAct: vi.fn(),
      markFailed: vi.fn(),
      finishRun: vi.fn(),
    };

    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const randomSpy = vi.spyOn(Math, 'random').mockReturnValue(0);
    const setIntervalSpy = vi.spyOn(globalThis, 'setInterval').mockImplementation((fn: TimerHandler) => {
      (fn as () => void)();
      return 456 as unknown as ReturnType<typeof setInterval>;
    });
    const clearIntervalSpy = vi.spyOn(globalThis, 'clearInterval').mockImplementation(() => {});

    try {
      await runDetailPhase(
        db as any,
        {
          ...makeConfig(),
          maxRetries: 1,
        },
        () => false,
      );

      expect(setIntervalSpy).toHaveBeenCalledWith(expect.any(Function), 30_000);
      expect(logSpy.mock.calls.some((call) => String(call[0]).includes('Delay: 0ms'))).toBe(true);
      expect(logSpy.mock.calls.some((call) => String(call[0]).includes('Retry 1 for /eli/cz/sb/2020/2'))).toBe(true);
    } finally {
      logSpy.mockRestore();
      randomSpy.mockRestore();
      setIntervalSpy.mockRestore();
      clearIntervalSpy.mockRestore();
    }

    expect(db.saveAct).toHaveBeenCalledTimes(1);
    expect(db.markFailed).not.toHaveBeenCalled();
    expect(db.finishRun).toHaveBeenCalledWith(505, 1, 1, 0, 'completed');
  });
});
