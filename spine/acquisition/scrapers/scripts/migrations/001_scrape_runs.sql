-- Migration 001: create scrape_runs table
-- Matches the INSERT in src/queue/scrape-worker.ts (recordJobResult).
--
-- Columns written by the worker:
--   scraper_type  — ScrapeJobData['type'] (autoline | mascus | mobile-de | firmy | judikaty | esbirka)
--   phase         — params.phase ?? 'all'
--   scraped       — count of successfully scraped items
--   failed        — count of failed items
--   duration_ms   — wall-clock time for the job
--   completed_at  — NOW() supplied by the INSERT

CREATE TABLE IF NOT EXISTS scrape_runs (
    id            BIGSERIAL    PRIMARY KEY,
    scraper_type  TEXT         NOT NULL,
    phase         TEXT         NOT NULL,
    scraped       INTEGER      NOT NULL DEFAULT 0,
    failed        INTEGER      NOT NULL DEFAULT 0,
    duration_ms   INTEGER,
    completed_at  TIMESTAMPTZ  NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS scrape_runs_scraper_type_idx ON scrape_runs (scraper_type);
CREATE INDEX IF NOT EXISTS scrape_runs_completed_at_idx ON scrape_runs (completed_at DESC);
