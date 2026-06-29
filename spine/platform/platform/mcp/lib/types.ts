export interface ProgressStats {
  total: number;
  scraped: number;
  failed: number;
  startedAt: number;
}

export interface ScrapeRun {
  id: number;
  phase: string;
  started_at: string;
  finished_at: string | null;
  urls_total: number;
  urls_scraped: number;
  urls_failed: number;
  status: 'running' | 'completed' | 'interrupted';
}

export interface ScraperConfigBase {
  phase: string;
  concurrency: number;
  delay: number;
  maxRetries: number;
  limit: number;
  dbPath: string;
}
