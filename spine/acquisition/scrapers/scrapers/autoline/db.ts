import Database from 'better-sqlite3';
import type { ListingData, SitemapUrl, UrlRow } from './types.js';

export const createDb = (dbPath: string) => {
  const db = new Database(dbPath);

  // Performance settings for bulk inserts
  db.pragma('journal_mode = WAL');
  db.pragma('synchronous = NORMAL');
  db.pragma('cache_size = -64000'); // 64MB
  db.pragma('busy_timeout = 5000');

  // Create tables
  db.exec(`
    CREATE TABLE IF NOT EXISTS autoline_urls (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      url TEXT UNIQUE NOT NULL,
      sitemap_file TEXT,
      lastmod TEXT,
      status TEXT DEFAULT 'pending',
      attempts INTEGER DEFAULT 0,
      last_attempt_at TEXT,
      error_message TEXT
    );

    CREATE TABLE IF NOT EXISTS autoline_listings (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      url TEXT UNIQUE NOT NULL,
      autoline_id TEXT,

      name TEXT, brand TEXT, model TEXT, sku TEXT, description TEXT,
      price REAL, price_currency TEXT,
      item_condition TEXT, availability TEXT,
      aggregate_rating REAL, review_count INTEGER,

      seller_name TEXT, content_location TEXT, date_published TEXT,

      category_path TEXT, category TEXT,

      image_urls TEXT, image_count INTEGER,

      vehicle_type TEXT, first_registration TEXT,
      mileage TEXT, mileage_km INTEGER,
      volume TEXT, payload TEXT, gross_weight TEXT,
      location_country TEXT, location_city TEXT,
      dealer_id TEXT, listing_date TEXT,

      engine_power TEXT, fuel_type TEXT, engine_displacement TEXT,
      fuel_tank TEXT, transmission TEXT,
      axle_count TEXT, axle_configuration TEXT, wheelbase TEXT,

      condition TEXT, vin TEXT, color TEXT,
      body_dimensions TEXT, air_conditioning TEXT,

      features TEXT,

      raw_specs_json TEXT,
      raw_jsonld TEXT,

      scraped_at TEXT DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS autoline_scrape_runs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      phase TEXT,
      started_at TEXT DEFAULT (datetime('now')),
      finished_at TEXT,
      urls_total INTEGER DEFAULT 0,
      urls_scraped INTEGER DEFAULT 0,
      urls_failed INTEGER DEFAULT 0,
      status TEXT DEFAULT 'running'
    );

    CREATE INDEX IF NOT EXISTS idx_autoline_urls_status ON autoline_urls(status);
    CREATE INDEX IF NOT EXISTS idx_autoline_urls_status_attempts ON autoline_urls(status, attempts);
    CREATE INDEX IF NOT EXISTS idx_autoline_listings_url ON autoline_listings(url);
  `);

  // Prepared statements
  const insertUrl = db.prepare(`
    INSERT OR IGNORE INTO autoline_urls (url, sitemap_file, lastmod)
    VALUES (@url, @sitemap_file, @lastmod)
  `);

  const insertUrlBatch = db.transaction((urls: Array<{ url: string; sitemap_file: string; lastmod?: string }>) => {
    for (const u of urls) {
      insertUrl.run({ url: u.url, sitemap_file: u.sitemap_file, lastmod: u.lastmod ?? null });
    }
  });

  const getPendingUrls = db.prepare<[number, number], UrlRow>(`
    SELECT * FROM autoline_urls
    WHERE status = 'pending' OR (status = 'failed' AND attempts < ?)
    ORDER BY id
    LIMIT ?
  `);

  const markScraped = db.prepare(`
    UPDATE autoline_urls SET status = 'scraped', attempts = attempts + 1, last_attempt_at = datetime('now')
    WHERE url = ?
  `);

  const markFailed = db.prepare(`
    UPDATE autoline_urls SET status = 'failed', attempts = attempts + 1, last_attempt_at = datetime('now'), error_message = ?
    WHERE url = ?
  `);

  const markGone = db.prepare(`
    UPDATE autoline_urls SET status = 'gone', attempts = attempts + 1, last_attempt_at = datetime('now')
    WHERE url = ?
  `);

  const insertListing = db.prepare(`
    INSERT OR REPLACE INTO autoline_listings (
      url, autoline_id,
      name, brand, model, sku, description,
      price, price_currency, item_condition, availability,
      aggregate_rating, review_count,
      seller_name, content_location, date_published,
      category_path, category,
      image_urls, image_count,
      vehicle_type, first_registration,
      mileage, mileage_km, volume, payload, gross_weight,
      location_country, location_city, dealer_id, listing_date,
      engine_power, fuel_type, engine_displacement,
      fuel_tank, transmission,
      axle_count, axle_configuration, wheelbase,
      condition, vin, color,
      body_dimensions, air_conditioning,
      features,
      raw_specs_json, raw_jsonld
    ) VALUES (
      @url, @autoline_id,
      @name, @brand, @model, @sku, @description,
      @price, @price_currency, @item_condition, @availability,
      @aggregate_rating, @review_count,
      @seller_name, @content_location, @date_published,
      @category_path, @category,
      @image_urls, @image_count,
      @vehicle_type, @first_registration,
      @mileage, @mileage_km, @volume, @payload, @gross_weight,
      @location_country, @location_city, @dealer_id, @listing_date,
      @engine_power, @fuel_type, @engine_displacement,
      @fuel_tank, @transmission,
      @axle_count, @axle_configuration, @wheelbase,
      @condition, @vin, @color,
      @body_dimensions, @air_conditioning,
      @features,
      @raw_specs_json, @raw_jsonld
    )
  `);

  const saveListing = db.transaction((data: ListingData) => {
    // Ensure all fields have at least null
    const params: Record<string, unknown> = {
      url: data.url,
      autoline_id: data.autoline_id ?? null,
      name: data.name ?? null,
      brand: data.brand ?? null,
      model: data.model ?? null,
      sku: data.sku ?? null,
      description: data.description ?? null,
      price: data.price ?? null,
      price_currency: data.price_currency ?? null,
      item_condition: data.item_condition ?? null,
      availability: data.availability ?? null,
      aggregate_rating: data.aggregate_rating ?? null,
      review_count: data.review_count ?? null,
      seller_name: data.seller_name ?? null,
      content_location: data.content_location ?? null,
      date_published: data.date_published ?? null,
      category_path: data.category_path ?? null,
      category: data.category ?? null,
      image_urls: data.image_urls ?? null,
      image_count: data.image_count ?? null,
      vehicle_type: data.vehicle_type ?? null,
      first_registration: data.first_registration ?? null,
      mileage: data.mileage ?? null,
      mileage_km: data.mileage_km ?? null,
      volume: data.volume ?? null,
      payload: data.payload ?? null,
      gross_weight: data.gross_weight ?? null,
      location_country: data.location_country ?? null,
      location_city: data.location_city ?? null,
      dealer_id: data.dealer_id ?? null,
      listing_date: data.listing_date ?? null,
      engine_power: data.engine_power ?? null,
      fuel_type: data.fuel_type ?? null,
      engine_displacement: data.engine_displacement ?? null,
      fuel_tank: data.fuel_tank ?? null,
      transmission: data.transmission ?? null,
      axle_count: data.axle_count ?? null,
      axle_configuration: data.axle_configuration ?? null,
      wheelbase: data.wheelbase ?? null,
      condition: data.condition ?? null,
      vin: data.vin ?? null,
      color: data.color ?? null,
      body_dimensions: data.body_dimensions ?? null,
      air_conditioning: data.air_conditioning ?? null,
      features: data.features ?? null,
      raw_specs_json: data.raw_specs_json ?? null,
      raw_jsonld: data.raw_jsonld ?? null,
    };
    insertListing.run(params);
    markScraped.run(data.url);
  });

  const startRun = db.prepare<[string], { id: number }>(`
    INSERT INTO autoline_scrape_runs (phase) VALUES (?) RETURNING id
  `);

  const finishRun = db.prepare(`
    UPDATE autoline_scrape_runs
    SET finished_at = datetime('now'), urls_total = ?, urls_scraped = ?, urls_failed = ?, status = ?
    WHERE id = ?
  `);

  const getUrlCounts = db.prepare<
    [],
    { total: number; pending: number; scraped: number; failed: number; gone: number }
  >(`
    SELECT
      COUNT(*) as total,
      COALESCE(SUM(CASE WHEN status = 'pending' THEN 1 ELSE 0 END), 0) as pending,
      COALESCE(SUM(CASE WHEN status = 'scraped' THEN 1 ELSE 0 END), 0) as scraped,
      COALESCE(SUM(CASE WHEN status = 'failed' THEN 1 ELSE 0 END), 0) as failed,
      COALESCE(SUM(CASE WHEN status = 'gone' THEN 1 ELSE 0 END), 0) as gone
    FROM autoline_urls
  `);

  return {
    db,
    insertUrlBatch: (urls: SitemapUrl[], sitemapFile: string) => {
      insertUrlBatch(urls.map((u) => ({ url: u.loc, sitemap_file: sitemapFile, lastmod: u.lastmod })));
    },
    getPendingUrls: (maxRetries: number, limit: number): UrlRow[] => {
      return getPendingUrls.all(maxRetries, limit) as UrlRow[];
    },
    markFailed: (url: string, error: string) => markFailed.run(error, url),
    markGone: (url: string) => markGone.run(url),
    saveListing,
    startRun: (phase: string): number => {
      const row = startRun.get(phase);
      return row!.id;
    },
    finishRun: (id: number, total: number, scraped: number, failed: number, status: string) => {
      finishRun.run(total, scraped, failed, status, id);
    },
    getUrlCounts: () => getUrlCounts.get()!,
    close: () => db.close(),
  };
};

export type ScraperDb = ReturnType<typeof createDb>;
