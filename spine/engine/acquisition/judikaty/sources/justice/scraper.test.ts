import { parseDetail, runDetail } from './scraper.js';
import type { DetailResponse } from './api.js';

vi.mock('./api.js', () => ({
  fetchYears: vi.fn(),
  fetchDayPage: vi.fn(),
  fetchDetail: vi.fn(),
}));

describe('justice scraper', () => {
  describe('parseDetail', () => {
    it('parses detail response into DecisionData', () => {
      const raw: DetailResponse = {
        uuid: 'abc-123',
        metadata: {
          type: 'JUDGEMENT',
          ecli: 'ECLI:CZ:OSPRAHA:2024:1.C.100.2024.1',
          publishedAt: '2024-06-20',
          decisionAt: '2024-06-15',
          caseNumber: { senate: 1, registry: 'C', index: 100, year: 2024, pageNumber: 32 },
          solver: { titlesBefore: 'JUDr.', firstName: 'Jan', lastName: 'Novák', titlesAfter: '', function: 'soudce' },
          courtCode: 'OSPRAHA',
          caseSubject: 'Občanskoprávní řízení',
          caseResultType: ['POTVRZENI'],
          flags: ['postoupení pohledávky', 'bezdůvodné obohacení'],
          regulations: [{ text: '§ 2991 z. č. 89/2012 Sb.' }],
        },
        verdictText: 'Žaloba se zamítá.',
        justificationText: 'Soud po provedeném dokazování zjistil...',
      };

      const result = parseDetail(raw, 'https://rozhodnuti.justice.cz/api/finaldoc/abc-123');

      expect(result.source).toBe('justice');
      expect(result.external_id).toBe('abc-123');
      expect(result.ecli).toBe('ECLI:CZ:OSPRAHA:2024:1.C.100.2024.1');
      expect(result.jednaci_cislo).toBe('1 C 100/2024-32');
      expect(result.soud).toBe('OSPRAHA');
      expect(result.autor).toBe('JUDr. Jan Novák');
      expect(result.datum_vydani).toBe('2024-06-15');
      expect(result.datum_zverejneni).toBe('2024-06-20');
      expect(result.typ_rozhodnuti).toBe('JUDGEMENT');
      expect(result.predmet_rizeni).toBe('Občanskoprávní řízení');
      expect(result.klicova_slova).toBe('["postoupení pohledávky","bezdůvodné obohacení"]');
      expect(result.zminena_ustanoveni).toBeDefined();
      expect(result.vyrok).toBe('Žaloba se zamítá.');
      expect(result.oduvodneni).toBe('Soud po provedeném dokazování zjistil...');
      expect(result.raw_json).toBeDefined();
    });

    it('handles minimal response', () => {
      const raw: DetailResponse = {
        uuid: 'min-1',
        metadata: {},
      };

      const result = parseDetail(raw, 'https://rozhodnuti.justice.cz/api/finaldoc/min-1');
      expect(result.source).toBe('justice');
      expect(result.external_id).toBe('min-1');
      expect(result.url).toBe('https://rozhodnuti.justice.cz/api/finaldoc/min-1');
    });

    it('handles empty flags and regulations', () => {
      const raw: DetailResponse = {
        uuid: 'test',
        metadata: { flags: [], regulations: [] },
      };

      const result = parseDetail(raw, 'https://example.com/test');
      expect(result.klicova_slova).toBeUndefined();
      expect(result.zminena_ustanoveni).toBeUndefined();
    });

    it('handles missing metadata', () => {
      const raw = { uuid: 'test' } as DetailResponse;
      const result = parseDetail(raw, 'https://example.com/test');
      expect(result.source).toBe('justice');
      expect(result.ecli).toBeUndefined();
    });

    it('stores raw JSON', () => {
      const raw: DetailResponse = {
        uuid: 'test',
        metadata: { ecli: 'ECLI:TEST' },
        verdictText: 'test verdict',
      };
      const result = parseDetail(raw, 'https://example.com/test');
      const parsed = JSON.parse(result.raw_json!);
      expect(parsed.uuid).toBe('test');
      expect(parsed.metadata.ecli).toBe('ECLI:TEST');
    });

    it('formats case number correctly', () => {
      const raw: DetailResponse = {
        uuid: 'test',
        metadata: {
          caseNumber: { senate: 9, registry: 'C', index: 22, year: 2024, pageNumber: 32 },
        },
      };
      const result = parseDetail(raw, 'https://example.com/test');
      expect(result.jednaci_cislo).toBe('9 C 22/2024-32');
    });

    it('formats case number without page number', () => {
      const raw: DetailResponse = {
        uuid: 'test',
        metadata: {
          caseNumber: { senate: 1, registry: 'C', index: 100, year: 2024 },
        },
      };
      const result = parseDetail(raw, 'https://example.com/test');
      expect(result.jednaci_cislo).toBe('1 C 100/2024');
    });

    it('formats solver name with titles', () => {
      const raw: DetailResponse = {
        uuid: 'test',
        metadata: {
          solver: { titlesBefore: 'Mgr.', firstName: 'Jana', lastName: 'Nová', titlesAfter: 'Ph.D.' },
        },
      };
      const result = parseDetail(raw, 'https://example.com/test');
      expect(result.autor).toBe('Mgr. Jana Nová Ph.D.');
    });

    it('returns undefined case number and solver when objects have no usable fields', () => {
      const raw: DetailResponse = {
        uuid: 'test',
        metadata: {
          caseNumber: {} as any,
          solver: {} as any,
        },
      };

      const result = parseDetail(raw, 'https://example.com/test');
      expect(result.jednaci_cislo).toBeUndefined();
      expect(result.autor).toBeUndefined();
    });

    it('formats partial case number without index/year segment', () => {
      const raw: DetailResponse = {
        uuid: 'test',
        metadata: {
          caseNumber: { senate: 3, registry: 'C' } as any,
        },
      };

      const result = parseDetail(raw, 'https://example.com/test');
      expect(result.jednaci_cislo).toBe('3 C');
    });
  });

  describe('runDetail', () => {
    let fetchDetail: ReturnType<typeof vi.fn>;

    beforeAll(async () => {
      const mod = await import('./api.js');
      fetchDetail = mod.fetchDetail as ReturnType<typeof vi.fn>;
    });

    beforeEach(() => {
      vi.clearAllMocks();
    });

    const mockDb = () => ({
      getUrlCounts: vi.fn().mockReturnValue({ total: 2, pending: 2, scraped: 0, failed: 0, gone: 0 }),
      getPendingUrls: vi.fn(),
      startRun: vi.fn().mockReturnValue(1),
      finishRun: vi.fn(),
      saveDecision: vi.fn(),
      markFailed: vi.fn(),
      markGone: vi.fn(),
    });

    it('processes URLs and saves decisions', async () => {
      const db = mockDb();
      db.getPendingUrls
        .mockReturnValueOnce([
          {
            url: 'https://rozhodnuti.justice.cz/api/finaldoc/uuid-1',
            id: 1,
            source: 'justice',
            external_id: 'uuid-1',
            status: 'pending',
            attempts: 0,
          },
        ])
        .mockReturnValueOnce([]);

      fetchDetail.mockResolvedValue({
        uuid: 'uuid-1',
        metadata: { ecli: 'ECLI:1', courtCode: 'OS' },
      });

      await runDetail(
        db as any,
        { source: 'justice', concurrency: 1, delay: 0, maxRetries: 1, limit: 0, dbPath: '', phase: 'detail' },
        () => false,
      );

      expect(db.saveDecision).toHaveBeenCalledTimes(1);
      expect(db.finishRun).toHaveBeenCalledWith(1, 2, 1, 0, 'completed');
    });

    it('handles fetch errors by marking failed', async () => {
      const db = mockDb();
      db.getPendingUrls
        .mockReturnValueOnce([
          {
            url: 'https://example.com/1',
            id: 1,
            source: 'justice',
            external_id: 'bad',
            status: 'pending',
            attempts: 0,
          },
        ])
        .mockReturnValueOnce([]);

      fetchDetail.mockRejectedValue(new Error('HTTP 500'));

      await runDetail(
        db as any,
        { source: 'justice', concurrency: 1, delay: 0, maxRetries: 0, limit: 0, dbPath: '', phase: 'detail' },
        () => false,
      );

      expect(db.markFailed).toHaveBeenCalled();
    });

    it('stops on shutdown', async () => {
      const db = mockDb();
      db.getPendingUrls.mockReturnValue([
        { url: 'https://example.com/1', id: 1, source: 'justice', external_id: 'x', status: 'pending', attempts: 0 },
      ]);

      await runDetail(
        db as any,
        { source: 'justice', concurrency: 1, delay: 0, maxRetries: 0, limit: 0, dbPath: '', phase: 'detail' },
        () => true,
      );

      expect(db.finishRun).toHaveBeenCalledWith(1, 2, 0, 0, 'interrupted');
    });

    it('handles no pending URLs', async () => {
      const db = mockDb();
      db.getUrlCounts.mockReturnValue({ total: 0, pending: 0, scraped: 0, failed: 0, gone: 0 });

      await runDetail(
        db as any,
        { source: 'justice', concurrency: 1, delay: 0, maxRetries: 0, limit: 0, dbPath: '', phase: 'detail' },
        () => false,
      );

      expect(db.startRun).not.toHaveBeenCalled();
    });

    it('honors limit and stops after reaching it', async () => {
      const db = mockDb();
      db.getPendingUrls.mockReturnValueOnce([
        {
          url: 'https://rozhodnuti.justice.cz/api/finaldoc/uuid-limit',
          id: 1,
          source: 'justice',
          external_id: 'uuid-limit',
          status: 'pending',
          attempts: 0,
        },
      ]);

      fetchDetail.mockResolvedValue({
        uuid: 'uuid-limit',
        metadata: { ecli: 'ECLI:LIMIT', courtCode: 'OS' },
      });

      await runDetail(
        db as any,
        { source: 'justice', concurrency: 1, delay: 0, maxRetries: 0, limit: 1, dbPath: '', phase: 'detail' },
        () => false,
      );

      expect(db.getPendingUrls).toHaveBeenCalledWith('justice', 0, 1);
      expect(db.finishRun).toHaveBeenCalledWith(1, 1, 1, 0, 'completed');
    });

    it('falls back to UUID parsed from URL when external_id is missing', async () => {
      const db = mockDb();
      db.getPendingUrls
        .mockReturnValueOnce([
          {
            url: 'https://rozhodnuti.justice.cz/api/finaldoc/uuid-from-url',
            id: 1,
            source: 'justice',
            status: 'pending',
            attempts: 0,
          },
        ])
        .mockReturnValueOnce([]);

      fetchDetail.mockResolvedValue({
        uuid: 'uuid-from-url',
        metadata: { ecli: 'ECLI:FALLBACK', courtCode: 'OS' },
      });

      await runDetail(
        db as any,
        { source: 'justice', concurrency: 1, delay: 0, maxRetries: 0, limit: 0, dbPath: '', phase: 'detail' },
        () => false,
      );

      expect(fetchDetail).toHaveBeenCalledWith('uuid-from-url');
      expect(db.saveDecision).toHaveBeenCalledTimes(1);
    });

    it('falls back to empty UUID when URL split yields no path segment', async () => {
      const db = mockDb();
      const malformedUrl = { split: () => [] as string[] } as unknown as string;

      db.getPendingUrls
        .mockReturnValueOnce([
          {
            url: malformedUrl,
            id: 1,
            source: 'justice',
            status: 'pending',
            attempts: 0,
          },
        ])
        .mockReturnValueOnce([]);

      fetchDetail.mockResolvedValue({
        uuid: 'fallback-empty',
        metadata: { ecli: 'ECLI:EMPTY', courtCode: 'OS' },
      });

      await runDetail(
        db as any,
        { source: 'justice', concurrency: 1, delay: 0, maxRetries: 0, limit: 0, dbPath: '', phase: 'detail' },
        () => false,
      );

      expect(fetchDetail).toHaveBeenCalledWith('');
      expect(db.saveDecision).toHaveBeenCalledTimes(1);
      expect(db.markFailed).not.toHaveBeenCalled();
    });

    it('logs periodic progress and retry attempts for transient detail fetch failures', async () => {
      const db = mockDb();
      db.getPendingUrls
        .mockReturnValueOnce([
          {
            url: 'https://rozhodnuti.justice.cz/api/finaldoc/uuid-retry',
            id: 1,
            source: 'justice',
            external_id: 'uuid-retry',
            status: 'pending',
            attempts: 0,
          },
        ])
        .mockReturnValueOnce([]);

      fetchDetail
        .mockRejectedValueOnce(new Error('temporary'))
        .mockResolvedValueOnce({
          uuid: 'uuid-retry',
          metadata: { ecli: 'ECLI:RETRY', courtCode: 'OS' },
        });

      const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
      const randomSpy = vi.spyOn(Math, 'random').mockReturnValue(0);
      const setIntervalSpy = vi.spyOn(globalThis, 'setInterval').mockImplementation((fn: TimerHandler) => {
        (fn as () => void)();
        return 987 as unknown as ReturnType<typeof setInterval>;
      });
      const clearIntervalSpy = vi.spyOn(globalThis, 'clearInterval').mockImplementation(() => {});

      try {
        await runDetail(
          db as any,
          { source: 'justice', concurrency: 1, delay: 0, maxRetries: 1, limit: 0, dbPath: '', phase: 'detail' },
          () => false,
        );

        expect(setIntervalSpy).toHaveBeenCalledWith(expect.any(Function), 30_000);
        expect(logSpy.mock.calls.some((call) => String(call[0]).includes('Delay: 0ms'))).toBe(true);
        expect(logSpy.mock.calls.some((call) => String(call[0]).includes('Retry 1 for https://rozhodnuti.justice.cz/api/finaldoc/uuid-retry'))).toBe(true);
      } finally {
        logSpy.mockRestore();
        randomSpy.mockRestore();
        setIntervalSpy.mockRestore();
        clearIntervalSpy.mockRestore();
      }

      expect(fetchDetail).toHaveBeenCalledTimes(2);
      expect(db.saveDecision).toHaveBeenCalledTimes(1);
      expect(db.markFailed).not.toHaveBeenCalled();
    });
  });
});
