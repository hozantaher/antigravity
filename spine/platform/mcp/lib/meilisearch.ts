/**
 * Shared Typesense client and collection configuration.
 *
 * Collections: judikaty_decisions (685K court decisions), esbirka_acts (8.8K Czech laws).
 * Other tables use ILIKE fallback in the MCP server.
 *
 * NOTE: File kept as meilisearch.ts to minimize import churn — exports are Typesense-based.
 */

import Typesense from 'typesense';
import type { CollectionFieldSchema } from 'typesense/lib/Typesense/Collection.js';

export interface SearchIndexConfig {
  fields: CollectionFieldSchema[];
  /** Columns with gzip-compressed bytea in PG needing decompression before indexing. */
  compressedColumns: string[];
  /** All searchable field names (used for query_by). */
  searchableFields: string[];
  /** Fields usable in filter_by. */
  filterableFields: string[];
}

/** Compute PG SELECT columns: union of all field names + compressed columns. */
export function getPgSelectColumns(config: SearchIndexConfig): string[] {
  const names = config.fields.map((f) => f.name);
  return [...new Set([...names, ...config.compressedColumns])];
}

export const SEARCH_INDEXES: Record<string, SearchIndexConfig> = {
  judikaty_decisions: {
    fields: [
      { name: 'spisova_znacka', type: 'string', optional: true },
      { name: 'ecli', type: 'string', optional: true },
      { name: 'soud', type: 'string', facet: true, optional: true },
      { name: 'source', type: 'string', facet: true },
      { name: 'datum_vydani', type: 'string', facet: true, optional: true },
      { name: 'typ_rozhodnuti', type: 'string', facet: true, optional: true },
      { name: 'oblast_prava', type: 'string', facet: true, optional: true },
      { name: 'predmet_rizeni', type: 'string', optional: true },
      { name: 'klicova_slova', type: 'string', optional: true },
      { name: 'zminena_ustanoveni', type: 'string', optional: true },
      { name: 'pravni_veta', type: 'string', optional: true },
      { name: 'vyrok', type: 'string', optional: true },
      { name: 'oduvodneni', type: 'string', optional: true },
      { name: 'autor', type: 'string', optional: true },
    ],
    compressedColumns: ['oduvodneni'],
    searchableFields: [
      'pravni_veta',
      'vyrok',
      'klicova_slova',
      'zminena_ustanoveni',
      'oduvodneni',
      'oblast_prava',
      'predmet_rizeni',
      'soud',
      'typ_rozhodnuti',
      'autor',
      'spisova_znacka',
    ],
    filterableFields: ['source', 'soud', 'typ_rozhodnuti', 'oblast_prava', 'datum_vydani'],
  },
  esbirka_acts: {
    fields: [
      { name: 'citace', type: 'string', facet: true, optional: true },
      { name: 'nazev', type: 'string', optional: true },
      { name: 'typ_aktu', type: 'string', facet: true, optional: true },
      { name: 'typ_zneni', type: 'string', optional: true },
      { name: 'datum_platnosti', type: 'string', facet: true, optional: true },
      { name: 'datum_zruseni', type: 'string', facet: true, optional: true },
      { name: 'fragment_count', type: 'int32', optional: true },
      { name: 'full_text', type: 'string', optional: true },
    ],
    compressedColumns: [],
    searchableFields: ['nazev', 'citace', 'full_text', 'typ_aktu', 'typ_zneni'],
    filterableFields: ['citace', 'typ_aktu', 'datum_platnosti', 'datum_zruseni'],
  },
};

/** Create a Typesense client from environment variables. Returns null if not configured. */
export function createSearchClient(): Typesense.Client | null {
  const url = process.env.TYPESENSE_URL || process.env.MEILI_URL;
  const apiKey = process.env.TYPESENSE_API_KEY || process.env.MEILI_API_KEY;
  if (!url || !apiKey) return null;

  const parsed = new URL(url);
  return new Typesense.Client({
    nodes: [
      {
        host: parsed.hostname,
        port: parseInt(parsed.port || (parsed.protocol === 'https:' ? '443' : '8108')),
        protocol: parsed.protocol.replace(':', ''),
      },
    ],
    apiKey,
    connectionTimeoutSeconds: 60,
  });
}

/** Check if a prefixed table name has a search index. */
export function hasSearchIndex(prefixedTable: string): boolean {
  return prefixedTable in SEARCH_INDEXES;
}
