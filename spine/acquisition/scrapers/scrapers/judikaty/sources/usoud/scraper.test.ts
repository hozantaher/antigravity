import * as cheerio from 'cheerio';
import { extractGetTextUrl, parseDetailPage, parseTextPage, runDetail } from './scraper.js';

const makeHtml = (fields: Record<string, string> = {}, sections: Record<string, string> = {}) => {
  // USoud detail pages use adjacent <td> cells for label:value pairs
  const fieldHtml = Object.entries(fields)
    .map(([label, value]) => `<tr><td>${label}</td><td>${value}</td></tr>`)
    .join('\n');

  const sectionHtml = Object.entries(sections)
    .map(([heading, content]) => `<h3>${heading}</h3><div>${content}</div>`)
    .join('\n');

  return `<html><head><title>ÚS Decision</title></head><body>
    <form id="form1">
      <table>${fieldHtml}</table>
      ${sectionHtml}
    </form>
  </body></html>`;
};

describe('usoud scraper', () => {
  describe('parseDetailPage', () => {
    it('extracts metadata from labeled table cells', () => {
      const html = makeHtml({
        'Spisová značka': 'I. ÚS 100/24',
        ECLI: 'ECLI:CZ:US:2024:1.US.100.24.1',
        'Soudce zpravodaj': 'JUDr. Rychetský',
        'Datum rozhodnutí': '31. 1. 2024',
        'Forma rozhodnutí': 'Nález',
        'Typ řízení': 'O ústavních stížnostech',
      });

      const result = parseDetailPage(html, 'https://nalus.usoud.cz/Search/ResultDetail.aspx?id=12345');
      expect(result.source).toBe('usoud');
      expect(result.soud).toBe('Ústavní soud');
      expect(result.external_id).toBe('12345');
      expect(result.spisova_znacka).toBe('I. ÚS 100/24');
      expect(result.ecli).toBe('ECLI:CZ:US:2024:1.US.100.24.1');
      expect(result.autor).toBe('JUDr. Rychetský');
      expect(result.datum_vydani).toBe('31. 1. 2024');
      expect(result.typ_rozhodnuti).toBe('Nález');
      expect(result.predmet_rizeni).toBe('O ústavních stížnostech');
    });

    it('extracts content sections', () => {
      const html = makeHtml(
        {},
        {
          'Právní věta': 'Právo na spravedlivý proces...',
          Výrok: 'Ústavní stížnosti se vyhovuje.',
          Odůvodnění: 'Ústavní soud přezkoumal...',
        },
      );

      const result = parseDetailPage(html, 'https://nalus.usoud.cz/Search/ResultDetail.aspx?id=100');
      expect(result.pravni_veta).toBe('Právo na spravedlivý proces...');
      expect(result.vyrok).toBe('Ústavní stížnosti se vyhovuje.');
      expect(result.oduvodneni).toBe('Ústavní soud přezkoumal...');
    });

    it('extracts cited legislation', () => {
      const html = makeHtml({
        'Dotčené ústavní zákony a mezinárodní smlouvy': '2/1993 Sb., čl. 36 odst.1; 89/2012 Sb.',
      });

      const result = parseDetailPage(html, 'https://nalus.usoud.cz/Search/ResultDetail.aspx?id=100');
      expect(result.zminena_ustanoveni).toBeDefined();
      const laws = JSON.parse(result.zminena_ustanoveni!);
      expect(laws).toContain('2/1993 Sb.');
    });

    it('maps alternate subject label, legal area and verdict type', () => {
      const html = makeHtml({
        'Předmět řízení': 'Náhrada škody',
        'Oblast práva': 'Správní právo',
        'Typ výroku': 'Vyhověno',
      });

      const result = parseDetailPage(html, 'https://nalus.usoud.cz/Search/ResultDetail.aspx?id=103');
      expect(result.predmet_rizeni).toBe('Náhrada škody');
      expect(result.oblast_prava).toBe('Správní právo');
      expect(result.klicova_slova).toBe(JSON.stringify(['Vyhověno']));
    });

    it('maps case number and publication date labels', () => {
      const html = makeHtml({
        'Číslo jednací': 'Pl. ÚS 1/24-1',
        'Datum zpřístupnění': '1. 2. 2024',
      });

      const result = parseDetailPage(html, 'https://nalus.usoud.cz/Search/ResultDetail.aspx?id=104');
      expect(result.jednaci_cislo).toBe('Pl. ÚS 1/24-1');
      expect(result.datum_zverejneni).toBe('1. 2. 2024');
    });

    it('handles ASP.NET panel content fallback', () => {
      const html = `<html><head><title>Test</title></head><body>
        <form id="form1">
          <div id="MainContent_pravniVeta">Důležitá právní věta.</div>
          <div id="MainContent_vyrok">Nález se zamítá.</div>
        </form>
      </body></html>`;

      const result = parseDetailPage(html, 'https://nalus.usoud.cz/Search/ResultDetail.aspx?id=100');
      expect(result.pravni_veta).toBe('Důležitá právní věta.');
      expect(result.vyrok).toBe('Nález se zamítá.');
    });

    it('handles empty ASP.NET fallback panels and reads odůvodnění fallback when present', () => {
      const html = `<html><head><title>Test</title></head><body>
        <form id="form1">
          <div id="MainContent_pravniVeta"></div>
          <div id="MainContent_vyrok"></div>
          <div id="MainContent_oduvodneni">Obsah odůvodnění z panelu.</div>
        </form>
      </body></html>`;

      const result = parseDetailPage(html, 'https://nalus.usoud.cz/Search/ResultDetail.aspx?id=101');
      expect(result.pravni_veta).toBeUndefined();
      expect(result.vyrok).toBeUndefined();
      expect(result.oduvodneni).toBe('Obsah odůvodnění z panelu.');
    });

    it('keeps odůvodnění undefined when fallback panel exists but is empty', () => {
      const html = `<html><head><title>Test</title></head><body>
        <form id="form1">
          <div id="MainContent_Oduvodneni"></div>
        </form>
      </body></html>`;

      const result = parseDetailPage(html, 'https://nalus.usoud.cz/Search/ResultDetail.aspx?id=102');
      expect(result.oduvodneni).toBeUndefined();
    });

    it('handles missing fields gracefully', () => {
      const html = '<html><head><title>Empty</title></head><body><form></form></body></html>';
      const result = parseDetailPage(html, 'https://nalus.usoud.cz/Search/ResultDetail.aspx?id=100');
      expect(result.source).toBe('usoud');
      expect(result.soud).toBe('Ústavní soud');
    });

    it('stores raw JSON', () => {
      const html = makeHtml({ ECLI: 'ECLI:CZ:US:2024:1' });
      const result = parseDetailPage(html, 'https://nalus.usoud.cz/Search/ResultDetail.aspx?id=100');
      expect(result.raw_json).toBeDefined();
      const raw = JSON.parse(result.raw_json!);
      expect(raw.title).toBe('ÚS Decision');
    });

    it('falls back to ECLI pattern in page text when table value is missing', () => {
      const html = `<html><body><div>ECLI:CZ:US:2024:2.US.1.24.1</div></body></html>`;
      const result = parseDetailPage(html, 'https://nalus.usoud.cz/Search/ResultDetail.aspx?id=100');
      expect(result.ecli).toBe('ECLI:CZ:US:2024:2.US.1.24.1');
    });

    it('handles URL without id and skips empty/&nbsp; field values', () => {
      const html = `<html><body>
        <form id="form1">
          <table>
            <tr><td>Spisová značka:</td><td>&nbsp;</td></tr>
            <tr><td>ECLI:</td><td>\u00a0</td></tr>
          </table>
        </form>
      </body></html>`;

      const result = parseDetailPage(html, 'https://nalus.usoud.cz/Search/ResultDetail.aspx');
      expect(result.external_id).toBeUndefined();
      expect(result.spisova_znacka).toBeUndefined();
      expect(result.ecli).toBeUndefined();
    });

    it('keeps first heading-derived values when duplicate sections exist', () => {
      const html = `<html><body>
        <h3>Právní věta</h3><div>První věta</div>
        <h3>Právní věta</h3><div>Druhá věta</div>
      </body></html>`;
      const result = parseDetailPage(html, 'https://nalus.usoud.cz/Search/ResultDetail.aspx?id=321');
      expect(result.pravni_veta).toBe('První věta');
    });
  });

  describe('extractGetTextUrl + parseTextPage', () => {
    it('extracts GetText.aspx URL from HTML blob', () => {
      const html = '<a href="https://nalus.usoud.cz/GetText.aspx?sz=1-ABC">text</a>';
      expect(extractGetTextUrl(html)).toBe('https://nalus.usoud.cz/GetText.aspx?sz=1-ABC');
      expect(extractGetTextUrl('<html>no link</html>')).toBeUndefined();
    });

    it('parses both výrok and odůvodnění from long text block', () => {
      const prefix = 'x'.repeat(600);
      const html = `<table><tr><td style="font-size:10pt;">${prefix} takto: Výrok text. Odůvodnění: Oduvodneni text.</td></tr></table>`;
      const decision = { url: 'u', source: 'usoud' } as any;
      parseTextPage(html, decision);

      expect(decision.vyrok).toContain('Výrok text');
      expect(decision.oduvodneni).toContain('Oduvodneni text');
    });

    it('parses only odůvodnění branch and only-výrok fallback branch', () => {
      const longA = 'x'.repeat(600);
      const onlyOduvHtml = `<table><tr><td style="font-size:10pt;">${longA} Odůvodnění: Jen odůvodnění.</td></tr></table>`;
      const decisionA = { url: 'u', source: 'usoud' } as any;
      parseTextPage(onlyOduvHtml, decisionA);
      expect(decisionA.oduvodneni).toContain('Jen odůvodnění');

      const longB = 'x'.repeat(600);
      const onlyVyrokHtml = `<table><tr><td style="font-size:10pt;">${longB} takto: Jen jedna část bez druhého markeru.</td></tr></table>`;
      const decisionB = { url: 'u', source: 'usoud' } as any;
      parseTextPage(onlyVyrokHtml, decisionB);
      expect(decisionB.oduvodneni).toContain('Jen jedna část');
    });

    it('returns early when no large text block is available', () => {
      const shortHtml = `<table><tr><td style="font-size:10pt;">Krátký text</td></tr></table>`;
      const decision = { url: 'u', source: 'usoud' } as any;
      parseTextPage(shortHtml, decision);
      expect(decision.vyrok).toBeUndefined();
      expect(decision.oduvodneni).toBeUndefined();
    });

    it('returns early when extracted long text is only whitespace', () => {
      const whitespace = ' '.repeat(700);
      const html = `<table><tr><td style="font-size:10pt;">${whitespace}</td></tr></table>`;
      const decision = { url: 'u', source: 'usoud' } as any;
      parseTextPage(html, decision);
      expect(decision.vyrok).toBeUndefined();
      expect(decision.oduvodneni).toBeUndefined();
    });

    it('handles defensive fallback when selected content text becomes empty after trim', () => {
      const proto = Object.getPrototypeOf(
        Object.getPrototypeOf(cheerio.load('<td>x</td>')('td')),
      ) as {
        text: (...args: unknown[]) => unknown;
      };
      const originalText = proto.text;
      let textCalls = 0;
      const textSpy = vi.spyOn(proto, 'text').mockImplementation(function (this: unknown, ...args: unknown[]) {
        if (args.length === 0) {
          textCalls += 1;
          if (textCalls === 1) return 'x'.repeat(600); // pass filter (>500 chars)
          if (textCalls === 2) return ' '.repeat(600); // become empty after trim
        }
        return originalText.apply(this, args);
      });

      try {
        const decision = { url: 'u', source: 'usoud' } as any;
        parseTextPage('<table><tr><td style="font-size:10pt;">placeholder</td></tr></table>', decision);
        expect(decision.vyrok).toBeUndefined();
        expect(decision.oduvodneni).toBeUndefined();
      } finally {
        textSpy.mockRestore();
      }
    });

    it('leaves decision unchanged when marker-free long text is present', () => {
      const long = 'x'.repeat(700) + ' žádné markery ';
      const html = `<table><tr><td style="font-size:10pt;">${long}</td></tr></table>`;
      const decision = { url: 'u', source: 'usoud' } as any;
      parseTextPage(html, decision);
      expect(decision.vyrok).toBeUndefined();
      expect(decision.oduvodneni).toBeUndefined();
    });
  });

  describe('runDetail', () => {
    let fetchSpy: ReturnType<typeof vi.fn>;

    beforeEach(() => {
      vi.clearAllMocks();
      fetchSpy = vi.fn();
      vi.stubGlobal('fetch', fetchSpy);
    });

    afterEach(() => {
      vi.unstubAllGlobals();
    });

    const mockSessionResponse = () => ({
      text: () => Promise.resolve('<html></html>'),
      headers: {
        getSetCookie: () => ['ASP.NET_SessionId=abc123; path=/; HttpOnly'],
      },
    });

    const mockSessionResponseWithoutCookies = () => ({
      text: () => Promise.resolve('<html></html>'),
      headers: {
        getSetCookie: () => [],
      },
    });

    const mockDetailResponse = (status: number, html: string) => ({
      status,
      text: () => Promise.resolve(html),
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
            url: 'https://nalus.usoud.cz/Search/ResultDetail.aspx?id=100',
            id: 1,
            source: 'usoud',
            status: 'pending',
            attempts: 0,
          },
        ])
        .mockReturnValueOnce([]);

      const html = makeHtml({ ECLI: 'ECLI:CZ:US:2024:1' });
      fetchSpy
        .mockResolvedValueOnce(mockSessionResponse()) // session cookie request
        .mockResolvedValueOnce(mockDetailResponse(200, html)); // detail page

      await runDetail(
        db as any,
        { source: 'usoud', concurrency: 1, delay: 0, maxRetries: 1, limit: 0, dbPath: '', phase: 'detail' },
        () => false,
      );

      expect(db.saveDecision).toHaveBeenCalledTimes(1);
      expect(db.finishRun).toHaveBeenCalledWith(1, 2, 1, 0, 'completed');

      // Verify the detail request included cookies
      const detailCall = fetchSpy.mock.calls[1];
      expect(detailCall[1].headers.Cookie).toBe('ASP.NET_SessionId=abc123');
    });

    it('handles 404 by marking gone', async () => {
      const db = mockDb();
      db.getPendingUrls
        .mockReturnValueOnce([
          {
            url: 'https://nalus.usoud.cz/Search/ResultDetail.aspx?id=999',
            id: 1,
            source: 'usoud',
            status: 'pending',
            attempts: 0,
          },
        ])
        .mockReturnValueOnce([]);

      fetchSpy.mockResolvedValueOnce(mockSessionResponse()).mockResolvedValueOnce(mockDetailResponse(404, ''));

      await runDetail(
        db as any,
        { source: 'usoud', concurrency: 1, delay: 0, maxRetries: 0, limit: 0, dbPath: '', phase: 'detail' },
        () => false,
      );

      expect(db.markGone).toHaveBeenCalled();
    });

    it('handles no pending URLs', async () => {
      const db = mockDb();
      db.getUrlCounts.mockReturnValue({ total: 0, pending: 0, scraped: 0, failed: 0, gone: 0 });

      await runDetail(
        db as any,
        { source: 'usoud', concurrency: 1, delay: 0, maxRetries: 0, limit: 0, dbPath: '', phase: 'detail' },
        () => false,
      );

      expect(db.startRun).not.toHaveBeenCalled();
    });

    it('stops on shutdown', async () => {
      const db = mockDb();
      db.getPendingUrls.mockReturnValue([
        {
          url: 'https://nalus.usoud.cz/Search/ResultDetail.aspx?id=100',
          id: 1,
          source: 'usoud',
          status: 'pending',
          attempts: 0,
        },
      ]);

      fetchSpy.mockResolvedValueOnce(mockSessionResponse());

      await runDetail(
        db as any,
        { source: 'usoud', concurrency: 1, delay: 0, maxRetries: 0, limit: 0, dbPath: '', phase: 'detail' },
        () => true,
      );

      expect(db.finishRun).toHaveBeenCalledWith(1, 2, 0, 0, 'interrupted');
    });

    it('continues when session endpoint returns no cookies', async () => {
      const db = mockDb();
      db.getPendingUrls
        .mockReturnValueOnce([
          {
            url: 'https://nalus.usoud.cz/Search/ResultDetail.aspx?id=700',
            id: 1,
            source: 'usoud',
            status: 'pending',
            attempts: 0,
          },
        ])
        .mockReturnValueOnce([]);

      fetchSpy
        .mockResolvedValueOnce(mockSessionResponseWithoutCookies())
        .mockResolvedValueOnce(mockDetailResponse(200, makeHtml({ ECLI: 'ECLI:CZ:US:2024:700' })));

      await runDetail(
        db as any,
        { source: 'usoud', concurrency: 1, delay: 0, maxRetries: 0, limit: 0, dbPath: '', phase: 'detail' },
        () => false,
      );

      expect(db.saveDecision).toHaveBeenCalledTimes(1);
      expect(db.markFailed).not.toHaveBeenCalled();
    });

    it('marks failed after 429 retries are exhausted', async () => {
      const db = mockDb();
      db.getPendingUrls
        .mockReturnValueOnce([
          {
            url: 'https://nalus.usoud.cz/Search/ResultDetail.aspx?id=701',
            id: 1,
            source: 'usoud',
            status: 'pending',
            attempts: 0,
          },
        ])
        .mockReturnValueOnce([]);

      const randomSpy = vi.spyOn(Math, 'random').mockReturnValue(0);
      fetchSpy
        .mockResolvedValueOnce(mockSessionResponse())
        .mockResolvedValueOnce(mockDetailResponse(429, ''))
        .mockResolvedValueOnce(mockDetailResponse(429, ''));

      try {
        await runDetail(
          db as any,
          { source: 'usoud', concurrency: 1, delay: 0, maxRetries: 1, limit: 0, dbPath: '', phase: 'detail' },
          () => false,
        );
      } finally {
        randomSpy.mockRestore();
      }

      expect(db.markFailed).toHaveBeenCalledWith(
        'https://nalus.usoud.cz/Search/ResultDetail.aspx?id=701',
        'Rate limited (429)',
      );
      expect(db.saveDecision).not.toHaveBeenCalled();
    });

    it('marks failures for 5xx and unexpected non-200 statuses', async () => {
      const db = mockDb();
      db.getUrlCounts.mockReturnValue({ total: 2, pending: 2, scraped: 0, failed: 0, gone: 0 });
      db.getPendingUrls
        .mockReturnValueOnce([
          {
            url: 'https://nalus.usoud.cz/Search/ResultDetail.aspx?id=702',
            id: 1,
            source: 'usoud',
            status: 'pending',
            attempts: 0,
          },
          {
            url: 'https://nalus.usoud.cz/Search/ResultDetail.aspx?id=703',
            id: 2,
            source: 'usoud',
            status: 'pending',
            attempts: 0,
          },
        ])
        .mockReturnValueOnce([]);

      fetchSpy
        .mockResolvedValueOnce(mockSessionResponse())
        .mockResolvedValueOnce(mockDetailResponse(500, ''))
        .mockResolvedValueOnce(mockDetailResponse(418, ''));

      await runDetail(
        db as any,
        { source: 'usoud', concurrency: 1, delay: 0, maxRetries: 0, limit: 0, dbPath: '', phase: 'detail' },
        () => false,
      );

      expect(db.markFailed).toHaveBeenNthCalledWith(
        1,
        'https://nalus.usoud.cz/Search/ResultDetail.aspx?id=702',
        'Server error (500)',
      );
      expect(db.markFailed).toHaveBeenNthCalledWith(
        2,
        'https://nalus.usoud.cz/Search/ResultDetail.aspx?id=703',
        'Unexpected status 418',
      );
    });

    it('fetches and parses linked GetText page when decision content is missing', async () => {
      const db = mockDb();
      db.getPendingUrls
        .mockReturnValueOnce([
          {
            url: 'https://nalus.usoud.cz/Search/ResultDetail.aspx?id=704',
            id: 1,
            source: 'usoud',
            status: 'pending',
            attempts: 0,
          },
        ])
        .mockReturnValueOnce([]);

      const longPrefix = 'x'.repeat(600);
      const detailHtml = `<html><body>
        <div>https://nalus.usoud.cz/GetText.aspx?sz=I-US-704</div>
      </body></html>`;
      const textHtml = `<table><tr><td style="font-size:10pt;">${longPrefix} takto: Výrok z textu. Odůvodnění: Odůvodnění z textu.</td></tr></table>`;

      fetchSpy
        .mockResolvedValueOnce(mockSessionResponse())
        .mockResolvedValueOnce(mockDetailResponse(200, detailHtml))
        .mockResolvedValueOnce(mockDetailResponse(200, textHtml));

      await runDetail(
        db as any,
        { source: 'usoud', concurrency: 1, delay: 0, maxRetries: 0, limit: 0, dbPath: '', phase: 'detail' },
        () => false,
      );

      const saved = db.saveDecision.mock.calls[0][0];
      expect(saved.vyrok).toContain('Výrok z textu');
      expect(saved.oduvodneni).toContain('Odůvodnění z textu');
    });

    it('keeps metadata when GetText fetch is non-200 or throws', async () => {
      const db = mockDb();
      db.getUrlCounts.mockReturnValue({ total: 2, pending: 2, scraped: 0, failed: 0, gone: 0 });
      db.getPendingUrls
        .mockReturnValueOnce([
          {
            url: 'https://nalus.usoud.cz/Search/ResultDetail.aspx?id=705',
            id: 1,
            source: 'usoud',
            status: 'pending',
            attempts: 0,
          },
          {
            url: 'https://nalus.usoud.cz/Search/ResultDetail.aspx?id=706',
            id: 2,
            source: 'usoud',
            status: 'pending',
            attempts: 0,
          },
        ])
        .mockReturnValueOnce([]);

      const detailHtmlA = `<html><body>https://nalus.usoud.cz/GetText.aspx?sz=I-US-705</body></html>`;
      const detailHtmlB = `<html><body>https://nalus.usoud.cz/GetText.aspx?sz=I-US-706</body></html>`;

      fetchSpy
        .mockResolvedValueOnce(mockSessionResponse())
        .mockResolvedValueOnce(mockDetailResponse(200, detailHtmlA))
        .mockResolvedValueOnce(mockDetailResponse(500, ''))
        .mockResolvedValueOnce(mockDetailResponse(200, detailHtmlB))
        .mockRejectedValueOnce(new Error('network down'));

      await runDetail(
        db as any,
        { source: 'usoud', concurrency: 1, delay: 0, maxRetries: 0, limit: 0, dbPath: '', phase: 'detail' },
        () => false,
      );

      expect(db.saveDecision).toHaveBeenCalledTimes(2);
      expect(db.markFailed).not.toHaveBeenCalled();
    });

    it('respects numeric limit and stops with completed status', async () => {
      const db = mockDb();
      db.getUrlCounts.mockReturnValue({ total: 2, pending: 2, scraped: 0, failed: 0, gone: 0 });
      db.getPendingUrls
        .mockReturnValueOnce([
          {
            url: 'https://nalus.usoud.cz/Search/ResultDetail.aspx?id=707',
            id: 1,
            source: 'usoud',
            status: 'pending',
            attempts: 0,
          },
        ])
        .mockReturnValueOnce([]);

      fetchSpy
        .mockResolvedValueOnce(mockSessionResponse())
        .mockResolvedValueOnce(mockDetailResponse(200, makeHtml({ ECLI: 'ECLI:CZ:US:2024:707' })));

      await runDetail(
        db as any,
        { source: 'usoud', concurrency: 1, delay: 0, maxRetries: 0, limit: 1, dbPath: '', phase: 'detail' },
        () => false,
      );

      expect(db.getPendingUrls).toHaveBeenCalledWith('usoud', 0, 1);
      expect(db.finishRun).toHaveBeenCalledWith(1, 1, 1, 0, 'completed');
    });

    it('does not fetch GetText page when detail already contains výrok/odůvodnění', async () => {
      const db = mockDb();
      db.getPendingUrls
        .mockReturnValueOnce([
          {
            url: 'https://nalus.usoud.cz/Search/ResultDetail.aspx?id=708',
            id: 1,
            source: 'usoud',
            status: 'pending',
            attempts: 0,
          },
        ])
        .mockReturnValueOnce([]);

      const detailHtml = `<html><body>
        <h3>Výrok</h3><div>Výrok je dostupný už na kartě.</div>
        <div>https://nalus.usoud.cz/GetText.aspx?sz=I-US-708</div>
      </body></html>`;

      fetchSpy
        .mockResolvedValueOnce(mockSessionResponse())
        .mockResolvedValueOnce(mockDetailResponse(200, detailHtml));

      await runDetail(
        db as any,
        { source: 'usoud', concurrency: 1, delay: 0, maxRetries: 0, limit: 0, dbPath: '', phase: 'detail' },
        () => false,
      );

      expect(fetchSpy).toHaveBeenCalledTimes(2);
      expect(db.saveDecision).toHaveBeenCalledWith(
        expect.objectContaining({
          vyrok: expect.stringContaining('Výrok je dostupný už na kartě.'),
        }),
      );
    });

    it('logs periodic progress report including current delay', async () => {
      const db = mockDb();
      db.getPendingUrls
        .mockReturnValueOnce([
          {
            url: 'https://nalus.usoud.cz/Search/ResultDetail.aspx?id=709',
            id: 1,
            source: 'usoud',
            status: 'pending',
            attempts: 0,
          },
        ])
        .mockReturnValueOnce([]);

      fetchSpy
        .mockResolvedValueOnce(mockSessionResponse())
        .mockResolvedValueOnce(mockDetailResponse(200, makeHtml({ ECLI: 'ECLI:CZ:US:2024:709' })));

      const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
      const setIntervalSpy = vi.spyOn(globalThis, 'setInterval').mockImplementation((fn: TimerHandler) => {
        (fn as () => void)();
        return 123 as unknown as ReturnType<typeof setInterval>;
      });
      const clearIntervalSpy = vi.spyOn(globalThis, 'clearInterval').mockImplementation(() => {});

      try {
        await runDetail(
          db as any,
          { source: 'usoud', concurrency: 1, delay: 0, maxRetries: 0, limit: 0, dbPath: '', phase: 'detail' },
          () => false,
        );

        expect(setIntervalSpy).toHaveBeenCalledWith(expect.any(Function), 30_000);
        expect(logSpy.mock.calls.some((call) => String(call[0]).includes('Delay: 0ms'))).toBe(true);
      } finally {
        logSpy.mockRestore();
        setIntervalSpy.mockRestore();
        clearIntervalSpy.mockRestore();
      }
    });
  });
});
