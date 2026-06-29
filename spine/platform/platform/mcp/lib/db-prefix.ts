/**
 * Centrální mapping source → table prefix pro sdílenou garaaage.db.
 *
 * Všechny tabulky v unified DB mají prefix: `{prefix}_{table}`.
 * Např. judikaty source → judikaty_decisions, judikaty_urls, judikaty_scrape_runs.
 */

/** Source name → SQL-safe table prefix (no hyphens). */
export const SOURCE_PREFIX: Record<string, string> = {
  autoline: 'autoline',
  mascus: 'mascus_cz',
  'mobile-de': 'mobile_de',
  judikaty: 'judikaty',
  esbirka: 'esbirka',
  'firmy-cz': 'firmy_cz',
};

/** Reverse mapping: prefix → source name. */
export const PREFIX_SOURCE: Record<string, string> = Object.fromEntries(
  Object.entries(SOURCE_PREFIX).map(([source, prefix]) => [prefix, source]),
);

/** Default unified database filename. */
export const DEFAULT_DB = 'garaaage.db';

/** Get prefixed table name: prefixTable('judikaty', 'decisions') → 'judikaty_decisions' */
export function prefixTable(source: string, table: string): string {
  const prefix = SOURCE_PREFIX[source];
  if (!prefix) throw new Error(`Unknown source: ${source}`);
  return `${prefix}_${table}`;
}

/**
 * Reverse a prefixed table name: 'judikaty_decisions' → { source: 'judikaty', table: 'decisions' }
 * Returns null if the prefix doesn't match any known source.
 */
export function unprefixTable(prefixedName: string): { source: string; table: string } | null {
  // Try longest prefix first to avoid mascus_ matching before mascus_cz_
  const prefixes = Object.keys(PREFIX_SOURCE).sort((a, b) => b.length - a.length);
  for (const prefix of prefixes) {
    if (prefixedName.startsWith(prefix + '_')) {
      return { source: PREFIX_SOURCE[prefix], table: prefixedName.slice(prefix.length + 1) };
    }
  }
  return null;
}
