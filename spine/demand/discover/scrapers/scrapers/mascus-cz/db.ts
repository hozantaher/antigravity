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
    CREATE TABLE IF NOT EXISTS mascus_cz_urls (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      url TEXT UNIQUE NOT NULL,
      sitemap_file TEXT,
      lastmod TEXT,
      status TEXT DEFAULT 'pending',
      attempts INTEGER DEFAULT 0,
      last_attempt_at TEXT,
      error_message TEXT
    );

    CREATE TABLE IF NOT EXISTS mascus_cz_listings (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      url TEXT UNIQUE NOT NULL,
      mascus_id TEXT,

      name TEXT, brand TEXT, model TEXT, sku TEXT, description TEXT,
      price REAL, price_currency TEXT,
      item_condition TEXT, availability TEXT,

      seller_name TEXT,

      category_path TEXT, category TEXT,

      image_urls TEXT, image_count INTEGER,

      year_of_manufacture TEXT, first_registration TEXT,
      mileage TEXT, mileage_km INTEGER,
      gross_weight TEXT,
      location_country TEXT, location_city TEXT,

      engine_power TEXT, engine_displacement TEXT,
      transmission TEXT, axle_configuration TEXT,

      vin TEXT, registration_number TEXT, emission_class TEXT,

      raw_specs_json TEXT,
      raw_jsonld TEXT,

      scraped_at TEXT DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS mascus_cz_scrape_runs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      phase TEXT,
      started_at TEXT DEFAULT (datetime('now')),
      finished_at TEXT,
      urls_total INTEGER DEFAULT 0,
      urls_scraped INTEGER DEFAULT 0,
      urls_failed INTEGER DEFAULT 0,
      status TEXT DEFAULT 'running'
    );

    CREATE INDEX IF NOT EXISTS idx_mascus_cz_urls_status ON mascus_cz_urls(status);
    CREATE INDEX IF NOT EXISTS idx_mascus_cz_urls_status_attempts ON mascus_cz_urls(status, attempts);
    CREATE INDEX IF NOT EXISTS idx_mascus_cz_listings_url ON mascus_cz_listings(url);
  `);

  // Prepared statements
  const insertUrl = db.prepare(`
    INSERT OR IGNORE INTO mascus_cz_urls (url, sitemap_file, lastmod)
    VALUES (@url, @sitemap_file, @lastmod)
  `);

  const insertUrlBatch = db.transaction((urls: Array<{ url: string; sitemap_file: string; lastmod?: string }>) => {
    for (const u of urls) {
      insertUrl.run({ url: u.url, sitemap_file: u.sitemap_file, lastmod: u.lastmod ?? null });
    }
  });

  const getPendingUrls = db.prepare<[number, number], UrlRow>(`
    SELECT * FROM mascus_cz_urls
    WHERE status = 'pending' OR (status = 'failed' AND attempts < ?)
    ORDER BY id
    LIMIT ?
  `);

  const markScraped = db.prepare(`
    UPDATE mascus_cz_urls SET status = 'scraped', attempts = attempts + 1, last_attempt_at = datetime('now')
    WHERE url = ?
  `);

  const markFailed = db.prepare(`
    UPDATE mascus_cz_urls SET status = 'failed', attempts = attempts + 1, last_attempt_at = datetime('now'), error_message = ?
    WHERE url = ?
  `);

  const markGone = db.prepare(`
    UPDATE mascus_cz_urls SET status = 'gone', attempts = attempts + 1, last_attempt_at = datetime('now')
    WHERE url = ?
  `);

  const insertListing = db.prepare(`
    INSERT OR REPLACE INTO mascus_cz_listings (
      url, mascus_id,
      name, brand, model, sku, description,
      price, price_currency, item_condition, availability,
      seller_name,
      category_path, category,
      image_urls, image_count,
      year_of_manufacture, first_registration,
      mileage, mileage_km, gross_weight,
      location_country, location_city,
      engine_power, engine_displacement,
      transmission, axle_configuration,
      vin, registration_number, emission_class,
      raw_specs_json, raw_jsonld
    ) VALUES (
      @url, @mascus_id,
      @name, @brand, @model, @sku, @description,
      @price, @price_currency, @item_condition, @availability,
      @seller_name,
      @category_path, @category,
      @image_urls, @image_count,
      @year_of_manufacture, @first_registration,
      @mileage, @mileage_km, @gross_weight,
      @location_country, @location_city,
      @engine_power, @engine_displacement,
      @transmission, @axle_configuration,
      @vin, @registration_number, @emission_class,
      @raw_specs_json, @raw_jsonld
    )
  `);

  const saveListing = db.transaction((data: ListingData) => {
    const params: Record<string, unknown> = {
      url: data.url,
      mascus_id: data.mascus_id ?? null,
      name: data.name ?? null,
      brand: data.brand ?? null,
      model: data.model ?? null,
      sku: data.sku ?? null,
      description: data.description ?? null,
      price: data.price ?? null,
      price_currency: data.price_currency ?? null,
      item_condition: data.item_condition ?? null,
      availability: data.availability ?? null,
      seller_name: data.seller_name ?? null,
      category_path: data.category_path ?? null,
      category: data.category ?? null,
      image_urls: data.image_urls ?? null,
      image_count: data.image_count ?? null,
      year_of_manufacture: data.year_of_manufacture ?? null,
      first_registration: data.first_registration ?? null,
      mileage: data.mileage ?? null,
      mileage_km: data.mileage_km ?? null,
      gross_weight: data.gross_weight ?? null,
      location_country: data.location_country ?? null,
      location_city: data.location_city ?? null,
      engine_power: data.engine_power ?? null,
      engine_displacement: data.engine_displacement ?? null,
      transmission: data.transmission ?? null,
      axle_configuration: data.axle_configuration ?? null,
      vin: data.vin ?? null,
      registration_number: data.registration_number ?? null,
      emission_class: data.emission_class ?? null,
      raw_specs_json: data.raw_specs_json ?? null,
      raw_jsonld: data.raw_jsonld ?? null,
    };
    insertListing.run(params);
    markScraped.run(data.url);
  });

  const startRun = db.prepare<[string], { id: number }>(`
    INSERT INTO mascus_cz_scrape_runs (phase) VALUES (?) RETURNING id
  `);

  const finishRun = db.prepare(`
    UPDATE mascus_cz_scrape_runs
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
    FROM mascus_cz_urls
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
