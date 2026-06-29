import type { ScraperConfigBase } from '../../lib/types.js';

export type Source = 'justice' | 'usoud' | 'nssoud' | 'nsoud';

export interface ScraperConfig extends ScraperConfigBase {
  phase: 'all' | 'discovery' | 'detail';
  source: Source | 'all';
}

export interface UrlRow {
  id: number;
  url: string;
  source: Source;
  external_id: string | null;
  ecli: string | null;
  jednaci_cislo: string | null;
  soud: string | null;
  datum_vydani: string | null;
  status: 'pending' | 'scraped' | 'failed' | 'gone';
  attempts: number;
  last_attempt_at: string | null;
  error_message: string | null;
}

export interface DecisionData {
  url: string;
  source: Source;
  external_id?: string;
  ecli?: string;
  jednaci_cislo?: string;
  spisova_znacka?: string;
  soud?: string;
  autor?: string;
  datum_vydani?: string;
  datum_zverejneni?: string;
  typ_rozhodnuti?: string;
  predmet_rizeni?: string;
  oblast_prava?: string;
  klicova_slova?: string;
  zminena_ustanoveni?: string;
  pravni_veta?: string;
  vyrok?: string;
  oduvodneni?: string;
  raw_json?: string;
  /** Transient — not persisted to DB, used to pass data between parse and postProcess */
  _textPageUrl?: string;
}

export interface UrlInsert {
  url: string;
  source: Source;
  external_id?: string;
  ecli?: string;
  jednaci_cislo?: string;
  soud?: string;
  datum_vydani?: string;
}

export interface SourceModule {
  runDiscovery: (
    db: import('./db.js').ScraperDb,
    config: ScraperConfig,
    isShuttingDown: () => boolean,
  ) => Promise<void>;
  runDetail: (db: import('./db.js').ScraperDb, config: ScraperConfig, isShuttingDown: () => boolean) => Promise<void>;
}
