import * as cheerio from 'cheerio';
import { parseDetailPage, runDetail } from './scraper.js';

vi.mock('../../../../lib/fetch.js', async (importOriginal) => {
  const actual = (await importOriginal()) as Record<string, unknown>;
  return { ...actual, fetchPage: vi.fn() };
});

/**
 * NSSoud /DokumentOriginal/Text/ pages are flat HTML with only <br/> tags.
 * This helper builds realistic test HTML matching the actual page structure.
 */
const makeHtml = (
  opts: {
    title?: string;
    caseRef?: string;
    typ?: string;
    body?: string;
  } = {},
) => {
  const title = opts.title ?? '1 As 100/2024- 50 - text';
  const caseRef = opts.caseRef ?? '1 As 100/2024 - 50';
  const typ = opts.typ ?? 'ROZSUDEK';
  const body =
    opts.body ??
    [
      `${caseRef}<br/>`,
      'pokračování<br/>',
      '<br/>',
      '[OBRÁZEK]<br/>',
      'ČESKÁ REPUBLIKA<br/>',
      `${typ}<br/>`,
      'JMÉNEM REPUBLIKY<br/>',
      '<br/>',
      'Nejvyšší správní soud rozhodl...<br/>',
      '<br/>',
      'takto:<br/>',
      '<br/>',
      'I. Kasační stížnost se zamítá.<br/>',
      '<br/>',
      'Odůvodnění:<br/>',
      '<br/>',
      'Soud posoudil věc takto...<br/>',
    ].join('\n');

  return `<html><head><title>${title}</title></head><body>\n${body}\n</body></html>`;
};

describe('nssoud scraper', () => {
  describe('parseDetailPage', () => {
    it('extracts metadata from flat text', () => {
      const html = makeHtml();
      const result = parseDetailPage(html, 'https://vyhledavac.nssoud.cz/DokumentOriginal/Text/12345');
      expect(result.source).toBe('nssoud');
      expect(result.soud).toBe('Nejvyšší správní soud');
      expect(result.external_id).toBe('12345');
      expect(result.spisova_znacka).toBe('1 As 100/2024 - 50');
      expect(result.jednaci_cislo).toBe('1 As 100/2024- 50');
      expect(result.typ_rozhodnuti).toBe('Rozsudek');
    });

    it('extracts výrok and odůvodnění from takto:/Odůvodnění: markers', () => {
      const html = makeHtml();
      const result = parseDetailPage(html, 'https://vyhledavac.nssoud.cz/DokumentOriginal/Text/100');
      expect(result.vyrok).toContain('Kasační stížnost se zamítá.');
      expect(result.oduvodneni).toContain('Soud posoudil věc takto...');
    });

    it('extracts ECLI from page text', () => {
      const html = makeHtml({
        body: 'ECLI:CZ:NSS:2024:1.AS.100.2024<br/>Some text...',
      });
      const result = parseDetailPage(html, 'https://vyhledavac.nssoud.cz/DokumentOriginal/Text/100');
      expect(result.ecli).toBe('ECLI:CZ:NSS:2024:1.AS.100.2024');
    });

    it('handles usnesení type', () => {
      const html = makeHtml({ typ: 'USNESENÍ' });
      const result = parseDetailPage(html, 'https://vyhledavac.nssoud.cz/DokumentOriginal/Text/100');
      expect(result.typ_rozhodnuti).toBe('Usnesení');
    });

    it('falls back to full body when no markers', () => {
      const html = makeHtml({
        body: 'Full decision text without section markers.',
      });
      const result = parseDetailPage(html, 'https://vyhledavac.nssoud.cz/DokumentOriginal/Text/100');
      expect(result.oduvodneni).toBe('Full decision text without section markers.');
    });

    it('handles missing fields gracefully', () => {
      const html = '<html><head><title>Empty</title></head><body></body></html>';
      const result = parseDetailPage(html, 'https://vyhledavac.nssoud.cz/DokumentOriginal/Text/100');
      expect(result.source).toBe('nssoud');
      expect(result.soud).toBe('Nejvyšší správní soud');
      expect(result.external_id).toBe('100');
    });

    it('stores raw JSON', () => {
      const html = makeHtml({ title: '1 As 1/2024- 10 - text' });
      const result = parseDetailPage(html, 'https://vyhledavac.nssoud.cz/DokumentOriginal/Text/100');
      expect(result.raw_json).toBeDefined();
      const raw = JSON.parse(result.raw_json!);
      expect(raw.title).toBe('1 As 1/2024- 10 - text');
    });

    it('extracts fallback ID from /rozhodnuti/ URL and derives spisova from jednaci_cislo', () => {
      const html = makeHtml({
        title: '4 As 211/2025- 27 - text',
        body: [
          'As 211/2025-29<br/>',
          'ČESKÁ REPUBLIKA<br/>',
          'ROZSUDEK<br/>',
          'JMÉNEM REPUBLIKY<br/>',
        ].join('\n'),
      });
      const result = parseDetailPage(html, 'https://vyhledavac.nssoud.cz/rozhodnuti/abc123');

      expect(result.external_id).toBe('abc123');
      expect(result.jednaci_cislo).toBe('4 As 211/2025- 27');
      expect(result.spisova_znacka).toBe('4 As 211/2025');
    });

    it('falls back to decision type detection in first lines', () => {
      const html = makeHtml({
        body: [
          '1 As 100/2024 - 50<br/>',
          'ČESKÁ REPUBLIKA<br/>',
          'ROZHODNUTÍ<br/>',
          'JMÉNEM REPUBLIKY<br/>',
          'R O Z S U D E K<br/>',
        ].join('\n'),
      });

      const result = parseDetailPage(html, 'https://vyhledavac.nssoud.cz/DokumentOriginal/Text/200');
      expect(result.typ_rozhodnuti).toBe('Rozsudek');
    });

    it('handles takto marker without odůvodnění marker', () => {
      const html = makeHtml({
        body: [
          '1 As 100/2024 - 50<br/>',
          'takto:<br/>',
          'I. Žaloba se zamítá.<br/>',
        ].join('\n'),
      });
      const result = parseDetailPage(html, 'https://vyhledavac.nssoud.cz/DokumentOriginal/Text/201');
      expect(result.vyrok).toContain('Žaloba se zamítá');
      expect(result.oduvodneni).toBeUndefined();
    });

    it('handles odůvodnění marker without takto marker', () => {
      const html = makeHtml({
        body: [
          '1 As 100/2024 - 50<br/>',
          'Odůvodnění:<br/>',
          'Důvody rozhodnutí.<br/>',
        ].join('\n'),
      });
      const result = parseDetailPage(html, 'https://vyhledavac.nssoud.cz/DokumentOriginal/Text/202');
      expect(result.vyrok).toBeUndefined();
      expect(result.oduvodneni).toContain('Důvody rozhodnutí');
    });

    it('keeps spisova_znacka undefined when first line is non-case text and title has no case number', () => {
      const html = makeHtml({
        title: 'Rozhodnutí NSS',
        body: [
          'Úvodní text bez spisové značky<br/>',
          'ROZSUDEK<br/>',
          'JMÉNEM REPUBLIKY<br/>',
        ].join('\n'),
      });
      const result = parseDetailPage(html, 'https://vyhledavac.nssoud.cz/DokumentOriginal/Text/777');

      expect(result.jednaci_cislo).toBeUndefined();
      expect(result.spisova_znacka).toBeUndefined();
      expect(result.typ_rozhodnuti).toBe('Rozsudek');
    });

    it('handles defensive fallback when cheerio body html is unavailable', () => {
      const proto = Object.getPrototypeOf(
        Object.getPrototypeOf(cheerio.load('<body>x</body>')('body')),
      ) as {
        html: (...args: unknown[]) => unknown;
      };
      const originalHtml = proto.html;
      const htmlSpy = vi.spyOn(proto, 'html').mockImplementation(function (this: unknown, ...args: unknown[]) {
        if (args.length === 0) {
          return undefined;
        }
        return originalHtml.apply(this, args);
      });

      try {
        const html = makeHtml();
        const result = parseDetailPage(html, 'https://vyhledavac.nssoud.cz/DokumentOriginal/Text/778');
        expect(result.external_id).toBe('778');
        expect(result.oduvodneni).toBeUndefined();
        expect(result.vyrok).toBeUndefined();
      } finally {
        htmlSpy.mockRestore();
      }
    });

    it('handles HTML without body and URL without recognizable ID', () => {
      const html = '<html><head><title>No body title</title></head></html>';
      const result = parseDetailPage(html, 'https://vyhledavac.nssoud.cz/unknown/path');
      expect(result.external_id).toBeUndefined();
      expect(result.oduvodneni).toBeUndefined();
      expect(result.raw_json).toBeDefined();
    });
  });

  describe('runDetail', () => {
    const originalFetch = globalThis.fetch;

    beforeEach(() => {
      vi.clearAllMocks();
    });

    afterEach(() => {
      globalThis.fetch = originalFetch;
    });

    const mockFetchResponse = (status: number, html: string, contentType = 'text/html; charset=utf-8') => {
      const encoder = new TextEncoder();
      const body = encoder.encode(html);
      globalThis.fetch = vi.fn().mockResolvedValue({
        status,
        headers: new Headers({ 'content-type': contentType }),
        text: () => Promise.resolve(html),
        arrayBuffer: () => Promise.resolve(body.buffer),
      });
    };

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
            url: 'https://vyhledavac.nssoud.cz/DokumentOriginal/Text/100',
            id: 1,
            source: 'nssoud',
            status: 'pending',
            attempts: 0,
          },
        ])
        .mockReturnValueOnce([]);

      const html = makeHtml({ body: 'ECLI:CZ:NSS:2024:1<br/>Some decision text...' });
      mockFetchResponse(200, html);

      await runDetail(
        db as any,
        { source: 'nssoud', concurrency: 1, delay: 0, maxRetries: 1, limit: 0, dbPath: '', phase: 'detail' },
        () => false,
      );

      expect(db.saveDecision).toHaveBeenCalledTimes(1);
      expect(db.finishRun).toHaveBeenCalledWith(1, 2, 1, 0, 'completed');
    });

    it('handles 404 by marking gone', async () => {
      const db = mockDb();
      db.getPendingUrls
        .mockReturnValueOnce([
          {
            url: 'https://vyhledavac.nssoud.cz/DokumentOriginal/Text/999',
            id: 1,
            source: 'nssoud',
            status: 'pending',
            attempts: 0,
          },
        ])
        .mockReturnValueOnce([]);

      mockFetchResponse(404, '');

      await runDetail(
        db as any,
        { source: 'nssoud', concurrency: 1, delay: 0, maxRetries: 0, limit: 0, dbPath: '', phase: 'detail' },
        () => false,
      );

      expect(db.markGone).toHaveBeenCalled();
    });

    it('handles no pending URLs', async () => {
      const db = mockDb();
      db.getUrlCounts.mockReturnValue({ total: 0, pending: 0, scraped: 0, failed: 0, gone: 0 });

      await runDetail(
        db as any,
        { source: 'nssoud', concurrency: 1, delay: 0, maxRetries: 0, limit: 0, dbPath: '', phase: 'detail' },
        () => false,
      );

      expect(db.startRun).not.toHaveBeenCalled();
    });

    it('stops on shutdown', async () => {
      const db = mockDb();
      db.getPendingUrls.mockReturnValue([
        {
          url: 'https://vyhledavac.nssoud.cz/DokumentOriginal/Text/100',
          id: 1,
          source: 'nssoud',
          status: 'pending',
          attempts: 0,
        },
      ]);

      mockFetchResponse(200, '');

      await runDetail(
        db as any,
        { source: 'nssoud', concurrency: 1, delay: 0, maxRetries: 0, limit: 0, dbPath: '', phase: 'detail' },
        () => true,
      );

      expect(db.finishRun).toHaveBeenCalledWith(1, 2, 0, 0, 'interrupted');
    });

    it('decodes UTF-16 response bodies and tolerates invalid retry-after header', async () => {
      const db = mockDb();
      db.getPendingUrls
        .mockReturnValueOnce([
          {
            url: 'https://vyhledavac.nssoud.cz/DokumentOriginal/Text/500',
            id: 1,
            source: 'nssoud',
            status: 'pending',
            attempts: 0,
          },
        ])
        .mockReturnValueOnce([]);

      const html = makeHtml();
      const utf16Buffer = Buffer.from(html, 'utf16le');
      globalThis.fetch = vi.fn().mockResolvedValue({
        status: 200,
        headers: {
          get: (name: string) => {
            if (name.toLowerCase() === 'content-type') return 'text/html; charset=utf-16le';
            if (name.toLowerCase() === 'retry-after') return 'not-a-number';
            return null;
          },
        },
        text: () => Promise.resolve('should-not-be-used'),
        arrayBuffer: () =>
          Promise.resolve(utf16Buffer.buffer.slice(utf16Buffer.byteOffset, utf16Buffer.byteOffset + utf16Buffer.byteLength)),
      });

      await runDetail(
        db as any,
        { source: 'nssoud', concurrency: 1, delay: 0, maxRetries: 0, limit: 0, dbPath: '', phase: 'detail' },
        () => false,
      );

      expect(db.saveDecision).toHaveBeenCalledTimes(1);
      const saved = db.saveDecision.mock.calls[0][0];
      expect(saved.typ_rozhodnuti).toBe('Rozsudek');
    });

    it('falls back to utf-8 when content-type header is missing', async () => {
      const db = mockDb();
      db.getPendingUrls
        .mockReturnValueOnce([
          {
            url: 'https://vyhledavac.nssoud.cz/DokumentOriginal/Text/501',
            id: 1,
            source: 'nssoud',
            status: 'pending',
            attempts: 0,
          },
        ])
        .mockReturnValueOnce([]);

      globalThis.fetch = vi.fn().mockResolvedValue({
        status: 200,
        headers: {
          get: () => null,
        },
        text: () => Promise.resolve(makeHtml()),
        arrayBuffer: () => Promise.resolve(new Uint8Array([]).buffer),
      });

      await runDetail(
        db as any,
        { source: 'nssoud', concurrency: 1, delay: 0, maxRetries: 0, limit: 0, dbPath: '', phase: 'detail' },
        () => false,
      );

      expect(db.saveDecision).toHaveBeenCalledTimes(1);
    });
  });
});
