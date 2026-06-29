import { buildSearchUrl, generateInitialSegments, runSearchPhase } from './search.js';

vi.mock('./browser.js', () => ({
  handleCookieConsent: vi.fn().mockResolvedValue(undefined),
}));

describe('buildSearchUrl', () => {
  it('generates URL with price range', () => {
    const url = buildSearchUrl('Car', 5000, 10000);
    expect(url).toContain('isSearchRequest=true');
    expect(url).toContain('s=Car');
    expect(url).toContain('vc=Car');
    expect(url).toContain('p=5000:10000');
  });

  it('generates URL with only lower bound', () => {
    const url = buildSearchUrl('Car', 5000, 0);
    expect(url).toContain('p=5000:');
    expect(url).not.toContain('p=5000:0');
  });

  it('generates URL with only upper bound', () => {
    const url = buildSearchUrl('Car', 0, 10000);
    expect(url).toContain('p=:10000');
  });

  it('generates URL without price when both are 0', () => {
    const url = buildSearchUrl('Car', 0, 0);
    expect(url).not.toContain('&p=');
  });

  it('works with different categories', () => {
    const url = buildSearchUrl('Truck', 1000, 2000);
    expect(url).toContain('s=Truck');
    expect(url).toContain('vc=Truck');
  });

  it('includes sort by relevance', () => {
    const url = buildSearchUrl('Car', 0, 0);
    expect(url).toContain('sb=rel');
  });
});

describe('generateInitialSegments', () => {
  it('generates segments from price breakpoints', () => {
    const segments = generateInitialSegments('Car');
    expect(segments.length).toBeGreaterThan(30);

    // First segment starts at 0
    expect(segments[0].price_from).toBe(0);
    expect(segments[0].price_to).toBe(500);
    expect(segments[0].category).toBe('Car');
  });

  it('last segment has price_to = 0 (open-ended)', () => {
    const segments = generateInitialSegments('Car');
    const last = segments[segments.length - 1];
    expect(last.price_from).toBe(90000);
    expect(last.price_to).toBe(0);
  });

  it('segments are contiguous', () => {
    const segments = generateInitialSegments('Motorbike');
    for (let i = 1; i < segments.length - 1; i++) {
      expect(segments[i].price_from).toBe(segments[i - 1].price_to);
    }
  });

  it('all segments have the specified category', () => {
    const segments = generateInitialSegments('Truck');
    for (const s of segments) {
      expect(s.category).toBe('Truck');
    }
  });
});

describe('runSearchPhase', () => {
  const mockPage = () => ({
    goto: vi.fn().mockResolvedValue(undefined),
    evaluate: vi.fn(),
    waitForTimeout: vi.fn().mockResolvedValue(undefined),
    close: vi.fn().mockResolvedValue(undefined),
    locator: vi.fn().mockReturnValue({
      isVisible: vi.fn().mockResolvedValue(false),
      isEnabled: vi.fn().mockResolvedValue(false),
      click: vi.fn().mockResolvedValue(undefined),
    }),
  });

  const mockContext = (page: ReturnType<typeof mockPage>) => ({
    newPage: vi.fn().mockResolvedValue(page),
  });

  const mockDb = () => ({
    getUrlCounts: vi.fn().mockReturnValue({ total: 0, pending: 0, scraped: 0, failed: 0, gone: 0 }),
    startRun: vi.fn().mockReturnValue(1),
    finishRun: vi.fn(),
    insertUrlBatch: vi.fn().mockReturnValue(0),
    getSegmentCountForCategory: vi.fn().mockReturnValue(0),
    insertSegments: vi.fn(),
    getPendingSegments: vi.fn().mockReturnValue([]),
    updateSegment: vi.fn(),
    getSegmentStats: vi.fn().mockReturnValue({}),
  });

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('initializes segments and processes category', async () => {
    const page = mockPage();
    const ctx = mockContext(page);
    const db = mockDb();

    // After inserting segments, return one pending segment
    db.getPendingSegments
      .mockReturnValueOnce([
        {
          id: 1,
          category: 'Car',
          price_from: 0,
          price_to: 500,
          total_results: null,
          last_page_scraped: 0,
          total_pages: null,
          status: 'pending',
        },
      ])
      .mockReturnValue([]);

    // extractTotalResults returns 5
    page.evaluate
      .mockResolvedValueOnce('5') // EXTRACT_TOTAL_RESULTS_SCRIPT
      .mockResolvedValueOnce({ currentPage: 1, maxPage: 1 }) // EXTRACT_PAGINATION_SCRIPT
      .mockResolvedValueOnce([{ url: 'https://mobile.de/a?id=1', mobile_id: '1' }]); // EXTRACT_LISTING_URLS_SCRIPT

    await runSearchPhase(
      ctx as any,
      db as any,
      {
        concurrency: 1,
        delay: 0,
        maxRetries: 0,
        limit: 0,
        dbPath: '',
        phase: 'search',
        categories: ['Car'],
        headless: true,
      },
      () => false,
    );

    expect(db.insertSegments).toHaveBeenCalled();
    expect(db.insertUrlBatch).toHaveBeenCalled();
    expect(db.finishRun).toHaveBeenCalledWith(1, expect.any(Number), expect.any(Number), 0, 'completed');
  });

  it('splits segments with too many pages', async () => {
    const page = mockPage();
    const ctx = mockContext(page);
    const db = mockDb();

    db.getPendingSegments
      .mockReturnValueOnce([
        {
          id: 1,
          category: 'Car',
          price_from: 0,
          price_to: 5000,
          total_results: null,
          last_page_scraped: 0,
          total_pages: null,
          status: 'pending',
        },
      ])
      .mockReturnValue([]);

    page.evaluate
      .mockResolvedValueOnce('10000') // totalResults
      .mockResolvedValueOnce({ currentPage: 1, maxPage: 100 }); // too many pages

    await runSearchPhase(
      ctx as any,
      db as any,
      {
        concurrency: 1,
        delay: 0,
        maxRetries: 0,
        limit: 0,
        dbPath: '',
        phase: 'search',
        categories: ['Car'],
        headless: true,
      },
      () => false,
    );

    expect(db.updateSegment).toHaveBeenCalledWith(expect.objectContaining({ status: 'split' }));
    expect(db.insertSegments).toHaveBeenCalledTimes(2); // initial + split
  });

  it('handles zero results segment', async () => {
    const page = mockPage();
    const ctx = mockContext(page);
    const db = mockDb();

    db.getPendingSegments
      .mockReturnValueOnce([
        {
          id: 1,
          category: 'Car',
          price_from: 0,
          price_to: 500,
          total_results: null,
          last_page_scraped: 0,
          total_pages: null,
          status: 'pending',
        },
      ])
      .mockReturnValue([]);

    page.evaluate
      .mockResolvedValueOnce('0') // totalResults = 0
      .mockResolvedValueOnce({ currentPage: 1, maxPage: 0 });

    await runSearchPhase(
      ctx as any,
      db as any,
      {
        concurrency: 1,
        delay: 0,
        maxRetries: 0,
        limit: 0,
        dbPath: '',
        phase: 'search',
        categories: ['Car'],
        headless: true,
      },
      () => false,
    );

    expect(db.updateSegment).toHaveBeenCalledWith(expect.objectContaining({ status: 'completed', total_pages: 0 }));
  });

  it('stops on shutdown', async () => {
    const page = mockPage();
    const ctx = mockContext(page);
    const db = mockDb();

    await runSearchPhase(
      ctx as any,
      db as any,
      {
        concurrency: 1,
        delay: 0,
        maxRetries: 0,
        limit: 0,
        dbPath: '',
        phase: 'search',
        categories: ['Car'],
        headless: true,
      },
      () => true,
    );

    expect(db.finishRun).toHaveBeenCalledWith(1, expect.any(Number), expect.any(Number), 0, 'interrupted');
  });

  it('resumes existing segments', async () => {
    const page = mockPage();
    const ctx = mockContext(page);
    const db = mockDb();

    db.getSegmentCountForCategory.mockReturnValue(5);
    db.getPendingSegments.mockReturnValue([]);
    db.getSegmentStats.mockReturnValue({ completed: 5 });

    await runSearchPhase(
      ctx as any,
      db as any,
      {
        concurrency: 1,
        delay: 0,
        maxRetries: 0,
        limit: 0,
        dbPath: '',
        phase: 'search',
        categories: ['Car'],
        headless: true,
      },
      () => false,
    );

    // Should not insert initial segments when they already exist
    expect(db.insertSegments).not.toHaveBeenCalled();
    expect(db.finishRun).toHaveBeenCalled();
  });

  it('handles empty listing results on a page', async () => {
    const page = mockPage();
    const ctx = mockContext(page);
    const db = mockDb();

    db.getPendingSegments
      .mockReturnValueOnce([
        {
          id: 1,
          category: 'Car',
          price_from: 0,
          price_to: 500,
          total_results: null,
          last_page_scraped: 0,
          total_pages: null,
          status: 'pending',
        },
      ])
      .mockReturnValue([]);

    page.evaluate
      .mockResolvedValueOnce('10') // totalResults
      .mockResolvedValueOnce({ currentPage: 1, maxPage: 2 }) // pagination
      .mockResolvedValueOnce([]); // empty listing URLs

    await runSearchPhase(
      ctx as any,
      db as any,
      {
        concurrency: 1,
        delay: 0,
        maxRetries: 0,
        limit: 0,
        dbPath: '',
        phase: 'search',
        categories: ['Car'],
        headless: true,
      },
      () => false,
    );

    // Should stop when no listings found
    expect(db.insertUrlBatch).not.toHaveBeenCalled();
  });

  it('navigates to next page using pagination', async () => {
    const page = mockPage();
    const ctx = mockContext(page);
    const db = mockDb();

    page.locator.mockReturnValue({
      isVisible: vi.fn().mockResolvedValue(true),
      isEnabled: vi.fn().mockResolvedValue(true),
      click: vi.fn().mockResolvedValue(undefined),
    });

    db.getPendingSegments
      .mockReturnValueOnce([
        {
          id: 1,
          category: 'Car',
          price_from: 0,
          price_to: 500,
          total_results: null,
          last_page_scraped: 0,
          total_pages: null,
          status: 'pending',
        },
      ])
      .mockReturnValue([]);

    page.evaluate
      .mockResolvedValueOnce('20') // totalResults
      .mockResolvedValueOnce({ currentPage: 1, maxPage: 2 }) // pagination
      .mockResolvedValueOnce([{ url: 'https://mobile.de/a?id=1', mobile_id: '1' }]) // page 1 listings
      .mockResolvedValueOnce([{ url: 'https://mobile.de/a?id=2', mobile_id: '2' }]); // page 2 listings

    await runSearchPhase(
      ctx as any,
      db as any,
      {
        concurrency: 1,
        delay: 0,
        maxRetries: 0,
        limit: 0,
        dbPath: '',
        phase: 'search',
        categories: ['Car'],
        headless: true,
      },
      () => false,
    );

    expect(db.insertUrlBatch).toHaveBeenCalledTimes(2);
  });

  it('splits open-ended segment', async () => {
    const page = mockPage();
    const ctx = mockContext(page);
    const db = mockDb();

    db.getPendingSegments
      .mockReturnValueOnce([
        {
          id: 1,
          category: 'Car',
          price_from: 90000,
          price_to: 0,
          total_results: null,
          last_page_scraped: 0,
          total_pages: null,
          status: 'pending',
        },
      ])
      .mockReturnValue([]);

    page.evaluate.mockResolvedValueOnce('5000').mockResolvedValueOnce({ currentPage: 1, maxPage: 100 });

    await runSearchPhase(
      ctx as any,
      db as any,
      {
        concurrency: 1,
        delay: 0,
        maxRetries: 0,
        limit: 0,
        dbPath: '',
        phase: 'search',
        categories: ['Car'],
        headless: true,
      },
      () => false,
    );

    // Should split the open-ended segment
    expect(db.insertSegments).toHaveBeenCalledTimes(2); // initial + split
    const splitCall = db.insertSegments.mock.calls[1][0];
    expect(splitCall).toHaveLength(2);
    expect(splitCall[1].price_to).toBe(0); // second sub-segment is still open-ended
  });

  it('handles too-narrow segment that cannot be split', async () => {
    const page = mockPage();
    const ctx = mockContext(page);
    const db = mockDb();

    db.getPendingSegments
      .mockReturnValueOnce([
        {
          id: 1,
          category: 'Car',
          price_from: 5000,
          price_to: 5001,
          total_results: null,
          last_page_scraped: 0,
          total_pages: null,
          status: 'pending',
        },
      ])
      .mockReturnValue([]);

    page.evaluate.mockResolvedValueOnce('5000').mockResolvedValueOnce({ currentPage: 1, maxPage: 100 });

    await runSearchPhase(
      ctx as any,
      db as any,
      {
        concurrency: 1,
        delay: 0,
        maxRetries: 0,
        limit: 0,
        dbPath: '',
        phase: 'search',
        categories: ['Car'],
        headless: true,
      },
      () => false,
    );

    // Should revert to pending since it can't split further
    expect(db.updateSegment).toHaveBeenCalledWith(expect.objectContaining({ status: 'pending' }));
  });

  it('handles search phase error by marking run as failed', async () => {
    const page = mockPage();
    const ctx = mockContext(page);
    ctx.newPage.mockRejectedValue(new Error('Browser crashed'));
    const db = mockDb();
    db.getPendingSegments.mockReturnValue([
      { id: 1, category: 'Car', price_from: 0, price_to: 500, status: 'pending', last_page_scraped: 0 },
    ]);

    await expect(
      runSearchPhase(
        ctx as any,
        db as any,
        {
          concurrency: 1,
          delay: 0,
          maxRetries: 0,
          limit: 0,
          dbPath: '',
          phase: 'search',
          categories: ['Car'],
          headless: true,
        },
        () => false,
      ),
    ).rejects.toThrow('Browser crashed');

    expect(db.finishRun).toHaveBeenCalledWith(1, 0, 0, 0, 'failed');
  });

  it('falls back to URL pagination when next button is not clickable', async () => {
    const page = mockPage();
    const ctx = mockContext(page);
    const db = mockDb();

    // Force clickNextPage() to return false
    page.locator.mockReturnValue({
      isVisible: vi.fn().mockResolvedValue(false),
      isEnabled: vi.fn().mockResolvedValue(false),
      click: vi.fn().mockResolvedValue(undefined),
    });

    db.getPendingSegments
      .mockReturnValueOnce([
        {
          id: 1,
          category: 'Car',
          price_from: 0,
          price_to: 500,
          total_results: null,
          last_page_scraped: 0,
          total_pages: null,
          status: 'pending',
        },
      ])
      .mockReturnValue([]);

    page.evaluate
      .mockResolvedValueOnce('20')
      .mockResolvedValueOnce({ currentPage: 1, maxPage: 2 })
      .mockResolvedValueOnce([{ url: 'https://mobile.de/a?id=11', mobile_id: '11' }])
      .mockResolvedValueOnce([{ url: 'https://mobile.de/a?id=12', mobile_id: '12' }]);

    await runSearchPhase(
      ctx as any,
      db as any,
      {
        concurrency: 1,
        delay: 0,
        maxRetries: 0,
        limit: 0,
        dbPath: '',
        phase: 'search',
        categories: ['Car'],
        headless: true,
      },
      () => false,
    );

    expect(page.goto).toHaveBeenCalledWith(expect.stringContaining('pageNumber=2'), expect.any(Object));
    expect(db.insertUrlBatch).toHaveBeenCalledTimes(2);
  });

  it('handles non-numeric total results as unknown value', async () => {
    const page = mockPage();
    const ctx = mockContext(page);
    const db = mockDb();

    db.getPendingSegments
      .mockReturnValueOnce([
        {
          id: 1,
          category: 'Car',
          price_from: 0,
          price_to: 500,
          total_results: null,
          last_page_scraped: 0,
          total_pages: null,
          status: 'pending',
        },
      ])
      .mockReturnValue([]);

    page.evaluate
      .mockResolvedValueOnce('not-a-number')
      .mockResolvedValueOnce({ currentPage: 1, maxPage: 1 })
      .mockResolvedValueOnce([{ url: 'https://mobile.de/a?id=21', mobile_id: '21' }]);

    await runSearchPhase(
      ctx as any,
      db as any,
      {
        concurrency: 1,
        delay: 0,
        maxRetries: 0,
        limit: 0,
        dbPath: '',
        phase: 'search',
        categories: ['Car'],
        headless: true,
      },
      () => false,
    );

    expect(db.updateSegment).toHaveBeenCalledWith(expect.objectContaining({ total_results: undefined }));
  });

  it('processes multiple pending passes for one category', async () => {
    const page = mockPage();
    const ctx = mockContext(page);
    const db = mockDb();

    db.getPendingSegments
      .mockReturnValueOnce([
        {
          id: 1,
          category: 'Car',
          price_from: 0,
          price_to: 500,
          total_results: null,
          last_page_scraped: 0,
          total_pages: null,
          status: 'pending',
        },
      ])
      .mockReturnValueOnce([
        {
          id: 2,
          category: 'Car',
          price_from: 500,
          price_to: 1000,
          total_results: null,
          last_page_scraped: 0,
          total_pages: null,
          status: 'pending',
        },
      ])
      .mockReturnValue([]);

    page.evaluate
      .mockResolvedValueOnce('5')
      .mockResolvedValueOnce({ currentPage: 1, maxPage: 1 })
      .mockResolvedValueOnce([{ url: 'https://mobile.de/a?id=31', mobile_id: '31' }])
      .mockResolvedValueOnce('6')
      .mockResolvedValueOnce({ currentPage: 1, maxPage: 1 })
      .mockResolvedValueOnce([{ url: 'https://mobile.de/a?id=32', mobile_id: '32' }]);

    await runSearchPhase(
      ctx as any,
      db as any,
      {
        concurrency: 1,
        delay: 0,
        maxRetries: 0,
        limit: 0,
        dbPath: '',
        phase: 'search',
        categories: ['Car'],
        headless: true,
      },
      () => false,
    );

    expect(db.insertUrlBatch).toHaveBeenCalledTimes(2);
  });

  it('uses pageNumber continuation URL, handles empty total-result text, and breaks page loop on shutdown', async () => {
    const page = mockPage();
    const ctx = mockContext(page);
    const db = mockDb();

    db.getPendingSegments
      .mockReturnValueOnce([
        {
          id: 1,
          category: 'Car',
          price_from: 0,
          price_to: 500,
          total_results: null,
          last_page_scraped: 1,
          total_pages: null,
          status: 'pending',
        },
      ])
      .mockReturnValue([]);

    let stopInsideSegment = false;
    page.evaluate
      .mockResolvedValueOnce(null) // total results text missing
      .mockImplementationOnce(async () => {
        stopInsideSegment = true; // trigger shutdown check inside the page loop
        return { currentPage: 2, maxPage: 2 };
      });

    await runSearchPhase(
      ctx as any,
      db as any,
      {
        concurrency: 1,
        delay: 0,
        maxRetries: 0,
        limit: 0,
        dbPath: '',
        phase: 'search',
        categories: ['Car'],
        headless: true,
      },
      () => stopInsideSegment,
    );

    expect(page.goto).toHaveBeenCalledWith(expect.stringContaining('pageNumber=2'), expect.any(Object));
    expect(db.updateSegment).toHaveBeenCalledWith(
      expect.objectContaining({
        id: 1,
        total_results: undefined,
        last_page_scraped: 1,
        status: 'in_progress',
      }),
    );
    expect(db.insertUrlBatch).not.toHaveBeenCalled();
  });

  it('stops inside segment loop when shutdown is requested between segments', async () => {
    const page = mockPage();
    const ctx = mockContext(page);
    const db = mockDb();

    db.getPendingSegments
      .mockReturnValueOnce([
        {
          id: 1,
          category: 'Car',
          price_from: 0,
          price_to: 500,
          total_results: null,
          last_page_scraped: 0,
          total_pages: null,
          status: 'pending',
        },
        {
          id: 2,
          category: 'Car',
          price_from: 500,
          price_to: 1000,
          total_results: null,
          last_page_scraped: 0,
          total_pages: null,
          status: 'pending',
        },
      ])
      .mockReturnValue([]);

    page.evaluate
      .mockResolvedValueOnce('5')
      .mockResolvedValueOnce({ currentPage: 1, maxPage: 1 })
      .mockResolvedValueOnce([{ url: 'https://mobile.de/a?id=41', mobile_id: '41' }]);

    let shouldStop = false;
    db.insertUrlBatch.mockImplementation(() => {
      shouldStop = true;
      return 1;
    });

    const shutdownMidLoop = () => shouldStop;

    await runSearchPhase(
      ctx as any,
      db as any,
      {
        concurrency: 1,
        delay: 0,
        maxRetries: 0,
        limit: 0,
        dbPath: '',
        phase: 'search',
        categories: ['Car'],
        headless: true,
      },
      shutdownMidLoop,
    );

    expect(db.insertUrlBatch).toHaveBeenCalledTimes(1);
  });
});
