import Database from 'better-sqlite3';
import type { ActData, Collection, UrlInsert, UrlRow } from './types.js';

export const createDb = (dbPath: string) => {
  const db = new Database(dbPath);

  db.pragma('journal_mode = WAL');
  db.pragma('synchronous = NORMAL');
  db.pragma('cache_size = -64000');
  db.pragma('busy_timeout = 5000');

  db.exec(`
    CREATE TABLE IF NOT EXISTS esbirka_urls (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      eli TEXT UNIQUE NOT NULL,
      citace TEXT NOT NULL,
      cislo TEXT NOT NULL,
      rok INTEGER NOT NULL,
      sbirka TEXT NOT NULL,
      nazev TEXT,
      typ_aktu TEXT,
      typ_zneni TEXT,
      datum_platnosti TEXT,
      datum_zruseni TEXT,
      dokument_base_id INTEGER,
      status TEXT DEFAULT 'pending',
      attempts INTEGER DEFAULT 0,
      last_attempt_at TEXT,
      error_message TEXT
    );

    CREATE TABLE IF NOT EXISTS esbirka_acts (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      eli TEXT UNIQUE NOT NULL,
      citace TEXT,
      nazev TEXT,
      typ_aktu TEXT,
      typ_zneni TEXT,
      datum_platnosti TEXT,
      datum_zruseni TEXT,
      full_text TEXT,
      fragment_count INTEGER,
      relationships_json TEXT,
      raw_metadata_json TEXT,
      scraped_at TEXT DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS esbirka_scrape_runs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      phase TEXT,
      started_at TEXT DEFAULT (datetime('now')),
      finished_at TEXT,
      urls_total INTEGER DEFAULT 0,
      urls_scraped INTEGER DEFAULT 0,
      urls_failed INTEGER DEFAULT 0,
      status TEXT DEFAULT 'running'
    );

    CREATE INDEX IF NOT EXISTS idx_esbirka_urls_status ON esbirka_urls(status);
    CREATE INDEX IF NOT EXISTS idx_esbirka_urls_status_attempts ON esbirka_urls(status, attempts);
    CREATE INDEX IF NOT EXISTS idx_esbirka_urls_sbirka ON esbirka_urls(sbirka);
    CREATE INDEX IF NOT EXISTS idx_esbirka_acts_eli ON esbirka_acts(eli);
    CREATE INDEX IF NOT EXISTS idx_esbirka_acts_citace ON esbirka_acts(citace);
  `);

  const insertUrlStmt = db.prepare(`
    INSERT OR IGNORE INTO esbirka_urls (eli, citace, cislo, rok, sbirka, nazev, typ_aktu, typ_zneni, datum_platnosti, datum_zruseni, dokument_base_id)
    VALUES (@eli, @citace, @cislo, @rok, @sbirka, @nazev, @typ_aktu, @typ_zneni, @datum_platnosti, @datum_zruseni, @dokument_base_id)
  `);

  const insertUrlBatch = db.transaction((urls: UrlInsert[]) => {
    for (const u of urls) {
      insertUrlStmt.run({
        eli: u.eli,
        citace: u.citace,
        cislo: u.cislo,
        rok: u.rok,
        sbirka: u.sbirka,
        nazev: u.nazev ?? null,
        typ_aktu: u.typ_aktu ?? null,
        typ_zneni: u.typ_zneni ?? null,
        datum_platnosti: u.datum_platnosti ?? null,
        datum_zruseni: u.datum_zruseni ?? null,
        dokument_base_id: u.dokument_base_id ?? null,
      });
    }
  });

  const getPendingUrls = db.prepare<[number, number], UrlRow>(`
    SELECT * FROM esbirka_urls
    WHERE status = 'pending' OR (status = 'failed' AND attempts < ?)
    ORDER BY id
    LIMIT ?
  `);

  const getPendingUrlsByCollection = db.prepare<[string, number, number], UrlRow>(`
    SELECT * FROM esbirka_urls
    WHERE sbirka = ? AND (status = 'pending' OR (status = 'failed' AND attempts < ?))
    ORDER BY id
    LIMIT ?
  `);

  const markScraped = db.prepare(`
    UPDATE esbirka_urls SET status = 'scraped', attempts = attempts + 1, last_attempt_at = datetime('now')
    WHERE eli = ?
  `);

  const markFailed = db.prepare(`
    UPDATE esbirka_urls SET status = 'failed', attempts = attempts + 1, last_attempt_at = datetime('now'), error_message = ?
    WHERE eli = ?
  `);

  const markGone = db.prepare(`
    UPDATE esbirka_urls SET status = 'gone', attempts = attempts + 1, last_attempt_at = datetime('now')
    WHERE eli = ?
  `);

  const insertAct = db.prepare(`
    INSERT OR REPLACE INTO esbirka_acts (
      eli, citace, nazev, typ_aktu, typ_zneni,
      datum_platnosti, datum_zruseni,
      full_text, fragment_count, relationships_json, raw_metadata_json
    ) VALUES (
      @eli, @citace, @nazev, @typ_aktu, @typ_zneni,
      @datum_platnosti, @datum_zruseni,
      @full_text, @fragment_count, @relationships_json, @raw_metadata_json
    )
  `);

  const saveAct = db.transaction((data: ActData) => {
    const params: Record<string, unknown> = {
      eli: data.eli,
      citace: data.citace ?? null,
      nazev: data.nazev ?? null,
      typ_aktu: data.typ_aktu ?? null,
      typ_zneni: data.typ_zneni ?? null,
      datum_platnosti: data.datum_platnosti ?? null,
      datum_zruseni: data.datum_zruseni ?? null,
      full_text: data.full_text ?? null,
      fragment_count: data.fragment_count ?? null,
      relationships_json: data.relationships_json ?? null,
      raw_metadata_json: data.raw_metadata_json ?? null,
    };
    insertAct.run(params);
    markScraped.run(data.eli);
  });

  const startRun = db.prepare<[string], { id: number }>(`
    INSERT INTO esbirka_scrape_runs (phase) VALUES (?) RETURNING id
  `);

  const finishRun = db.prepare(`
    UPDATE esbirka_scrape_runs
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
    FROM esbirka_urls
  `);

  const getUrlCountsByCollection = db.prepare<
    [string],
    { total: number; pending: number; scraped: number; failed: number; gone: number }
  >(`
    SELECT
      COUNT(*) as total,
      COALESCE(SUM(CASE WHEN status = 'pending' THEN 1 ELSE 0 END), 0) as pending,
      COALESCE(SUM(CASE WHEN status = 'scraped' THEN 1 ELSE 0 END), 0) as scraped,
      COALESCE(SUM(CASE WHEN status = 'failed' THEN 1 ELSE 0 END), 0) as failed,
      COALESCE(SUM(CASE WHEN status = 'gone' THEN 1 ELSE 0 END), 0) as gone
    FROM esbirka_urls
    WHERE sbirka = ?
  `);

  return {
    db,
    insertUrlBatch: (urls: UrlInsert[]) => insertUrlBatch(urls),
    getPendingUrls: (maxRetries: number, limit: number, collection?: Collection): UrlRow[] => {
      if (collection) {
        return getPendingUrlsByCollection.all(collection, maxRetries, limit) as UrlRow[];
      }
      return getPendingUrls.all(maxRetries, limit) as UrlRow[];
    },
    markFailed: (eli: string, error: string) => markFailed.run(error, eli),
    markGone: (eli: string) => markGone.run(eli),
    saveAct,
    startRun: (phase: string): number => {
      const row = startRun.get(phase);
      return row!.id;
    },
    finishRun: (id: number, total: number, scraped: number, failed: number, status: string) => {
      finishRun.run(total, scraped, failed, status, id);
    },
    getUrlCounts: (collection?: Collection) => {
      if (collection) return getUrlCountsByCollection.get(collection)!;
      return getUrlCounts.get()!;
    },
    close: () => db.close(),
  };
};

export type ScraperDb = ReturnType<typeof createDb>;
