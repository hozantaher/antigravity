import Database from 'better-sqlite3';
import { Queue } from 'bullmq';
import IORedis from 'ioredis';
import type { BusinessData, UrlRow } from './types.js';

const redisConnection = new IORedis(process.env.REDIS_URL || 'redis://127.0.0.1:6379', {
  maxRetriesPerRequest: null,
});
const ingestQueue = new Queue('antigravity-ingest', { connection: redisConnection as any });

/** Extract firmy_id and url_type from a firmy.cz URL */
const parseUrl = (url: string): { firmy_id: number | null; slug: string | null; url_type: string | null } => {
  const detailMatch = url.match(/\/detail\/(\d+)-(.+?)\.html/);
  if (detailMatch) return { firmy_id: parseInt(detailMatch[1], 10), slug: detailMatch[2], url_type: 'detail' };

  const unverifiedMatch = url.match(/\/neoverena-firma\/(\d+)-(.+?)\.html/);
  if (unverifiedMatch)
    return { firmy_id: parseInt(unverifiedMatch[1], 10), slug: unverifiedMatch[2], url_type: 'unverified' };

  return { firmy_id: null, slug: null, url_type: null };
};

export const createDb = (dbPath: string) => {
  const db = new Database(dbPath);

  db.pragma('journal_mode = WAL');
  db.pragma('synchronous = NORMAL');
  db.pragma('cache_size = -64000');
  db.pragma('busy_timeout = 5000');

  db.exec(`
    CREATE TABLE IF NOT EXISTS firmy_cz_urls (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      url TEXT UNIQUE NOT NULL,
      firmy_id INTEGER,
      slug TEXT,
      url_type TEXT,
      sitemap_file TEXT,
      status TEXT DEFAULT 'pending',
      attempts INTEGER DEFAULT 0,
      last_attempt_at TEXT,
      error_message TEXT
    );

    CREATE TABLE IF NOT EXISTS firmy_cz_businesses (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      url TEXT UNIQUE NOT NULL,
      firmy_id INTEGER,
      url_type TEXT,

      name TEXT, description TEXT,
      ico TEXT, datova_schranka TEXT,
      datum_zapisu TEXT, pravni_forma TEXT, velikost_firmy TEXT,

      website TEXT, telephone TEXT, email TEXT,

      street_address TEXT, address_locality TEXT,
      postal_code TEXT, address_country TEXT,
      latitude REAL, longitude REAL,

      category_path TEXT, categories_json TEXT,

      opening_hours TEXT, opening_hours_detail TEXT,

      rating_value REAL, rating_count INTEGER,

      primary_image TEXT, image_urls TEXT, image_count INTEGER,

      filters_json TEXT, same_as_json TEXT,

      raw_html TEXT, raw_jsonld TEXT,

      scraped_at TEXT DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS firmy_cz_scrape_runs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      phase TEXT,
      started_at TEXT DEFAULT (datetime('now')),
      finished_at TEXT,
      urls_total INTEGER DEFAULT 0,
      urls_scraped INTEGER DEFAULT 0,
      urls_failed INTEGER DEFAULT 0,
      status TEXT DEFAULT 'running'
    );

    CREATE INDEX IF NOT EXISTS idx_firmy_cz_urls_status ON firmy_cz_urls(status);
    CREATE INDEX IF NOT EXISTS idx_firmy_cz_urls_status_attempts ON firmy_cz_urls(status, attempts);
    CREATE INDEX IF NOT EXISTS idx_firmy_cz_urls_firmy_id ON firmy_cz_urls(firmy_id);
    CREATE INDEX IF NOT EXISTS idx_firmy_cz_urls_url_type ON firmy_cz_urls(url_type);
    CREATE INDEX IF NOT EXISTS idx_firmy_cz_businesses_firmy_id ON firmy_cz_businesses(firmy_id);
    CREATE INDEX IF NOT EXISTS idx_firmy_cz_businesses_ico ON firmy_cz_businesses(ico);
  `);

  // Prepared statements
  const insertUrl = db.prepare(`
    INSERT OR IGNORE INTO firmy_cz_urls (url, firmy_id, slug, url_type, sitemap_file)
    VALUES (@url, @firmy_id, @slug, @url_type, @sitemap_file)
  `);

  const insertUrlBatch = db.transaction((urls: Array<{ url: string; sitemap_file: string }>) => {
    for (const u of urls) {
      const { firmy_id, slug, url_type } = parseUrl(u.url);
      insertUrl.run({
        url: u.url,
        firmy_id,
        slug,
        url_type,
        sitemap_file: u.sitemap_file,
      });
    }
  });

  const getPendingUrls = db.prepare<[number, number], UrlRow>(`
    SELECT * FROM firmy_cz_urls
    WHERE status = 'pending' OR (status = 'failed' AND attempts < ?)
    ORDER BY id
    LIMIT ?
  `);

  const markScraped = db.prepare(`
    UPDATE firmy_cz_urls SET status = 'scraped', attempts = attempts + 1, last_attempt_at = datetime('now')
    WHERE url = ?
  `);

  const markFailed = db.prepare(`
    UPDATE firmy_cz_urls SET status = 'failed', attempts = attempts + 1, last_attempt_at = datetime('now'), error_message = ?
    WHERE url = ?
  `);

  const markGone = db.prepare(`
    UPDATE firmy_cz_urls SET status = 'gone', attempts = attempts + 1, last_attempt_at = datetime('now')
    WHERE url = ?
  `);

  const insertBusiness = db.prepare(`
    INSERT OR REPLACE INTO firmy_cz_businesses (
      url, firmy_id, url_type,
      name, description, ico, datova_schranka,
      datum_zapisu, pravni_forma, velikost_firmy,
      website, telephone, email,
      street_address, address_locality, postal_code, address_country,
      latitude, longitude,
      category_path, categories_json,
      opening_hours, opening_hours_detail,
      rating_value, rating_count,
      primary_image, image_urls, image_count,
      filters_json, same_as_json,
      raw_html, raw_jsonld
    ) VALUES (
      @url, @firmy_id, @url_type,
      @name, @description, @ico, @datova_schranka,
      @datum_zapisu, @pravni_forma, @velikost_firmy,
      @website, @telephone, @email,
      @street_address, @address_locality, @postal_code, @address_country,
      @latitude, @longitude,
      @category_path, @categories_json,
      @opening_hours, @opening_hours_detail,
      @rating_value, @rating_count,
      @primary_image, @image_urls, @image_count,
      @filters_json, @same_as_json,
      @raw_html, @raw_jsonld
    )
  `);

  const saveBusiness = db.transaction((data: BusinessData) => {
    const params: Record<string, unknown> = {
      url: data.url,
      firmy_id: data.firmy_id ?? null,
      url_type: data.url_type ?? null,
      name: data.name ?? null,
      description: data.description ?? null,
      ico: data.ico ?? null,
      datova_schranka: data.datova_schranka ?? null,
      datum_zapisu: data.datum_zapisu ?? null,
      pravni_forma: data.pravni_forma ?? null,
      velikost_firmy: data.velikost_firmy ?? null,
      website: data.website ?? null,
      telephone: data.telephone ?? null,
      email: data.email ?? null,
      street_address: data.street_address ?? null,
      address_locality: data.address_locality ?? null,
      postal_code: data.postal_code ?? null,
      address_country: data.address_country ?? null,
      latitude: data.latitude ?? null,
      longitude: data.longitude ?? null,
      category_path: data.category_path ?? null,
      categories_json: data.categories_json ?? null,
      opening_hours: data.opening_hours ?? null,
      opening_hours_detail: data.opening_hours_detail ?? null,
      rating_value: data.rating_value ?? null,
      rating_count: data.rating_count ?? null,
      primary_image: data.primary_image ?? null,
      image_urls: data.image_urls ?? null,
      image_count: data.image_count ?? null,
      filters_json: data.filters_json ?? null,
      same_as_json: data.same_as_json ?? null,
      raw_html: data.raw_html ?? null,
      raw_jsonld: data.raw_jsonld ?? null,
    };
    insertBusiness.run(params);
    markScraped.run(data.url);

    // The Hijack: Odeslání do Antigravity
    ingestQueue.add('new-business', { source: 'firmy-cz', item: data })
      .catch(err => console.error('[firmy-cz] Failed to send to Antigravity Ingest Queue:', err));
  });

  const startRun = db.prepare<[string], { id: number }>(`
    INSERT INTO firmy_cz_scrape_runs (phase) VALUES (?) RETURNING id
  `);

  const finishRun = db.prepare(`
    UPDATE firmy_cz_scrape_runs
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
    FROM firmy_cz_urls
  `);

  return {
    db,
    insertUrlBatch: (urls: string[], sitemapFile: string) => {
      insertUrlBatch(urls.map((u) => ({ url: u, sitemap_file: sitemapFile })));
    },
    getPendingUrls: (maxRetries: number, limit: number): UrlRow[] => {
      return getPendingUrls.all(maxRetries, limit) as UrlRow[];
    },
    markFailed: (url: string, error: string) => markFailed.run(error, url),
    markGone: (url: string) => markGone.run(url),
    saveBusiness,
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
