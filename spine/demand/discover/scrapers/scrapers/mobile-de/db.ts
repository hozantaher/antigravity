import Database from 'better-sqlite3';
import type { ListingData, SearchProgressRow, SearchSegmentRow, UrlRow, VehicleCategory } from './types.js';

export const createDb = (dbPath: string) => {
  const db = new Database(dbPath);

  // Performance settings for bulk inserts
  db.pragma('journal_mode = WAL');
  db.pragma('synchronous = NORMAL');
  db.pragma('cache_size = -64000'); // 64MB
  db.pragma('busy_timeout = 5000');

  // Create tables
  db.exec(`
    CREATE TABLE IF NOT EXISTS mobile_de_urls (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      url TEXT UNIQUE NOT NULL,
      mobile_id TEXT NOT NULL,
      category TEXT,
      status TEXT DEFAULT 'pending',
      attempts INTEGER DEFAULT 0,
      last_attempt_at TEXT,
      error_message TEXT
    );

    CREATE TABLE IF NOT EXISTS mobile_de_listings (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      url TEXT UNIQUE NOT NULL,
      mobile_id TEXT NOT NULL,
      category TEXT,

      title TEXT, subtitle TEXT,

      price_eur REAL, price_eur_original REAL, price_czk REAL, price_evaluation TEXT,

      mileage TEXT, mileage_km INTEGER, power TEXT, fuel TEXT,
      transmission TEXT, first_registration TEXT, num_owners INTEGER,

      damage_condition TEXT, body_category TEXT, model_range TEXT, trim_line TEXT,
      cubic_capacity TEXT, engine_type TEXT, energy_consumption TEXT,
      co2_emissions TEXT, co2_class TEXT, fuel_consumption TEXT,
      num_seats INTEGER, door_count TEXT, climatisation TEXT,
      park_assists TEXT, airbag TEXT, manufacturer_color TEXT,
      color TEXT, interior TEXT,

      features TEXT,
      description TEXT,

      seller_name TEXT, seller_address1 TEXT, seller_address2 TEXT,
      seller_rating TEXT, seller_rating_count TEXT, seller_id TEXT,

      image_urls TEXT,
      image_count INTEGER,

      raw_technical_data TEXT,
      raw_key_features TEXT,

      scraped_at TEXT DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS mobile_de_search_progress (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      category TEXT NOT NULL UNIQUE,
      total_results INTEGER,
      last_page_scraped INTEGER DEFAULT 0,
      total_pages INTEGER,
      status TEXT DEFAULT 'pending'
    );

    CREATE TABLE IF NOT EXISTS mobile_de_scrape_runs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      phase TEXT,
      started_at TEXT DEFAULT (datetime('now')),
      finished_at TEXT,
      urls_total INTEGER DEFAULT 0,
      urls_scraped INTEGER DEFAULT 0,
      urls_failed INTEGER DEFAULT 0,
      status TEXT DEFAULT 'running'
    );

    CREATE TABLE IF NOT EXISTS mobile_de_search_segments (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      category TEXT NOT NULL,
      price_from INTEGER NOT NULL,
      price_to INTEGER NOT NULL,
      total_results INTEGER,
      last_page_scraped INTEGER DEFAULT 0,
      total_pages INTEGER,
      status TEXT DEFAULT 'pending',
      UNIQUE(category, price_from, price_to)
    );

    CREATE INDEX IF NOT EXISTS idx_mobile_de_urls_status ON mobile_de_urls(status);
    CREATE INDEX IF NOT EXISTS idx_mobile_de_urls_status_attempts ON mobile_de_urls(status, attempts);
    CREATE INDEX IF NOT EXISTS idx_mobile_de_urls_mobile_id ON mobile_de_urls(mobile_id);
    CREATE INDEX IF NOT EXISTS idx_mobile_de_listings_url ON mobile_de_listings(url);
    CREATE INDEX IF NOT EXISTS idx_mobile_de_search_segments_status ON mobile_de_search_segments(category, status);
  `);

  // Prepared statements
  const insertUrl = db.prepare(`
    INSERT OR IGNORE INTO mobile_de_urls (url, mobile_id, category)
    VALUES (@url, @mobile_id, @category)
  `);

  const insertUrlBatch = db.transaction((urls: Array<{ url: string; mobile_id: string; category: string }>) => {
    let inserted = 0;
    for (const u of urls) {
      const result = insertUrl.run({ url: u.url, mobile_id: u.mobile_id, category: u.category });
      if (result.changes > 0) inserted++;
    }
    return inserted;
  });

  const getPendingUrls = db.prepare<[number, number], UrlRow>(`
    SELECT * FROM mobile_de_urls
    WHERE status = 'pending' OR (status = 'failed' AND attempts < ?)
    ORDER BY id
    LIMIT ?
  `);

  const markScraped = db.prepare(`
    UPDATE mobile_de_urls SET status = 'scraped', attempts = attempts + 1, last_attempt_at = datetime('now')
    WHERE url = ?
  `);

  const markFailed = db.prepare(`
    UPDATE mobile_de_urls SET status = 'failed', attempts = attempts + 1, last_attempt_at = datetime('now'), error_message = ?
    WHERE url = ?
  `);

  const markGone = db.prepare(`
    UPDATE mobile_de_urls SET status = 'gone', attempts = attempts + 1, last_attempt_at = datetime('now')
    WHERE url = ?
  `);

  const insertListing = db.prepare(`
    INSERT OR REPLACE INTO mobile_de_listings (
      url, mobile_id, category,
      title, subtitle,
      price_eur, price_eur_original, price_czk, price_evaluation,
      mileage, mileage_km, power, fuel,
      transmission, first_registration, num_owners,
      damage_condition, body_category, model_range, trim_line,
      cubic_capacity, engine_type, energy_consumption,
      co2_emissions, co2_class, fuel_consumption,
      num_seats, door_count, climatisation,
      park_assists, airbag, manufacturer_color,
      color, interior,
      features, description,
      seller_name, seller_address1, seller_address2,
      seller_rating, seller_rating_count, seller_id,
      image_urls, image_count,
      raw_technical_data, raw_key_features
    ) VALUES (
      @url, @mobile_id, @category,
      @title, @subtitle,
      @price_eur, @price_eur_original, @price_czk, @price_evaluation,
      @mileage, @mileage_km, @power, @fuel,
      @transmission, @first_registration, @num_owners,
      @damage_condition, @body_category, @model_range, @trim_line,
      @cubic_capacity, @engine_type, @energy_consumption,
      @co2_emissions, @co2_class, @fuel_consumption,
      @num_seats, @door_count, @climatisation,
      @park_assists, @airbag, @manufacturer_color,
      @color, @interior,
      @features, @description,
      @seller_name, @seller_address1, @seller_address2,
      @seller_rating, @seller_rating_count, @seller_id,
      @image_urls, @image_count,
      @raw_technical_data, @raw_key_features
    )
  `);

  const saveListing = db.transaction((data: ListingData) => {
    const params: Record<string, unknown> = {
      url: data.url,
      mobile_id: data.mobile_id,
      category: data.category ?? null,
      title: data.title ?? null,
      subtitle: data.subtitle ?? null,
      price_eur: data.price_eur ?? null,
      price_eur_original: data.price_eur_original ?? null,
      price_czk: data.price_czk ?? null,
      price_evaluation: data.price_evaluation ?? null,
      mileage: data.mileage ?? null,
      mileage_km: data.mileage_km ?? null,
      power: data.power ?? null,
      fuel: data.fuel ?? null,
      transmission: data.transmission ?? null,
      first_registration: data.first_registration ?? null,
      num_owners: data.num_owners ?? null,
      damage_condition: data.damage_condition ?? null,
      body_category: data.body_category ?? null,
      model_range: data.model_range ?? null,
      trim_line: data.trim_line ?? null,
      cubic_capacity: data.cubic_capacity ?? null,
      engine_type: data.engine_type ?? null,
      energy_consumption: data.energy_consumption ?? null,
      co2_emissions: data.co2_emissions ?? null,
      co2_class: data.co2_class ?? null,
      fuel_consumption: data.fuel_consumption ?? null,
      num_seats: data.num_seats ?? null,
      door_count: data.door_count ?? null,
      climatisation: data.climatisation ?? null,
      park_assists: data.park_assists ?? null,
      airbag: data.airbag ?? null,
      manufacturer_color: data.manufacturer_color ?? null,
      color: data.color ?? null,
      interior: data.interior ?? null,
      features: data.features ?? null,
      description: data.description ?? null,
      seller_name: data.seller_name ?? null,
      seller_address1: data.seller_address1 ?? null,
      seller_address2: data.seller_address2 ?? null,
      seller_rating: data.seller_rating ?? null,
      seller_rating_count: data.seller_rating_count ?? null,
      seller_id: data.seller_id ?? null,
      image_urls: data.image_urls ?? null,
      image_count: data.image_count ?? null,
      raw_technical_data: data.raw_technical_data ?? null,
      raw_key_features: data.raw_key_features ?? null,
    };
    insertListing.run(params);
    markScraped.run(data.url);
  });

  // Search progress
  const upsertSearchProgress = db.prepare(`
    INSERT INTO mobile_de_search_progress (category, total_results, last_page_scraped, total_pages, status)
    VALUES (@category, @total_results, @last_page_scraped, @total_pages, @status)
    ON CONFLICT(category) DO UPDATE SET
      total_results = COALESCE(@total_results, total_results),
      last_page_scraped = @last_page_scraped,
      total_pages = COALESCE(@total_pages, total_pages),
      status = @status
  `);

  const getSearchProgress = db.prepare<[string], SearchProgressRow>(`
    SELECT * FROM mobile_de_search_progress WHERE category = ?
  `);

  const startRun = db.prepare<[string], { id: number }>(`
    INSERT INTO mobile_de_scrape_runs (phase) VALUES (?) RETURNING id
  `);

  const finishRun = db.prepare(`
    UPDATE mobile_de_scrape_runs
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
    FROM mobile_de_urls
  `);

  // Search segments
  const insertSegment = db.prepare(`
    INSERT OR IGNORE INTO mobile_de_search_segments (category, price_from, price_to)
    VALUES (@category, @price_from, @price_to)
  `);

  const insertSegmentsBatch = db.transaction(
    (segments: Array<{ category: string; price_from: number; price_to: number }>) => {
      for (const s of segments) {
        insertSegment.run(s);
      }
    },
  );

  const getPendingSegmentsStmt = db.prepare<[string], SearchSegmentRow>(`
    SELECT * FROM mobile_de_search_segments
    WHERE category = ? AND status IN ('pending', 'in_progress')
    ORDER BY price_from ASC
  `);

  const getSegmentStmt = db.prepare<[number], SearchSegmentRow>(`
    SELECT * FROM mobile_de_search_segments WHERE id = ?
  `);

  const updateSegmentStmt = db.prepare(`
    UPDATE mobile_de_search_segments
    SET total_results = COALESCE(@total_results, total_results),
        last_page_scraped = @last_page_scraped,
        total_pages = COALESCE(@total_pages, total_pages),
        status = @status
    WHERE id = @id
  `);

  const deleteSegmentStmt = db.prepare(`
    DELETE FROM mobile_de_search_segments WHERE id = ?
  `);

  const getSegmentStatsStmt = db.prepare<[string], { status: string; count: number }>(`
    SELECT status, COUNT(*) as count FROM mobile_de_search_segments
    WHERE category = ?
    GROUP BY status
  `);

  const getSegmentCountForCategory = db.prepare<[string], { count: number }>(`
    SELECT COUNT(*) as count FROM mobile_de_search_segments WHERE category = ?
  `);

  const resetSearchSegments = db.prepare(`DELETE FROM mobile_de_search_segments`);
  const resetSearchProgress = db.prepare(`DELETE FROM mobile_de_search_progress`);

  return {
    db,
    insertUrlBatch: (urls: Array<{ url: string; mobile_id: string; category: string }>) => {
      return insertUrlBatch(urls);
    },
    getPendingUrls: (maxRetries: number, limit: number): UrlRow[] => {
      return getPendingUrls.all(maxRetries, limit) as UrlRow[];
    },
    markFailed: (url: string, error: string) => markFailed.run(error, url),
    markGone: (url: string) => markGone.run(url),
    saveListing,
    getSearchProgress: (category: VehicleCategory): SearchProgressRow | undefined => {
      return getSearchProgress.get(category) as SearchProgressRow | undefined;
    },
    upsertSearchProgress: (data: {
      category: VehicleCategory;
      total_results?: number;
      last_page_scraped: number;
      total_pages?: number;
      status: string;
    }) => {
      upsertSearchProgress.run({
        category: data.category,
        total_results: data.total_results ?? null,
        last_page_scraped: data.last_page_scraped,
        total_pages: data.total_pages ?? null,
        status: data.status,
      });
    },
    startRun: (phase: string): number => {
      const row = startRun.get(phase);
      return row!.id;
    },
    finishRun: (id: number, total: number, scraped: number, failed: number, status: string) => {
      finishRun.run(total, scraped, failed, status, id);
    },
    getUrlCounts: () => getUrlCounts.get()!,
    insertSegments: (segments: Array<{ category: string; price_from: number; price_to: number }>) => {
      insertSegmentsBatch(segments);
    },
    getPendingSegments: (category: string): SearchSegmentRow[] => {
      return getPendingSegmentsStmt.all(category) as SearchSegmentRow[];
    },
    getSegment: (id: number): SearchSegmentRow | undefined => {
      return getSegmentStmt.get(id) as SearchSegmentRow | undefined;
    },
    updateSegment: (data: {
      id: number;
      total_results?: number;
      last_page_scraped: number;
      total_pages?: number;
      status: string;
    }) => {
      updateSegmentStmt.run({
        id: data.id,
        total_results: data.total_results ?? null,
        last_page_scraped: data.last_page_scraped,
        total_pages: data.total_pages ?? null,
        status: data.status,
      });
    },
    deleteSegment: (id: number) => {
      deleteSegmentStmt.run(id);
    },
    getSegmentStats: (category: string): Record<string, number> => {
      const rows = getSegmentStatsStmt.all(category) as Array<{ status: string; count: number }>;
      const stats: Record<string, number> = {};
      for (const row of rows) {
        stats[row.status] = row.count;
      }
      return stats;
    },
    getSegmentCountForCategory: (category: string): number => {
      return (getSegmentCountForCategory.get(category) as { count: number }).count;
    },
    resetSearch: () => {
      resetSearchSegments.run();
      resetSearchProgress.run();
    },
    close: () => db.close(),
  };
};

export type ScraperDb = ReturnType<typeof createDb>;
