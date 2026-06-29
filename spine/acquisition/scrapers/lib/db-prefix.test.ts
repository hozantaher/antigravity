import { describe, expect, it } from 'vitest';
import {
  DEFAULT_DB,
  PREFIX_SOURCE,
  SOURCE_PREFIX,
  prefixTable,
  unprefixTable,
} from './db-prefix';

describe('db-prefix', () => {
  it('builds prefixed table names from source + table', () => {
    expect(prefixTable('judikaty', 'decisions')).toBe('judikaty_decisions');
    expect(prefixTable('firmy-cz', 'urls')).toBe('firmy_cz_urls');
  });

  it('throws for unknown sources', () => {
    expect(() => prefixTable('unknown-source', 'table')).toThrow('Unknown source: unknown-source');
  });

  it('reverses prefixed table names back to source and table', () => {
    expect(unprefixTable('judikaty_decisions')).toEqual({
      source: 'judikaty',
      table: 'decisions',
    });
    expect(unprefixTable('mobile_de_urls')).toEqual({
      source: 'mobile-de',
      table: 'urls',
    });
  });

  it('prefers longest matching prefixes and returns null for unknown prefix', () => {
    expect(unprefixTable('mascus_cz_scrape_runs')).toEqual({
      source: 'mascus',
      table: 'scrape_runs',
    });
    expect(unprefixTable('not_existing_table')).toBeNull();
  });

  it('exports expected defaults and mappings', () => {
    expect(DEFAULT_DB).toBe('garaaage.db');
    expect(SOURCE_PREFIX['mobile-de']).toBe('mobile_de');
    expect(PREFIX_SOURCE.mobile_de).toBe('mobile-de');
  });
});
