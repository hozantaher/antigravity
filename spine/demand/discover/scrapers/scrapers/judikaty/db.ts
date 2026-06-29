import Database from 'better-sqlite3';
import type { DecisionData, Source, UrlInsert, UrlRow } from './types.js';

export const createDb = (dbPath: string) => {
  const db = new Database(dbPath);

  db.pragma('journal_mode = WAL');
  db.pragma('synchronous = NORMAL');
  db.pragma('cache_size = -64000');
  db.pragma('busy_timeout = 5000');

  db.exec(`
    CREATE TABLE IF NOT EXISTS judikaty_urls (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      url TEXT UNIQUE NOT NULL,
      source TEXT NOT NULL,
      external_id TEXT,
      ecli TEXT,
      jednaci_cislo TEXT,
      soud TEXT,
      datum_vydani TEXT,
      status TEXT DEFAULT 'pending',
      attempts INTEGER DEFAULT 0,
      last_attempt_at TEXT,
      error_message TEXT
    );

    CREATE TABLE IF NOT EXISTS judikaty_decisions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      url TEXT UNIQUE NOT NULL,
      source TEXT NOT NULL,
      external_id TEXT,
      ecli TEXT,
      jednaci_cislo TEXT,
      spisova_znacka TEXT,
      soud TEXT,
      autor TEXT,
      datum_vydani TEXT,
      datum_zverejneni TEXT,
      typ_rozhodnuti TEXT,
      predmet_rizeni TEXT,
      oblast_prava TEXT,
      klicova_slova TEXT,
      zminena_ustanoveni TEXT,
      pravni_veta TEXT,
      vyrok TEXT,
      oduvodneni TEXT,
      raw_json TEXT,
      scraped_at TEXT DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS judikaty_scrape_runs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      phase TEXT,
      started_at TEXT DEFAULT (datetime('now')),
      finished_at TEXT,
      urls_total INTEGER DEFAULT 0,
      urls_scraped INTEGER DEFAULT 0,
      urls_failed INTEGER DEFAULT 0,
      status TEXT DEFAULT 'running'
    );

    CREATE INDEX IF NOT EXISTS idx_judikaty_urls_status ON judikaty_urls(status);
    CREATE INDEX IF NOT EXISTS idx_judikaty_urls_source_status ON judikaty_urls(source, status);
    CREATE INDEX IF NOT EXISTS idx_judikaty_urls_status_attempts ON judikaty_urls(status, attempts);
    CREATE INDEX IF NOT EXISTS idx_judikaty_decisions_url ON judikaty_decisions(url);
    CREATE INDEX IF NOT EXISTS idx_judikaty_decisions_ecli ON judikaty_decisions(ecli);
    CREATE INDEX IF NOT EXISTS idx_judikaty_decisions_source ON judikaty_decisions(source);
    CREATE INDEX IF NOT EXISTS idx_judikaty_decisions_spisova_znacka ON judikaty_decisions(spisova_znacka);
    CREATE INDEX IF NOT EXISTS idx_judikaty_decisions_jednaci_cislo ON judikaty_decisions(jednaci_cislo);
  `);

  const insertUrlStmt = db.prepare(`
    INSERT OR IGNORE INTO judikaty_urls (url, source, external_id, ecli, jednaci_cislo, soud, datum_vydani)
    VALUES (@url, @source, @external_id, @ecli, @jednaci_cislo, @soud, @datum_vydani)
  `);

  const insertUrlBatch = db.transaction((urls: UrlInsert[]) => {
    for (const u of urls) {
      insertUrlStmt.run({
        url: u.url,
        source: u.source,
        external_id: u.external_id ?? null,
        ecli: u.ecli ?? null,
        jednaci_cislo: u.jednaci_cislo ?? null,
        soud: u.soud ?? null,
        datum_vydani: u.datum_vydani ?? null,
      });
    }
  });

  const getPendingUrls = db.prepare<[string, number, number], UrlRow>(`
    SELECT * FROM judikaty_urls
    WHERE source = ? AND (status = 'pending' OR (status = 'failed' AND attempts < ?))
    ORDER BY id
    LIMIT ?
  `);

  const markScraped = db.prepare(`
    UPDATE judikaty_urls SET status = 'scraped', attempts = attempts + 1, last_attempt_at = datetime('now')
    WHERE url = ?
  `);

  const markFailedStmt = db.prepare(`
    UPDATE judikaty_urls SET status = 'failed', attempts = attempts + 1, last_attempt_at = datetime('now'), error_message = ?
    WHERE url = ?
  `);

  const markGoneStmt = db.prepare(`
    UPDATE judikaty_urls SET status = 'gone', attempts = attempts + 1, last_attempt_at = datetime('now')
    WHERE url = ?
  `);

  const insertDecision = db.prepare(`
    INSERT OR REPLACE INTO judikaty_decisions (
      url, source, external_id, ecli, jednaci_cislo, spisova_znacka,
      soud, autor, datum_vydani, datum_zverejneni,
      typ_rozhodnuti, predmet_rizeni, oblast_prava,
      klicova_slova, zminena_ustanoveni,
      pravni_veta, vyrok, oduvodneni, raw_json
    ) VALUES (
      @url, @source, @external_id, @ecli, @jednaci_cislo, @spisova_znacka,
      @soud, @autor, @datum_vydani, @datum_zverejneni,
      @typ_rozhodnuti, @predmet_rizeni, @oblast_prava,
      @klicova_slova, @zminena_ustanoveni,
      @pravni_veta, @vyrok, @oduvodneni, @raw_json
    )
  `);

  const saveDecision = db.transaction((data: DecisionData) => {
    const params: Record<string, unknown> = {
      url: data.url,
      source: data.source,
      external_id: data.external_id ?? null,
      ecli: data.ecli ?? null,
      jednaci_cislo: data.jednaci_cislo ?? null,
      spisova_znacka: data.spisova_znacka ?? null,
      soud: data.soud ?? null,
      autor: data.autor ?? null,
      datum_vydani: data.datum_vydani ?? null,
      datum_zverejneni: data.datum_zverejneni ?? null,
      typ_rozhodnuti: data.typ_rozhodnuti ?? null,
      predmet_rizeni: data.predmet_rizeni ?? null,
      oblast_prava: data.oblast_prava ?? null,
      klicova_slova: data.klicova_slova ?? null,
      zminena_ustanoveni: data.zminena_ustanoveni ?? null,
      pravni_veta: data.pravni_veta ?? null,
      vyrok: data.vyrok ?? null,
      oduvodneni: data.oduvodneni ?? null,
      raw_json: data.raw_json ?? null,
    };
    insertDecision.run(params);
    markScraped.run(data.url);
  });

  const startRun = db.prepare<[string], { id: number }>(`
    INSERT INTO judikaty_scrape_runs (phase) VALUES (?) RETURNING id
  `);

  const finishRun = db.prepare(`
    UPDATE judikaty_scrape_runs
    SET finished_at = datetime('now'), urls_total = ?, urls_scraped = ?, urls_failed = ?, status = ?
    WHERE id = ?
  `);

  const getUrlCounts = db.prepare<
    [string],
    { total: number; pending: number; scraped: number; failed: number; gone: number }
  >(`
    SELECT
      COUNT(*) as total,
      COALESCE(SUM(CASE WHEN status = 'pending' THEN 1 ELSE 0 END), 0) as pending,
      COALESCE(SUM(CASE WHEN status = 'scraped' THEN 1 ELSE 0 END), 0) as scraped,
      COALESCE(SUM(CASE WHEN status = 'failed' THEN 1 ELSE 0 END), 0) as failed,
      COALESCE(SUM(CASE WHEN status = 'gone' THEN 1 ELSE 0 END), 0) as gone
    FROM judikaty_urls
    WHERE source = ?
  `);

  return {
    db,
    insertUrlBatch: (urls: UrlInsert[]) => {
      insertUrlBatch(urls);
    },
    getPendingUrls: (source: Source, maxRetries: number, limit: number): UrlRow[] => {
      return getPendingUrls.all(source, maxRetries, limit) as UrlRow[];
    },
    markFailed: (url: string, error: string) => markFailedStmt.run(error, url),
    markGone: (url: string) => markGoneStmt.run(url),
    saveDecision,
    startRun: (phase: string): number => {
      const row = startRun.get(phase);
      return row!.id;
    },
    finishRun: (id: number, total: number, scraped: number, failed: number, status: string) => {
      finishRun.run(total, scraped, failed, status, id);
    },
    getUrlCounts: (source: Source) => getUrlCounts.get(source)!,
    close: () => db.close(),
  };
};

export type ScraperDb = ReturnType<typeof createDb>;
