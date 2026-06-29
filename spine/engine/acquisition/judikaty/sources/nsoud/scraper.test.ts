import * as cheerio from 'cheerio';
import { parseDetailPage, parseTextPage, runDetail } from './scraper.js';

vi.mock('../../../shared/fetch.js', async (importOriginal) => {
  const actual = (await importOriginal()) as Record<string, unknown>;
  return { ...actual, fetchPage: vi.fn() };
});

/** Build a realistic sbirka.nsoud.cz decision page */
const makeHtml = ({
  h1 = 'Usnesení Nejvyššího soudu ze dne 17.07.2003, sp. zn. 11 Tcu 95/2003',
  h2 = 'Trestní stíhání',
  ogDescription = 'Právní věta tohoto rozhodnutí.',
  sections = {} as Record<string, string>,
  strongLabels = {} as Record<string, string>,
}: {
  h1?: string;
  h2?: string;
  ogDescription?: string;
  sections?: Record<string, string>;
  strongLabels?: Record<string, string>;
} = {}) => {
  const sectionHtml = Object.entries(sections)
    .map(([heading, content]) => `<h2>${heading}</h2><p>${content}</p>`)
    .join('\n');

  const strongHtml = Object.entries(strongLabels)
    .map(([label, value]) => `<strong>${label}:</strong> ${value}`)
    .join('<br>\n');

  return `<html>
    <head>
      <title>Sbirka rozhodnutí</title>
      <meta property="og:title" content="${h1}" />
      <meta property="og:description" content="${ogDescription}" />
    </head>
    <body>
      <h1>${h1}</h1>
      ${h2 ? `<h2>${h2}</h2>` : ''}
      ${strongHtml ? `<p>${strongHtml}</p>` : ''}
      ${sectionHtml}
    </body>
  </html>`;
};

describe('nsoud scraper', () => {
  describe('parseDetailPage', () => {
    it('extracts metadata from <h1>', () => {
      const html = makeHtml();
      const result = parseDetailPage(html, 'https://sbirka.nsoud.cz/sbirka/13855/');

      expect(result.source).toBe('nsoud');
      expect(result.external_id).toBe('13855');
      expect(result.typ_rozhodnuti).toBe('Usnesení');
      expect(result.soud).toBe('Nejvyšší soud');
      expect(result.datum_vydani).toBe('17.07.2003');
      expect(result.spisova_znacka).toBe('11 Tcu 95/2003');
    });

    it('extracts rozsudek decision type', () => {
      const html = makeHtml({
        h1: 'Rozsudek Nejvyššího soudu ze dne 05.01.2022, sp. zn. 21 Cdo 1234/2021',
      });
      const result = parseDetailPage(html, 'https://sbirka.nsoud.cz/sbirka/50000/');

      expect(result.typ_rozhodnuti).toBe('Rozsudek');
      expect(result.datum_vydani).toBe('05.01.2022');
      expect(result.spisova_znacka).toBe('21 Cdo 1234/2021');
    });

    it('extracts oblast_prava from <h2>', () => {
      const html = makeHtml({ h2: 'Trestní stíhání' });
      const result = parseDetailPage(html, 'https://sbirka.nsoud.cz/sbirka/100/');
      expect(result.oblast_prava).toBe('Trestní stíhání');
    });

    it('extracts právní věta from og:description', () => {
      const html = makeHtml({ ogDescription: 'Důležitá právní věta rozhodnutí.' });
      const result = parseDetailPage(html, 'https://sbirka.nsoud.cz/sbirka/100/');
      expect(result.pravni_veta).toBe('Důležitá právní věta rozhodnutí.');
    });

    it('extracts heslo and předpisy from <strong> labels', () => {
      const html = makeHtml({
        strongLabels: {
          Heslo: 'Trest, Recidiva',
          Předpisy: 'z. č. 40/2009 Sb.',
        },
      });
      const result = parseDetailPage(html, 'https://sbirka.nsoud.cz/sbirka/100/');
      expect(result.klicova_slova).toBe('Trest, Recidiva');
      expect(result.zminena_ustanoveni).toBe('z. č. 40/2009 Sb.');
    });

    it('extracts content sections', () => {
      const html = makeHtml({
        sections: {
          Výrok: 'Dovolání se zamítá.',
          Odůvodnění: 'Nejvyšší soud rozhodl...',
        },
      });
      const result = parseDetailPage(html, 'https://sbirka.nsoud.cz/sbirka/100/');
      expect(result.vyrok).toBe('Dovolání se zamítá.');
      expect(result.oduvodneni).toBe('Nejvyšší soud rozhodl...');
    });

    it('skips structural h2 headings for oblast_prava', () => {
      const html = makeHtml({
        h2: '', // no non-structural h2
        sections: {
          Výrok: 'Dovolání se zamítá.',
        },
      });
      const result = parseDetailPage(html, 'https://sbirka.nsoud.cz/sbirka/100/');
      // The Výrok heading should not become oblast_prava
      expect(result.oblast_prava).toBeUndefined();
    });

    it('handles missing fields gracefully', () => {
      const html = '<html><head><title>Empty</title></head><body></body></html>';
      const result = parseDetailPage(html, 'https://sbirka.nsoud.cz/sbirka/100/');
      expect(result.source).toBe('nsoud');
      expect(result.url).toBe('https://sbirka.nsoud.cz/sbirka/100/');
      expect(result.external_id).toBe('100');
      expect(result.typ_rozhodnuti).toBeUndefined();
      expect(result.soud).toBeUndefined();
    });

    it('stores raw JSON with meta tags', () => {
      const html = makeHtml();
      const result = parseDetailPage(html, 'https://sbirka.nsoud.cz/sbirka/100/');
      expect(result.raw_json).toBeDefined();
      const raw = JSON.parse(result.raw_json!);
      expect(raw.title).toBe('Sbirka rozhodnutí');
      expect(raw.meta['og:description']).toBe('Právní věta tohoto rozhodnutí.');
    });

    it('extracts ID from URL without trailing slash', () => {
      const result = parseDetailPage(
        '<html><head><title>T</title></head><body></body></html>',
        'https://sbirka.nsoud.cz/sbirka/42',
      );
      expect(result.external_id).toBe('42');
    });

    it('extracts special senate court label and linked text page URL', () => {
      const html = `<html><body>
        <h1>Usnesení Zvláštní senát ze dne 01.01.2020, sp. zn. Konf 1/2020</h1>
        <a href="https://sbirka.nsoud.cz/sbirka/text?p=123">Sbírkový text</a>
      </body></html>`;

      const result = parseDetailPage(html, 'https://sbirka.nsoud.cz/sbirka/999/');
      expect(result.soud).toBe('Zvláštní senát');
      expect(result._textPageUrl).toContain('sbirka.nsoud.cz/sbirka/text?p=123');
    });

    it('falls back to main content split when section headings are missing', () => {
      const html = `<html><body>
        <article>
          <div class="content">Úvodní část. Výrok Dovolání se zamítá. Odůvodnění Soud dospěl k závěru.</div>
        </article>
      </body></html>`;
      const result = parseDetailPage(html, 'https://sbirka.nsoud.cz/sbirka/100/');

      expect(result.vyrok).toContain('Výrok');
      expect(result.oduvodneni).toContain('Odůvodnění');
    });

    it('keeps unmatched court names and handles URL without numeric sbirka ID', () => {
      const html = makeHtml({
        h1: 'Usnesení Mimořádného soudu ze dne 03.03.2021, sp. zn. X 1/2021',
      });

      const result = parseDetailPage(html, 'https://sbirka.nsoud.cz/jina-cesta/abc');
      expect(result.external_id).toBeUndefined();
      expect(result.soud).toBe('Mimořádného soudu ze');
    });

    it('falls back to full main content when no Výrok marker is present', () => {
      const html = `<html><body>
        <article>
          <div class="content">Pouze souvislý text bez sekčních markerů.</div>
        </article>
      </body></html>`;
      const result = parseDetailPage(html, 'https://sbirka.nsoud.cz/sbirka/100/');

      expect(result.vyrok).toBeUndefined();
      expect(result.oduvodneni).toContain('Pouze souvislý text');
    });

    it('handles h1 without court/date/spis and keeps first non-structural h2 only', () => {
      const html = `<html><body>
        <h1>Usnesení anonymního orgánu</h1>
        <h2>Oblast A</h2>
        <h2>Oblast B</h2>
      </body></html>`;

      const result = parseDetailPage(html, 'https://sbirka.nsoud.cz/sbirka/321/');
      expect(result.typ_rozhodnuti).toBe('Usnesení');
      expect(result.soud).toBeUndefined();
      expect(result.datum_vydani).toBeUndefined();
      expect(result.spisova_znacka).toBeUndefined();
      expect(result.oblast_prava).toBe('Oblast A');
    });

    it('ignores empty strong labels/values and parses label variant "Předpis"', () => {
      const html = `<html><body>
        <h1>Usnesení Nejvyššího soudu ze dne 01.01.2024, sp. zn. 1 T 1/2024</h1>
        <p>
          <strong>:</strong> ignorovat
          <strong>Heslo:</strong>
          <strong>Předpis:</strong> § 10 tr. zákoníku
        </p>
      </body></html>`;

      const result = parseDetailPage(html, 'https://sbirka.nsoud.cz/sbirka/322/');
      expect(result.klicova_slova).toBeUndefined();
      expect(result.zminena_ustanoveni).toContain('§ 10');
    });

    it('ignores unknown strong labels without mapping side effects', () => {
      const html = makeHtml({
        strongLabels: {
          'Jiný štítek': 'Volná hodnota',
        },
      });

      const result = parseDetailPage(html, 'https://sbirka.nsoud.cz/sbirka/400/');
      expect(result.klicova_slova).toBeUndefined();
      expect(result.zminena_ustanoveni).toBeUndefined();
    });

    it('keeps fallback fields empty when main content text is blank and link has no href', () => {
      const html = `<html><body>
        <article><div class="content">   </div></article>
        <a>Bez href</a>
      </body></html>`;

      const result = parseDetailPage(html, 'https://sbirka.nsoud.cz/sbirka/323/');
      expect(result.vyrok).toBeUndefined();
      expect(result.oduvodneni).toBeUndefined();
      expect(result._textPageUrl).toBeUndefined();
    });

    it('handles defensive fallback when first-word match unexpectedly fails', () => {
      const originalMatch = String.prototype.match;
      const matchSpy = vi.spyOn(String.prototype, 'match').mockImplementation(function (
        this: string,
        pattern: RegExp | string,
      ) {
        if (pattern instanceof RegExp && pattern.source === '^(\\S+)') return null;
        return (originalMatch as (...args: unknown[]) => unknown).call(this, pattern);
      });

      try {
        const html = `<html><body>
          <h1>Usnesení Nejvyššího soudu ze dne 01.01.2024, sp. zn. 1 T 1/2024</h1>
        </body></html>`;

        const result = parseDetailPage(html, 'https://sbirka.nsoud.cz/sbirka/501/');
        expect(result.typ_rozhodnuti).toBeUndefined();
        expect(result.soud).toBe('Nejvyšší soud');
        expect(result.datum_vydani).toBe('01.01.2024');
      } finally {
        matchSpy.mockRestore();
      }
    });

    it('handles defensive fallback when strong parent html is unavailable', () => {
      const strongSelectionProto = Object.getPrototypeOf(
        Object.getPrototypeOf(cheerio.load('<p><strong>x</strong></p>')('strong')),
      ) as { html: (...args: unknown[]) => unknown };
      const originalHtml = strongSelectionProto.html;
      let htmlNoArgCalls = 0;
      const htmlSpy = vi.spyOn(strongSelectionProto, 'html').mockImplementation(function (
        this: unknown,
        ...args: unknown[]
      ) {
        if (args.length === 0) {
          htmlNoArgCalls += 1;
          if (htmlNoArgCalls === 1) return null;
        }
        return originalHtml.apply(this, args);
      });

      try {
        const html = `<html><body>
          <h1>Usnesení Nejvyššího soudu ze dne 01.01.2024, sp. zn. 1 T 1/2024</h1>
          <p><strong>Heslo:</strong> Trest</p>
        </body></html>`;

        const result = parseDetailPage(html, 'https://sbirka.nsoud.cz/sbirka/502/');
        expect(result.klicova_slova).toBeUndefined();
      } finally {
        htmlSpy.mockRestore();
      }
    });

    it('handles defensive fallback when href attr lookup returns undefined inside link filter', () => {
      const selectionProto = Object.getPrototypeOf(
        Object.getPrototypeOf(cheerio.load('<a href="https://sbirka.nsoud.cz/sbirka/text?p=1">x</a>')('a')),
      ) as { attr: (...args: unknown[]) => unknown };
      const originalAttr = selectionProto.attr;
      let hrefAttrCalls = 0;
      const attrSpy = vi.spyOn(selectionProto, 'attr').mockImplementation(function (this: unknown, ...args: unknown[]) {
        if (args.length === 1 && args[0] === 'href') {
          const firstNode = (this as { [index: number]: { name?: string } })[0];
          if (firstNode?.name === 'a') {
            hrefAttrCalls += 1;
            if (hrefAttrCalls === 1) return undefined;
          }
        }
        return originalAttr.apply(this, args);
      });

      try {
        const html = `<html><body>
          <h1>Usnesení Nejvyššího soudu ze dne 01.01.2024, sp. zn. 1 T 1/2024</h1>
          <a href="https://sbirka.nsoud.cz/sbirka/text?p=1">Sbírkový text</a>
        </body></html>`;

        const result = parseDetailPage(html, 'https://sbirka.nsoud.cz/sbirka/503/');
        expect(result._textPageUrl).toBeUndefined();
      } finally {
        attrSpy.mockRestore();
      }
    });
  });

  describe('parseTextPage', () => {
    it('parses právní věta and odůvodnění markers from text page', () => {
      const decision = { url: 'x', source: 'nsoud' } as any;
      const html = `<html><head><title>ECLI:CZ:NS:2024:ABC</title></head><body>
        <div class="detail-section__content">Úvod Právní věta: První část. Z odůvodnění: Druhá část.</div>
      </body></html>`;

      parseTextPage(html, decision);

      expect(decision.ecli).toContain('ECLI:CZ:NS:2024:ABC');
      expect(decision.pravni_veta).toContain('První část');
      expect(decision.oduvodneni).toContain('Druhá část');
    });

    it('handles text page with only odůvodnění marker', () => {
      const decision = { url: 'x', source: 'nsoud' } as any;
      const html = `<html><body>
        <div class="detail-section__content">Úvod Z odůvodnění: Samotné odůvodnění.</div>
      </body></html>`;

      parseTextPage(html, decision);
      expect(decision.oduvodneni).toContain('Samotné odůvodnění');
    });

    it('handles text page with only právní věta marker', () => {
      const decision = { url: 'x', source: 'nsoud' } as any;
      const html = `<html><body>
        <div class="detail-section__content">Právní věta: Jediný text bez dalšího markeru.</div>
      </body></html>`;

      parseTextPage(html, decision);
      expect(decision.oduvodneni).toContain('Jediný text');
    });

    it('does not override existing ECLI and právní věta when already present', () => {
      const decision = { url: 'x', source: 'nsoud', ecli: 'ECLI:EXISTING', pravni_veta: 'Původní věta' } as any;
      const html = `<html><head><title>ECLI:CZ:NS:2024:NEW</title></head><body>
        <div class="detail-section__content">Právní věta: Nová věta. Z odůvodnění: Nové odůvodnění.</div>
      </body></html>`;

      parseTextPage(html, decision);
      expect(decision.ecli).toBe('ECLI:EXISTING');
      expect(decision.pravni_veta).toBe('Původní věta');
      expect(decision.oduvodneni).toContain('Nové odůvodnění');
    });

    it('ignores text page when content block is missing', () => {
      const decision = { url: 'x', source: 'nsoud' } as any;
      parseTextPage('<html><body><div>No content block</div></body></html>', decision);
      expect(decision.ecli).toBeUndefined();
      expect(decision.oduvodneni).toBeUndefined();
    });

    it('does not set odůvodnění when marker is present but trailing text is empty', () => {
      const decision = { url: 'x', source: 'nsoud' } as any;
      const html = `<html><body>
        <div class="detail-section__content">Právní věta: Stručná věta. Z odůvodnění:</div>
      </body></html>`;

      parseTextPage(html, decision);
      expect(decision.pravni_veta).toContain('Stručná věta');
      expect(decision.oduvodneni).toBeUndefined();
    });

    it('does not set odůvodnění when only "Z odůvodnění" marker has no trailing text', () => {
      const decision = { url: 'x', source: 'nsoud' } as any;
      parseTextPage('<html><body><div class="detail-section__content">Z odůvodnění:</div></body></html>', decision);
      expect(decision.oduvodneni).toBeUndefined();
    });

    it('keeps existing odůvodnění when only empty právní věta marker is present', () => {
      const decision = { url: 'x', source: 'nsoud', oduvodneni: 'Původní odůvodnění' } as any;
      parseTextPage('<html><body><div class="detail-section__content">Právní věta:</div></body></html>', decision);
      expect(decision.oduvodneni).toBe('Původní odůvodnění');
    });

    it('leaves odůvodnění empty when právní věta marker has no content', () => {
      const decision = { url: 'x', source: 'nsoud' } as any;
      parseTextPage('<html><body><div class="detail-section__content">Právní věta:</div></body></html>', decision);
      expect(decision.oduvodneni).toBeUndefined();
    });
  });

  describe('runDetail', () => {
    let fetchPage: ReturnType<typeof vi.fn>;

    beforeAll(async () => {
      const mod = await import('../../../shared/fetch.js');
      fetchPage = mod.fetchPage as ReturnType<typeof vi.fn>;
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
          { url: 'https://sbirka.nsoud.cz/sbirka/100/', id: 1, source: 'nsoud', status: 'pending', attempts: 0 },
        ])
        .mockReturnValueOnce([]);

      const html = makeHtml();
      fetchPage.mockResolvedValue({ status: 200, html });

      await runDetail(
        db as any,
        { source: 'nsoud', concurrency: 1, delay: 0, maxRetries: 1, limit: 0, dbPath: '', phase: 'detail' },
        () => false,
      );

      expect(db.saveDecision).toHaveBeenCalledTimes(1);
      expect(db.finishRun).toHaveBeenCalledWith(1, 2, 1, 0, 'completed');
    });

    it('handles 404 by marking gone', async () => {
      const db = mockDb();
      db.getPendingUrls
        .mockReturnValueOnce([
          { url: 'https://sbirka.nsoud.cz/sbirka/999/', id: 1, source: 'nsoud', status: 'pending', attempts: 0 },
        ])
        .mockReturnValueOnce([]);

      fetchPage.mockResolvedValue({ status: 404, html: '' });

      await runDetail(
        db as any,
        { source: 'nsoud', concurrency: 1, delay: 0, maxRetries: 0, limit: 0, dbPath: '', phase: 'detail' },
        () => false,
      );

      expect(db.markGone).toHaveBeenCalled();
    });

    it('handles no pending URLs', async () => {
      const db = mockDb();
      db.getUrlCounts.mockReturnValue({ total: 0, pending: 0, scraped: 0, failed: 0, gone: 0 });

      await runDetail(
        db as any,
        { source: 'nsoud', concurrency: 1, delay: 0, maxRetries: 0, limit: 0, dbPath: '', phase: 'detail' },
        () => false,
      );

      expect(db.startRun).not.toHaveBeenCalled();
    });

    it('stops on shutdown', async () => {
      const db = mockDb();
      db.getPendingUrls.mockReturnValue([
        { url: 'https://sbirka.nsoud.cz/sbirka/100/', id: 1, source: 'nsoud', status: 'pending', attempts: 0 },
      ]);

      await runDetail(
        db as any,
        { source: 'nsoud', concurrency: 1, delay: 0, maxRetries: 0, limit: 0, dbPath: '', phase: 'detail' },
        () => true,
      );

      expect(db.finishRun).toHaveBeenCalledWith(1, 2, 0, 0, 'interrupted');
    });

    it('continues when linked text sub-page returns non-200', async () => {
      const db = mockDb();
      db.getPendingUrls
        .mockReturnValueOnce([
          { url: 'https://sbirka.nsoud.cz/sbirka/123/', id: 1, source: 'nsoud', status: 'pending', attempts: 0 },
        ])
        .mockReturnValueOnce([]);

      fetchPage
        .mockResolvedValueOnce({
          status: 200,
          html: `<html><body>
            <h1>Usnesení Nejvyššího soudu ze dne 01.01.2020, sp. zn. 1 T 1/2020</h1>
            <a href="https://sbirka.nsoud.cz/sbirka/text?p=123">Sbírkový text</a>
          </body></html>`,
        })
        .mockResolvedValueOnce({ status: 500, html: '' });

      await runDetail(
        db as any,
        { source: 'nsoud', concurrency: 1, delay: 0, maxRetries: 0, limit: 0, dbPath: '', phase: 'detail' },
        () => false,
      );

      expect(fetchPage).toHaveBeenCalledTimes(2);
      expect(db.saveDecision).toHaveBeenCalledTimes(1);
      expect(db.markFailed).not.toHaveBeenCalled();
    });

    it('continues when linked text sub-page fetch throws', async () => {
      const db = mockDb();
      db.getPendingUrls
        .mockReturnValueOnce([
          { url: 'https://sbirka.nsoud.cz/sbirka/124/', id: 1, source: 'nsoud', status: 'pending', attempts: 0 },
        ])
        .mockReturnValueOnce([]);

      fetchPage
        .mockResolvedValueOnce({
          status: 200,
          html: `<html><body>
            <h1>Usnesení Nejvyššího soudu ze dne 01.01.2020, sp. zn. 1 T 2/2020</h1>
            <a href="https://sbirka.nsoud.cz/sbirka/text?p=124">Sbírkový text</a>
          </body></html>`,
        })
        .mockRejectedValueOnce(new Error('network failure'));

      await runDetail(
        db as any,
        { source: 'nsoud', concurrency: 1, delay: 0, maxRetries: 0, limit: 0, dbPath: '', phase: 'detail' },
        () => false,
      );

      expect(fetchPage).toHaveBeenCalledTimes(2);
      expect(db.saveDecision).toHaveBeenCalledTimes(1);
      expect(db.markFailed).not.toHaveBeenCalled();
    });

    it('parses linked text sub-page when it returns 200', async () => {
      const db = mockDb();
      db.getPendingUrls
        .mockReturnValueOnce([
          { url: 'https://sbirka.nsoud.cz/sbirka/125/', id: 1, source: 'nsoud', status: 'pending', attempts: 0 },
        ])
        .mockReturnValueOnce([]);

      fetchPage
        .mockResolvedValueOnce({
          status: 200,
          html: `<html><body>
            <h1>Usnesení Nejvyššího soudu ze dne 01.01.2020, sp. zn. 1 T 3/2020</h1>
            <a href="https://sbirka.nsoud.cz/sbirka/text?p=125">Sbírkový text</a>
          </body></html>`,
        })
        .mockResolvedValueOnce({
          status: 200,
          html: `<html><head><title>ECLI:CZ:NS:2020:1T3.1</title></head><body>
            <div class="detail-section__content">Právní věta: Věta. Z odůvodnění: Obsah odůvodnění.</div>
          </body></html>`,
        });

      await runDetail(
        db as any,
        { source: 'nsoud', concurrency: 1, delay: 0, maxRetries: 0, limit: 0, dbPath: '', phase: 'detail' },
        () => false,
      );

      expect(fetchPage).toHaveBeenCalledTimes(2);
      expect(db.saveDecision).toHaveBeenCalledTimes(1);
      const saved = db.saveDecision.mock.calls[0][0] as Record<string, string | undefined>;
      expect(saved.ecli).toContain('ECLI:CZ:NS:2020:1T3.1');
      expect(saved.oduvodneni).toContain('Obsah odůvodnění');
    });
  });
});
