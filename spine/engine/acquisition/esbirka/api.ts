import { randomFrom, USER_AGENTS } from '../shared/fetch.js';
import type { DokumentMetadata, FragmentyResponse, SouvislostiResponse, SparqlResponse } from './types.js';

const SPARQL_ENDPOINT = 'https://opendata.eselpoint.cz/sparql';
const SBR_CACHE_BASE = 'https://www.e-sbirka.cz/sbr-cache';

const jsonHeaders = () => ({
  'User-Agent': randomFrom(USER_AGENTS),
  Accept: 'application/json',
});

// --- SPARQL ---

/**
 * Fetch all acts from a given collection via SPARQL.
 * Uses Czech diacritics in vocabulary URIs (required by the endpoint).
 * Note: Virtuoso requires xsd:string typed literals for filtering.
 */
export const fetchAllActs = async (sbirka: string): Promise<SparqlResponse> => {
  const query = `
    PREFIX sbirka: <https://slovník.gov.cz/datový/sbírka/pojem/>
    PREFIX xsd: <http://www.w3.org/2001/XMLSchema#>
    SELECT ?s ?citace
    FROM <esel-esb:eli/czPravniAkt>
    WHERE {
      ?s a sbirka:právní-akt .
      ?s sbirka:patří-do-sbírky "${sbirka}"^^xsd:string .
      ?s sbirka:citace-právního-aktu ?citace .
    }
  `;

  const url = `${SPARQL_ENDPOINT}?query=${encodeURIComponent(query.trim())}`;
  const response = await fetch(url, {
    headers: {
      'User-Agent': randomFrom(USER_AGENTS),
      Accept: 'application/sparql-results+json',
    },
    signal: AbortSignal.timeout(120_000),
  });

  if (!response.ok) {
    throw new Error(`SPARQL HTTP ${response.status}: ${await response.text()}`);
  }

  return response.json() as Promise<SparqlResponse>;
};

// --- sbr-cache REST API ---

const encodeEli = (eli: string): string => encodeURIComponent(eli);

export const fetchMetadata = async (eli: string): Promise<DokumentMetadata> => {
  const url = `${SBR_CACHE_BASE}/dokumenty-sbirky/${encodeEli(eli)}`;
  const response = await fetch(url, {
    headers: jsonHeaders(),
    signal: AbortSignal.timeout(30_000),
  });

  if (response.status === 404) {
    throw new Error(`Not found: ${eli}`);
  }

  if (!response.ok) {
    throw new Error(`HTTP ${response.status} for ${url}`);
  }

  return response.json() as Promise<DokumentMetadata>;
};

/**
 * Fetch fragments page. Returns null for 400 status (indicates no more pages).
 */
export const fetchFragments = async (eli: string, page: number): Promise<FragmentyResponse | null> => {
  const url = `${SBR_CACHE_BASE}/dokumenty-sbirky/${encodeEli(eli)}/fragmenty?cisloStranky=${page}`;
  const response = await fetch(url, {
    headers: jsonHeaders(),
    signal: AbortSignal.timeout(60_000),
  });

  // API returns 400 for out-of-range pages
  if (response.status === 400) {
    return null;
  }

  if (!response.ok) {
    throw new Error(`HTTP ${response.status} fetching fragments page ${page} for ${eli}`);
  }

  return response.json() as Promise<FragmentyResponse>;
};

export const fetchRelationships = async (eli: string): Promise<SouvislostiResponse> => {
  const url = `${SBR_CACHE_BASE}/dokumenty-sbirky/${encodeEli(eli)}/souvislosti`;
  const response = await fetch(url, {
    headers: jsonHeaders(),
    signal: AbortSignal.timeout(30_000),
  });

  if (!response.ok) {
    throw new Error(`HTTP ${response.status} fetching relationships for ${eli}`);
  }

  return response.json() as Promise<SouvislostiResponse>;
};
