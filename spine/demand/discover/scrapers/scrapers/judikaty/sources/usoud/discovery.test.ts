import * as cheerio from 'cheerio';
import { extractFormTokens, parseSearchResults, runDiscovery } from './discovery.js';
import { generateYearRanges } from '../../utils.js';

vi.mock('../../utils.js', () => ({
  generateYearRanges: vi.fn(() => [{ label: '2024', from: '01.01.2024', to: '31.12.2024' }]),
}));

const mockFetch = vi.fn();
vi.stubGlobal('fetch', mockFetch);

describe('usoud discovery', () => {
  describe('extractFormTokens', () => {
    it('extracts ASP.NET form tokens', () => {
      const html = `<html><body><form>
        <input type="hidden" name="__VIEWSTATE" id="__VIEWSTATE" value="abc123" />
        <input type="hidden" name="__VIEWSTATEGENERATOR" id="__VIEWSTATEGENERATOR" value="gen456" />
        <input type="hidden" name="__EVENTVALIDATION" id="__EVENTVALIDATION" value="val789" />
      </form></body></html>`;

      const tokens = extractFormTokens(html);
      expect(tokens.viewState).toBe('abc123');
      expect(tokens.viewStateGenerator).toBe('gen456');
      expect(tokens.eventValidation).toBe('val789');
    });

    it('handles missing tokens', () => {
      const tokens = extractFormTokens('<html><body></body></html>');
      expect(tokens.viewState).toBe('');
    });
  });

  describe('parseSearchResults', () => {
    it('parses result table rows with real USoud HTML structure', () => {
      const html = `<html><body>
        <input type="submit" name="ctl00$bResults" value="Nalezené (42)" id="ctl00_bResults" />
        <table>
          <tr class='resultDataHeader'><th>Sp.zn.</th></tr>
          <tr class='resultData0'>
            <td class='resultData0'><input type='checkbox' /></td>
            <td class='resultData0'>
              <a href='ResultDetail.aspx?id=126450&pos=1&cnt=42&typ=result' class='resultData0'>IV.ÚS 2779/23 #1</a>
              <br />ECLI:CZ:US:2024:4.US.2779.23.1<br />Ronovská Kateřina
            </td>
            <td class='resultData0'>STĚŽOVATEL - FO</td>
            <td class='resultData0'>31. 1. 2024<br />(-)  19. 10. 2023<br />26. 2. 2024</td>
            <td class='resultData0'>2/1993 Sb.</td>
            <td class='resultData0'>Usnesení</td>
            <td class='resultData0'>odmítnuto</td>
            <td class='resultData0'>&nbsp;</td>
            <td class='resultData0'>základní práva</td>
          </tr>
          <tr class='resultData1'>
            <td class='resultData1'><input type='checkbox' /></td>
            <td class='resultData1'>
              <a href='ResultDetail.aspx?id=126452&pos=2&cnt=42&typ=result' class='resultData1'>IV.ÚS 2198/23 #1</a>
              <br />ECLI:CZ:US:2024:4.US.2198.23.1<br />Ronovská Kateřina
            </td>
            <td class='resultData1'>STĚŽOVATEL - FO</td>
            <td class='resultData1'>30. 1. 2024</td>
            <td class='resultData1'></td>
            <td class='resultData1'>Nález</td>
            <td class='resultData1'>vyhověno</td>
            <td class='resultData1'>&nbsp;</td>
            <td class='resultData1'>právo na soudní ochranu</td>
          </tr>
        </table>
      </body></html>`;

      const { urls, totalResults, totalPages } = parseSearchResults(html);
      expect(urls).toHaveLength(2);
      expect(totalResults).toBe(42);
      expect(totalPages).toBe(5); // ceil(42/10)
      expect(urls[0].source).toBe('usoud');
      expect(urls[0].external_id).toBe('126450');
      expect(urls[0].ecli).toBe('ECLI:CZ:US:2024:4.US.2779.23.1');
      expect(urls[0].soud).toBe('Ústavní soud');
      expect(urls[0].datum_vydani).toBe('31.1.2024');
      expect(urls[1].external_id).toBe('126452');
    });

    it('handles empty results', () => {
      const html = `<html><body>
        <input type="submit" name="ctl00$bResults" value="Nalezené (0)" id="ctl00_bResults" />
        <table><tr class='resultDataHeader'><th>Empty</th></tr></table>
      </body></html>`;

      const { urls, totalResults } = parseSearchResults(html);
      expect(urls).toHaveLength(0);
      expect(totalResults).toBe(0);
    });

    it('extracts total from cnt query param', () => {
      const html = `<html><body>
        <tr class='resultData0'>
          <td></td>
          <td><a href='ResultDetail.aspx?id=1&cnt=301&typ=result'>Test</a></td>
        </tr>
      </body></html>`;

      const { totalResults } = parseSearchResults(html);
      expect(totalResults).toBe(301);
    });

    it('handles absolute detail URLs and missing optional fields', () => {
      const html = `<html><body>
        <table>
          <tr class='resultData0'>
            <td></td>
            <td><a href='https://nalus.usoud.cz/Search/ResultDetail.aspx?id=777&typ=result'></a></td>
            <td></td>
            <td>bez data</td>
          </tr>
        </table>
      </body></html>`;

      const { urls, totalResults } = parseSearchResults(html);
      expect(totalResults).toBe(0);
      expect(urls).toHaveLength(1);
      expect(urls[0].url).toBe('https://nalus.usoud.cz/Search/ResultDetail.aspx?id=777&typ=result');
      expect(urls[0].external_id).toBe('777');
      expect(urls[0].jednaci_cislo).toBeUndefined();
      expect(urls[0].datum_vydani).toBeUndefined();
      expect(urls[0].ecli).toBeUndefined();
    });

    it('handles rows where detail link is outside the expected second column', () => {
      const html = `<html><body>
        <table>
          <tr class='resultData0'>
            <td><a href='ResultDetail.aspx?id=999&typ=result'>Link v prvním sloupci</a></td>
          </tr>
        </table>
      </body></html>`;

      const { urls } = parseSearchResults(html);
      expect(urls).toHaveLength(1);
      expect(urls[0].external_id).toBe('999');
      expect(urls[0].jednaci_cislo).toBeUndefined();
      expect(urls[0].ecli).toBeUndefined();
    });

    it('handles defensive fallback when cheerio attr() returns undefined for detail href', () => {
      const html = `<html><body>
        <table>
          <tr class='resultData0'>
            <td></td>
            <td><a href='ResultDetail.aspx?id=126450&typ=result'>IV. ÚS 1/24</a></td>
            <td></td>
            <td>31. 1. 2024</td>
          </tr>
        </table>
      </body></html>`;

      const proto = Object.getPrototypeOf(
        Object.getPrototypeOf(cheerio.load('<a href="/x">x</a>')('a')),
      ) as {
        attr: (...args: unknown[]) => unknown;
      };
      const originalAttr = proto.attr;
      const attrSpy = vi.spyOn(proto, 'attr').mockImplementation(function (this: unknown, ...args: unknown[]) {
        if (args.length === 1 && args[0] === 'href') return undefined;
        return originalAttr.apply(this, args);
      });

      try {
        const { urls } = parseSearchResults(html);
        expect(urls).toHaveLength(1);
        expect(urls[0].url).toBe('https://nalus.usoud.cz/Search/');
        expect(urls[0].external_id).toBeUndefined();
      } finally {
        attrSpy.mockRestore();
      }
    });
  });

  describe('runDiscovery', () => {
    beforeEach(() => {
      vi.clearAllMocks();
      vi.mocked(generateYearRanges).mockReturnValue([{ label: '2024', from: '01.01.2024', to: '31.12.2024' }] as any);
    });

    const mockDb = () => ({
      insertUrlBatch: vi.fn(),
      getUrlCounts: vi.fn().mockReturnValue({ total: 1, pending: 1, scraped: 0, failed: 0, gone: 0 }),
    });

    const makeSearchPage = () => `<html><body><form>
      <input type="hidden" id="__VIEWSTATE" value="vs1" />
      <input type="hidden" id="__VIEWSTATEGENERATOR" value="vsg1" />
      <input type="hidden" id="__EVENTVALIDATION" value="ev1" />
    </form></body></html>`;

    const makeResultPage = (total = 1, count = 1) => {
      const rows = Array.from({ length: count }, (_, i) => `<tr class='resultData${i % 2}'>
          <td></td>
          <td>
            <a href='ResultDetail.aspx?id=${i + 1}&amp;cnt=${total}&amp;typ=result'>I. ÚS ${i + 1}/24</a><br/>
            ECLI:CZ:US:2024:${i + 1}
          </td>
          <td></td>
          <td>15. 1. 2024</td>
        </tr>`).join('');

      return `<html><body>
        <input type="submit" name="ctl00$bResults" value="Nalezené (${total})" />
        <table>
          <tr class='resultDataHeader'><th>Sp.zn.</th></tr>
          ${rows}
        </table>
      </body></html>`;
    };

    const mkHeaders = (extras?: Record<string, string>) => ({
      get: (name: string) => extras?.[name.toLowerCase()] ?? null,
      getSetCookie: () => (extras?.['set-cookie'] ? [extras['set-cookie']] : []),
    });

    it('fetches search page with cookies and submits search form', async () => {
      const db = mockDb();

      const makeHeaders = (extras?: Record<string, string>) => {
        const h = new Headers();
        if (extras) {
          for (const [k, v] of Object.entries(extras)) h.set(k, v);
        }
        // Headers.getSetCookie() needs actual set-cookie headers
        return {
          get: (name: string) => extras?.[name.toLowerCase()] ?? null,
          getSetCookie: () => (extras?.['set-cookie'] ? [extras['set-cookie']] : []),
        };
      };

      // GET search page
      mockFetch
        .mockResolvedValueOnce({
          ok: true,
          status: 200,
          text: () => Promise.resolve(makeSearchPage()),
          headers: makeHeaders({ 'set-cookie': 'ASP.NET_SessionId=test123; path=/' }),
        })
        // POST form → 302 redirect
        .mockResolvedValueOnce({
          status: 302,
          text: () => Promise.resolve(''),
          headers: makeHeaders({ location: '/Search/Results.aspx' }),
        })
        // Follow redirect to results
        .mockResolvedValueOnce({
          ok: true,
          status: 200,
          text: () => Promise.resolve(makeResultPage()),
          headers: makeHeaders(),
        })
        // Subsequent years will fail gracefully (mock returns error page)
        .mockResolvedValue({
          ok: false,
          status: 500,
          text: () => Promise.resolve(''),
          headers: makeHeaders(),
        });

      await runDiscovery(
        db as any,
        { source: 'usoud', phase: 'discovery', concurrency: 1, delay: 0, maxRetries: 3, limit: 1, dbPath: '' },
        () => false,
      );

      expect(db.insertUrlBatch).toHaveBeenCalled();
      const inserted = db.insertUrlBatch.mock.calls[0][0];
      expect(inserted[0].source).toBe('usoud');
    });

    it('handles non-200 initial page status gracefully', async () => {
      const db = mockDb();
      mockFetch.mockResolvedValue({
        status: 500,
        text: () => Promise.resolve(''),
        headers: {
          get: () => null,
          getSetCookie: () => [],
        },
      });

      await runDiscovery(
        db as any,
        { source: 'usoud', phase: 'discovery', concurrency: 1, delay: 0, maxRetries: 3, limit: 1, dbPath: '' },
        () => false,
      );

      expect(db.insertUrlBatch).not.toHaveBeenCalled();
      expect(db.getUrlCounts).toHaveBeenCalledWith('usoud');
    });

    it('handles non-redirect failed search response', async () => {
      const db = mockDb();
      mockFetch
        .mockResolvedValueOnce({
          status: 200,
          text: () => Promise.resolve(makeSearchPage()),
          headers: {
            get: () => null,
            getSetCookie: () => ['ASP.NET_SessionId=test123; path=/'],
          },
        })
        .mockResolvedValueOnce({
          status: 503,
          text: () => Promise.resolve('error'),
          headers: {
            get: () => null,
            getSetCookie: () => [],
          },
        });

      await runDiscovery(
        db as any,
        { source: 'usoud', phase: 'discovery', concurrency: 1, delay: 0, maxRetries: 3, limit: 1, dbPath: '' },
        () => false,
      );

      expect(db.insertUrlBatch).not.toHaveBeenCalled();
    });

    it('handles zero-result searches', async () => {
      const db = mockDb();
      mockFetch
        .mockResolvedValueOnce({
          status: 200,
          text: () => Promise.resolve(makeSearchPage()),
          headers: {
            get: () => null,
            getSetCookie: () => ['ASP.NET_SessionId=test123; path=/'],
          },
        })
        .mockResolvedValueOnce({
          status: 302,
          text: () => Promise.resolve(''),
          headers: {
            get: (name: string) => (name.toLowerCase() === 'location' ? '/Search/Results.aspx' : null),
            getSetCookie: () => [],
          },
        })
        .mockResolvedValueOnce({
          status: 200,
          text: () => Promise.resolve('<html><body><input type="submit" name="ctl00$bResults" value="Nalezené (0)" /></body></html>'),
          headers: {
            get: () => null,
            getSetCookie: () => [],
          },
        });

      await runDiscovery(
        db as any,
        { source: 'usoud', phase: 'discovery', concurrency: 1, delay: 0, maxRetries: 3, limit: 1, dbPath: '' },
        () => false,
      );

      expect(db.insertUrlBatch).not.toHaveBeenCalled();
    });

    it('follows redirect on initial GET and stops pagination on non-200 page', async () => {
      const db = mockDb();
      mockFetch
        // Initial GET responds with redirect
        .mockResolvedValueOnce({
          status: 302,
          text: () => Promise.resolve(''),
          headers: {
            get: (name: string) => (name.toLowerCase() === 'location' ? '/Search/Search.aspx?restored=1' : null),
            getSetCookie: () => ['ASP.NET_SessionId=first123; path=/'],
          },
        })
        // Redirect target for GET
        .mockResolvedValueOnce({
          status: 200,
          text: () => Promise.resolve(makeSearchPage()),
          headers: {
            get: () => null,
            getSetCookie: () => ['ASP.NET_SessionId=final123; path=/'],
          },
        })
        // POST with redirect to results
        .mockResolvedValueOnce({
          status: 302,
          text: () => Promise.resolve(''),
          headers: {
            get: (name: string) => (name.toLowerCase() === 'location' ? '/Search/Results.aspx' : null),
            getSetCookie: () => [],
          },
        })
        // Redirect target after POST: first result page (10 urls, 3 pages total)
        .mockResolvedValueOnce({
          status: 200,
          text: () => Promise.resolve(makeResultPage(25, 10)),
          headers: {
            get: () => null,
            getSetCookie: () => [],
          },
        })
        // First paginated page fails and should break pagination
        .mockResolvedValueOnce({
          status: 500,
          text: () => Promise.resolve(''),
          headers: {
            get: () => null,
            getSetCookie: () => [],
          },
        });

      await runDiscovery(
        db as any,
        { source: 'usoud', phase: 'discovery', concurrency: 1, delay: 0, maxRetries: 3, limit: 25, dbPath: '' },
        () => false,
      );

      expect(db.insertUrlBatch).toHaveBeenCalledTimes(1);
      expect(db.insertUrlBatch.mock.calls[0][0]).toHaveLength(10);
    });

    it('breaks pagination when next page contains no result rows', async () => {
      const db = mockDb();
      mockFetch
        .mockResolvedValueOnce({
          status: 200,
          text: () => Promise.resolve(makeSearchPage()),
          headers: {
            get: () => null,
            getSetCookie: () => ['ASP.NET_SessionId=test123; path=/'],
          },
        })
        .mockResolvedValueOnce({
          status: 302,
          text: () => Promise.resolve(''),
          headers: {
            get: (name: string) => (name.toLowerCase() === 'location' ? '/Search/Results.aspx' : null),
            getSetCookie: () => [],
          },
        })
        .mockResolvedValueOnce({
          status: 200,
          text: () => Promise.resolve(makeResultPage(20, 10)),
          headers: {
            get: () => null,
            getSetCookie: () => [],
          },
        })
        .mockResolvedValueOnce({
          status: 200,
          text: () =>
            Promise.resolve(`<html><body>
              <input type="submit" name="ctl00$bResults" value="Nalezené (20)" />
              <table><tr class='resultDataHeader'><th>No rows</th></tr></table>
            </body></html>`),
          headers: {
            get: () => null,
            getSetCookie: () => [],
          },
        });

      await runDiscovery(
        db as any,
        { source: 'usoud', phase: 'discovery', concurrency: 1, delay: 0, maxRetries: 3, limit: 20, dbPath: '' },
        () => false,
      );

      expect(db.insertUrlBatch).toHaveBeenCalledTimes(1);
    });

    it('inserts paginated results across many pages and hits the 10th-page log path', async () => {
      const db = mockDb();

      mockFetch
        .mockResolvedValueOnce({
          status: 200,
          text: () => Promise.resolve(makeSearchPage()),
          headers: mkHeaders({ 'set-cookie': 'ASP.NET_SessionId=test123; path=/' }),
        })
        .mockResolvedValueOnce({
          status: 302,
          text: () => Promise.resolve(''),
          headers: mkHeaders({ location: '/Search/Results.aspx' }),
        })
        .mockResolvedValueOnce({
          status: 200,
          text: () => Promise.resolve(makeResultPage(110, 10)),
          headers: mkHeaders(),
        });

      for (let i = 0; i < 9; i++) {
        mockFetch.mockResolvedValueOnce({
          status: 200,
          text: () => Promise.resolve(makeResultPage(110, 1)),
          headers: mkHeaders(),
        });
      }

      await runDiscovery(
        db as any,
        { source: 'usoud', phase: 'discovery', concurrency: 1, delay: 0, maxRetries: 3, limit: 19, dbPath: '' },
        () => false,
      );

      expect(db.insertUrlBatch).toHaveBeenCalledTimes(10);
      expect(db.insertUrlBatch.mock.calls[0][0]).toHaveLength(10);
      expect(db.insertUrlBatch.mock.calls[1][0]).toHaveLength(1);
    });

    it('handles exceptions thrown while fetching paginated pages', async () => {
      const db = mockDb();
      mockFetch
        .mockResolvedValueOnce({
          status: 200,
          text: () => Promise.resolve(makeSearchPage()),
          headers: mkHeaders({ 'set-cookie': 'ASP.NET_SessionId=test123; path=/' }),
        })
        .mockResolvedValueOnce({
          status: 302,
          text: () => Promise.resolve(''),
          headers: mkHeaders({ location: '/Search/Results.aspx' }),
        })
        .mockResolvedValueOnce({
          status: 200,
          text: () => Promise.resolve(makeResultPage(20, 10)),
          headers: mkHeaders(),
        })
        .mockRejectedValueOnce(new Error('network exploded'));

      await runDiscovery(
        db as any,
        { source: 'usoud', phase: 'discovery', concurrency: 1, delay: 0, maxRetries: 3, limit: 20, dbPath: '' },
        () => false,
      );

      expect(db.insertUrlBatch).toHaveBeenCalledTimes(1);
    });

    it('stops on shutdown', async () => {
      const db = mockDb();

      await runDiscovery(
        db as any,
        { source: 'usoud', phase: 'discovery', concurrency: 1, delay: 0, maxRetries: 3, limit: 0, dbPath: '' },
        () => true,
      );

      expect(mockFetch).not.toHaveBeenCalled();
    });

    it('handles failed page loads gracefully', async () => {
      const db = mockDb();

      // GET search page fails for all years
      mockFetch.mockResolvedValue({
        ok: true,
        status: 200,
        text: () => Promise.resolve('<html><body></body></html>'), // No form tokens
        headers: {
          get: () => null,
          getSetCookie: () => [],
        },
      });

      await runDiscovery(
        db as any,
        { source: 'usoud', phase: 'discovery', concurrency: 1, delay: 0, maxRetries: 3, limit: 1, dbPath: '' },
        () => false,
      );

      // Should not throw, just skip years with missing tokens
      expect(db.insertUrlBatch).not.toHaveBeenCalled();
    });

    it('handles unexpected exceptions in per-range flow', async () => {
      const db = mockDb();
      mockFetch.mockRejectedValueOnce(new Error('initial fetch crashed'));

      await runDiscovery(
        db as any,
        { source: 'usoud', phase: 'discovery', concurrency: 1, delay: 0, maxRetries: 3, limit: 1, dbPath: '' },
        () => false,
      );

      expect(db.insertUrlBatch).not.toHaveBeenCalled();
      expect(db.getUrlCounts).toHaveBeenCalledWith('usoud');
    });

    it('handles absolute redirects on both GET and POST paths', async () => {
      const db = mockDb();

      mockFetch
        // Initial GET redirects with absolute location
        .mockResolvedValueOnce({
          status: 302,
          text: () => Promise.resolve(''),
          headers: mkHeaders({
            location: 'https://nalus.usoud.cz/Search/Search.aspx?absolute=1',
            'set-cookie': 'invalid-cookie-format',
          }),
        })
        // Followed GET returns search page
        .mockResolvedValueOnce({
          status: 200,
          text: () => Promise.resolve(makeSearchPage()),
          headers: mkHeaders({ 'set-cookie': 'ASP.NET_SessionId=ok123; path=/' }),
        })
        // POST redirects with absolute location
        .mockResolvedValueOnce({
          status: 302,
          text: () => Promise.resolve(''),
          headers: mkHeaders({ location: 'https://nalus.usoud.cz/Search/Results.aspx' }),
        })
        // Redirected results page
        .mockResolvedValueOnce({
          status: 200,
          text: () => Promise.resolve(makeResultPage(1, 1)),
          headers: mkHeaders(),
        });

      await runDiscovery(
        db as any,
        { source: 'usoud', phase: 'discovery', concurrency: 1, delay: 0, maxRetries: 3, limit: 1, dbPath: '' },
        () => false,
      );

      expect(db.insertUrlBatch).toHaveBeenCalledTimes(1);
      expect(mockFetch).toHaveBeenCalledTimes(4);
    });

    it('handles redirect responses without location headers gracefully', async () => {
      const db = mockDb();

      mockFetch
        // GET search page succeeds
        .mockResolvedValueOnce({
          status: 200,
          text: () => Promise.resolve(makeSearchPage()),
          headers: { get: () => null },
        })
        // POST reports redirect but without location; parser receives empty body
        .mockResolvedValueOnce({
          status: 302,
          text: () => Promise.resolve('<html><body>no results</body></html>'),
          headers: { get: () => null },
        });

      await runDiscovery(
        db as any,
        { source: 'usoud', phase: 'discovery', concurrency: 1, delay: 0, maxRetries: 3, limit: 1, dbPath: '' },
        () => false,
      );

      expect(db.insertUrlBatch).not.toHaveBeenCalled();
      expect(db.getUrlCounts).toHaveBeenCalledWith('usoud');
    });

    it('handles initial GET redirect without location header gracefully', async () => {
      const db = mockDb();

      mockFetch.mockResolvedValueOnce({
        status: 302,
        text: () => Promise.resolve(''),
        headers: {
          get: () => null,
          getSetCookie: () => [],
        },
      });

      await runDiscovery(
        db as any,
        { source: 'usoud', phase: 'discovery', concurrency: 1, delay: 0, maxRetries: 3, limit: 1, dbPath: '' },
        () => false,
      );

      expect(db.insertUrlBatch).not.toHaveBeenCalled();
      expect(db.getUrlCounts).toHaveBeenCalledWith('usoud');
    });

    it('stops before next range when limit is reached', async () => {
      const db = mockDb();
      vi.mocked(generateYearRanges).mockReturnValue([
        { label: '2024', from: '01.01.2024', to: '31.12.2024' },
        { label: '2023', from: '01.01.2023', to: '31.12.2023' },
      ] as any);

      mockFetch
        .mockResolvedValueOnce({
          status: 200,
          text: () => Promise.resolve(makeSearchPage()),
          headers: mkHeaders({ 'set-cookie': 'ASP.NET_SessionId=test123; path=/' }),
        })
        .mockResolvedValueOnce({
          status: 302,
          text: () => Promise.resolve(''),
          headers: mkHeaders({ location: '/Search/Results.aspx' }),
        })
        .mockResolvedValueOnce({
          status: 200,
          text: () => Promise.resolve(makeResultPage(1, 1)),
          headers: mkHeaders(),
        });

      await runDiscovery(
        db as any,
        { source: 'usoud', phase: 'discovery', concurrency: 1, delay: 0, maxRetries: 3, limit: 1, dbPath: '' },
        () => false,
      );

      // Only first range should execute
      expect(mockFetch).toHaveBeenCalledTimes(3);
      expect(db.insertUrlBatch).toHaveBeenCalledTimes(1);
    });

    it('stops pagination immediately when page limit is already reached after first page', async () => {
      const db = mockDb();

      mockFetch
        .mockResolvedValueOnce({
          status: 200,
          text: () => Promise.resolve(makeSearchPage()),
          headers: mkHeaders({ 'set-cookie': 'ASP.NET_SessionId=test123; path=/' }),
        })
        .mockResolvedValueOnce({
          status: 302,
          text: () => Promise.resolve(''),
          headers: mkHeaders({ location: '/Search/Results.aspx' }),
        })
        .mockResolvedValueOnce({
          status: 200,
          text: () => Promise.resolve(makeResultPage(20, 1)),
          headers: mkHeaders(),
        });

      await runDiscovery(
        db as any,
        { source: 'usoud', phase: 'discovery', concurrency: 1, delay: 0, maxRetries: 3, limit: 1, dbPath: '' },
        () => false,
      );

      // No extra page fetch expected because discovered >= limit before page loop body
      expect(mockFetch).toHaveBeenCalledTimes(3);
      expect(db.insertUrlBatch).toHaveBeenCalledTimes(1);
    });

    it('stops pagination when shutdown is requested before fetching next results page', async () => {
      const db = mockDb();

      mockFetch
        .mockResolvedValueOnce({
          status: 200,
          text: () => Promise.resolve(makeSearchPage()),
          headers: mkHeaders({ 'set-cookie': 'ASP.NET_SessionId=test123; path=/' }),
        })
        .mockResolvedValueOnce({
          status: 302,
          text: () => Promise.resolve(''),
          headers: mkHeaders({ location: '/Search/Results.aspx' }),
        })
        .mockResolvedValueOnce({
          status: 200,
          text: () => Promise.resolve(makeResultPage(20, 10)),
          headers: mkHeaders(),
        });

      let checks = 0;
      const shutdownOnPaginationStart = () => {
        checks += 1;
        return checks >= 2;
      };

      await runDiscovery(
        db as any,
        { source: 'usoud', phase: 'discovery', concurrency: 1, delay: 0, maxRetries: 3, limit: 20, dbPath: '' },
        shutdownOnPaginationStart,
      );

      expect(mockFetch).toHaveBeenCalledTimes(3);
      expect(db.insertUrlBatch).toHaveBeenCalledTimes(1);
    });
  });
});
