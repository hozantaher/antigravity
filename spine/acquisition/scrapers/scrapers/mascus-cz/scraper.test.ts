import { parseDetailPage, runDetailPhase } from './scraper.js';

vi.mock('../../lib/fetch.js', async (importOriginal) => {
  const actual = (await importOriginal()) as Record<string, unknown>;
  return { ...actual, fetchPage: vi.fn() };
});

const makeHtml = (jsonld: object[], specsHtml = '', imageHtml = '') => `
<html>
<head>
  ${jsonld.map((j) => `<script type="application/ld+json">${JSON.stringify(j)}</script>`).join('\n')}
</head>
<body>${specsHtml}${imageHtml}</body>
</html>
`;

describe('parseDetailPage', () => {
  it('parses Product JSON-LD with seller from offers', () => {
    const html = makeHtml([
      [
        {
          '@type': 'Product',
          name: 'CAT 320',
          description: 'Excavator',
          sku: 'M123',
          brand: { name: 'Caterpillar' },
          model: '320',
          offers: {
            price: 85000,
            priceCurrency: 'EUR',
            itemCondition: 'UsedCondition',
            availability: 'InStock',
            seller: { name: 'Heavy Machines Ltd' },
          },
        },
      ],
    ]);

    const result = parseDetailPage(html, 'https://www.mascus.cz/excavator/cat-320.html');
    expect(result.name).toBe('CAT 320');
    expect(result.brand).toBe('Caterpillar');
    expect(result.price).toBe(85000);
    expect(result.seller_name).toBe('Heavy Machines Ltd');
    expect(result.mascus_id).toBe('cat-320');
  });

  it('parses BreadcrumbList JSON-LD', () => {
    const html = makeHtml([
      {
        '@type': 'BreadcrumbList',
        itemListElement: [{ name: 'Mascus' }, { name: 'Excavators' }, { name: 'CAT 320' }],
      },
    ]);

    const result = parseDetailPage(html, 'https://www.mascus.cz/x/test.html');
    expect(result.category_path).toBe('Mascus > Excavators > CAT 320');
    expect(result.category).toBe('Excavators');
  });

  it('parses HTML specs with key-value wrappers', () => {
    const specsHtml = `
      <div class="key-value-wrapper">
        <span class="key-value-label">Rok výroby:</span>
        <span class="key-value-value">2020</span>
      </div>
      <div class="key-value-wrapper">
        <span class="key-value-label">Najeté km:</span>
        <span class="key-value-value">15 000 km</span>
      </div>
      <div class="key-value-wrapper">
        <span class="key-value-label">Stát:</span>
        <span class="key-value-value">Česká republika</span>
      </div>
      <div class="key-value-wrapper">
        <span class="key-value-label">VIN:</span>
        <span class="key-value-value">WDB12345</span>
      </div>
    `;

    const result = parseDetailPage(makeHtml([], specsHtml), 'https://www.mascus.cz/x/t.html');
    expect(result.year_of_manufacture).toBe('2020');
    expect(result.mileage).toBe('15 000 km');
    expect(result.mileage_km).toBe(15000);
    expect(result.location_country).toBe('Česká republika');
    expect(result.vin).toBe('WDB12345');
  });

  it('parses image gallery thumbnails', () => {
    const imageHtml = `
      <img class="image-gallery-thumbnail-image" src="https://img1.jpg" />
      <img class="image-gallery-thumbnail-image" src="https://img2.jpg" />
      <img class="image-gallery-thumbnail-image" src="data:image/gif;base64,..." />
    `;

    const result = parseDetailPage(makeHtml([], '', imageHtml), 'https://www.mascus.cz/x/t.html');
    expect(result.image_count).toBe(2);
    const urls = JSON.parse(result.image_urls!);
    expect(urls).toEqual(['https://img1.jpg', 'https://img2.jpg']);
  });

  it('deduplicates image URLs', () => {
    const imageHtml = `
      <img class="image-gallery-thumbnail-image" src="https://img1.jpg" />
      <img class="image-gallery-thumbnail-image" src="https://img1.jpg" />
    `;

    const result = parseDetailPage(makeHtml([], '', imageHtml), 'https://www.mascus.cz/x/t.html');
    expect(result.image_count).toBe(1);
  });

  it('handles missing JSON-LD gracefully', () => {
    const html = '<html><head></head><body></body></html>';
    const result = parseDetailPage(html, 'https://www.mascus.cz/x/t.html');
    expect(result.url).toBe('https://www.mascus.cz/x/t.html');
    expect(result.name).toBeUndefined();
  });

  it('handles array JSON-LD blocks (Mascus wraps in arrays)', () => {
    const html = makeHtml([
      [
        { '@type': 'Product', name: 'Wrapped Product' },
        { '@type': 'BreadcrumbList', itemListElement: [{ name: 'A' }, { name: 'B' }] },
      ],
    ]);

    const result = parseDetailPage(html, 'https://www.mascus.cz/x/t.html');
    expect(result.name).toBe('Wrapped Product');
    expect(result.category_path).toBe('A > B');
  });

  it('extracts mascus_id from URL slug', () => {
    const result = parseDetailPage(makeHtml([]), 'https://www.mascus.cz/cat/my-machine-slug.html');
    expect(result.mascus_id).toBe('my-machine-slug');
  });

  it('handles URL without .html', () => {
    const result = parseDetailPage(makeHtml([]), 'https://www.mascus.cz/no-ext');
    expect(result.mascus_id).toBeUndefined();
  });

  it('stores raw data', () => {
    const result = parseDetailPage(makeHtml([{ '@type': 'Product', name: 'Test' }]), 'https://www.mascus.cz/x/t.html');
    expect(result.raw_jsonld).toBeDefined();
    expect(result.raw_specs_json).toBeDefined();
  });

  it('maps additional spec fields', () => {
    const specsHtml = `
      <div class="key-value-wrapper">
        <span class="key-value-label">Převodovka:</span>
        <span class="key-value-value">Automat</span>
      </div>
      <div class="key-value-wrapper">
        <span class="key-value-label">Výkon motoru:</span>
        <span class="key-value-value">250 kW</span>
      </div>
      <div class="key-value-wrapper">
        <span class="key-value-label">Třída emisí:</span>
        <span class="key-value-value">Euro 6</span>
      </div>
    `;

    const result = parseDetailPage(makeHtml([], specsHtml), 'https://www.mascus.cz/x/t.html');
    expect(result.transmission).toBe('Automat');
    expect(result.engine_power).toBe('250 kW');
    expect(result.emission_class).toBe('Euro 6');
  });

  it('skips empty/malformed/non-object JSON-LD entries', () => {
    const html = `
      <html><head>
        <script type="application/ld+json">   </script>
        <script type="application/ld+json">{"broken": </script>
        <script type="application/ld+json">"primitive"</script>
        <script type="application/ld+json">[null,"x",{"@type":"Product","name":"Valid Product"}]</script>
      </head><body></body></html>
    `;

    const result = parseDetailPage(html, 'https://www.mascus.cz/x/edge.html');
    expect(result.name).toBe('Valid Product');
  });

  it('parses price from string offers and handles missing seller', () => {
    const html = makeHtml([
      {
        '@type': 'Product',
        name: 'String Price Machine',
        offers: {
          price: '12345',
          priceCurrency: 'EUR',
          itemCondition: 'UsedCondition',
          availability: 'InStock',
        },
      },
    ]);

    const result = parseDetailPage(html, 'https://www.mascus.cz/x/price.html');
    expect(result.price).toBe(12345);
    expect(result.seller_name).toBeUndefined();
  });

  it('handles breadcrumb edge cases (empty and single-item paths)', () => {
    const emptyResult = parseDetailPage(
      makeHtml([{ '@type': 'BreadcrumbList', itemListElement: [] }]),
      'https://www.mascus.cz/x/b1.html',
    );
    expect(emptyResult.category_path).toBeUndefined();

    const singleResult = parseDetailPage(
      makeHtml([{ '@type': 'BreadcrumbList', itemListElement: [{ name: 'Only' }] }]),
      'https://www.mascus.cz/x/b2.html',
    );
    expect(singleResult.category_path).toBe('Only');
    expect(singleResult.category).toBeUndefined();
  });

  it('ignores empty/unknown spec labels and keeps mileage_km undefined when mileage is non-numeric', () => {
    const specsHtml = `
      <div class="key-value-wrapper">
        <span class="key-value-label">:</span>
        <span class="key-value-value">ignored</span>
      </div>
      <div class="key-value-wrapper">
        <span class="key-value-label">Neznámé pole:</span>
        <span class="key-value-value">foo</span>
      </div>
      <div class="key-value-wrapper">
        <span class="key-value-label">Najeté km:</span>
        <span class="key-value-value">bez údajů</span>
      </div>
    `;

    const result = parseDetailPage(makeHtml([], specsHtml), 'https://www.mascus.cz/x/specs-edge.html');
    expect(result.mileage).toBe('bez údajů');
    expect(result.mileage_km).toBeUndefined();
    const rawSpecs = JSON.parse(result.raw_specs_json!);
    expect(rawSpecs['Neznámé pole']).toBe('foo');
  });

  it('supports @type arrays and ignores unsupported JSON-LD types', () => {
    const html = makeHtml([
      { '@type': ['Product', 'Vehicle'], name: 'Array Type Machine' },
      { '@type': 'Thing', name: 'Ignored Block' },
    ]);

    const result = parseDetailPage(html, 'https://www.mascus.cz/x/types.html');
    expect(result.name).toBe('Array Type Machine');
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
      .mockReturnValueOnce([{ url: 'https://www.mascus.cz/x/m.html', id: 1, status: 'pending', attempts: 0 }])
      .mockReturnValueOnce([]);

    const html = makeHtml([{ '@type': 'Product', name: 'Machine 1' }]);
    fetchPage.mockResolvedValue({ status: 200, html });

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
      .mockReturnValueOnce([{ url: 'https://www.mascus.cz/x/m.html', id: 1, status: 'pending', attempts: 0 }])
      .mockReturnValueOnce([]);

    fetchPage.mockResolvedValue({ status: 404, html: '' });

    await runDetailPhase(
      db as any,
      { concurrency: 1, delay: 0, maxRetries: 0, limit: 0, dbPath: '', phase: 'detail' },
      () => false,
    );

    expect(db.markGone).toHaveBeenCalled();
  });

  it('handles 500 by marking failed', async () => {
    const db = mockDb();
    db.getPendingUrls
      .mockReturnValueOnce([{ url: 'https://www.mascus.cz/x/m.html', id: 1, status: 'pending', attempts: 0 }])
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
      .mockReturnValueOnce([{ url: 'https://www.mascus.cz/x/m.html', id: 1, status: 'pending', attempts: 0 }])
      .mockReturnValueOnce([]);

    const html = makeHtml([{ '@type': 'Product', name: 'Machine' }]);
    fetchPage.mockResolvedValueOnce({ status: 429, html: '', retryAfter: 1 }).mockResolvedValue({ status: 200, html });

    await runDetailPhase(
      db as any,
      { concurrency: 1, delay: 0, maxRetries: 2, limit: 0, dbPath: '', phase: 'detail' },
      () => false,
    );

    expect(db.saveListing).toHaveBeenCalled();
  });

  it('stops on shutdown', async () => {
    const db = mockDb();
    db.getPendingUrls.mockReturnValue([]);

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

  it('respects limit and stops when remaining reaches zero', async () => {
    const db = mockDb();
    db.getUrlCounts.mockReturnValue({ total: 10, pending: 10, scraped: 0, failed: 0, gone: 0 });
    db.getPendingUrls.mockReturnValueOnce([
      { url: 'https://www.mascus.cz/x/limit.html', id: 1, status: 'pending', attempts: 0 },
    ]);

    fetchPage.mockResolvedValue({ status: 200, html: makeHtml([{ '@type': 'Product', name: 'Limited Machine' }]) });

    await runDetailPhase(
      db as any,
      { concurrency: 1, delay: 0, maxRetries: 0, limit: 1, dbPath: '', phase: 'detail' },
      () => false,
    );

    expect(db.getPendingUrls).toHaveBeenCalledWith(0, 1);
    expect(db.finishRun).toHaveBeenCalledWith(1, 1, 1, 0, 'completed');
  });

  it('marks URL as failed on unexpected non-200 statuses', async () => {
    const db = mockDb();
    db.getPendingUrls
      .mockReturnValueOnce([{ url: 'https://www.mascus.cz/x/redirect.html', id: 1, status: 'pending', attempts: 0 }])
      .mockReturnValueOnce([]);

    fetchPage.mockResolvedValue({ status: 302, html: '' });

    await runDetailPhase(
      db as any,
      { concurrency: 1, delay: 0, maxRetries: 0, limit: 0, dbPath: '', phase: 'detail' },
      () => false,
    );

    expect(db.markFailed).toHaveBeenCalledWith('https://www.mascus.cz/x/redirect.html', 'Unexpected status 302');
  });

  it('retries repeated 429 responses and eventually marks failed', async () => {
    const db = mockDb();
    db.getPendingUrls
      .mockReturnValueOnce([{ url: 'https://www.mascus.cz/x/rate-limit.html', id: 1, status: 'pending', attempts: 0 }])
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
    expect(db.markFailed).toHaveBeenCalledWith('https://www.mascus.cz/x/rate-limit.html', 'Rate limited (429)');
  });

  it('executes periodic progress callback and logs current delay', async () => {
    const db = mockDb();
    db.getPendingUrls.mockReturnValueOnce([]);

    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const setIntervalSpy = vi.spyOn(globalThis, 'setInterval').mockImplementation(((handler: unknown) => {
      if (typeof handler === 'function') handler();
      return 654 as ReturnType<typeof setInterval>;
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
      expect(clearIntervalSpy).toHaveBeenCalledWith(654);
    } finally {
      clearIntervalSpy.mockRestore();
      setIntervalSpy.mockRestore();
      logSpy.mockRestore();
    }
  });
});
