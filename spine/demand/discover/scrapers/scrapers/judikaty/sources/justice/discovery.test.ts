import { runDiscovery } from './discovery.js';

vi.mock('./api.js', () => ({
  fetchYears: vi.fn(),
  fetchDayPage: vi.fn(),
}));

describe('justice discovery', () => {
  let fetchYears: ReturnType<typeof vi.fn>;
  let fetchDayPage: ReturnType<typeof vi.fn>;

  beforeAll(async () => {
    const mod = await import('./api.js');
    fetchYears = mod.fetchYears as ReturnType<typeof vi.fn>;
    fetchDayPage = mod.fetchDayPage as ReturnType<typeof vi.fn>;
  });

  beforeEach(() => {
    vi.clearAllMocks();
  });

  const mockDb = () => ({
    insertUrlBatch: vi.fn(),
    getUrlCounts: vi.fn().mockReturnValue({ total: 5, pending: 5, scraped: 0, failed: 0, gone: 0 }),
  });

  it('discovers URLs from date hierarchy', async () => {
    const db = mockDb();
    fetchYears.mockResolvedValue([{ rok: 2024, pocet: 2, odkaz: 'https://rozhodnuti.justice.cz/api/opendata/2024' }]);
    fetchDayPage.mockImplementation(async (year: number, month: number, day: number) => {
      if (year === 2024 && month === 1 && day === 1) {
        return {
          items: [
            {
              jednaciCislo: '1 C 1/2024',
              soud: 'OS Praha',
              autor: 'Novák',
              ecli: 'ECLI:CZ:OSPRAHA:2024:1',
              predmetRizeni: 'Občanské',
              datumVydani: '2024-01-01',
              datumZverejneni: '2024-01-05',
              klicovaSlova: ['nájem'],
              zminenaUstanoveni: [],
              odkaz: 'https://rozhodnuti.justice.cz/api/finaldoc/uuid-1',
            },
          ],
          numberOfItems: 1,
          pageSize: 100,
          pageNumber: 0,
          totalPages: 1,
          totalElements: 1,
        };
      }
      throw new Error('HTTP 404');
    });

    await runDiscovery(
      db as any,
      { source: 'justice', phase: 'discovery', concurrency: 1, delay: 0, maxRetries: 3, limit: 5, dbPath: '' },
      () => false,
    );

    expect(db.insertUrlBatch).toHaveBeenCalled();
    const insertedUrls = db.insertUrlBatch.mock.calls[0][0];
    expect(insertedUrls[0]).toMatchObject({
      source: 'justice',
      ecli: 'ECLI:CZ:OSPRAHA:2024:1',
      jednaci_cislo: '1 C 1/2024',
      soud: 'OS Praha',
    });
  });

  it('handles pagination', async () => {
    const db = mockDb();
    fetchYears.mockResolvedValue([{ rok: 2024, pocet: 150, odkaz: 'https://example.com/2024' }]);
    fetchDayPage.mockImplementation(async (_y: number, _m: number, _d: number, page: number) => {
      if (_m === 1 && _d === 1) {
        if (page === 0) {
          return {
            items: Array.from({ length: 100 }, (_, i) => ({
              jednaciCislo: `1 C ${i}/2024`,
              soud: 'OS',
              autor: 'A',
              ecli: `ECLI:${i}`,
              predmetRizeni: 'X',
              datumVydani: '2024-01-01',
              datumZverejneni: '2024-01-01',
              klicovaSlova: [],
              zminenaUstanoveni: [],
              odkaz: `https://rozhodnuti.justice.cz/api/finaldoc/uuid-${i}`,
            })),
            numberOfItems: 100,
            pageSize: 100,
            pageNumber: 0,
            totalPages: 2,
            totalElements: 150,
          };
        }
        if (page === 1) {
          return {
            items: Array.from({ length: 50 }, (_, i) => ({
              jednaciCislo: `1 C ${i + 100}/2024`,
              soud: 'OS',
              autor: 'A',
              ecli: `ECLI:${i + 100}`,
              predmetRizeni: 'X',
              datumVydani: '2024-01-01',
              datumZverejneni: '2024-01-01',
              klicovaSlova: [],
              zminenaUstanoveni: [],
              odkaz: `https://rozhodnuti.justice.cz/api/finaldoc/uuid-${i + 100}`,
            })),
            numberOfItems: 50,
            pageSize: 100,
            pageNumber: 1,
            totalPages: 2,
            totalElements: 150,
          };
        }
      }
      throw new Error('HTTP 404');
    });

    await runDiscovery(
      db as any,
      { source: 'justice', phase: 'discovery', concurrency: 1, delay: 0, maxRetries: 3, limit: 200, dbPath: '' },
      () => false,
    );

    expect(db.insertUrlBatch).toHaveBeenCalled();
    // fetchDay handles pagination internally — all 150 URLs from both pages arrive in one batch
    const allInserted = db.insertUrlBatch.mock.calls.flatMap((c: unknown[][]) => c[0]);
    expect(allInserted.length).toBe(150);
  });

  it('respects limit', async () => {
    const db = mockDb();
    fetchYears.mockResolvedValue([{ rok: 2024, pocet: 1000, odkaz: 'https://example.com/2024' }]);
    fetchDayPage.mockImplementation(async () => ({
      items: Array.from({ length: 100 }, (_, i) => ({
        jednaciCislo: `${i}`,
        soud: 'OS',
        autor: 'A',
        ecli: `ECLI:${i}`,
        predmetRizeni: 'X',
        datumVydani: '2024-01-01',
        datumZverejneni: '2024-01-01',
        klicovaSlova: [],
        zminenaUstanoveni: [],
        odkaz: `https://example.com/uuid-${Math.random()}`,
      })),
      numberOfItems: 100,
      pageSize: 100,
      pageNumber: 0,
      totalPages: 1,
      totalElements: 100,
    }));

    await runDiscovery(
      db as any,
      { source: 'justice', phase: 'discovery', concurrency: 1, delay: 0, maxRetries: 3, limit: 50, dbPath: '' },
      () => false,
    );

    expect(db.insertUrlBatch).toHaveBeenCalled();
  });

  it('stops on shutdown', async () => {
    const db = mockDb();
    fetchYears.mockResolvedValue([{ rok: 2024, pocet: 100, odkaz: 'https://example.com/2024' }]);

    await runDiscovery(
      db as any,
      { source: 'justice', phase: 'discovery', concurrency: 1, delay: 0, maxRetries: 3, limit: 0, dbPath: '' },
      () => true,
    );

    expect(fetchDayPage).not.toHaveBeenCalled();
  });

  it('handles empty day pages without inserting empty batches', async () => {
    const db = mockDb();
    fetchYears.mockResolvedValue([{ rok: 2024, pocet: 0, odkaz: 'https://example.com/2024' }]);
    fetchDayPage.mockResolvedValue({
      items: [],
      numberOfItems: 0,
      pageSize: 100,
      pageNumber: 0,
      totalPages: 1,
      totalElements: 0,
    });

    let checks = 0;
    const shutdownAfterFirstMonth = () => {
      checks += 1;
      return checks > 3;
    };

    await runDiscovery(
      db as any,
      { source: 'justice', phase: 'discovery', concurrency: 1, delay: 0, maxRetries: 3, limit: 0, dbPath: '' },
      shutdownAfterFirstMonth,
    );

    expect(fetchDayPage).toHaveBeenCalled();
    expect(db.insertUrlBatch).not.toHaveBeenCalled();
  });

  it('processes unlimited mode without applying limit slicing', async () => {
    const db = mockDb();
    fetchYears.mockResolvedValue([{ rok: 2024, pocet: 1, odkaz: 'https://example.com/2024' }]);
    fetchDayPage.mockImplementation(async (_y: number, m: number, d: number, page: number) => {
      if (m === 1 && d === 1 && page === 0) {
        return {
          items: [
            {
              jednaciCislo: '1 C 1/2024',
              soud: 'OS',
              autor: 'A',
              ecli: 'ECLI:ONE',
              predmetRizeni: 'X',
              datumVydani: '2024-01-01',
              datumZverejneni: '2024-01-02',
              klicovaSlova: [],
              zminenaUstanoveni: [],
              odkaz: 'https://rozhodnuti.justice.cz/api/finaldoc/uuid-unlimited',
            },
          ],
          numberOfItems: 1,
          pageSize: 100,
          pageNumber: 0,
          totalPages: 1,
          totalElements: 1,
        };
      }

      return {
        items: [],
        numberOfItems: 0,
        pageSize: 100,
        pageNumber: 0,
        totalPages: 1,
        totalElements: 0,
      };
    });

    let checks = 0;
    const shutdownAfterFirstMonth = () => {
      checks += 1;
      return checks > 3;
    };

    await runDiscovery(
      db as any,
      { source: 'justice', phase: 'discovery', concurrency: 1, delay: 0, maxRetries: 3, limit: 0, dbPath: '' },
      shutdownAfterFirstMonth,
    );

    expect(db.insertUrlBatch).toHaveBeenCalledTimes(1);
    expect(db.insertUrlBatch.mock.calls[0][0]).toHaveLength(1);
    expect(db.insertUrlBatch.mock.calls[0][0][0].external_id).toBe('uuid-unlimited');
  });

  it('stops before processing next year once limit is reached', async () => {
    const db = mockDb();
    fetchYears.mockResolvedValue([
      { rok: 2024, pocet: 10, odkaz: 'https://example.com/2024' },
      { rok: 2023, pocet: 10, odkaz: 'https://example.com/2023' },
    ]);
    fetchDayPage.mockImplementation(async (y: number, m: number, d: number, page: number) => {
      if (y === 2024 && m === 1 && d === 1 && page === 0) {
        return {
          items: [
            {
              jednaciCislo: '1 C 2/2024',
              soud: 'OS',
              autor: 'A',
              ecli: 'ECLI:LIMIT',
              predmetRizeni: 'X',
              datumVydani: '2024-01-01',
              datumZverejneni: '2024-01-02',
              klicovaSlova: [],
              zminenaUstanoveni: [],
              odkaz: 'https://rozhodnuti.justice.cz/api/finaldoc/uuid-limit-year',
            },
          ],
          numberOfItems: 1,
          pageSize: 100,
          pageNumber: 0,
          totalPages: 1,
          totalElements: 1,
        };
      }

      return {
        items: [],
        numberOfItems: 0,
        pageSize: 100,
        pageNumber: 0,
        totalPages: 1,
        totalElements: 0,
      };
    });

    await runDiscovery(
      db as any,
      { source: 'justice', phase: 'discovery', concurrency: 1, delay: 0, maxRetries: 3, limit: 1, dbPath: '' },
      () => false,
    );

    const calledYears = new Set(fetchDayPage.mock.calls.map((c: unknown[]) => c[0] as number));
    expect(calledYears.has(2023)).toBe(false);
    expect(db.insertUrlBatch).toHaveBeenCalledTimes(1);
  });

  it('logs periodic progress and falls back to raw odkaz when split().pop() is unavailable', async () => {
    const db = mockDb();
    const fallbackUrl = { split: () => [] as string[] } as unknown as string;

    fetchYears.mockResolvedValue([{ rok: 2024, pocet: 1, odkaz: 'https://example.com/2024' }]);
    fetchDayPage.mockImplementation(async (_y: number, m: number, d: number, page: number) => {
      if (m === 1 && d === 1 && page === 0) {
        return {
          items: [
            {
              jednaciCislo: '1 C 3/2024',
              soud: 'OS',
              autor: 'A',
              ecli: 'ECLI:FALLBACK',
              predmetRizeni: 'X',
              datumVydani: '2024-01-01',
              datumZverejneni: '2024-01-02',
              klicovaSlova: [],
              zminenaUstanoveni: [],
              odkaz: fallbackUrl,
            },
          ],
          numberOfItems: 1,
          pageSize: 100,
          pageNumber: 0,
          totalPages: 1,
          totalElements: 1,
        };
      }

      return {
        items: [],
        numberOfItems: 0,
        pageSize: 100,
        pageNumber: 0,
        totalPages: 1,
        totalElements: 0,
      };
    });

    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const setIntervalSpy = vi.spyOn(globalThis, 'setInterval').mockImplementation((fn: TimerHandler) => {
      (fn as () => void)();
      return 654 as unknown as ReturnType<typeof setInterval>;
    });
    const clearIntervalSpy = vi.spyOn(globalThis, 'clearInterval').mockImplementation(() => {});

    try {
      await runDiscovery(
        db as any,
        { source: 'justice', phase: 'discovery', concurrency: 1, delay: 0, maxRetries: 3, limit: 1, dbPath: '' },
        () => false,
      );

      expect(setIntervalSpy).toHaveBeenCalledWith(expect.any(Function), 30_000);
      expect(logSpy).toHaveBeenCalled();
    } finally {
      logSpy.mockRestore();
      setIntervalSpy.mockRestore();
      clearIntervalSpy.mockRestore();
    }

    expect(db.insertUrlBatch).toHaveBeenCalledTimes(1);
    const inserted = db.insertUrlBatch.mock.calls[0][0][0];
    expect(inserted.external_id).toBe(fallbackUrl);
  });
});
