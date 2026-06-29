import * as cheerio from 'cheerio';
import { parseDetailPage, runDetailPhase } from './scraper.js';

const makeHtml = (jsonldBlocks: object[] = [], body = '') => `
<html>
<head>
  ${jsonldBlocks.map((j) => `<script type="application/ld+json">${JSON.stringify(j)}</script>`).join('\n')}
</head>
<body>${body}</body>
</html>
`;

const makeUrlRow = (overrides: Partial<any> = {}) => ({
  id: 1,
  url: 'https://www.firmy.cz/detail/123-firma-test.html',
  firmy_id: 123,
  slug: 'firma-test',
  url_type: 'detail',
  sitemap_file: null,
  status: 'pending',
  attempts: 0,
  last_attempt_at: null,
  error_message: null,
  ...overrides,
});

describe('firmy-cz parseDetailPage', () => {
  it('parses LocalBusiness JSON-LD and breadcrumb category path', () => {
    const html = makeHtml(
      [
        {
          '@type': 'LocalBusiness',
          name: 'Firma Test',
          description: 'Popis firmy',
          url: 'https://firma.example',
          telephone: '+420111222333',
          geo: { latitude: '50.087', longitude: '14.421' },
          address: {
            streetAddress: 'Václavské náměstí 1',
            addressLocality: 'Praha',
            postalCode: '11000',
            addressCountry: 'CZ',
          },
          openingHours: ['Mo-Fr 08:00-17:00'],
          aggregateRating: { ratingValue: '4.8', ratingCount: '37' },
          image: { url: 'https://img.example/hero.jpg' },
          sameAs: ['https://facebook.com/firma-test'],
        },
        {
          '@type': 'BreadcrumbList',
          itemListElement: [{ name: 'Firmy.cz' }, { name: 'Průmysl' }, { name: 'Strojírenství' }],
        },
      ],
      '',
    );

    const result = parseDetailPage(html, {
      id: 1,
      url: 'https://www.firmy.cz/detail/123-firma-test.html',
      firmy_id: 123,
      slug: 'firma-test',
      url_type: 'detail',
      sitemap_file: null,
      status: 'pending',
      attempts: 0,
      last_attempt_at: null,
      error_message: null,
    });

    expect(result.name).toBe('Firma Test');
    expect(result.website).toBe('https://firma.example');
    expect(result.telephone).toBe('+420111222333');
    expect(result.address_locality).toBe('Praha');
    expect(result.latitude).toBe(50.087);
    expect(result.longitude).toBe(14.421);
    expect(result.rating_value).toBe(4.8);
    expect(result.rating_count).toBe(37);
    expect(result.primary_image).toBe('https://img.example/hero.jpg');
    expect(result.category_path).toBe('Firmy.cz > Průmysl > Strojírenství');
    expect(JSON.parse(result.same_as_json!)).toEqual(['https://facebook.com/firma-test']);
  });

  it('extracts HTML fallback fields and deduplicates media/filters', () => {
    const body = `
      <a href="mailto:info@example.cz">Napište nám</a>
      <div>IČO: 12345678</div>
      <a href="https://portal.example/firmy.cz/restaurace">Restaurace</a>
      <span class="tag">Rozvoz</span>
      <span class="tag">Rozvoz</span>
      <img src="https://www.firmy.cz/images/a.jpg" />
      <img src="https://www.firmy.cz/images/a.jpg" />
      <img src="https://www.firmy.cz/images/logo.png" />
    `;

    const result = parseDetailPage(makeHtml([], body), {
      id: 2,
      url: 'https://www.firmy.cz/neoverena-firma/456-demo.html',
      firmy_id: 456,
      slug: 'demo',
      url_type: 'unverified',
      sitemap_file: null,
      status: 'pending',
      attempts: 0,
      last_attempt_at: null,
      error_message: null,
    });

    expect(result.email).toBe('info@example.cz');
    expect(result.ico).toBe('12345678');
    expect(result.image_count).toBe(1);
    expect(JSON.parse(result.image_urls!)).toEqual(['https://www.firmy.cz/images/a.jpg']);
    expect(JSON.parse(result.filters_json!)).toEqual(['Rozvoz']);
    expect(JSON.parse(result.categories_json!)).toEqual([
      { name: 'Restaurace', url: 'https://portal.example/firmy.cz/restaurace' },
    ]);
  });

  it('handles malformed JSON-LD gracefully', () => {
    const html = `
      <html>
      <head><script type="application/ld+json">{bad json</script></head>
      <body></body>
      </html>
    `;
    const result = parseDetailPage(html, {
      id: 3,
      url: 'https://www.firmy.cz/detail/999-malformed.html',
      firmy_id: 999,
      slug: 'malformed',
      url_type: 'detail',
      sitemap_file: null,
      status: 'pending',
      attempts: 0,
      last_attempt_at: null,
      error_message: null,
    });

    expect(result.url).toBe('https://www.firmy.cz/detail/999-malformed.html');
    expect(result.raw_jsonld).toBeDefined();
    expect(JSON.parse(result.raw_jsonld!)).toEqual([]);
  });

  // M1: malformed JSON-LD should log at debug (not silently skip)
  it('logs at debug when JSON-LD block is malformed (M1)', () => {
    const debugSpy = vi.spyOn(console, 'debug').mockImplementation(() => {});
    try {
      const html = `
        <html>
        <head>
          <script type="application/ld+json">{this is: not valid json!!}</script>
          <script type="application/ld+json">${JSON.stringify({ '@type': 'LocalBusiness', name: 'Valid' })}</script>
        </head>
        <body></body>
        </html>
      `;
      const result = parseDetailPage(html, {
        id: 99,
        url: 'https://www.firmy.cz/detail/99-debug-test.html',
        firmy_id: 99,
        slug: 'debug-test',
        url_type: 'detail',
        sitemap_file: null,
        status: 'pending',
        attempts: 0,
        last_attempt_at: null,
        error_message: null,
      });
      // Valid block should still be processed
      expect(result.name).toBe('Valid');
      // Malformed block should produce a debug log
      expect(debugSpy).toHaveBeenCalledWith(expect.stringContaining('JSON-LD'), expect.anything());
    } finally {
      debugSpy.mockRestore();
    }
  });

  it('extracts additional labeled fields, opening hours detail and data-src images', () => {
    const longLine = 'x'.repeat(120);
    const body = `
      <dl class="detailInfo">
        <dt>Datova schranka</dt><dd>abc123</dd>
        <dt>Datum zapisu</dt><dd>2020-01-01</dd>
        <dt>Pravni forma</dt><dd>s.r.o.</dd>
        <dt>Velikost</dt><dd>10-49</dd>
      </dl>
      <div class="hours-table">
        <div class="row">Po 08:00-17:00</div>
        <div class="row">${longLine}</div>
      </div>
      <img data-src="https://cdn.example/foto.jpg" />
      <img src="https://cdn.example/icon-help.png" />
      <span class="service"><span>Nested</span></span>
      <span class="service">Platba kartou</span>
    `;

    const result = parseDetailPage(
      makeHtml(
        [
          {
            '@type': ['Organization', 'Store'],
            name: 'Organization Demo',
            openingHours: 'Mo-Fr 09:00-18:00',
            image: 'https://cdn.example/hero.png',
          },
          {
            '@type': 'BreadcrumbList',
          },
        ],
        body,
      ),
      makeUrlRow(),
    );

    expect(result.name).toBe('Organization Demo');
    expect(result.opening_hours).toBe('Mo-Fr 09:00-18:00');
    expect(result.primary_image).toBe('https://cdn.example/hero.png');
    expect(result.datova_schranka).toBe('abc123');
    expect(result.datum_zapisu).toBe('2020-01-01');
    expect(result.pravni_forma).toBe('s.r.o.');
    expect(result.velikost_firmy).toBe('10-49');
    expect(result.opening_hours_detail).toContain('Po 08:00-17:00');
    expect(result.image_count).toBe(1);
    expect(JSON.parse(result.image_urls!)).toEqual(['https://cdn.example/foto.jpg']);
    expect(JSON.parse(result.filters_json!)).toEqual(['Platba kartou']);
  });

  it('handles invalid numeric JSON-LD values and null URL-row metadata', () => {
    const result = parseDetailPage(
      makeHtml([
        {
          '@type': 'LocalBusiness',
          geo: { latitude: 'not-a-number', longitude: '14.5' },
          aggregateRating: { ratingValue: '4.5', ratingCount: 'oops' },
          image: { url: 'https://img.example/x.jpg' },
          sameAs: 'https://facebook.com/not-array',
        },
      ]),
      makeUrlRow({ firmy_id: null, url_type: null }),
    );

    expect(result.firmy_id).toBeUndefined();
    expect(result.url_type).toBeUndefined();
    expect(result.latitude).toBeUndefined();
    expect(result.longitude).toBe(14.5);
    expect(result.rating_value).toBe(4.5);
    expect(result.rating_count).toBeUndefined();
    expect(result.primary_image).toBe('https://img.example/x.jpg');
    expect(result.same_as_json).toBeUndefined();
  });

  it('covers parser edge branches for empty JSON-LD, label fallbacks and skipped noisy HTML values', () => {
    const longName = 'Kategorie '.repeat(20);
    const html = `
      <html>
        <head>
          <script type="application/ld+json">   </script>
          <script type="application/ld+json">${JSON.stringify({
            '@type': 'WebSite',
            name: 'Ignored type',
          })}</script>
          <script type="application/ld+json">${JSON.stringify({
            '@type': 'LocalBusiness',
            name: 'Edge Firma',
            geo: { latitude: '50.1', longitude: 'n/a' },
            aggregateRating: { ratingValue: 'oops', ratingCount: '12' },
          })}</script>
        </head>
        <body>
          <a href="mailto:kontakt@example.cz?subject=hello">Kontakt</a>

          <dl class="detailInfo">
            <dt>Neznámý štítek</dt><div>Fallback hodnota</div>
            <dt>Datová schránka</dt><dd></dd>
          </dl>

          <a href="https://portal.example/firmy.cz/valid">Platná kategorie</a>
          <a href="https://portal.example/firmy.cz/too-long">${longName}</a>

          <span class="badge">A</span>
          <span class="badge">Platba kartou</span>
        </body>
      </html>
    `;

    const result = parseDetailPage(html, makeUrlRow());

    expect(result.name).toBe('Edge Firma');
    expect(result.latitude).toBe(50.1);
    expect(result.longitude).toBeUndefined();
    expect(result.rating_value).toBeUndefined();
    expect(result.rating_count).toBe(12);
    expect(result.email).toBe('kontakt@example.cz');
    expect(result.datova_schranka).toBeUndefined();
    expect(result.category_path).toBeUndefined();
    expect(JSON.parse(result.categories_json!)).toEqual([
      { name: 'Platná kategorie', url: 'https://portal.example/firmy.cz/valid' },
    ]);
    expect(JSON.parse(result.filters_json!)).toEqual(['Platba kartou']);
    expect(JSON.parse(result.raw_jsonld!)).toHaveLength(2);
  });

  it('handles defensive href fallback when anchor attr lookup returns undefined', () => {
    const selectionProto = Object.getPrototypeOf(
      Object.getPrototypeOf(cheerio.load('<a href="mailto:x@y.z">x</a>')('a')),
    ) as { attr: (...args: unknown[]) => unknown };
    const originalAttr = selectionProto.attr;
    const attrSpy = vi.spyOn(selectionProto, 'attr').mockImplementation(function (this: unknown, ...args: unknown[]) {
      if (args.length === 1 && args[0] === 'href') {
        const firstNode = (this as { [index: number]: { name?: string } })[0];
        if (firstNode?.name === 'a') return undefined;
      }
      return originalAttr.apply(this, args);
    });

    try {
      const html = makeHtml(
        [],
        `
          <a href="mailto:kontakt@example.cz">Kontakt</a>
          <a href="https://portal.example/firmy.cz/restaurace">Restaurace</a>
        `,
      );
      const result = parseDetailPage(html, makeUrlRow());

      expect(result.email).toBeUndefined();
      expect(result.categories_json).toBeUndefined();
    } finally {
      attrSpy.mockRestore();
    }
  });
});

describe('firmy-cz runDetailPhase', () => {
  const fetchMock = vi.fn();

  beforeEach(() => {
    vi.clearAllMocks();
    vi.stubGlobal('fetch', fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('processes pending URL and saves business data', async () => {
    const db = {
      getUrlCounts: vi.fn().mockReturnValue({ total: 1, pending: 1, failed: 0, scraped: 0, gone: 0 }),
      getPendingUrls: vi
        .fn()
        .mockReturnValueOnce([
          {
            id: 1,
            url: 'https://www.firmy.cz/detail/123-test.html',
            firmy_id: 123,
            slug: 'test',
            url_type: 'detail',
            sitemap_file: null,
            status: 'pending',
            attempts: 0,
            last_attempt_at: null,
            error_message: null,
          },
        ])
        .mockReturnValueOnce([]),
      startRun: vi.fn().mockReturnValue(501),
      finishRun: vi.fn(),
      saveBusiness: vi.fn(),
      markFailed: vi.fn(),
      markGone: vi.fn(),
    };

    fetchMock.mockResolvedValue({
      status: 200,
      headers: { get: () => null },
      text: async () =>
        makeHtml([
          {
            '@type': 'LocalBusiness',
            name: 'Detail Test',
          },
        ]),
    });

    await runDetailPhase(
      db as any,
      {
        phase: 'detail',
        concurrency: 1,
        delay: 0,
        maxRetries: 0,
        limit: 0,
        dbPath: '',
      },
      () => false,
    );

    expect(db.saveBusiness).toHaveBeenCalledTimes(1);
    expect(db.markFailed).not.toHaveBeenCalled();
    expect(db.markGone).not.toHaveBeenCalled();
    expect(db.finishRun).toHaveBeenCalledWith(501, 1, 1, 0, 'completed');
  });

  it('marks URL gone on 404 response', async () => {
    const db = {
      getUrlCounts: vi.fn().mockReturnValue({ total: 1, pending: 1, failed: 0, scraped: 0, gone: 0 }),
      getPendingUrls: vi
        .fn()
        .mockReturnValueOnce([
          {
            id: 1,
            url: 'https://www.firmy.cz/detail/404-missing.html',
            firmy_id: 404,
            slug: 'missing',
            url_type: 'detail',
            sitemap_file: null,
            status: 'pending',
            attempts: 0,
            last_attempt_at: null,
            error_message: null,
          },
        ])
        .mockReturnValueOnce([]),
      startRun: vi.fn().mockReturnValue(502),
      finishRun: vi.fn(),
      saveBusiness: vi.fn(),
      markFailed: vi.fn(),
      markGone: vi.fn(),
    };

    fetchMock.mockResolvedValue({
      status: 404,
      headers: { get: () => null },
      text: async () => '',
    });

    await runDetailPhase(
      db as any,
      {
        phase: 'detail',
        concurrency: 1,
        delay: 0,
        maxRetries: 0,
        limit: 0,
        dbPath: '',
      },
      () => false,
    );

    expect(db.saveBusiness).not.toHaveBeenCalled();
    expect(db.markGone).toHaveBeenCalledWith('https://www.firmy.cz/detail/404-missing.html');
    expect(db.finishRun).toHaveBeenCalledWith(502, 1, 0, 1, 'completed');
  });

  it('returns early when there are no pending or failed URLs', async () => {
    const db = {
      getUrlCounts: vi.fn().mockReturnValue({ total: 0, pending: 0, failed: 0, scraped: 0, gone: 0 }),
      getPendingUrls: vi.fn(),
      startRun: vi.fn(),
      finishRun: vi.fn(),
      saveBusiness: vi.fn(),
      markFailed: vi.fn(),
      markGone: vi.fn(),
    };

    await runDetailPhase(
      db as any,
      { phase: 'detail', concurrency: 1, delay: 0, maxRetries: 0, limit: 0, dbPath: '' },
      () => false,
    );

    expect(db.startRun).not.toHaveBeenCalled();
    expect(db.finishRun).not.toHaveBeenCalled();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('marks URL gone on 410 response', async () => {
    const db = {
      getUrlCounts: vi.fn().mockReturnValue({ total: 1, pending: 1, failed: 0, scraped: 0, gone: 0 }),
      getPendingUrls: vi
        .fn()
        .mockReturnValueOnce([makeUrlRow({ url: 'https://www.firmy.cz/detail/410-gone.html' })])
        .mockReturnValueOnce([]),
      startRun: vi.fn().mockReturnValue(503),
      finishRun: vi.fn(),
      saveBusiness: vi.fn(),
      markFailed: vi.fn(),
      markGone: vi.fn(),
    };

    fetchMock.mockResolvedValue({
      status: 410,
      headers: { get: () => null },
      text: async () => '',
    });

    await runDetailPhase(
      db as any,
      { phase: 'detail', concurrency: 1, delay: 0, maxRetries: 0, limit: 0, dbPath: '' },
      () => false,
    );

    expect(db.markGone).toHaveBeenCalledWith('https://www.firmy.cz/detail/410-gone.html');
    expect(db.markFailed).not.toHaveBeenCalled();
    expect(db.finishRun).toHaveBeenCalledWith(503, 1, 0, 1, 'completed');
  });

  it('handles 429 with retry and then marks failed when retries are exhausted', async () => {
    const db = {
      getUrlCounts: vi.fn().mockReturnValue({ total: 1, pending: 1, failed: 0, scraped: 0, gone: 0 }),
      getPendingUrls: vi
        .fn()
        .mockReturnValueOnce([makeUrlRow({ url: 'https://www.firmy.cz/detail/429-rate-limit.html' })])
        .mockReturnValueOnce([]),
      startRun: vi.fn().mockReturnValue(504),
      finishRun: vi.fn(),
      saveBusiness: vi.fn(),
      markFailed: vi.fn(),
      markGone: vi.fn(),
    };

    const randomSpy = vi.spyOn(Math, 'random').mockReturnValue(0);
    fetchMock.mockResolvedValue({
      status: 429,
      headers: { get: (name: string) => (name.toLowerCase() === 'retry-after' ? '0' : null) },
      text: async () => '',
    });

    try {
      await runDetailPhase(
        db as any,
        { phase: 'detail', concurrency: 1, delay: 0, maxRetries: 1, limit: 0, dbPath: '' },
        () => false,
      );
    } finally {
      randomSpy.mockRestore();
    }

    // KT-A8: 429 responses are now classified by the block detector first,
    // so the failure message comes from the block path (not the legacy
    // "Rate limited (429)" line).
    expect(db.markFailed).toHaveBeenCalledWith(
      'https://www.firmy.cz/detail/429-rate-limit.html',
      'Block detected (rate_limit)',
    );
    expect(db.markGone).not.toHaveBeenCalled();
    expect(db.finishRun).toHaveBeenCalledWith(504, 1, 0, 1, 'completed');
  });

  it('marks URL as failed on server errors and unexpected status codes', async () => {
    const db = {
      getUrlCounts: vi.fn().mockReturnValue({ total: 2, pending: 2, failed: 0, scraped: 0, gone: 0 }),
      getPendingUrls: vi
        .fn()
        .mockReturnValueOnce([
          makeUrlRow({ url: 'https://www.firmy.cz/detail/500-error.html' }),
          makeUrlRow({ id: 2, url: 'https://www.firmy.cz/detail/302-unexpected.html' }),
        ])
        .mockReturnValueOnce([]),
      startRun: vi.fn().mockReturnValue(505),
      finishRun: vi.fn(),
      saveBusiness: vi.fn(),
      markFailed: vi.fn(),
      markGone: vi.fn(),
    };

    fetchMock.mockResolvedValueOnce({
      status: 500,
      headers: { get: () => null },
      text: async () => '',
    });
    fetchMock.mockResolvedValueOnce({
      status: 302,
      headers: { get: () => null },
      text: async () => '',
    });

    await runDetailPhase(
      db as any,
      { phase: 'detail', concurrency: 1, delay: 0, maxRetries: 0, limit: 0, dbPath: '' },
      () => false,
    );

    expect(db.markFailed).toHaveBeenCalledTimes(2);
    expect(db.markFailed).toHaveBeenNthCalledWith(
      1,
      'https://www.firmy.cz/detail/500-error.html',
      'Server error (500)',
    );
    expect(db.markFailed).toHaveBeenNthCalledWith(
      2,
      'https://www.firmy.cz/detail/302-unexpected.html',
      'Unexpected status 302',
    );
    expect(db.saveBusiness).not.toHaveBeenCalled();
    expect(db.finishRun).toHaveBeenCalledWith(505, 2, 0, 2, 'completed');
  });

  it('respects limit and reports interrupted when shutdown is requested', async () => {
    const db = {
      getUrlCounts: vi.fn().mockReturnValue({ total: 3, pending: 3, failed: 0, scraped: 0, gone: 0 }),
      getPendingUrls: vi.fn().mockReturnValue([makeUrlRow(), makeUrlRow({ id: 2 }), makeUrlRow({ id: 3 })]),
      startRun: vi.fn().mockReturnValue(506),
      finishRun: vi.fn(),
      saveBusiness: vi.fn(),
      markFailed: vi.fn(),
      markGone: vi.fn(),
    };

    let calls = 0;
    fetchMock.mockResolvedValue({
      status: 200,
      headers: { get: () => null },
      text: async () => makeHtml([{ '@type': 'LocalBusiness', name: 'Limited' }]),
    });

    await runDetailPhase(
      db as any,
      { phase: 'detail', concurrency: 1, delay: 0, maxRetries: 0, limit: 1, dbPath: '' },
      () => {
        calls++;
        return calls > 1;
      },
    );

    expect(db.getPendingUrls).toHaveBeenCalledWith(0, 1);
    expect(db.finishRun).toHaveBeenCalledWith(506, 1, 0, 0, 'interrupted');
  });

  it('stops after reaching limit when not shutting down', async () => {
    const db = {
      getUrlCounts: vi.fn().mockReturnValue({ total: 2, pending: 2, failed: 0, scraped: 0, gone: 0 }),
      getPendingUrls: vi
        .fn()
        .mockReturnValueOnce([makeUrlRow({ url: 'https://www.firmy.cz/detail/limit-only-one.html' })])
        .mockReturnValueOnce([]),
      startRun: vi.fn().mockReturnValue(507),
      finishRun: vi.fn(),
      saveBusiness: vi.fn(),
      markFailed: vi.fn(),
      markGone: vi.fn(),
    };

    fetchMock.mockResolvedValue({
      status: 200,
      headers: { get: () => null },
      text: async () => makeHtml([{ '@type': 'LocalBusiness', name: 'One' }]),
    });

    await runDetailPhase(
      db as any,
      { phase: 'detail', concurrency: 1, delay: 0, maxRetries: 0, limit: 1, dbPath: '' },
      () => false,
    );

    expect(db.getPendingUrls).toHaveBeenCalledTimes(1);
    expect(db.getPendingUrls).toHaveBeenCalledWith(0, 1);
    expect(db.finishRun).toHaveBeenCalledWith(507, 1, 1, 0, 'completed');
  });

  it('executes periodic progress callback and logs delay in progress line', async () => {
    const db = {
      getUrlCounts: vi.fn().mockReturnValue({ total: 1, pending: 1, failed: 0, scraped: 0, gone: 0 }),
      getPendingUrls: vi.fn().mockReturnValueOnce([]),
      startRun: vi.fn().mockReturnValue(508),
      finishRun: vi.fn(),
      saveBusiness: vi.fn(),
      markFailed: vi.fn(),
      markGone: vi.fn(),
    };

    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const setIntervalSpy = vi.spyOn(globalThis, 'setInterval').mockImplementation(((handler: unknown) => {
      if (typeof handler === 'function') handler();
      return 321 as ReturnType<typeof setInterval>;
    }) as typeof setInterval);
    const clearIntervalSpy = vi.spyOn(globalThis, 'clearInterval');

    try {
      await runDetailPhase(
        db as any,
        { phase: 'detail', concurrency: 1, delay: 0, maxRetries: 0, limit: 0, dbPath: '' },
        () => false,
      );

      expect(setIntervalSpy).toHaveBeenCalled();
      expect(logSpy.mock.calls.some(([msg]) => String(msg).includes('Delay: 0ms'))).toBe(true);
      expect(clearIntervalSpy).toHaveBeenCalledWith(321);
    } finally {
      clearIntervalSpy.mockRestore();
      setIntervalSpy.mockRestore();
      logSpy.mockRestore();
    }
  });

  // ────────────────────────────────────────────────────────────────────
  // KT-A8 — block detection integration. Each case proves that a block
  // signature does NOT silently land as an empty BusinessData row, and
  // that the URL is marked failed with a deterministic block_type tag in
  // the audit log line.
  // ────────────────────────────────────────────────────────────────────

  it('KT-A8: Cloudflare 200 challenge does not save empty business and is marked failed', async () => {
    const db = {
      getUrlCounts: vi.fn().mockReturnValue({ total: 1, pending: 1, failed: 0, scraped: 0, gone: 0 }),
      getPendingUrls: vi
        .fn()
        .mockReturnValueOnce([makeUrlRow({ url: 'https://www.firmy.cz/detail/cf-200-challenge.html' })])
        .mockReturnValueOnce([]),
      startRun: vi.fn().mockReturnValue(610),
      finishRun: vi.fn(),
      saveBusiness: vi.fn(),
      markFailed: vi.fn(),
      markGone: vi.fn(),
    };

    fetchMock.mockResolvedValue({
      status: 200,
      headers: {
        get: (name: string) => (name.toLowerCase() === 'cf-ray' ? 'abc-PRG' : null),
      },
      text: async () =>
        '<!DOCTYPE html><html><head><title>Just a moment...</title></head><body>Checking your browser</body></html>',
    });

    const warnLines: string[] = [];
    const origWarn = console.warn;
    console.warn = (...args: unknown[]) => {
      warnLines.push(args.map(String).join(' '));
    };
    try {
      await runDetailPhase(
        db as any,
        { phase: 'detail', concurrency: 1, delay: 0, maxRetries: 0, limit: 0, dbPath: '' },
        () => false,
      );
    } finally {
      console.warn = origWarn;
    }

    expect(db.saveBusiness).not.toHaveBeenCalled();
    expect(db.markFailed).toHaveBeenCalledWith(
      'https://www.firmy.cz/detail/cf-200-challenge.html',
      'Block detected (cloudflare)',
    );
    expect(warnLines.some((line) => line.includes('"op":"firmy_cz.detect_block"'))).toBe(true);
    expect(warnLines.some((line) => line.includes('"block_type":"cloudflare"'))).toBe(true);
  });

  it('KT-A8: reCAPTCHA 200 widget marks URL failed with captcha tag', async () => {
    const db = {
      getUrlCounts: vi.fn().mockReturnValue({ total: 1, pending: 1, failed: 0, scraped: 0, gone: 0 }),
      getPendingUrls: vi
        .fn()
        .mockReturnValueOnce([makeUrlRow({ url: 'https://www.firmy.cz/detail/recaptcha-page.html' })])
        .mockReturnValueOnce([]),
      startRun: vi.fn().mockReturnValue(611),
      finishRun: vi.fn(),
      saveBusiness: vi.fn(),
      markFailed: vi.fn(),
      markGone: vi.fn(),
    };

    fetchMock.mockResolvedValue({
      status: 200,
      headers: { get: () => null },
      text: async () => '<html><body><div class="g-recaptcha" data-sitekey="abc"></div></body></html>',
    });

    const warnLines: string[] = [];
    const origWarn = console.warn;
    console.warn = (...args: unknown[]) => {
      warnLines.push(args.map(String).join(' '));
    };
    try {
      await runDetailPhase(
        db as any,
        { phase: 'detail', concurrency: 1, delay: 0, maxRetries: 0, limit: 0, dbPath: '' },
        () => false,
      );
    } finally {
      console.warn = origWarn;
    }

    expect(db.saveBusiness).not.toHaveBeenCalled();
    expect(db.markFailed).toHaveBeenCalledWith(
      'https://www.firmy.cz/detail/recaptcha-page.html',
      'Block detected (captcha)',
    );
    expect(warnLines.some((line) => line.includes('"block_type":"captcha"'))).toBe(true);
  });

  it('KT-A8: plain 403 surfaces as forbidden block', async () => {
    const db = {
      getUrlCounts: vi.fn().mockReturnValue({ total: 1, pending: 1, failed: 0, scraped: 0, gone: 0 }),
      getPendingUrls: vi
        .fn()
        .mockReturnValueOnce([makeUrlRow({ url: 'https://www.firmy.cz/detail/forbidden.html' })])
        .mockReturnValueOnce([]),
      startRun: vi.fn().mockReturnValue(612),
      finishRun: vi.fn(),
      saveBusiness: vi.fn(),
      markFailed: vi.fn(),
      markGone: vi.fn(),
    };

    fetchMock.mockResolvedValue({
      status: 403,
      headers: { get: (name: string) => (name.toLowerCase() === 'server' ? 'nginx' : null) },
      text: async () => '<h1>403 Forbidden</h1>',
    });

    const warnLines: string[] = [];
    const origWarn = console.warn;
    console.warn = (...args: unknown[]) => {
      warnLines.push(args.map(String).join(' '));
    };
    try {
      await runDetailPhase(
        db as any,
        { phase: 'detail', concurrency: 1, delay: 0, maxRetries: 0, limit: 0, dbPath: '' },
        () => false,
      );
    } finally {
      console.warn = origWarn;
    }

    expect(db.saveBusiness).not.toHaveBeenCalled();
    expect(db.markFailed).toHaveBeenCalledWith(
      'https://www.firmy.cz/detail/forbidden.html',
      'Block detected (forbidden)',
    );
    expect(warnLines.some((line) => line.includes('"block_type":"forbidden"'))).toBe(true);
  });

  it('KT-A8: clean 200 + valid HTML does not log a block warning', async () => {
    const db = {
      getUrlCounts: vi.fn().mockReturnValue({ total: 1, pending: 1, failed: 0, scraped: 0, gone: 0 }),
      getPendingUrls: vi
        .fn()
        .mockReturnValueOnce([makeUrlRow({ url: 'https://www.firmy.cz/detail/clean.html' })])
        .mockReturnValueOnce([]),
      startRun: vi.fn().mockReturnValue(613),
      finishRun: vi.fn(),
      saveBusiness: vi.fn(),
      markFailed: vi.fn(),
      markGone: vi.fn(),
    };

    fetchMock.mockResolvedValue({
      status: 200,
      headers: { get: () => null },
      text: async () => makeHtml([{ '@type': 'LocalBusiness', name: 'Clean Co' }]),
    });

    const warnLines: string[] = [];
    const origWarn = console.warn;
    console.warn = (...args: unknown[]) => {
      warnLines.push(args.map(String).join(' '));
    };
    try {
      await runDetailPhase(
        db as any,
        { phase: 'detail', concurrency: 1, delay: 0, maxRetries: 0, limit: 0, dbPath: '' },
        () => false,
      );
    } finally {
      console.warn = origWarn;
    }

    expect(db.saveBusiness).toHaveBeenCalled();
    expect(db.markFailed).not.toHaveBeenCalled();
    expect(warnLines.some((line) => line.includes('firmy_cz.detect_block'))).toBe(false);
  });
});
