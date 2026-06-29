import * as cheerio from 'cheerio';
import { generateYearRanges } from '../../utils.js';
import { parseResultRows, runDiscovery } from './discovery.js';

vi.mock('../../utils.js', () => ({
  generateYearRanges: vi.fn(() => [{ label: '2024', from: '01.01.2024', to: '31.12.2024' }]),
}));

const mockFetch = vi.fn();
vi.stubGlobal('fetch', mockFetch);

describe('nssoud discovery', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(generateYearRanges).mockReturnValue([{ label: '2024', from: '01.01.2024', to: '31.12.2024' }] as any);
  });

  describe('parseResultRows', () => {
    it('parses result table rows with document links', () => {
      const html = `<table>
        <tr>
          <td>1</td>
          <td><input name="ZobrazeneVysledky[0].ID" type="hidden" value="718182"></td>
          <td>31.01.2024</td>
          <td>1\u00a0As\u00a0262/2023\u00a0-\u00a019</td>
          <td>senát NSS</td>
          <td>Usnesení</td>
          <td>odmítnuto</td>
          <td>&nbsp;</td>
          <td>&nbsp;</td>
          <td>test</td>
          <td>
            <a href="/DokumentOriginal/Index/718182">PDF</a>
            <a href="/DokumentOriginal/Text/718182">Text</a>
          </td>
        </tr>
        <tr>
          <td>2</td>
          <td><input name="ZobrazeneVysledky[1].ID" type="hidden" value="718340"></td>
          <td>31.01.2024</td>
          <td>2\u00a0Afs\u00a095/2023</td>
          <td>senát NSS</td>
          <td>Rozsudek</td>
          <td>zamítnuto</td>
          <td>&nbsp;</td>
          <td>&nbsp;</td>
          <td>test</td>
          <td><a href="/DokumentOriginal/Index/718340">PDF</a></td>
        </tr>
      </table>`;

      const urls = parseResultRows(html);
      expect(urls).toHaveLength(2);
      expect(urls[0].source).toBe('nssoud');
      expect(urls[0].external_id).toBe('718182');
      expect(urls[0].soud).toBe('Nejvyšší správní soud');
      expect(urls[0].url).toContain('/DokumentOriginal/Text/718182');
      expect(urls[0].datum_vydani).toBe('31.01.2024');
      expect(urls[0].jednaci_cislo).toBe('1 As 262/2023');
      expect(urls[1].external_id).toBe('718340');
    });

    it('handles absolute URLs', () => {
      const html = `<table><tr>
        <td></td><td></td><td></td><td></td>
        <td><a href="https://vyhledavac.nssoud.cz/DokumentOriginal/Index/999">Detail</a></td>
      </tr></table>`;

      const urls = parseResultRows(html);
      expect(urls).toHaveLength(1);
      expect(urls[0].url).toBe('https://vyhledavac.nssoud.cz/DokumentOriginal/Text/999');
    });

    it('returns empty for no matching links', () => {
      const html = `<table><tr><td>No links here</td></tr></table>`;
      expect(parseResultRows(html)).toHaveLength(0);
    });

    it('returns empty for empty HTML', () => {
      expect(parseResultRows('')).toHaveLength(0);
    });

    it('skips header rows', () => {
      const html = `<table>
        <tr><th>Date</th><th>Case</th></tr>
        <tr><td>2024</td><td><a href="/DokumentOriginal/Index/1">D</a></td></tr>
      </table>`;
      expect(parseResultRows(html)).toHaveLength(1);
    });

    it('handles rows without hidden ID and without parseable document ID', () => {
      const html = `<table>
        <tr>
          <td>1</td>
          <td></td>
          <td></td>
          <td></td>
          <td><a href="/DokumentOriginal/Custom/abc">Custom link</a></td>
        </tr>
      </table>`;

      const urls = parseResultRows(html);
      expect(urls).toHaveLength(1);
      expect(urls[0].url).toBe('https://vyhledavac.nssoud.cz/DokumentOriginal/Custom/abc');
      expect(urls[0].external_id).toBeUndefined();
      expect(urls[0].datum_vydani).toBeUndefined();
      expect(urls[0].jednaci_cislo).toBeUndefined();
    });

    it('handles defensive fallback when cheerio attr() returns undefined for href', () => {
      const html = `<table>
        <tr>
          <td>1</td>
          <td><input name="ZobrazeneVysledky[0].ID" type="hidden" value="1"></td>
          <td>01.01.2024</td>
          <td>1 As 1/2024</td>
          <td><a href="/DokumentOriginal/Index/1">PDF</a></td>
        </tr>
      </table>`;

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
        const urls = parseResultRows(html);
        expect(urls).toHaveLength(1);
        expect(urls[0].url).toBe('https://vyhledavac.nssoud.cz');
      } finally {
        attrSpy.mockRestore();
      }
    });

  });

  describe('runDiscovery', () => {
    const mockDb = () => ({
      insertUrlBatch: vi.fn(),
      getUrlCounts: vi.fn().mockReturnValue({ total: 5, pending: 5, scraped: 0, failed: 0, gone: 0 }),
    });

    const makeFormPage = () => `<html><body>
      <form id="findform" method="post">
        <input name="vyhledavaciSekce[1].vyhledavaciPodminka[0].vyhledavaciPodminkaHodnota[0].HodnotaDatumACasOd" type="text" value="" />
        <input name="vyhledavaciSekce[1].vyhledavaciPodminka[0].vyhledavaciPodminkaHodnota[0].HodnotaDatumACasDo" type="text" value="" />
        <input name="__RequestVerificationToken" type="hidden" value="token123" />
      </form>
    </body></html>`;

    const makeResultPage = (count: number) => {
      const rows = Array.from(
        { length: count },
        (_, i) => `<tr>
        <td>${i + 1}</td>
        <td><input name="ZobrazeneVysledky[${i}].ID" type="hidden" value="${1000 + i}"></td>
        <td>01.01.2024</td>
        <td>1 As ${i}/2024</td>
        <td><a href="/DokumentOriginal/Index/${1000 + i}">PDF</a></td>
      </tr>`,
      ).join('');

      return `<html><body>
        <table class="infinite-scroll">${rows}</table>
        <script>var currParams = '[]'; var currViewId = '1'; var currSort = '';</script>
      </body></html>`;
    };

    const makeHeaders = (cookies: string[] = []) => ({
      getSetCookie: () => cookies,
      get: () => null,
    });

    it('fetches form page, submits with dates, and discovers URLs', async () => {
      const db = mockDb();

      // GET form page
      mockFetch
        .mockResolvedValueOnce({
          ok: true,
          status: 200,
          text: () => Promise.resolve(makeFormPage()),
          headers: { getSetCookie: () => ['session=abc'] },
        })
        // POST form with dates → results
        .mockResolvedValueOnce({
          ok: true,
          status: 200,
          text: () => Promise.resolve(makeResultPage(5)),
          headers: { getSetCookie: () => [] },
        });

      await runDiscovery(
        db as any,
        { source: 'nssoud', phase: 'discovery', concurrency: 1, delay: 0, maxRetries: 3, limit: 5, dbPath: '' },
        () => false,
      );

      expect(db.insertUrlBatch).toHaveBeenCalled();
      const inserted = db.insertUrlBatch.mock.calls[0][0];
      expect(inserted[0].source).toBe('nssoud');
    });

    it('serializes form inputs and paginates additional pages', async () => {
      const db = mockDb();

      const formHtml = `<html><body>
        <input name="__RequestVerificationToken" type="hidden" value="outside-token" />
        <form id="findform" method="post">
          <input name="noTypeInput" />
          <input type="submit" name="submitButton" value="skip" />
          <input type="checkbox" name="checkedFlag" value="yes" checked />
          <input type="checkbox" name="uncheckedFlag" value="no" />
          <input type="radio" name="checkedRadio" value="r1" checked />
          <input type="radio" name="uncheckedRadio" value="r2" />
          <input value="missingName" />
          <input name="vyhledavaciSekce[1].vyhledavaciPodminka[0].vyhledavaciPodminkaHodnota[0].HodnotaDatumACasOd" type="text" value="" />
          <input name="vyhledavaciSekce[1].vyhledavaciPodminka[0].vyhledavaciPodminkaHodnota[0].HodnotaDatumACasDo" type="text" value="" />
        </form>
      </body></html>`;

      const resultRows = Array.from({ length: 20 }, (_, i) => `<tr>
        <td>${i + 1}</td>
        <td><input name="ZobrazeneVysledky[${i}].ID" type="hidden" value="${7000 + i}" /></td>
        <td>02.01.2024</td>
        <td>2 As ${i}/2024</td>
        <td><a href="/DokumentOriginal/Index/${7000 + i}">PDF</a></td>
      </tr>`).join('');

      const initialResults = `<html><body>
        <table class="infinite-scroll">${resultRows}</table>
        <script>var currParams = '[{"x":1}]'; var currViewId = 'v1'; var currSort = 'date';</script>
      </body></html>`;

      const moreRows = `<table>
        <tr>
          <td>1</td>
          <td><input name="ZobrazeneVysledky[0].ID" type="hidden" value="9001" /></td>
          <td>03.01.2024</td>
          <td>3 As 1/2024</td>
          <td><a href="/DokumentOriginal/Index/9001">PDF</a></td>
        </tr>
      </table>`;

      mockFetch
        .mockResolvedValueOnce({
          ok: true,
          status: 200,
          text: () => Promise.resolve(formHtml),
          headers: makeHeaders(['session=abc; path=/']),
        })
        .mockResolvedValueOnce({
          ok: true,
          status: 200,
          text: () => Promise.resolve(initialResults),
          headers: makeHeaders(['search=s1; path=/']),
        })
        .mockResolvedValueOnce({
          ok: true,
          status: 200,
          text: () => Promise.resolve(moreRows),
          headers: makeHeaders(),
        })
        .mockResolvedValueOnce({
          ok: true,
          status: 200,
          text: () => Promise.resolve('    '),
          headers: makeHeaders(),
        });

      await runDiscovery(
        db as any,
        { source: 'nssoud', phase: 'discovery', concurrency: 1, delay: 0, maxRetries: 3, limit: 25, dbPath: '' },
        () => false,
      );

      expect(mockFetch).toHaveBeenCalledTimes(4);
      const postBody = mockFetch.mock.calls[1][1].body as string;
      expect(postBody).toContain('__RequestVerificationToken=outside-token');
      expect(postBody).toContain('checkedFlag=yes');
      expect(postBody).not.toContain('uncheckedFlag=no');
      expect(postBody).toContain('HodnotaDatumACasOd=01.01.2024');
      expect(postBody).toContain('HodnotaDatumACasDo=31.12.2024');
      expect(db.insertUrlBatch).toHaveBeenCalledTimes(2);
      expect(db.insertUrlBatch.mock.calls[1][0]).toHaveLength(1);
    });

    it('handles search submission failures without throwing', async () => {
      const db = mockDb();
      mockFetch
        .mockResolvedValueOnce({
          ok: true,
          status: 200,
          text: () => Promise.resolve('<html><body><form id="findform"></form></body></html>'),
          headers: {},
        })
        .mockResolvedValueOnce({
          ok: false,
          status: 503,
          text: () => Promise.resolve(''),
          headers: makeHeaders(),
        });

      await runDiscovery(
        db as any,
        { source: 'nssoud', phase: 'discovery', concurrency: 1, delay: 0, maxRetries: 3, limit: 1, dbPath: '' },
        () => false,
      );

      expect(db.insertUrlBatch).not.toHaveBeenCalled();
    });

    it('handles successful search with zero parsed rows and missing pagination variables', async () => {
      const db = mockDb();
      mockFetch
        .mockResolvedValueOnce({
          ok: true,
          status: 200,
          text: () => Promise.resolve(`<html><body><form id="findform">
            <input name="vyhledavaciSekce[1].vyhledavaciPodminka[0].vyhledavaciPodminkaHodnota[0].HodnotaDatumACasOd" />
            <input name="vyhledavaciSekce[1].vyhledavaciPodminka[0].vyhledavaciPodminkaHodnota[0].HodnotaDatumACasDo" />
          </form></body></html>`),
          headers: makeHeaders(),
        })
        .mockResolvedValueOnce({
          ok: true,
          status: 200,
          text: () => Promise.resolve('<html><body><table class="infinite-scroll"></table></body></html>'),
          headers: makeHeaders(),
        });

      await runDiscovery(
        db as any,
        { source: 'nssoud', phase: 'discovery', concurrency: 1, delay: 0, maxRetries: 3, limit: 1, dbPath: '' },
        () => false,
      );

      expect(db.insertUrlBatch).not.toHaveBeenCalled();
    });

    it('skips infinite-scroll fetches when limit is reached after initial insert', async () => {
      const db = mockDb();
      const rows = Array.from({ length: 20 }, (_, i) => `<tr>
          <td>${i + 1}</td>
          <td><input name="ZobrazeneVysledky[${i}].ID" type="hidden" value="${5000 + i}" /></td>
          <td>01.01.2024</td>
          <td>1 As ${i}/2024</td>
          <td><a href="/DokumentOriginal/Index/${5000 + i}">PDF</a></td>
        </tr>`).join('');

      mockFetch
        .mockResolvedValueOnce({
          ok: true,
          status: 200,
          text: () => Promise.resolve(`<html><body><form id="findform">
            <input name="vyhledavaciSekce[1].vyhledavaciPodminka[0].vyhledavaciPodminkaHodnota[0].HodnotaDatumACasOd" />
            <input name="vyhledavaciSekce[1].vyhledavaciPodminka[0].vyhledavaciPodminkaHodnota[0].HodnotaDatumACasDo" />
          </form></body></html>`),
          headers: makeHeaders(['session=abc; path=/']),
        })
        .mockResolvedValueOnce({
          ok: true,
          status: 200,
          text: () =>
            Promise.resolve(`<html><body>
              <table class="infinite-scroll">${rows}</table>
              <script>var currParams = '[1]';</script>
            </body></html>`),
          headers: {},
        });

      await runDiscovery(
        db as any,
        { source: 'nssoud', phase: 'discovery', concurrency: 1, delay: 0, maxRetries: 3, limit: 20, dbPath: '' },
        () => false,
      );

      expect(mockFetch).toHaveBeenCalledTimes(2);
      expect(db.insertUrlBatch).toHaveBeenCalledTimes(1);
    });

    it('handles missing search form gracefully', async () => {
      const db = mockDb();
      mockFetch.mockResolvedValue({
        ok: true,
        status: 200,
        text: () => Promise.resolve('<html><body><div>No form here</div></body></html>'),
        headers: makeHeaders(),
      });

      await runDiscovery(
        db as any,
        { source: 'nssoud', phase: 'discovery', concurrency: 1, delay: 0, maxRetries: 3, limit: 1, dbPath: '' },
        () => false,
      );

      expect(db.insertUrlBatch).not.toHaveBeenCalled();
      expect(db.getUrlCounts).toHaveBeenCalledWith('nssoud');
    });

    it('stops infinite scroll when additional fetch returns non-OK status', async () => {
      const db = mockDb();
      const rows = Array.from({ length: 20 }, (_, i) => `<tr>
          <td>${i + 1}</td>
          <td><input name="ZobrazeneVysledky[${i}].ID" type="hidden" value="${2000 + i}"></td>
          <td>01.01.2024</td>
          <td>1 As ${i}/2024</td>
          <td><a href="/DokumentOriginal/Index/${2000 + i}">PDF</a></td>
        </tr>`).join('');

      mockFetch
        .mockResolvedValueOnce({
          ok: true,
          status: 200,
          text: () => Promise.resolve(`<html><body><form id="findform">
            <input name="vyhledavaciSekce[1].vyhledavaciPodminka[0].vyhledavaciPodminkaHodnota[0].HodnotaDatumACasOd" />
            <input name="vyhledavaciSekce[1].vyhledavaciPodminka[0].vyhledavaciPodminkaHodnota[0].HodnotaDatumACasDo" />
          </form></body></html>`),
          headers: makeHeaders(),
        })
        .mockResolvedValueOnce({
          ok: true,
          status: 200,
          text: () =>
            Promise.resolve(`<html><body>
              <table class="infinite-scroll">${rows}</table>
              <script>var currParams = '[1]'; var currViewId = '1'; var currSort = '';</script>
            </body></html>`),
          headers: makeHeaders(),
        })
        .mockResolvedValueOnce({
          ok: false,
          status: 500,
          text: () => Promise.resolve(''),
          headers: makeHeaders(),
        });

      await runDiscovery(
        db as any,
        { source: 'nssoud', phase: 'discovery', concurrency: 1, delay: 0, maxRetries: 3, limit: 21, dbPath: '' },
        () => false,
      );

      expect(db.insertUrlBatch).toHaveBeenCalledTimes(1);
    });

    it('logs page milestones and stops when a loaded page has no parsable rows', async () => {
      const db = mockDb();
      const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
      const rows = Array.from({ length: 20 }, (_, i) => `<tr>
          <td>${i + 1}</td>
          <td><input name="ZobrazeneVysledky[${i}].ID" type="hidden" value="${3000 + i}"></td>
          <td>01.01.2024</td>
          <td>1 As ${i}/2024</td>
          <td><a href="/DokumentOriginal/Index/${3000 + i}">PDF</a></td>
        </tr>`).join('');
      const oneRow = `<table><tr>
        <td>1</td>
        <td><input name="ZobrazeneVysledky[0].ID" type="hidden" value="9999"></td>
        <td>02.01.2024</td>
        <td>2 As 1/2024</td>
        <td><a href="/DokumentOriginal/Index/9999">PDF</a></td>
      </tr></table>`;

      try {
        mockFetch
          .mockResolvedValueOnce({
            ok: true,
            status: 200,
            text: () => Promise.resolve(`<html><body><form id="findform">
              <input name="vyhledavaciSekce[1].vyhledavaciPodminka[0].vyhledavaciPodminkaHodnota[0].HodnotaDatumACasOd" />
              <input name="vyhledavaciSekce[1].vyhledavaciPodminka[0].vyhledavaciPodminkaHodnota[0].HodnotaDatumACasDo" />
            </form></body></html>`),
            headers: makeHeaders(),
          })
          .mockResolvedValueOnce({
            ok: true,
            status: 200,
            text: () =>
              Promise.resolve(`<html><body>
                <table class="infinite-scroll">${rows}</table>
                <script>var currParams = '[1]'; var currViewId = '1'; var currSort = '';</script>
              </body></html>`),
            headers: makeHeaders(),
          })
          .mockResolvedValueOnce({ ok: true, status: 200, text: () => Promise.resolve(oneRow), headers: makeHeaders() })
          .mockResolvedValueOnce({ ok: true, status: 200, text: () => Promise.resolve(oneRow), headers: makeHeaders() })
          .mockResolvedValueOnce({ ok: true, status: 200, text: () => Promise.resolve(oneRow), headers: makeHeaders() })
          .mockResolvedValueOnce({ ok: true, status: 200, text: () => Promise.resolve(oneRow), headers: makeHeaders() })
          .mockResolvedValueOnce({
            ok: true,
            status: 200,
            text: () => Promise.resolve('<table><tr><th>no rows</th></tr></table>'),
            headers: makeHeaders(),
          });

        await runDiscovery(
          db as any,
          { source: 'nssoud', phase: 'discovery', concurrency: 1, delay: 0, maxRetries: 3, limit: 100, dbPath: '' },
          () => false,
        );

        expect(db.insertUrlBatch).toHaveBeenCalledTimes(5);
        expect(logSpy.mock.calls.some(([msg]) => typeof msg === 'string' && msg.includes('page 5'))).toBe(true);
      } finally {
        logSpy.mockRestore();
      }
    });

    it('handles load-more fetch exceptions without crashing the run', async () => {
      const db = mockDb();
      const rows = Array.from({ length: 20 }, (_, i) => `<tr>
          <td>${i + 1}</td>
          <td><input name="ZobrazeneVysledky[${i}].ID" type="hidden" value="${4000 + i}"></td>
          <td>01.01.2024</td>
          <td>1 As ${i}/2024</td>
          <td><a href="/DokumentOriginal/Index/${4000 + i}">PDF</a></td>
        </tr>`).join('');

      mockFetch
        .mockResolvedValueOnce({
          ok: true,
          status: 200,
          text: () => Promise.resolve(`<html><body><form id="findform">
            <input name="vyhledavaciSekce[1].vyhledavaciPodminka[0].vyhledavaciPodminkaHodnota[0].HodnotaDatumACasOd" />
            <input name="vyhledavaciSekce[1].vyhledavaciPodminka[0].vyhledavaciPodminkaHodnota[0].HodnotaDatumACasDo" />
          </form></body></html>`),
          headers: makeHeaders(),
        })
        .mockResolvedValueOnce({
          ok: true,
          status: 200,
          text: () =>
            Promise.resolve(`<html><body>
              <table class="infinite-scroll">${rows}</table>
              <script>var currParams = '[1]'; var currViewId = '1'; var currSort = '';</script>
            </body></html>`),
          headers: makeHeaders(),
        })
        .mockRejectedValueOnce(new Error('load-more exploded'));

      await runDiscovery(
        db as any,
        { source: 'nssoud', phase: 'discovery', concurrency: 1, delay: 0, maxRetries: 3, limit: 100, dbPath: '' },
        () => false,
      );

      expect(db.insertUrlBatch).toHaveBeenCalledTimes(1);
      expect(db.getUrlCounts).toHaveBeenCalledWith('nssoud');
    });

    it('handles unexpected exceptions in per-range flow', async () => {
      const db = mockDb();
      mockFetch.mockRejectedValueOnce(new Error('initial GET failed'));

      await runDiscovery(
        db as any,
        { source: 'nssoud', phase: 'discovery', concurrency: 1, delay: 0, maxRetries: 3, limit: 1, dbPath: '' },
        () => false,
      );

      expect(db.insertUrlBatch).not.toHaveBeenCalled();
      expect(db.getUrlCounts).toHaveBeenCalledWith('nssoud');
    });

    it('handles page load errors gracefully', async () => {
      const db = mockDb();
      mockFetch.mockResolvedValue({
        ok: false,
        status: 500,
        text: () => Promise.resolve(''),
        headers: { getSetCookie: () => [] },
      });

      await runDiscovery(
        db as any,
        { source: 'nssoud', phase: 'discovery', concurrency: 1, delay: 0, maxRetries: 3, limit: 1, dbPath: '' },
        () => false,
      );

      // Should not throw, just log errors
      expect(db.getUrlCounts).toHaveBeenCalled();
    });

    it('stops on shutdown', async () => {
      const db = mockDb();

      await runDiscovery(
        db as any,
        { source: 'nssoud', phase: 'discovery', concurrency: 1, delay: 0, maxRetries: 3, limit: 0, dbPath: '' },
        () => true,
      );

      expect(mockFetch).not.toHaveBeenCalled();
    });

    it('respects limit', async () => {
      const db = mockDb();

      mockFetch
        .mockResolvedValueOnce({
          ok: true,
          status: 200,
          text: () => Promise.resolve(makeFormPage()),
          headers: { getSetCookie: () => [] },
        })
        .mockResolvedValueOnce({
          ok: true,
          status: 200,
          text: () => Promise.resolve(makeResultPage(30)),
          headers: { getSetCookie: () => [] },
        });

      await runDiscovery(
        db as any,
        { source: 'nssoud', phase: 'discovery', concurrency: 1, delay: 0, maxRetries: 3, limit: 10, dbPath: '' },
        () => false,
      );

      expect(db.insertUrlBatch).toHaveBeenCalled();
    });

    it('stops before processing next range when global limit was reached', async () => {
      const db = mockDb();
      vi.mocked(generateYearRanges).mockReturnValue([
        { label: '2024', from: '01.01.2024', to: '31.12.2024' },
        { label: '2023', from: '01.01.2023', to: '31.12.2023' },
      ] as any);

      mockFetch
        .mockResolvedValueOnce({
          ok: true,
          status: 200,
          text: () => Promise.resolve(makeFormPage()),
          headers: { getSetCookie: () => [] },
        })
        .mockResolvedValueOnce({
          ok: true,
          status: 200,
          text: () => Promise.resolve(makeResultPage(1)),
          headers: { getSetCookie: () => [] },
        });

      await runDiscovery(
        db as any,
        { source: 'nssoud', phase: 'discovery', concurrency: 1, delay: 0, maxRetries: 3, limit: 1, dbPath: '' },
        () => false,
      );

      expect(mockFetch).toHaveBeenCalledTimes(2);
      expect(db.insertUrlBatch).toHaveBeenCalledTimes(1);
    });
  });
});
