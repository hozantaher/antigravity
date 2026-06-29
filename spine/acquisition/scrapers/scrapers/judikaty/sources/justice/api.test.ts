import { fetchDayPage, fetchDetail, fetchJson, fetchYears } from './api.js';

// Mock global fetch
const mockFetch = vi.fn();
vi.stubGlobal('fetch', mockFetch);

describe('justice api', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('fetchJson', () => {
    it('fetches JSON from API', async () => {
      const data = [{ year: 2024, count: 1000 }];
      mockFetch.mockResolvedValue({
        ok: true,
        json: () => Promise.resolve(data),
      });

      const result = await fetchJson('/opendata');
      expect(result).toEqual(data);
      expect(mockFetch).toHaveBeenCalledWith(
        'https://rozhodnuti.justice.cz/api/opendata',
        expect.objectContaining({
          headers: expect.objectContaining({ Accept: 'application/json' }),
        }),
      );
    });

    it('throws on non-OK response with full URL in error message', async () => {
      mockFetch.mockResolvedValue({
        ok: false,
        status: 404,
      });

      await expect(fetchJson('/opendata/2024/1/32')).rejects.toThrow(
        'HTTP 404 for https://rozhodnuti.justice.cz/api/opendata/2024/1/32',
      );
    });

    it('includes User-Agent header', async () => {
      mockFetch.mockResolvedValue({
        ok: true,
        json: () => Promise.resolve({}),
      });

      await fetchJson('/test');
      const headers = mockFetch.mock.calls[0][1].headers;
      expect(headers['User-Agent']).toBeDefined();
      expect(headers['User-Agent'].length).toBeGreaterThan(0);
    });

    it('uses 30s timeout', async () => {
      mockFetch.mockResolvedValue({
        ok: true,
        json: () => Promise.resolve({}),
      });

      await fetchJson('/test');
      const signal = mockFetch.mock.calls[0][1].signal;
      expect(signal).toBeDefined();
    });
  });

  describe('wrapper endpoints', () => {
    it('fetchYears calls /opendata', async () => {
      const payload = [{ rok: 2026, pocet: 1, odkaz: '/api/opendata/2026' }];
      mockFetch.mockResolvedValue({ ok: true, json: () => Promise.resolve(payload) });

      await expect(fetchYears()).resolves.toEqual(payload);
      expect(mockFetch).toHaveBeenCalledWith('https://rozhodnuti.justice.cz/api/opendata', expect.any(Object));
    });

    it('fetchDayPage builds the expected date/page path', async () => {
      const payload = { items: [], numberOfItems: 0, pageSize: 50, pageNumber: 2, totalPages: 2, totalElements: 0 };
      mockFetch.mockResolvedValue({ ok: true, json: () => Promise.resolve(payload) });

      await expect(fetchDayPage(2024, 3, 15, 2)).resolves.toEqual(payload);
      expect(mockFetch).toHaveBeenCalledWith(
        'https://rozhodnuti.justice.cz/api/opendata/2024/3/15?page=2',
        expect.any(Object),
      );
    });

    it('fetchDetail calls /finaldoc/{uuid}', async () => {
      const payload = { uuid: 'abc-123', metadata: {} };
      mockFetch.mockResolvedValue({ ok: true, json: () => Promise.resolve(payload) });

      await expect(fetchDetail('abc-123')).resolves.toEqual(payload);
      expect(mockFetch).toHaveBeenCalledWith('https://rozhodnuti.justice.cz/api/finaldoc/abc-123', expect.any(Object));
    });
  });
});
