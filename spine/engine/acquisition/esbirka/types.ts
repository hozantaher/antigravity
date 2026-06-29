import type { ScraperConfigBase } from '../shared/types.js';

export type Collection = 'sb' | 'sm';

export interface ScraperConfig extends ScraperConfigBase {
  phase: 'all' | 'discovery' | 'detail';
  collection: Collection | 'all';
}

export interface UrlRow {
  id: number;
  eli: string;
  citace: string;
  cislo: string;
  rok: number;
  sbirka: string;
  nazev: string | null;
  typ_aktu: string | null;
  typ_zneni: string | null;
  datum_platnosti: string | null;
  datum_zruseni: string | null;
  dokument_base_id: number | null;
  status: 'pending' | 'scraped' | 'failed' | 'gone';
  attempts: number;
  last_attempt_at: string | null;
  error_message: string | null;
}

export interface ActData {
  eli: string;
  citace: string;
  nazev?: string;
  typ_aktu?: string;
  typ_zneni?: string;
  datum_platnosti?: string;
  datum_zruseni?: string;
  full_text?: string;
  fragment_count?: number;
  relationships_json?: string;
  raw_metadata_json?: string;
}

export interface UrlInsert {
  eli: string;
  citace: string;
  cislo: string;
  rok: number;
  sbirka: string;
  nazev?: string;
  typ_aktu?: string;
  typ_zneni?: string;
  datum_platnosti?: string;
  datum_zruseni?: string;
  dokument_base_id?: number;
}

// --- SPARQL response types ---

export interface SparqlResponse {
  head: { vars: string[] };
  results: {
    bindings: SparqlBinding[];
  };
}

export interface SparqlBinding {
  s: { type: string; value: string };
  citace: { type: string; value: string };
}

// --- sbr-cache REST API types ---

export interface DokumentMetadata {
  dokumentBaseId: number;
  eli: string;
  staleUrl: string;
  sbirkaKod: string;
  kodDokumentuSbirky: string;
  nazev: string;
  zkracenaCitace: string;
  uplnaCitace: string;
  typZneni: string;
  druhPravnihoAktuKod: string;
  typAktuKod: string;
  datumUcinnostiOd?: string;
  datumUcinnostiZneniOd?: string;
  datumCasVyhlaseni?: string;
  novely?: Array<{ staleUrl: string; kodDokumentuSbirky: string }>;
  nikdyNebylUcinny: boolean;
  jeMezinarodniSmlouva: boolean;
  [key: string]: unknown;
}

export interface FragmentyResponse {
  seznam: Fragment[];
}

export interface Fragment {
  id: number;
  eli: string;
  staleUrl: string;
  kodTypuFragmentu: string;
  uplnaCitace: string;
  zkracenaCitace: string;
  hloubka: number;
  xhtml?: string;
  jeUcinny: boolean;
  odkazyZFragmentu: Array<{
    odkazId: number;
    odkazBaseId: number;
    kodTypuVazbyOdkazu: string;
    cil: { staleUrl: string };
  }>;
  [key: string]: unknown;
}

export interface SouvislostiResponse {
  souvislosti: Souvislost[];
}

export interface Souvislost {
  typ: string;
  pocetDokumentuSbirky: number;
  dokumentySbirky: Array<{
    staleUrl: string;
    nazev: string;
    kodDokumentuSbirky: string;
    stavDokumentuSbirky: string;
  }>;
}
