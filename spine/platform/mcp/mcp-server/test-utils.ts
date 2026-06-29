import { gzipSync } from 'zlib';
import type { SourceInfo } from './db.js';
import pg from 'pg';

// --- Test data ---

const ACTS_RELS_JSON = JSON.stringify([
  {
    typ: 'MENI',
    pocet: 2,
    dokumenty: [
      { citace: '460/2016 Sb.', nazev: 'Novela OZ', stav: 'AKTUALNE_PLATNY', url: '/sb/2016/460' },
      { citace: '303/2017 Sb.', nazev: 'Další novela', stav: 'AKTUALNE_PLATNY', url: '/sb/2017/303' },
    ],
  },
  {
    typ: 'JE_MENEN',
    pocet: 1,
    dokumenty: [{ citace: '40/1964 Sb.', nazev: 'Starý OZ', stav: 'ZRUSENY', url: '/sb/1964/40' }],
  },
]);

const OZ_FULL_TEXT = `Preambule zákona.
<var>§ 2445</var>
Základní ustanovení
<p>(1) Smlouvou o zprostředkování se zprostředkovatel zavazuje.</p>
<p>(2) Je-li již při uzavření smlouvy zřejmé.</p>
<var>§ 2446</var>
<p>(1) Zprostředkovatel sdělí zájemci bez zbytečného odkladu vše.</p>
<var>§ 2447</var>
<p>(1) Provize je splatná dnem uzavření zprostředkované smlouvy.</p>
<var>§ 2448</var>
Bylo-li ujednáno, že zprostředkovateli vznikne právo na provizi.`;

const ACTS_DATA = [
  {
    id: 1,
    eli: 'eli:test:89-2012',
    citace: '89/2012 Sb.',
    nazev: 'Zákon občanský zákoník',
    typ_aktu: 'PRAVPRED',
    typ_zneni: 'AKTUALNI',
    datum_platnosti: '2014-01-01',
    datum_zruseni: null,
    fragment_count: 3080,
    full_text: OZ_FULL_TEXT,
    relationships_json: ACTS_RELS_JSON,
    raw_metadata_json: null,
    scraped_at: '2026-01-01 00:00:00',
  },
  {
    id: 2,
    eli: 'eli:test:253-2008',
    citace: '253/2008 Sb.',
    nazev: 'Zákon o AML',
    typ_aktu: null,
    typ_zneni: null,
    datum_platnosti: null,
    datum_zruseni: null,
    fragment_count: null,
    full_text: 'Text AML zákona.',
    relationships_json: null,
    raw_metadata_json: null,
    scraped_at: '2026-01-01 00:00:00',
  },
];

const GZIPPED_ODUVODNENI = gzipSync('Komprimované odůvodnění rozhodnutí.');

const DECISIONS_DATA = [
  {
    id: 1,
    url: 'https://nsoud.cz/1',
    source: 'nsoud',
    external_id: null,
    ecli: 'ECLI:CZ:NS:2009:33.CDO.2675.2007.1',
    jednaci_cislo: null,
    spisova_znacka: '33 Cdo 2675/2007, ECLI:CZ:NS:2009:33.CDO.2675.2007.1',
    soud: 'Nejvyšší soud',
    datum_vydani: '30.10.2009',
    typ_rozhodnuti: 'Rozsudek',
    oblast_prava: null,
    predmet_rizeni: null,
    klicova_slova: null,
    zminena_ustanoveni: null,
    pravni_veta: 'Rozhodčí doložka ve zprostředkovatelské smlouvě.',
    vyrok: 'Dovolání se zamítá.',
    oduvodneni: 'Odůvodnění rozhodnutí NS v plném znění. '.repeat(50),
    raw_json: null,
    scraped_at: '2026-01-01',
  },
  {
    id: 2,
    url: 'https://usoud.cz/1',
    source: 'usoud',
    external_id: null,
    ecli: null,
    jednaci_cislo: 'I.ÚS 52/25 #1',
    spisova_znacka: 'I.ÚS 52/25',
    soud: 'Ústavní soud',
    datum_vydani: '25. 2. 2026',
    typ_rozhodnuti: 'Nález',
    oblast_prava: null,
    predmet_rizeni: null,
    klicova_slova: null,
    zminena_ustanoveni: null,
    pravni_veta: null,
    vyrok: 'Ústavní stížnost se odmítá.',
    oduvodneni: 'Odůvodnění ÚS nálezu.',
    raw_json: null,
    scraped_at: '2026-01-01',
  },
  {
    id: 3,
    url: 'https://nssoud.cz/1',
    source: 'nssoud',
    external_id: null,
    ecli: null,
    jednaci_cislo: '2 Afs 250/2025 - 27',
    spisova_znacka: '2 Afs 250/2025 - 27',
    soud: 'Nejvyšší správní soud',
    datum_vydani: '11.03.2026',
    typ_rozhodnuti: 'Usnesení',
    oblast_prava: null,
    predmet_rizeni: null,
    klicova_slova: null,
    zminena_ustanoveni: null,
    pravni_veta: null,
    vyrok: 'Kasační stížnost se zamítá.',
    oduvodneni: null,
    raw_json: null,
    scraped_at: '2026-01-01',
  },
  {
    id: 4,
    url: 'https://test.cz/gz',
    source: 'nsoud',
    external_id: null,
    ecli: null,
    jednaci_cislo: null,
    spisova_znacka: 'GZ 1/2026',
    soud: 'Test soud',
    datum_vydani: '01.01.2026',
    typ_rozhodnuti: 'Test',
    oblast_prava: null,
    predmet_rizeni: null,
    klicova_slova: null,
    zminena_ustanoveni: null,
    pravni_veta: null,
    vyrok: 'Výrok.',
    oduvodneni: GZIPPED_ODUVODNENI,
    raw_json: null,
    scraped_at: '2026-01-01',
  },
];

// --- Column definitions for information_schema simulation ---

const ACTS_COLUMNS = [
  'id',
  'eli',
  'citace',
  'nazev',
  'typ_aktu',
  'typ_zneni',
  'datum_platnosti',
  'datum_zruseni',
  'fragment_count',
  'full_text',
  'relationships_json',
  'raw_metadata_json',
  'scraped_at',
];
const DECISIONS_COLUMNS = [
  'id',
  'url',
  'source',
  'external_id',
  'ecli',
  'jednaci_cislo',
  'spisova_znacka',
  'soud',
  'datum_vydani',
  'typ_rozhodnuti',
  'oblast_prava',
  'predmet_rizeni',
  'klicova_slova',
  'zminena_ustanoveni',
  'pravni_veta',
  'vyrok',
  'oduvodneni',
  'raw_json',
  'scraped_at',
];

// --- Mock PG Pool ---

type MockRow = Record<string, unknown>;

/**
 * Rudimentary SQL parser for test mock. Handles SELECT, WHERE, LIKE, ILIKE, LIMIT, ORDER BY.
 * NOT a full SQL parser — just enough for the MCP server's queries.
 */
function executeMockQuery(
  sql: string,
  params: unknown[],
  tables: Map<string, MockRow[]>,
  columnsMap: Map<string, string[]>,
): { rows: MockRow[]; fields: Array<{ name: string }> } {
  sql = sql.trim().replace(/;$/, '');

  // information_schema.tables
  if (/information_schema\.tables/i.test(sql)) {
    const likePat = params.find((p) => typeof p === 'string') as string | undefined;
    const allTableNames = [...tables.keys()];
    let filtered = allTableNames;
    if (likePat) {
      const regex = new RegExp('^' + likePat.replace(/%/g, '.*').replace(/_/g, '.') + '$');
      filtered = allTableNames.filter((t) => regex.test(t));
    }
    return { rows: filtered.map((t) => ({ table_name: t })), fields: [{ name: 'table_name' }] };
  }

  // information_schema.columns
  if (/information_schema\.columns/i.test(sql)) {
    const tableName = params.find((p) => typeof p === 'string') as string;
    const cols = columnsMap.get(tableName) || [];
    return {
      rows: cols.map((c, i) => ({
        column_name: c,
        data_type: 'text',
        is_nullable: c === 'id' ? 'NO' : 'YES',
        column_default: null,
        ordinal_position: i + 1,
      })),
      fields: [{ name: 'column_name' }, { name: 'data_type' }, { name: 'is_nullable' }, { name: 'column_default' }],
    };
  }

  // pg_stat_user_tables
  if (/pg_stat_user_tables/i.test(sql)) {
    const likePat = params.find((p) => typeof p === 'string') as string | undefined;
    let entries = [...tables.entries()];
    if (likePat) {
      const regex = new RegExp('^' + likePat.replace(/%/g, '.*').replace(/_/g, '.') + '$');
      entries = entries.filter(([name]) => regex.test(name));
    }
    return {
      rows: entries.map(([name, data]) => ({ relname: name, n_live_tup: String(data.length) })),
      fields: [{ name: 'relname' }, { name: 'n_live_tup' }],
    };
  }

  // pg_indexes
  if (/pg_indexes/i.test(sql)) {
    return { rows: [], fields: [{ name: 'indexdef' }] };
  }

  // SELECT from data tables
  const fromMatch = sql.match(/FROM\s+"?(\w+)"?/i);
  if (!fromMatch) return { rows: [], fields: [] };
  const tableName = fromMatch[1];
  const tableData = tables.get(tableName);
  if (!tableData) throw new Error(`relation "${tableName}" does not exist`);

  let rows = [...tableData];

  // WHERE clause processing
  const whereMatch = sql.match(/WHERE\s+(.+?)(?:\s+ORDER\s+|\s+LIMIT\s+|$)/is);
  if (whereMatch) {
    const whereSql = whereMatch[1];
    rows = rows.filter((row) => evaluateWhere(whereSql, row, params));
  }

  // LIMIT
  const limitMatch = sql.match(/LIMIT\s+(\d+|\$\d+)/i);
  if (limitMatch) {
    const limitVal = limitMatch[1].startsWith('$')
      ? Number(params[parseInt(limitMatch[1].slice(1)) - 1])
      : parseInt(limitMatch[1]);
    rows = rows.slice(0, limitVal);
  }

  // SELECT columns
  const selectMatch = sql.match(/SELECT\s+(.+?)\s+FROM/is);
  const selectStr = selectMatch ? selectMatch[1].trim() : '*';

  if (selectStr === '*' || selectStr === 'COUNT(*) as count') {
    if (selectStr === 'COUNT(*) as count') {
      let countRows = [...(tables.get(tableName) || [])];
      if (whereMatch) {
        countRows = countRows.filter((row) => evaluateWhere(whereMatch[1], row, params));
      }
      return { rows: [{ count: String(countRows.length) }], fields: [{ name: 'count' }] };
    }
    const allCols = columnsMap.get(tableName) || Object.keys(rows[0] || {});
    return { rows, fields: allCols.map((c) => ({ name: c })) };
  }

  // Parse select expressions
  const selectExprs = parseSelectExprs(selectStr);
  const mappedRows = rows.map((row) => {
    const out: MockRow = {};
    for (const expr of selectExprs) {
      if (expr.col === '*') {
        Object.assign(out, row);
      } else if (expr.func === 'length') {
        const val = row[expr.col];
        out[expr.alias] = val ? String(val).length : null;
      } else if (expr.func === 'substring') {
        const val = row[expr.col];
        out[expr.alias] = val ? String(val).substring(0, 500) : null;
      } else {
        out[expr.alias] = row[expr.col];
      }
    }
    return out;
  });

  const fields = selectExprs.map((e) => ({ name: e.alias }));
  return { rows: mappedRows, fields };
}

interface SelectExpr {
  col: string;
  alias: string;
  func?: string;
}

function parseSelectExprs(selectStr: string): SelectExpr[] {
  const exprs: SelectExpr[] = [];
  // Split by comma, respecting parentheses
  const parts = selectStr.split(/,(?![^()]*\))/);
  for (const part of parts) {
    const trimmed = part.trim();
    const funcMatch = trimmed.match(/^(\w+)\((?:"?(\w+)"?(?:,\s*[^)]*)?)\)\s+as\s+"?(\w+)"?$/i);
    if (funcMatch) {
      exprs.push({ col: funcMatch[2], alias: funcMatch[3], func: funcMatch[1].toLowerCase() });
      continue;
    }
    const aliasMatch = trimmed.match(/^"?(\w+)"?\s+as\s+"?(\w+)"?$/i);
    if (aliasMatch) {
      exprs.push({ col: aliasMatch[1], alias: aliasMatch[2] });
      continue;
    }
    const plainMatch = trimmed.match(/^"?(\w+)"?$/);
    if (plainMatch) {
      exprs.push({ col: plainMatch[1], alias: plainMatch[1] });
    }
  }
  return exprs;
}

function evaluateWhere(whereSql: string, row: MockRow, params: unknown[]): boolean {
  // Handle AND-connected conditions
  const conditions = whereSql.split(/\s+AND\s+/i);
  return conditions.every((cond) => evaluateCondition(cond.trim(), row, params));
}

function evaluateCondition(cond: string, row: MockRow, params: unknown[]): boolean {
  // Handle OR-connected conditions (within parentheses)
  if (cond.startsWith('(') && cond.endsWith(')')) {
    const inner = cond.slice(1, -1);
    const orParts = inner.split(/\s+OR\s+/i);
    return orParts.some((part) => evaluateCondition(part.trim(), row, params));
  }

  // column = $N (parameterized)
  const eqMatch = cond.match(/^"?(\w+)"?\s*=\s*\$(\d+)$/i);
  if (eqMatch) {
    const val = row[eqMatch[1]];
    const param = params[parseInt(eqMatch[2]) - 1];
    return val === param;
  }

  // column = 'literal' (inline string in raw SQL)
  const litMatch = cond.match(/^"?(\w+)"?\s*=\s*'([^']*)'\s*$/i);
  if (litMatch) {
    return row[litMatch[1]] === litMatch[2];
  }

  // column LIKE $N
  const likeMatch = cond.match(/^"?(\w+)"?\s+(I?LIKE)\s+\$(\d+)$/i);
  if (likeMatch) {
    const val = String(row[likeMatch[1]] ?? '');
    const pattern = String(params[parseInt(likeMatch[3]) - 1] ?? '');
    const regex = new RegExp(
      '^' + pattern.replace(/%/g, '.*').replace(/_/g, '.') + '$',
      likeMatch[2].toUpperCase() === 'ILIKE' ? 'i' : '',
    );
    return regex.test(val);
  }

  // column IS NOT NULL / IS NULL
  const nullMatch = cond.match(/^"?(\w+)"?\s+IS\s+(NOT\s+)?NULL$/i);
  if (nullMatch) {
    const val = row[nullMatch[1]];
    return nullMatch[2] ? val != null : val == null;
  }

  return true; // unknown condition — pass
}

/**
 * Create a mock PG Pool that answers queries against in-memory test data.
 * Returns sources for esbirka and judikaty.
 */
export function createTestDatabase(): {
  esbirkaSource: SourceInfo;
  judikatySource: SourceInfo;
  pool: pg.Pool;
} {
  const tables = new Map<string, MockRow[]>([
    ['esbirka_acts', ACTS_DATA],
    ['judikaty_decisions', DECISIONS_DATA],
  ]);

  const columnsMap = new Map<string, string[]>([
    ['esbirka_acts', ACTS_COLUMNS],
    ['judikaty_decisions', DECISIONS_COLUMNS],
  ]);

  // Create a mock Pool object
  const mockPool = {
    query: async (sql: string, params?: unknown[]) => {
      return executeMockQuery(sql, params ?? [], tables, columnsMap);
    },
    end: async () => {},
  } as unknown as pg.Pool;

  const esbirkaSource: SourceInfo = {
    name: 'esbirka',
    prefix: 'esbirka',
    pool: mockPool,
    tableMap: new Map([['acts', 'esbirka_acts']]),
    columnCache: new Map([['esbirka_acts', ACTS_COLUMNS]]),
  };

  const judikatySource: SourceInfo = {
    name: 'judikaty',
    prefix: 'judikaty',
    pool: mockPool,
    tableMap: new Map([['decisions', 'judikaty_decisions']]),
    columnCache: new Map([['judikaty_decisions', DECISIONS_COLUMNS]]),
  };

  return { esbirkaSource, judikatySource, pool: mockPool };
}
