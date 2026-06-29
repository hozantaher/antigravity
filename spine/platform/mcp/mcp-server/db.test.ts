import { describe, it, expect, beforeAll, afterEach, vi } from 'vitest';
import { EventEmitter } from 'events';
import Typesense from 'typesense';
import {
  executeQuery,
  extractParagraphs,
  ftsSearch,
  getDecision,
  getLawContext,
  getSchema,
  getStats,
  rewriteTableNames,
  attachPoolErrorHandler,
  _setSearchClient,
  type SourceInfo,
} from './db.js';
import { createTestDatabase } from './test-utils.js';
import { logger } from '../lib/logger.js';

let esbirka: SourceInfo;
let judikaty: SourceInfo;

beforeAll(() => {
  ({ esbirkaSource: esbirka, judikatySource: judikaty } = createTestDatabase());
});

// --- rewriteTableNames ---

describe('rewriteTableNames', () => {
  const tableMap = new Map([
    ['decisions', 'judikaty_decisions'],
    ['urls', 'judikaty_urls'],
  ]);

  it('rewrites FROM clause', () => {
    expect(rewriteTableNames('SELECT * FROM decisions', tableMap)).toBe('SELECT * FROM "judikaty_decisions"');
  });

  it('rewrites JOIN clause', () => {
    expect(rewriteTableNames('SELECT * FROM decisions JOIN urls ON 1=1', tableMap)).toContain('"judikaty_urls"');
  });

  it('does not rewrite column names or string literals', () => {
    const sql = "SELECT decisions FROM other WHERE x = 'decisions'";
    expect(rewriteTableNames(sql, tableMap)).toBe(sql);
  });

  it('handles identity map (no rewriting)', () => {
    const identity = new Map([['acts', 'acts']]);
    expect(rewriteTableNames('SELECT * FROM acts', identity)).toBe('SELECT * FROM acts');
  });
});

// --- executeQuery ---

describe('executeQuery', () => {
  it('executes a simple SELECT', async () => {
    const result = await executeQuery(esbirka, { sql: 'SELECT citace, nazev FROM acts' });
    expect(result.rowCount).toBe(2);
    expect(result.columns).toContain('citace');
    expect(result.rows[0]).toHaveProperty('citace', '89/2012 Sb.');
  });

  it('respects LIMIT', async () => {
    const result = await executeQuery(esbirka, { sql: 'SELECT * FROM acts', limit: 1 });
    expect(result.rowCount).toBe(1);
  });

  it('handles SQL errors gracefully', async () => {
    await expect(executeQuery(esbirka, { sql: 'SELECT * FROM nonexistent' })).rejects.toThrow();
  });

  it('returns empty result for no matches', async () => {
    const result = await executeQuery(esbirka, { sql: "SELECT * FROM acts WHERE citace = 'NOPE'" });
    expect(result.rowCount).toBe(0);
  });
});

// --- extractParagraphs ---

describe('extractParagraphs', () => {
  it('extracts specific paragraphs from OZ', async () => {
    const result = await extractParagraphs(esbirka, '89/2012 Sb.', ['2445', '2446']);
    expect(result.found).toHaveLength(2);
    expect(result.found[0].paragraph).toBe('§ 2445');
    expect(result.found[0].text).toContain('zprostředkovatel');
    expect(result.found[1].paragraph).toBe('§ 2446');
    expect(result.missing).toHaveLength(0);
  });

  it('handles § prefix in input', async () => {
    const result = await extractParagraphs(esbirka, '89/2012 Sb.', ['§ 2445']);
    expect(result.found).toHaveLength(1);
  });

  it('reports missing paragraphs', async () => {
    const result = await extractParagraphs(esbirka, '89/2012 Sb.', ['2445', '9999']);
    expect(result.found).toHaveLength(1);
    expect(result.missing).toEqual(['9999']);
  });

  it('strips HTML tags', async () => {
    const result = await extractParagraphs(esbirka, '89/2012 Sb.', ['2445']);
    expect(result.found[0].text).not.toContain('<var>');
  });

  it('returns empty for nonexistent law', async () => {
    const result = await extractParagraphs(esbirka, 'NOPE/0000 Sb.', ['1']);
    expect(result.found).toHaveLength(0);
    expect(result.missing).toEqual(['1']);
  });
});

// --- ftsSearch (ILIKE) ---

describe('ftsSearch', () => {
  it('finds decisions via ILIKE', async () => {
    const result = await ftsSearch(judikaty, 'decisions', 'zprostředkov', ['pravni_veta']);
    expect(result.rowCount).toBeGreaterThan(0);
  });

  it('validates columns against table schema', async () => {
    const result = await ftsSearch(judikaty, 'decisions', 'test', ['nonexistent_column']);
    expect(result.rowCount).toBe(0);
  });

  it('returns empty for nonexistent table', async () => {
    const result = await ftsSearch(judikaty, 'nonexistent', 'test', ['col']);
    expect(result.rowCount).toBe(0);
  });

  it('falls back correctly for acts', async () => {
    const result = await ftsSearch(esbirka, 'acts', 'občanský', ['nazev']);
    expect(result.rowCount).toBeGreaterThan(0);
  });

  it('returns empty for empty query', async () => {
    const result = await ftsSearch(judikaty, 'decisions', '', ['pravni_veta']);
    expect(result.rowCount).toBe(0);
  });

  it('respects limit', async () => {
    const result = await ftsSearch(judikaty, 'decisions', 'soud', ['soud'], 1);
    expect(result.rowCount).toBeLessThanOrEqual(1);
  });

  it('returns warning for invalid filter syntax', async () => {
    const result = await ftsSearch(judikaty, 'decisions', 'test', ['pravni_veta'], 20, 'source = nsoud');
    expect(result.warning).toBeDefined();
  });

  it('does not warn for valid filter', async () => {
    const result = await ftsSearch(judikaty, 'decisions', 'zprostředkov', ['pravni_veta'], 20, "source = 'nsoud'");
    expect(result.warning).toBeUndefined();
  });

  it('returns results for multi-word query when only some words match (OR)', async () => {
    // "zprostředkov" matches decision 1, "neexistující_slovo" matches nothing
    // With AND this would return 0; with OR it returns decision 1
    const result = await ftsSearch(judikaty, 'decisions', 'zprostředkov neexistující_slovo', ['pravni_veta']);
    expect(result.rowCount).toBeGreaterThan(0);
  });

  it('returns multiple results for multi-word query across different rows', async () => {
    // "doložka" matches decision 1 (pravni_veta), "stížnost" matches decisions 2+3 (vyrok)
    const result = await ftsSearch(judikaty, 'decisions', 'doložka stížnost', ['pravni_veta', 'vyrok']);
    expect(result.rowCount).toBeGreaterThanOrEqual(3);
  });

  it('multi-word search works with filter', async () => {
    const result = await ftsSearch(judikaty, 'decisions', 'zprostředkov neexistující', ['pravni_veta'], 20, "source = 'nsoud'");
    expect(result.rowCount).toBeGreaterThan(0);
    // Only nsoud results
    expect(result.rows.every((r: any) => r.source === 'nsoud')).toBe(true);
  });
});

// --- getDecision ---

describe('getDecision', () => {
  it('finds by exact spisová značka', async () => {
    const result = await getDecision(judikaty, 'I.ÚS 52/25');
    expect(result).not.toBeNull();
    expect(result).toContain('Ústavní soud');
  });

  it('finds by ECLI', async () => {
    const result = await getDecision(judikaty, 'ECLI:CZ:NS:2009:33.CDO.2675.2007.1');
    expect(result).not.toBeNull();
    expect(result).toContain('Nejvyšší soud');
  });

  it('finds by jednací číslo', async () => {
    const result = await getDecision(judikaty, 'I.ÚS 52/25 #1');
    expect(result).not.toBeNull();
    expect(result).toContain('Ústavní soud');
  });

  it('finds by LIKE prefix match', async () => {
    const result = await getDecision(judikaty, '33 Cdo 2675/2007');
    expect(result).not.toBeNull();
    expect(result).toContain('Nejvyšší soud');
  });

  it('returns null for nonexistent decision', async () => {
    const result = await getDecision(judikaty, 'XXXXX/9999/NOPE');
    expect(result).toBeNull();
  });

  it('returns only metadata section', async () => {
    const result = await getDecision(judikaty, 'I.ÚS 52/25', 'metadata');
    expect(result).not.toBeNull();
    expect(result).toContain('Ústavní soud');
    expect(result).not.toContain('## Výrok');
  });

  it('decompresses gzipped oduvodneni', async () => {
    const result = await getDecision(judikaty, 'GZ 1/2026', 'oduvodneni');
    expect(result).not.toBeNull();
    expect(result).toContain('Komprimované odůvodnění');
  });
});

// --- getSchema / getStats ---

describe('getSchema', () => {
  it('returns CREATE TABLE for esbirka', async () => {
    const schema = await getSchema(esbirka);
    expect(schema).toContain('esbirka_acts');
  });
});

describe('getStats', () => {
  it('returns row counts for esbirka', async () => {
    const stats = await getStats(esbirka);
    expect(stats.source).toBe('esbirka');
    expect(stats.acts).toBe(2);
  });

  it('returns row counts for judikaty', async () => {
    const stats = await getStats(judikaty);
    expect(stats.source).toBe('judikaty');
    expect(stats.decisions).toBe(4);
  });
});

// --- getLawContext ---

describe('getLawContext', () => {
  it('returns law metadata with relationships', async () => {
    const result = await getLawContext(esbirka, '89/2012 Sb.');
    expect(result).not.toBeNull();
    expect(result).toContain('Zákon občanský zákoník');
    expect(result).toContain('MENI');
    expect(result).toContain('460/2016 Sb.');
  });

  it('returns null for nonexistent law', async () => {
    const result = await getLawContext(esbirka, 'NOPE/0000 Sb.');
    expect(result).toBeNull();
  });

  // M2: malformed relationships_json should log at debug, not silently skip
  it('still returns law text when relationships_json is malformed (M2 — logs at debug)', async () => {
    // Build a source with a row containing malformed relationships_json
    const { createTestDatabase: createDb } = await import('./test-utils.js');
    const dbResult = createDb();
    // Override the mock query to inject malformed JSON
    const badPool = {
      query: async (_sql: string, _params?: unknown[]) => {
        return {
          rows: [
            {
              citace: 'MALFORMED/1',
              nazev: 'Zákon s chybou',
              typ_aktu: null,
              typ_zneni: null,
              datum_platnosti: null,
              datum_zruseni: null,
              fragment_count: null,
              text_length: null,
              relationships_json: '{this is not valid json!!!',
              scraped_at: null,
            },
          ],
          fields: [],
        };
      },
      end: async () => {},
    } as unknown as import('pg').Pool;

    const badSource = {
      ...dbResult.esbirkaSource,
      pool: badPool,
      tableMap: new Map([['acts', 'esbirka_acts']]),
    };

    const debugSpy = vi.spyOn(logger, 'debug');
    try {
      const result = await getLawContext(badSource, 'MALFORMED/1');
      // Should still return text (just without relationships section)
      expect(result).not.toBeNull();
      expect(result).toContain('Zákon s chybou');
      // M2: logger.debug should have been called with the parse error
      expect(debugSpy).toHaveBeenCalledWith(
        expect.objectContaining({ citace: 'MALFORMED/1' }),
        expect.stringContaining('relationships_json'),
      );
    } finally {
      debugSpy.mockRestore();
    }
  });
});

// --- ftsSearch — Typesense path ---

function createMockTypesenseClient(searchFn: (...args: any[]) => any): Typesense.Client {
  return {
    collections: () => ({
      documents: () => ({ search: searchFn }),
    }),
    health: { retrieve: async () => ({ ok: true }) },
  } as unknown as Typesense.Client;
}

const MOCK_HIT = {
  document: {
    id: '1',
    spisova_znacka: '33 Cdo 2675/2007',
    soud: 'Nejvyšší soud',
    source: 'nsoud',
    pravni_veta: 'Rozhodčí doložka ve zprostředkovatelské smlouvě.',
  },
  highlights: [
    { field: 'pravni_veta', snippet: '>>>zprostředkovatel<<<ské smlouvě' },
  ],
};

describe('ftsSearch — Typesense path', () => {
  afterEach(() => {
    _setSearchClient(null);
  });

  it('returns results with _snippet from highlights', async () => {
    const searchFn = async () => ({ hits: [MOCK_HIT] });
    _setSearchClient(createMockTypesenseClient(searchFn));

    const result = await ftsSearch(judikaty, 'decisions', 'zprostředkovatel', ['pravni_veta']);
    expect(result.rowCount).toBe(1);
    expect(result.rows[0].pravni_veta_snippet).toContain('>>>zprostředkovatel<<<');
  });

  it('copies document metadata to result rows', async () => {
    const searchFn = async () => ({ hits: [MOCK_HIT] });
    _setSearchClient(createMockTypesenseClient(searchFn));

    const result = await ftsSearch(judikaty, 'decisions', 'test', ['pravni_veta']);
    expect(result.rows[0].soud).toBe('Nejvyšší soud');
    expect(result.rows[0].source).toBe('nsoud');
    expect(result.rows[0].spisova_znacka).toBe('33 Cdo 2675/2007');
  });

  it('returns empty for empty query', async () => {
    const searchFn = async () => { throw new Error('should not be called'); };
    _setSearchClient(createMockTypesenseClient(searchFn));

    const result = await ftsSearch(judikaty, 'decisions', '', ['pravni_veta']);
    expect(result.rowCount).toBe(0);
  });

  it('returns empty for non-searchable columns', async () => {
    const searchFn = async () => { throw new Error('should not be called'); };
    _setSearchClient(createMockTypesenseClient(searchFn));

    const result = await ftsSearch(judikaty, 'decisions', 'test', ['nonexistent_column']);
    expect(result.rowCount).toBe(0);
  });

  it('converts = filter to Typesense :=', async () => {
    let capturedParams: any = null;
    const searchFn = async (params: any) => { capturedParams = params; return { hits: [] }; };
    _setSearchClient(createMockTypesenseClient(searchFn));

    await ftsSearch(judikaty, 'decisions', 'test', ['pravni_veta'], 20, "source = 'nsoud'");
    expect(capturedParams.filter_by).toBe('source:=nsoud');
  });

  it('converts != filter to Typesense :!=', async () => {
    let capturedParams: any = null;
    const searchFn = async (params: any) => { capturedParams = params; return { hits: [] }; };
    _setSearchClient(createMockTypesenseClient(searchFn));

    await ftsSearch(judikaty, 'decisions', 'test', ['pravni_veta'], 20, "source != 'nsoud'");
    expect(capturedParams.filter_by).toBe('source:!=nsoud');
  });

  it('converts > filter to Typesense :>', async () => {
    let capturedParams: any = null;
    const searchFn = async (params: any) => { capturedParams = params; return { hits: [] }; };
    _setSearchClient(createMockTypesenseClient(searchFn));

    await ftsSearch(judikaty, 'decisions', 'test', ['pravni_veta'], 20, "datum_vydani > '2020'");
    expect(capturedParams.filter_by).toBe('datum_vydani:>2020');
  });

  it('combines AND filters with &&', async () => {
    let capturedParams: any = null;
    const searchFn = async (params: any) => { capturedParams = params; return { hits: [] }; };
    _setSearchClient(createMockTypesenseClient(searchFn));

    await ftsSearch(judikaty, 'decisions', 'test', ['pravni_veta'], 20, "source = 'nsoud' AND typ_rozhodnuti = 'Rozsudek'");
    expect(capturedParams.filter_by).toBe('source:=nsoud && typ_rozhodnuti:=Rozsudek');
  });

  it('warns on non-filterable fields', async () => {
    const searchFn = async () => ({ hits: [] });
    _setSearchClient(createMockTypesenseClient(searchFn));

    const result = await ftsSearch(judikaty, 'decisions', 'test', ['pravni_veta'], 20, "pravni_veta = 'xxx'");
    expect(result.warning).toContain('ignored');
  });

  it('warns on invalid filter syntax', async () => {
    const searchFn = async () => ({ hits: [] });
    _setSearchClient(createMockTypesenseClient(searchFn));

    const result = await ftsSearch(judikaty, 'decisions', 'test', ['pravni_veta'], 20, 'source = nsoud');
    expect(result.warning).toContain('ignored');
  });

  it('strips FTS5 boolean syntax from query', async () => {
    let capturedParams: any = null;
    const searchFn = async (params: any) => { capturedParams = params; return { hits: [] }; };
    _setSearchClient(createMockTypesenseClient(searchFn));

    await ftsSearch(judikaty, 'decisions', 'odpovědnost AND škoda NOT "test"', ['pravni_veta']);
    // AND/NOT/quotes stripped → multiple spaces remain (Typesense handles that)
    expect(capturedParams.q).toContain('odpovědnost');
    expect(capturedParams.q).toContain('škoda');
    expect(capturedParams.q).toContain('test');
    expect(capturedParams.q).not.toMatch(/AND|NOT|"/i);
  });

  it('falls back to ILIKE on Typesense error', async () => {
    const searchFn = async () => { throw new Error('Typesense down'); };
    _setSearchClient(createMockTypesenseClient(searchFn));

    // Should not throw — falls back to ILIKE which finds data in mock PG
    const result = await ftsSearch(judikaty, 'decisions', 'zprostředkov', ['pravni_veta']);
    expect(result.rowCount).toBeGreaterThan(0);
  });

  it('returns empty snippet for column without highlight', async () => {
    const searchFn = async () => ({ hits: [MOCK_HIT] });
    _setSearchClient(createMockTypesenseClient(searchFn));

    const result = await ftsSearch(judikaty, 'decisions', 'test', ['pravni_veta', 'vyrok']);
    expect(result.rows[0].vyrok_snippet).toBe('');
  });

  it('respects limit parameter', async () => {
    let capturedParams: any = null;
    const searchFn = async (params: any) => { capturedParams = params; return { hits: [] }; };
    _setSearchClient(createMockTypesenseClient(searchFn));

    await ftsSearch(judikaty, 'decisions', 'test', ['pravni_veta'], 5);
    expect(capturedParams.per_page).toBe(5);
  });

  it('only queries searchable columns in query_by', async () => {
    let capturedParams: any = null;
    const searchFn = async (params: any) => { capturedParams = params; return { hits: [] }; };
    _setSearchClient(createMockTypesenseClient(searchFn));

    await ftsSearch(judikaty, 'decisions', 'test', ['pravni_veta', 'vyrok', 'nonexistent']);
    expect(capturedParams.query_by).toBe('pravni_veta,vyrok');
  });
});

// --- H3: attachPoolErrorHandler (pg.Pool idle error crash protection) ---

describe('attachPoolErrorHandler', () => {
  // Pg Pool extends EventEmitter; simulate by emitting 'error' synchronously and asserting
  // the process does not crash (the test itself keeps running).
  it('does not crash on idle client error', () => {
    const fakePool = new EventEmitter() as unknown as import('pg').Pool;
    attachPoolErrorHandler(fakePool);
    const err = new Error('idle client timeout');

    // Without a handler, emitter.emit('error', ...) throws — if the handler is attached, this is a no-op.
    expect(() => (fakePool as unknown as EventEmitter).emit('error', err, {})).not.toThrow();
  });

  it('logs at warn level with err payload', () => {
    const fakePool = new EventEmitter() as unknown as import('pg').Pool;
    const warnSpy = vi.spyOn(logger, 'warn').mockImplementation(() => logger);
    attachPoolErrorHandler(fakePool);

    const err = new Error('connection reset');
    (fakePool as unknown as EventEmitter).emit('error', err, { processID: 1234 });

    expect(warnSpy).toHaveBeenCalledTimes(1);
    const call = warnSpy.mock.calls[0];
    // First arg = object payload containing err
    expect(call[0]).toMatchObject({ err });
    // Second arg = message string
    expect(call[1]).toMatch(/pg\.Pool idle client error/i);

    warnSpy.mockRestore();
  });

  it('remains usable after idle error (does not detach listener)', () => {
    const fakePool = new EventEmitter() as unknown as import('pg').Pool;
    const warnSpy = vi.spyOn(logger, 'warn').mockImplementation(() => logger);
    attachPoolErrorHandler(fakePool);

    // Emit two errors in sequence — both should be handled without throwing
    expect(() => {
      (fakePool as unknown as EventEmitter).emit('error', new Error('first'), {});
      (fakePool as unknown as EventEmitter).emit('error', new Error('second'), {});
    }).not.toThrow();

    expect(warnSpy).toHaveBeenCalledTimes(2);
    warnSpy.mockRestore();
  });

  it('accepts undefined client (idle error before client object exists)', () => {
    const fakePool = new EventEmitter() as unknown as import('pg').Pool;
    const warnSpy = vi.spyOn(logger, 'warn').mockImplementation(() => logger);
    attachPoolErrorHandler(fakePool);

    expect(() => (fakePool as unknown as EventEmitter).emit('error', new Error('no client'))).not.toThrow();
    expect(warnSpy).toHaveBeenCalledTimes(1);
    warnSpy.mockRestore();
  });
});
