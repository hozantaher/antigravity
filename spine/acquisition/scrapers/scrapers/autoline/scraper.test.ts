import * as cheerio from 'cheerio';
import { parseDetailPage, runDetailPhase } from './scraper.js';

vi.mock('../../lib/fetch.js', async (importOriginal) => {
  const actual = (await importOriginal()) as Record<string, unknown>;
  return { ...actual, fetchPage: vi.fn() };
});

const makeHtml = (jsonld: object[], specsHtml = '') => `
<html>
<head>
  ${jsonld.map((j) => `<script type="application/ld+json">${JSON.stringify(j)}</script>`).join('\n')}
</head>
<body>${specsHtml}</body>
</html>
`;

describe('parseDetailPage', () => {
  it('parses Product JSON-LD', () => {
    const html = makeHtml([
      {
        '@type': 'Product',
        name: 'Volvo FH 500',
        description: 'Great truck',
        sku: 'ABC123',
        brand: { name: 'Volvo' },
        model: 'FH 500',
        offers: {
          price: 45000,
          priceCurrency: 'EUR',
          itemCondition: 'UsedCondition',
          availability: 'InStock',
        },
        image: ['https://img1.jpg', 'https://img2.jpg'],
        aggregateRating: { ratingValue: '4.5', reviewCount: '10' },
      },
    ]);

    const result = parseDetailPage(html, 'https://autoline.cz/truck--12345');
    expect(result.name).toBe('Volvo FH 500');
    expect(result.brand).toBe('Volvo');
    expect(result.model).toBe('FH 500');
    expect(result.price).toBe(45000);
    expect(result.price_currency).toBe('EUR');
    expect(result.item_condition).toBe('UsedCondition');
    expect(result.image_count).toBe(2);
    expect(result.aggregate_rating).toBe(4.5);
    expect(result.review_count).toBe(10);
    expect(result.autoline_id).toBe('12345');
  });

  it('parses ImageObject JSON-LD', () => {
    const html = makeHtml([
      {
        '@type': 'ImageObject',
        author: 'Dealer XYZ',
        contentLocation: 'Prague',
        datePublished: '2024-01-01',
      },
    ]);

    const result = parseDetailPage(html, 'https://autoline.cz/x--99');
    expect(result.seller_name).toBe('Dealer XYZ');
    expect(result.content_location).toBe('Prague');
    expect(result.date_published).toBe('2024-01-01');
  });

  it('parses BreadcrumbList JSON-LD', () => {
    const html = makeHtml([
      {
        '@type': 'BreadcrumbList',
        itemListElement: [{ name: 'Home' }, { name: 'Trucks' }, { name: 'Volvo FH' }],
      },
    ]);

    const result = parseDetailPage(html, 'https://autoline.cz/x--1');
    expect(result.category_path).toBe('Home > Trucks > Volvo FH');
    expect(result.category).toBe('Trucks');
  });

  it('parses HTML specs', () => {
    const specsHtml = `
      <div class="block" data-id="main">
        <div class="item"><span class="field">Typ:</span><span class="value">Tahač</span></div>
        <div class="item"><span class="field">Najeto:</span><span class="value">500 000 km</span></div>
        <span class="loc-country">CZ</span>
        <span class="loc-city">Praha</span>
      </div>
      <div class="block" data-id="engine">
        <div class="item"><span class="field">Palivo:</span><span class="value">Diesel</span></div>
      </div>
      <div class="block" data-id="condition">
        <div class="item"><span class="field">VIN:</span><span class="value">WDB123</span></div>
      </div>
    `;

    const result = parseDetailPage(makeHtml([], specsHtml), 'https://autoline.cz/x--1');
    expect(result.vehicle_type).toBe('Tahač');
    expect(result.mileage).toBe('500 000 km');
    expect(result.mileage_km).toBe(500000);
    expect(result.location_country).toBe('CZ');
    expect(result.location_city).toBe('Praha');
    expect(result.fuel_type).toBe('Diesel');
    expect(result.vin).toBe('WDB123');
  });

  it('parses features with tick class', () => {
    const specsHtml = `
      <div class="block" data-id="additional-options">
        <div class="item with-tick"><span class="field">ABS:</span><span class="value"></span></div>
        <div class="item with-tick"><span class="field">ESP:</span><span class="value">Ano</span></div>
      </div>
    `;

    const result = parseDetailPage(makeHtml([], specsHtml), 'https://autoline.cz/x--1');
    const features = JSON.parse(result.features!);
    expect(features).toContain('ABS');
    expect(features).toContain('ESP: Ano');
  });

  it('handles missing JSON-LD gracefully', () => {
    const html = '<html><head></head><body></body></html>';
    const result = parseDetailPage(html, 'https://autoline.cz/x--1');
    expect(result.url).toBe('https://autoline.cz/x--1');
    expect(result.name).toBeUndefined();
  });

  it('handles malformed JSON-LD gracefully', () => {
    const html = `<html><head><script type="application/ld+json">{bad json</script></head><body></body></html>`;
    const result = parseDetailPage(html, 'https://autoline.cz/x--1');
    expect(result.url).toBe('https://autoline.cz/x--1');
  });

  // M1: malformed JSON-LD should log at debug (not silently skip)
  it('logs at console.debug when JSON-LD block is malformed (M1)', () => {
    const debugSpy = vi.spyOn(console, 'debug').mockImplementation(() => {});
    try {
      const html = `
        <html>
        <head>
          <script type="application/ld+json">{this is: not valid!}</script>
          <script type="application/ld+json">${JSON.stringify({ '@type': 'Product', name: 'ValidTruck' })}</script>
        </head>
        <body></body>
        </html>
      `;
      const result = parseDetailPage(html, 'https://autoline.cz/truck--999');
      expect(result.name).toBe('ValidTruck');
      expect(debugSpy).toHaveBeenCalledWith(
        expect.stringContaining('JSON-LD'),
        expect.anything(),
      );
    } finally {
      debugSpy.mockRestore();
    }
  });

  it('handles empty specs', () => {
    const result = parseDetailPage(makeHtml([]), 'https://autoline.cz/x--1');
    expect(result.raw_specs_json).toBe('{}');
    expect(result.features).toBeUndefined();
  });

  it('extracts autoline_id from URL', () => {
    const result = parseDetailPage(makeHtml([]), 'https://autoline.cz/truck--54321');
    expect(result.autoline_id).toBe('54321');
  });

  it('handles URL without autoline_id', () => {
    const result = parseDetailPage(makeHtml([]), 'https://autoline.cz/no-id');
    expect(result.autoline_id).toBeUndefined();
  });

  it('handles price as string', () => {
    const html = makeHtml([
      {
        '@type': 'Product',
        offers: { price: '12345.67', priceCurrency: 'CZK' },
      },
    ]);
    const result = parseDetailPage(html, 'https://autoline.cz/x--1');
    expect(result.price).toBe(12345.67);
  });

  it('handles array @type', () => {
    const html = makeHtml([
      {
        '@type': ['Product', 'Vehicle'],
        name: 'Multi-type',
      },
    ]);
    const result = parseDetailPage(html, 'https://autoline.cz/x--1');
    expect(result.name).toBe('Multi-type');
  });

  it('stores raw JSON-LD and specs', () => {
    const jsonld = { '@type': 'Product', name: 'Test' };
    const result = parseDetailPage(makeHtml([jsonld]), 'https://autoline.cz/x--1');
    expect(result.raw_jsonld).toBeDefined();
    expect(JSON.parse(result.raw_jsonld!)).toEqual([jsonld]);
  });

  it('skips empty JSON-LD script blocks', () => {
    const html = `<html><head><script type="application/ld+json">   </script></head><body></body></html>`;
    const result = parseDetailPage(html, 'https://autoline.cz/x--1');
    expect(JSON.parse(result.raw_jsonld!)).toEqual([]);
  });

  it('handles breadcrumb with a single item and unknown JSON-LD type', () => {
    const html = makeHtml([
      { '@type': 'Thing', name: 'Ignored' },
      { '@type': 'BreadcrumbList', itemListElement: [{ name: 'Only One' }] },
    ]);

    const result = parseDetailPage(html, 'https://autoline.cz/x--1');
    expect(result.category_path).toBe('Only One');
    expect(result.category).toBeUndefined();
  });

  it('keeps breadcrumb fields undefined when itemListElement is missing', () => {
    const html = makeHtml([{ '@type': 'BreadcrumbList' }]);
    const result = parseDetailPage(html, 'https://autoline.cz/x--1');
    expect(result.category_path).toBeUndefined();
    expect(result.category).toBeUndefined();
  });

  it('keeps features undefined for empty with-tick labels', () => {
    const specsHtml = `
      <div class="block" data-id="additional-options">
        <div class="item with-tick"><span class="field">:</span><span class="value"></span></div>
      </div>
    `;

    const result = parseDetailPage(makeHtml([], specsHtml), 'https://autoline.cz/x--1');
    expect(result.features).toBeUndefined();
  });

  it('stores specs for unknown block ids and handles non-numeric mileage', () => {
    const specsHtml = `
      <div class="block" data-id="mystery">
        <div class="item"><span class="field">Neznámé:</span><span class="value">hodnota</span></div>
      </div>
      <div class="block" data-id="main">
        <div class="item"><span class="field">Najeto:</span><span class="value">bez km</span></div>
      </div>
    `;

    const result = parseDetailPage(makeHtml([], specsHtml), 'https://autoline.cz/x--1');
    expect(result.mileage).toBe('bez km');
    expect(result.mileage_km).toBeUndefined();
    const raw = JSON.parse(result.raw_specs_json!);
    expect(raw.mystery['Neznámé']).toBe('hodnota');
  });

  it('handles defensive fallback when block data-id attr is unavailable and field label is empty', () => {
    const selectionProto = Object.getPrototypeOf(
      Object.getPrototypeOf(cheerio.load('<div data-id="main"></div>')('div')),
    ) as { attr: (...args: unknown[]) => unknown };
    const originalAttr = selectionProto.attr;
    const attrSpy = vi.spyOn(selectionProto, 'attr').mockImplementation(function (this: unknown, ...args: unknown[]) {
      if (args.length === 1 && args[0] === 'data-id') {
        const firstNode = (this as { [index: number]: { name?: string } })[0];
        if (firstNode?.name === 'div') return undefined;
      }
      return originalAttr.apply(this, args);
    });

    try {
      const specsHtml = `
        <div class="block" data-id="main">
          <div class="item"><span class="field"></span><span class="value">hodnota</span></div>
        </div>
      `;
      const result = parseDetailPage(makeHtml([], specsHtml), 'https://autoline.cz/x--1');
      const raw = JSON.parse(result.raw_specs_json!);

      expect(raw.unknown).toEqual({});
    } finally {
      attrSpy.mockRestore();
    }
  });
});

describe('runDetailPhase', () => {
  let fetchPage: ReturnType<typeof vi.fn>;

  beforeAll(async () => {
    const mod = await import('../../lib/fetch.js');
    fetchPage = mod.fetchPage as ReturnType<typeof vi.fn>;
  });

  const mockDb = () => ({
    getUrlCounts: vi.fn().mockReturnValue({ total: 2, pending: 2, scraped: 0, failed: 0, gone: 0 }),
    getPendingUrls: vi.fn(),
    startRun: vi.fn().mockReturnValue(1),
    finishRun: vi.fn(),
    saveListing: vi.fn(),
    markFailed: vi.fn(),
    markGone: vi.fn(),
  });

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('processes URLs and saves listings', async () => {
    const db = mockDb();
    db.getPendingUrls
      .mockReturnValueOnce([{ url: 'https://autoline.cz/truck--1', id: 1, status: 'pending', attempts: 0 }])
      .mockReturnValueOnce([]);

    const html = makeHtml([{ '@type': 'Product', name: 'Truck 1' }]);
    fetchPage.mockResolvedValue({ status: 200, html, retryAfter: undefined });

    await runDetailPhase(
      db as any,
      { concurrency: 1, delay: 0, maxRetries: 1, limit: 0, dbPath: '', phase: 'detail' },
      () => false,
    );

    expect(db.saveListing).toHaveBeenCalledTimes(1);
    expect(db.finishRun).toHaveBeenCalledWith(1, 2, 1, 0, 'completed');
  });

  it('handles 404 by marking gone', async () => {
    const db = mockDb();
    db.getPendingUrls
      .mockReturnValueOnce([{ url: 'https://autoline.cz/truck--1', id: 1, status: 'pending', attempts: 0 }])
      .mockReturnValueOnce([]);

    fetchPage.mockResolvedValue({ status: 404, html: '' });

    await runDetailPhase(
      db as any,
      { concurrency: 1, delay: 0, maxRetries: 0, limit: 0, dbPath: '', phase: 'detail' },
      () => false,
    );

    expect(db.markGone).toHaveBeenCalledWith('https://autoline.cz/truck--1');
  });

  it('handles 500 by marking failed after retries', async () => {
    const db = mockDb();
    db.getPendingUrls
      .mockReturnValueOnce([{ url: 'https://autoline.cz/truck--1', id: 1, status: 'pending', attempts: 0 }])
      .mockReturnValueOnce([]);

    fetchPage.mockResolvedValue({ status: 500, html: '' });

    await runDetailPhase(
      db as any,
      { concurrency: 1, delay: 0, maxRetries: 0, limit: 0, dbPath: '', phase: 'detail' },
      () => false,
    );

    expect(db.markFailed).toHaveBeenCalled();
  });

  it('handles 429 rate limiting', async () => {
    const db = mockDb();
    db.getPendingUrls
      .mockReturnValueOnce([{ url: 'https://autoline.cz/truck--1', id: 1, status: 'pending', attempts: 0 }])
      .mockReturnValueOnce([]);

    const html = makeHtml([{ '@type': 'Product', name: 'Truck' }]);
    fetchPage.mockResolvedValueOnce({ status: 429, html: '', retryAfter: 1 }).mockResolvedValue({ status: 200, html });

    await runDetailPhase(
      db as any,
      { concurrency: 1, delay: 0, maxRetries: 2, limit: 0, dbPath: '', phase: 'detail' },
      () => false,
    );

    expect(db.saveListing).toHaveBeenCalled();
  });

  it('respects limit', async () => {
    const db = mockDb();
    db.getUrlCounts.mockReturnValue({ total: 10, pending: 10, scraped: 0, failed: 0, gone: 0 });
    db.getPendingUrls.mockReturnValue([{ url: 'https://autoline.cz/truck--1', id: 1, status: 'pending', attempts: 0 }]);

    const html = makeHtml([{ '@type': 'Product', name: 'Truck' }]);
    fetchPage.mockResolvedValue({ status: 200, html });

    await runDetailPhase(
      db as any,
      { concurrency: 1, delay: 0, maxRetries: 0, limit: 1, dbPath: '', phase: 'detail' },
      () => false,
    );

    expect(db.finishRun).toHaveBeenCalledWith(1, 1, expect.any(Number), expect.any(Number), 'completed');
  });

  it('stops on shutdown', async () => {
    const db = mockDb();
    db.getPendingUrls.mockReturnValue([{ url: 'https://autoline.cz/truck--1', id: 1, status: 'pending', attempts: 0 }]);

    await runDetailPhase(
      db as any,
      { concurrency: 1, delay: 0, maxRetries: 0, limit: 0, dbPath: '', phase: 'detail' },
      () => true,
    );

    expect(db.finishRun).toHaveBeenCalledWith(1, 2, 0, 0, 'interrupted');
  });

  it('handles no pending URLs', async () => {
    const db = mockDb();
    db.getUrlCounts.mockReturnValue({ total: 0, pending: 0, scraped: 0, failed: 0, gone: 0 });

    await runDetailPhase(
      db as any,
      { concurrency: 1, delay: 0, maxRetries: 0, limit: 0, dbPath: '', phase: 'detail' },
      () => false,
    );

    expect(db.startRun).not.toHaveBeenCalled();
  });

  it('handles unexpected status codes', async () => {
    const db = mockDb();
    db.getPendingUrls
      .mockReturnValueOnce([{ url: 'https://autoline.cz/truck--1', id: 1, status: 'pending', attempts: 0 }])
      .mockReturnValueOnce([]);

    fetchPage.mockResolvedValue({ status: 301, html: '' });

    await runDetailPhase(
      db as any,
      { concurrency: 1, delay: 0, maxRetries: 0, limit: 0, dbPath: '', phase: 'detail' },
      () => false,
    );

    expect(db.markFailed).toHaveBeenCalled();
  });

  it('handles 410 by marking gone', async () => {
    const db = mockDb();
    db.getPendingUrls
      .mockReturnValueOnce([{ url: 'https://autoline.cz/truck--1', id: 1, status: 'pending', attempts: 0 }])
      .mockReturnValueOnce([]);

    fetchPage.mockResolvedValue({ status: 410, html: '' });

    await runDetailPhase(
      db as any,
      { concurrency: 1, delay: 0, maxRetries: 0, limit: 0, dbPath: '', phase: 'detail' },
      () => false,
    );

    expect(db.markGone).toHaveBeenCalled();
  });

  it('marks failed after repeated 429 responses exhaust retries', async () => {
    const db = mockDb();
    db.getPendingUrls
      .mockReturnValueOnce([{ url: 'https://autoline.cz/truck--2', id: 2, status: 'pending', attempts: 0 }])
      .mockReturnValueOnce([]);

    fetchPage
      .mockResolvedValueOnce({ status: 429, html: '', retryAfter: 1 })
      .mockResolvedValueOnce({ status: 429, html: '', retryAfter: 1 });

    await runDetailPhase(
      db as any,
      { concurrency: 1, delay: 0, maxRetries: 1, limit: 0, dbPath: '', phase: 'detail' },
      () => false,
    );

    expect(fetchPage).toHaveBeenCalledTimes(2);
    expect(db.markFailed).toHaveBeenCalledWith('https://autoline.cz/truck--2', 'Rate limited (429)');
  });

  it('executes periodic progress callback and logs dynamic delay', async () => {
    const db = mockDb();
    db.getPendingUrls.mockReturnValueOnce([]);

    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const setIntervalSpy = vi.spyOn(globalThis, 'setInterval').mockImplementation(((handler: unknown) => {
      if (typeof handler === 'function') handler();
      return 987 as ReturnType<typeof setInterval>;
    }) as typeof setInterval);
    const clearIntervalSpy = vi.spyOn(globalThis, 'clearInterval');

    try {
      await runDetailPhase(
        db as any,
        { concurrency: 1, delay: 0, maxRetries: 0, limit: 0, dbPath: '', phase: 'detail' },
        () => false,
      );

      expect(setIntervalSpy).toHaveBeenCalled();
      expect(logSpy.mock.calls.some(([msg]) => String(msg).includes('Delay: 0ms'))).toBe(true);
      expect(clearIntervalSpy).toHaveBeenCalledWith(987);
    } finally {
      clearIntervalSpy.mockRestore();
      setIntervalSpy.mockRestore();
      logSpy.mockRestore();
    }
  });
});
