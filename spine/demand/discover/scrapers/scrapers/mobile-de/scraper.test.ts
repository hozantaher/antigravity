import { parsePrice, parseMileageKm, runDetailPhase } from './scraper.js';

vi.mock('./browser.js', () => ({
  handleCookieConsent: vi.fn().mockResolvedValue(undefined),
}));

describe('parsePrice', () => {
  it('parses "12 345 €"', () => {
    expect(parsePrice('12 345 €')).toBe(12345);
  });

  it('parses "12.345 €"', () => {
    expect(parsePrice('12.345 €')).toBe(12345);
  });

  it('parses "1.234.567 €"', () => {
    expect(parsePrice('1.234.567 €')).toBe(1234567);
  });

  it('parses "12,50 €"', () => {
    expect(parsePrice('12,50 €')).toBe(12.5);
  });

  it('returns undefined for empty string', () => {
    expect(parsePrice('')).toBeUndefined();
  });

  it('returns undefined for non-numeric string', () => {
    expect(parsePrice('abc')).toBeUndefined();
  });

  it('parses price without currency symbol', () => {
    expect(parsePrice('5000')).toBe(5000);
  });
});

describe('parseMileageKm', () => {
  it('parses "123 456 km"', () => {
    expect(parseMileageKm('123 456 km')).toBe(123456);
  });

  it('parses "0 km"', () => {
    expect(parseMileageKm('0 km')).toBe(0);
  });

  it('parses "50000"', () => {
    expect(parseMileageKm('50000')).toBe(50000);
  });

  it('returns undefined for empty string', () => {
    expect(parseMileageKm('')).toBeUndefined();
  });

  it('returns undefined for non-numeric string', () => {
    expect(parseMileageKm('abc')).toBeUndefined();
  });

  it('parses "1 km" edge case', () => {
    expect(parseMileageKm('1 km')).toBe(1);
  });
});

describe('runDetailPhase', () => {
  const mockPage = () => ({
    goto: vi.fn().mockResolvedValue({ status: () => 200 }),
    evaluate: vi.fn(),
    waitForTimeout: vi.fn().mockResolvedValue(undefined),
    url: vi.fn().mockReturnValue('https://www.mobile.de/cz/podrobnosti.html?id=1'),
    close: vi.fn().mockResolvedValue(undefined),
  });

  const mockContext = (page: ReturnType<typeof mockPage>) => ({
    newPage: vi.fn().mockResolvedValue(page),
  });

  const mockDb = () => ({
    getUrlCounts: vi.fn().mockReturnValue({ total: 1, pending: 1, scraped: 0, failed: 0, gone: 0 }),
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

  it('processes URLs with browser and saves listings', async () => {
    const page = mockPage();
    const ctx = mockContext(page);
    const db = mockDb();

    page.evaluate
      .mockResolvedValueOnce(true) // IS_LISTING_SCRIPT
      .mockResolvedValueOnce({
        title: 'BMW 320d',
        priceLabel: '25 000 €',
        priceCzk: null,
        priceEvaluation: null,
        mileageRaw: '100 000 km',
        power: '140 kW',
        fuel: 'Diesel',
        transmission: 'Automat',
        firstRegistration: '2020',
        numOwnersRaw: null,
        technicalData: {},
        features: [],
        description: 'Nice car',
        sellerName: 'Dealer',
        sellerAddress1: 'Street 1',
        sellerAddress2: null,
        sellerRating: null,
        sellerRatingCount: null,
        sellerId: null,
        imageUrls: ['https://img1.jpg'],
        rawKeyFeatures: null,
      }); // EXTRACT_SCRIPT

    db.getPendingUrls
      .mockReturnValueOnce([{ url: 'https://mobile.de/a?id=1', mobile_id: '1', id: 1, status: 'pending', attempts: 0 }])
      .mockReturnValueOnce([]);

    await runDetailPhase(
      ctx as any,
      db as any,
      {
        concurrency: 1,
        delay: 0,
        maxRetries: 1,
        limit: 0,
        dbPath: '',
        phase: 'detail',
        categories: ['Car'],
        headless: true,
      },
      () => false,
    );

    expect(db.saveListing).toHaveBeenCalledTimes(1);
    expect(db.finishRun).toHaveBeenCalledWith(1, 1, 1, 0, 'completed');
  });

  it('handles 404 by marking gone', async () => {
    const page = mockPage();
    page.goto.mockResolvedValue({ status: () => 404 });
    const ctx = mockContext(page);
    const db = mockDb();

    db.getPendingUrls
      .mockReturnValueOnce([{ url: 'https://mobile.de/a?id=1', mobile_id: '1', id: 1, status: 'pending', attempts: 0 }])
      .mockReturnValueOnce([]);

    await runDetailPhase(
      ctx as any,
      db as any,
      {
        concurrency: 1,
        delay: 0,
        maxRetries: 0,
        limit: 0,
        dbPath: '',
        phase: 'detail',
        categories: ['Car'],
        headless: true,
      },
      () => false,
    );

    expect(db.markGone).toHaveBeenCalled();
  });

  it('handles 500 by marking failed', async () => {
    const page = mockPage();
    page.goto.mockResolvedValue({ status: () => 500 });
    const ctx = mockContext(page);
    const db = mockDb();

    db.getPendingUrls
      .mockReturnValueOnce([{ url: 'https://mobile.de/a?id=1', mobile_id: '1', id: 1, status: 'pending', attempts: 0 }])
      .mockReturnValueOnce([]);

    await runDetailPhase(
      ctx as any,
      db as any,
      {
        concurrency: 1,
        delay: 0,
        maxRetries: 0,
        limit: 0,
        dbPath: '',
        phase: 'detail',
        categories: ['Car'],
        headless: true,
      },
      () => false,
    );

    expect(db.markFailed).toHaveBeenCalled();
  });

  it('handles 429/403 rate limiting', async () => {
    const page = mockPage();
    page.goto
      .mockResolvedValueOnce({ status: () => 200 }) // cookie page
      .mockResolvedValueOnce({ status: () => 429 })
      .mockResolvedValueOnce({ status: () => 200 });
    page.evaluate.mockResolvedValueOnce(true).mockResolvedValueOnce({
      title: 'Test',
      priceLabel: null,
      priceCzk: null,
      priceEvaluation: null,
      mileageRaw: null,
      power: null,
      fuel: null,
      transmission: null,
      firstRegistration: null,
      numOwnersRaw: null,
      technicalData: {},
      features: [],
      description: null,
      sellerName: null,
      sellerAddress1: null,
      sellerAddress2: null,
      sellerRating: null,
      sellerRatingCount: null,
      sellerId: null,
      imageUrls: [],
      rawKeyFeatures: null,
    });

    const ctx = mockContext(page);
    const db = mockDb();

    db.getPendingUrls
      .mockReturnValueOnce([{ url: 'https://mobile.de/a?id=1', mobile_id: '1', id: 1, status: 'pending', attempts: 0 }])
      .mockReturnValueOnce([]);

    await runDetailPhase(
      ctx as any,
      db as any,
      {
        concurrency: 1,
        delay: 0,
        maxRetries: 2,
        limit: 0,
        dbPath: '',
        phase: 'detail',
        categories: ['Car'],
        headless: true,
      },
      () => false,
    );

    expect(db.saveListing).toHaveBeenCalled();
  });

  it('handles non-listing page redirect by marking gone', async () => {
    const page = mockPage();
    page.goto.mockResolvedValue({ status: () => 200 });
    page.evaluate.mockResolvedValueOnce(false); // IS_LISTING_SCRIPT returns false
    page.url.mockReturnValue('https://www.mobile.de/cz/'); // Not a detail page URL
    const ctx = mockContext(page);
    const db = mockDb();

    db.getPendingUrls
      .mockReturnValueOnce([{ url: 'https://mobile.de/a?id=1', mobile_id: '1', id: 1, status: 'pending', attempts: 0 }])
      .mockReturnValueOnce([]);

    await runDetailPhase(
      ctx as any,
      db as any,
      {
        concurrency: 1,
        delay: 0,
        maxRetries: 0,
        limit: 0,
        dbPath: '',
        phase: 'detail',
        categories: ['Car'],
        headless: true,
      },
      () => false,
    );

    expect(db.markGone).toHaveBeenCalled();
  });

  it('maps extracted fields including fallbacks and stops at configured limit', async () => {
    const page = mockPage();
    const ctx = mockContext(page);
    const db = mockDb();

    page.evaluate
      .mockResolvedValueOnce(false) // IS_LISTING_SCRIPT
      .mockResolvedValueOnce({
        title: null,
        priceLabel: '25 000 €',
        priceCzk: '625 000 Kč',
        priceEvaluation: 'Výhodná cena',
        mileageRaw: '100 000 km',
        power: '90 kW',
        fuel: 'Benzín',
        transmission: 'Manuál',
        firstRegistration: '2018',
        numOwnersRaw: '2 majitelé',
        technicalData: {
          mileage: '123 456 km',
          power: '110 kW',
          fuel: 'Diesel',
          transmission: 'Automat',
          firstRegistration: '2020',
          numSeats: '5 míst',
          category: 'SUV',
          damageCondition: 'Bez poškození',
          modelRange: 'X3',
          trimLine: 'Sport',
          cubicCapacity: '1998 cm3',
          'envkv.engineType': 'Řadový',
          'envkv.energyConsumption': '6.2 l/100 km',
          'envkv.co2Emissions': '120 g/km',
          'envkv.co2Class': 'B',
          'envkv.consumptionDetails.fuel': '5.8 l/100 km',
          doorCount: '5',
          climatisation: 'Automatická',
          parkAssists: 'Ano',
          airbag: '6',
          manufacturerColorName: 'Modrá',
          color: 'Blue',
          interior: 'Leather',
        },
        features: ['ABS', 'ESP'],
        description: 'Udržované vozidlo',
        sellerName: 'Autosalon',
        sellerAddress1: 'Ulice 1',
        sellerAddress2: 'Praha',
        sellerRating: '4,8',
        sellerRatingCount: '10',
        sellerId: '123',
        imageUrls: ['https://img1.jpg', 'https://img2.jpg'],
        rawKeyFeatures: 'raw-key',
      }); // EXTRACT_SCRIPT
    page.url.mockReturnValue('https://www.mobile.de/cz/details.html?id=1');

    db.getPendingUrls.mockReturnValueOnce([
      { url: 'https://mobile.de/a?id=1', mobile_id: '1', category: 'SUV', id: 1, status: 'pending', attempts: 0 },
    ]);

    await runDetailPhase(
      ctx as any,
      db as any,
      {
        concurrency: 1,
        delay: 0,
        maxRetries: 0,
        limit: 1,
        dbPath: '',
        phase: 'detail',
        categories: ['Car'],
        headless: true,
      },
      () => false,
    );

    expect(db.getPendingUrls).toHaveBeenCalledTimes(1);
    expect(db.saveListing).toHaveBeenCalledWith(
      expect.objectContaining({
        title: undefined,
        num_owners: 2,
        num_seats: 5,
        features: JSON.stringify(['ABS', 'ESP']),
        raw_technical_data: expect.any(String),
        category: 'SUV',
      }),
    );
    expect(db.finishRun).toHaveBeenCalledWith(1, 1, 1, 0, 'completed');
  });

  it('uses undefined when owner/seat values are not numeric', async () => {
    const page = mockPage();
    const ctx = mockContext(page);
    const db = mockDb();

    page.evaluate
      .mockResolvedValueOnce(true) // IS_LISTING_SCRIPT
      .mockResolvedValueOnce({
        title: 'Test',
        priceLabel: null,
        priceCzk: null,
        priceEvaluation: null,
        mileageRaw: null,
        power: null,
        fuel: null,
        transmission: null,
        firstRegistration: null,
        numOwnersRaw: 'neuvedeno',
        technicalData: { numSeats: 'neuvedeno' },
        features: [],
        description: null,
        sellerName: null,
        sellerAddress1: null,
        sellerAddress2: null,
        sellerRating: null,
        sellerRatingCount: null,
        sellerId: null,
        imageUrls: [],
        rawKeyFeatures: null,
      }); // EXTRACT_SCRIPT

    db.getPendingUrls
      .mockReturnValueOnce([{ url: 'https://mobile.de/a?id=1', mobile_id: '1', id: 1, status: 'pending', attempts: 0 }])
      .mockReturnValueOnce([]);

    await runDetailPhase(
      ctx as any,
      db as any,
      {
        concurrency: 1,
        delay: 0,
        maxRetries: 0,
        limit: 0,
        dbPath: '',
        phase: 'detail',
        categories: ['Car'],
        headless: true,
      },
      () => false,
    );

    expect(db.saveListing).toHaveBeenCalledWith(
      expect.objectContaining({
        num_owners: undefined,
        num_seats: undefined,
      }),
    );
  });

  it('handles missing response object as status 0 and marks non-detail page gone', async () => {
    const page = mockPage();
    page.goto.mockResolvedValueOnce({ status: () => 200 }).mockResolvedValueOnce(undefined);
    page.evaluate.mockResolvedValueOnce(false); // IS_LISTING_SCRIPT
    page.url.mockReturnValue('https://www.mobile.de/cz/');
    const ctx = mockContext(page);
    const db = mockDb();

    db.getPendingUrls
      .mockReturnValueOnce([{ url: 'https://mobile.de/a?id=1', mobile_id: '1', id: 1, status: 'pending', attempts: 0 }])
      .mockReturnValueOnce([]);

    await runDetailPhase(
      ctx as any,
      db as any,
      {
        concurrency: 1,
        delay: 0,
        maxRetries: 0,
        limit: 0,
        dbPath: '',
        phase: 'detail',
        categories: ['Car'],
        headless: true,
      },
      () => false,
    );

    expect(db.markGone).toHaveBeenCalledWith('https://mobile.de/a?id=1');
  });

  it('retries repeatedly blocked URL and eventually marks it failed', async () => {
    const page = mockPage();
    page.goto
      .mockResolvedValueOnce({ status: () => 200 }) // cookie page
      .mockResolvedValueOnce({ status: () => 429 })
      .mockResolvedValueOnce({ status: () => 429 });
    const ctx = mockContext(page);
    const db = mockDb();

    db.getPendingUrls
      .mockReturnValueOnce([{ url: 'https://mobile.de/a?id=1', mobile_id: '1', id: 1, status: 'pending', attempts: 0 }])
      .mockReturnValueOnce([]);

    await runDetailPhase(
      ctx as any,
      db as any,
      {
        concurrency: 1,
        delay: 0,
        maxRetries: 1,
        limit: 0,
        dbPath: '',
        phase: 'detail',
        categories: ['Car'],
        headless: true,
      },
      () => false,
    );

    expect(db.markFailed).toHaveBeenCalledWith('https://mobile.de/a?id=1', expect.stringContaining('Blocked (429)'));
  });

  it('supports zero concurrency by skipping worker page setup', async () => {
    const page = mockPage();
    const ctx = mockContext(page);
    const db = mockDb();

    db.getPendingUrls.mockReturnValue([]);

    await runDetailPhase(
      ctx as any,
      db as any,
      {
        concurrency: 0,
        delay: 0,
        maxRetries: 0,
        limit: 0,
        dbPath: '',
        phase: 'detail',
        categories: ['Car'],
        headless: true,
      },
      () => false,
    );

    expect(ctx.newPage).not.toHaveBeenCalled();
    expect(db.finishRun).toHaveBeenCalledWith(1, 1, 0, 0, 'completed');
  });

  it('stops on shutdown', async () => {
    const page = mockPage();
    const ctx = mockContext(page);
    const db = mockDb();
    db.getPendingUrls.mockReturnValue([]);

    await runDetailPhase(
      ctx as any,
      db as any,
      {
        concurrency: 1,
        delay: 0,
        maxRetries: 0,
        limit: 0,
        dbPath: '',
        phase: 'detail',
        categories: ['Car'],
        headless: true,
      },
      () => true,
    );

    expect(db.finishRun).toHaveBeenCalledWith(1, 1, 0, 0, 'interrupted');
  });

  it('handles no pending URLs', async () => {
    const page = mockPage();
    const ctx = mockContext(page);
    const db = mockDb();
    db.getUrlCounts.mockReturnValue({ total: 0, pending: 0, scraped: 0, failed: 0, gone: 0 });

    await runDetailPhase(
      ctx as any,
      db as any,
      {
        concurrency: 1,
        delay: 0,
        maxRetries: 0,
        limit: 0,
        dbPath: '',
        phase: 'detail',
        categories: ['Car'],
        headless: true,
      },
      () => false,
    );

    expect(db.startRun).not.toHaveBeenCalled();
  });

  it('handles page close error gracefully in finally', async () => {
    const page = mockPage();
    page.close.mockRejectedValue(new Error('already closed'));
    const ctx = mockContext(page);
    const db = mockDb();
    db.getPendingUrls.mockReturnValue([]);

    await runDetailPhase(
      ctx as any,
      db as any,
      {
        concurrency: 1,
        delay: 0,
        maxRetries: 0,
        limit: 0,
        dbPath: '',
        phase: 'detail',
        categories: ['Car'],
        headless: true,
      },
      () => true,
    );

    // No error thrown
    expect(db.finishRun).toHaveBeenCalled();
  });

  it('executes periodic progress callback and logs current delay', async () => {
    const page = mockPage();
    const ctx = mockContext(page);
    const db = mockDb();
    db.getPendingUrls.mockReturnValueOnce([]);

    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const setIntervalSpy = vi.spyOn(globalThis, 'setInterval').mockImplementation(((handler: unknown) => {
      if (typeof handler === 'function') handler();
      return 777 as ReturnType<typeof setInterval>;
    }) as typeof setInterval);
    const clearIntervalSpy = vi.spyOn(globalThis, 'clearInterval');

    try {
      await runDetailPhase(
        ctx as any,
        db as any,
        {
          concurrency: 1,
          delay: 0,
          maxRetries: 0,
          limit: 0,
          dbPath: '',
          phase: 'detail',
          categories: ['Car'],
          headless: true,
        },
        () => false,
      );

      expect(setIntervalSpy).toHaveBeenCalled();
      expect(logSpy.mock.calls.some(([msg]) => String(msg).includes('Delay: 0ms'))).toBe(true);
      expect(clearIntervalSpy).toHaveBeenCalledWith(777);
    } finally {
      clearIntervalSpy.mockRestore();
      setIntervalSpy.mockRestore();
      logSpy.mockRestore();
    }
  });
});
