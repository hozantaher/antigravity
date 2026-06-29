import pg from 'pg';
import Typesense from 'typesense';
import { SOURCE_PREFIX, unprefixTable } from '../lib/db-prefix.js';
import { createSearchClient, hasSearchIndex, SEARCH_INDEXES } from '../lib/meilisearch.js';
import { logger } from '../lib/logger.js';
import { tryGunzip } from '../lib/utils.js';

const { Pool } = pg;

export interface SourceInfo {
  name: string;
  prefix: string;
  pool: pg.Pool;
  /** Mapping of unprefixed table name → prefixed table name for this source. */
  tableMap: Map<string, string>;
  /** Cache: prefixed table name → column names. Populated lazily. */
  columnCache: Map<string, string[]>;
}

// Shared Typesense client (null if not configured)
let searchClient: Typesense.Client | null = null;

const RAW_COLUMN_PATTERN = /^raw_/;
const MAX_RESPONSE_BYTES = 100_000;
const DEFAULT_LIMIT = 100;
const MAX_LIMIT = 1000;
const MAX_LIMIT_WITH_RAW = 5;

/**
 * Attach an idle-error handler to a pg.Pool.
 * pg.Pool emits 'error' when an idle client connection fails (e.g. server-side
 * TCP reset). Without a handler, the default EventEmitter behavior re-throws
 * the error and crashes the process (see https://node-postgres.com/api/pool#error).
 * Exported so it can be unit-tested against a fake EventEmitter.
 */
export function attachPoolErrorHandler(pool: pg.Pool): void {
  pool.on('error', (err, _client) => {
    logger.warn({ err }, 'pg.Pool idle client error');
  });
}

/**
 * Discover sources from PostgreSQL by grouping prefixed table names.
 * Creates a shared Pool; all sources share the same connection pool.
 */
export const discoverSources = async (databaseUrl: string): Promise<Map<string, SourceInfo>> => {
  const sources = new Map<string, SourceInfo>();

  // Initialize Typesense client (optional — search falls back to ILIKE without it)
  searchClient = createSearchClient();
  if (searchClient) {
    try {
      await searchClient.health.retrieve();
      logger.info({ url: process.env.TYPESENSE_URL || process.env.MEILI_URL }, 'Typesense connected');
    } catch (e) {
      logger.warn({ err: e }, 'Typesense unreachable, falling back to ILIKE');
      searchClient = null;
    }
  }

  const pool = new Pool({
    connectionString: databaseUrl,
    ssl: { rejectUnauthorized: false },
    max: 10,
    idleTimeoutMillis: 30000,
    connectionTimeoutMillis: 5000,
  });

  // Handle idle-client errors so they don't crash the process (pg.Pool emits 'error'
  // when an idle PG connection fails; default EventEmitter behavior is to throw).
  attachPoolErrorHandler(pool);

  const { rows: allTables } = await pool.query<{ table_name: string }>(
    `SELECT table_name FROM information_schema.tables
     WHERE table_schema = 'public' AND table_type = 'BASE TABLE'
     ORDER BY table_name`,
  );

  // Group tables by known prefix
  const prefixGroups = new Map<string, Map<string, string>>();

  for (const { table_name } of allTables) {
    const parsed = unprefixTable(table_name);
    if (!parsed) continue;

    const sourceName = parsed.source;
    const prefix = SOURCE_PREFIX[sourceName];
    if (!prefix) continue;

    if (!prefixGroups.has(sourceName)) {
      prefixGroups.set(sourceName, new Map());
    }
    prefixGroups.get(sourceName)!.set(parsed.table, table_name);
  }

  for (const [sourceName, tableMap] of prefixGroups) {
    sources.set(sourceName, {
      name: sourceName,
      prefix: SOURCE_PREFIX[sourceName],
      pool,
      tableMap,
      columnCache: new Map(),
    });
  }

  return sources;
};

// --- SQL table name rewriting ---

/**
 * Rewrite unprefixed table names in user SQL to their prefixed equivalents.
 * Only replaces after SQL keywords (FROM, JOIN, INTO, UPDATE, TABLE, EXISTS).
 */
export function rewriteTableNames(sql: string, tableMap: Map<string, string>): string {
  if (tableMap.size === 0) return sql;

  for (const [unprefixed, prefixed] of tableMap) {
    if (unprefixed === prefixed) continue;

    const pattern = new RegExp(
      `(\\b(?:FROM|JOIN|INTO|UPDATE|TABLE|EXISTS)\\s+)"?\\b(${escapeRegex(unprefixed)})\\b"?`,
      'gi',
    );
    sql = sql.replace(pattern, `$1"${prefixed}"`);
  }
  return sql;
}

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function resolveTable(source: SourceInfo, unprefixedName: string): string {
  return source.tableMap.get(unprefixedName) ?? unprefixedName;
}

/** Get column names for a table, using cache on SourceInfo to avoid repeated information_schema queries. */
async function getTableColumns(source: SourceInfo, tableName: string): Promise<string[]> {
  const cached = source.columnCache.get(tableName);
  if (cached) return cached;

  const { rows } = await source.pool.query<{ column_name: string }>(
    `SELECT column_name FROM information_schema.columns
     WHERE table_schema = 'public' AND table_name = $1
     ORDER BY ordinal_position`,
    [tableName],
  );
  const cols = rows.map((r) => r.column_name);
  source.columnCache.set(tableName, cols);
  return cols;
}

// --- Schema & Stats ---

export const getSchema = async (source: SourceInfo): Promise<string> => {
  const prefix = source.prefix;

  // Get table definitions
  const { rows: tables } = await source.pool.query<{ table_name: string }>(
    `SELECT table_name FROM information_schema.tables
     WHERE table_schema = 'public' AND table_type = 'BASE TABLE' AND table_name LIKE $1
     ORDER BY table_name`,
    [`${prefix}_%`],
  );

  const parts: string[] = [];

  for (const { table_name } of tables) {
    const { rows: cols } = await source.pool.query<{
      column_name: string;
      data_type: string;
      is_nullable: string;
      column_default: string | null;
    }>(
      `SELECT column_name, data_type, is_nullable, column_default
       FROM information_schema.columns
       WHERE table_schema = 'public' AND table_name = $1
       ORDER BY ordinal_position`,
      [table_name],
    );

    const colDefs = cols.map((c) => {
      let def = `  "${c.column_name}" ${c.data_type.toUpperCase()}`;
      if (c.is_nullable === 'NO') def += ' NOT NULL';
      if (c.column_default) def += ` DEFAULT ${c.column_default}`;
      return def;
    });
    parts.push(`CREATE TABLE "${table_name}" (\n${colDefs.join(',\n')}\n);`);
  }

  // Get indexes
  const { rows: indexes } = await source.pool.query<{ indexdef: string }>(
    `SELECT indexdef FROM pg_indexes
     WHERE schemaname = 'public' AND tablename LIKE $1
     ORDER BY indexname`,
    [`${prefix}_%`],
  );
  for (const { indexdef } of indexes) {
    parts.push(indexdef + ';');
  }

  return parts.join('\n\n');
};

export const getStats = async (source: SourceInfo): Promise<Record<string, unknown>> => {
  const prefix = source.prefix;

  const { rows: tables } = await source.pool.query<{ relname: string; n_live_tup: string }>(
    `SELECT relname, n_live_tup FROM pg_stat_user_tables
     WHERE schemaname = 'public' AND relname LIKE $1
     ORDER BY relname`,
    [`${prefix}_%`],
  );

  const stats: Record<string, unknown> = { source: source.name };
  for (const { relname, n_live_tup } of tables) {
    const displayName = unprefixTable(relname)?.table ?? relname;
    const approx = parseInt(n_live_tup, 10);

    if (approx > 0) {
      stats[displayName] = approx;
    } else {
      const { rows } = await source.pool.query<{ count: string }>(`SELECT COUNT(*) as count FROM "${relname}"`);
      stats[displayName] = parseInt(rows[0].count, 10);
    }
  }
  return stats;
};

// --- Query execution ---

export interface QueryOptions {
  sql: string;
  limit?: number;
  includeRaw?: boolean;
}

export interface QueryResult {
  columns: string[];
  rows: Record<string, unknown>[];
  rowCount: number;
  truncated: boolean;
  truncationReason?: string;
}

export const executeQuery = async (source: SourceInfo, options: QueryOptions): Promise<QueryResult> => {
  const { includeRaw = false } = options;
  let { sql } = options;
  const requestedLimit = Math.min(options.limit ?? DEFAULT_LIMIT, includeRaw ? MAX_LIMIT_WITH_RAW : MAX_LIMIT);

  // Rewrite unprefixed table names → prefixed equivalents
  sql = rewriteTableNames(sql, source.tableMap);

  // Append LIMIT if missing
  const normalizedSql = sql.replace(/;+\s*$/, '');
  const sqlNoComments = normalizedSql.replace(/--[^\n]*/g, '').replace(/\/\*[\s\S]*?\*\//g, '');
  const hasLimit = /\bLIMIT\s+\d+/i.test(sqlNoComments);
  const execSql = hasLimit ? normalizedSql : `${normalizedSql} LIMIT ${requestedLimit}`;

  const { rows: allRows, fields } = await source.pool.query(execSql);

  const cappedRows = allRows.slice(0, requestedLimit);
  const wasCappedByRowLimit = allRows.length > requestedLimit;

  const columns = fields.map((f) => f.name);

  // Process rows: decompress gzipped blobs, handle raw columns
  const processedRows = cappedRows.map((row: Record<string, unknown>) => {
    const processed = { ...row };
    for (const col of columns) {
      const val = processed[col];
      if (val == null) continue;

      const isRawCol = RAW_COLUMN_PATTERN.test(col);
      const decompressed = tryGunzip(val);

      if (decompressed !== null) {
        processed[col] =
          isRawCol && !includeRaw
            ? `[${formatBytes((val as Buffer).length)} - use include_raw=true to retrieve]`
            : decompressed;
      } else if (isRawCol && !includeRaw && val instanceof Buffer) {
        processed[col] = `[${formatBytes(val.length)} - use include_raw=true to retrieve]`;
      }
    }
    return processed;
  });

  let truncated = wasCappedByRowLimit;
  let truncationReason: string | undefined = wasCappedByRowLimit
    ? `Results capped to ${requestedLimit} rows`
    : undefined;

  if (JSON.stringify(processedRows).length > MAX_RESPONSE_BYTES) {
    let lo = 1;
    let hi = processedRows.length;
    while (lo < hi) {
      const mid = Math.ceil((lo + hi) / 2);
      if (JSON.stringify(processedRows.slice(0, mid)).length <= MAX_RESPONSE_BYTES) {
        lo = mid;
      } else {
        hi = mid - 1;
      }
    }
    const trimmedRows = processedRows.slice(0, lo);
    truncated = true;
    truncationReason = `Response truncated from ${processedRows.length} to ${trimmedRows.length} rows to stay under ${formatBytes(MAX_RESPONSE_BYTES)} response limit`;
    return { columns, rows: trimmedRows, rowCount: trimmedRows.length, truncated, truncationReason };
  }

  return { columns, rows: processedRows, rowCount: processedRows.length, truncated, truncationReason };
};

const formatBytes = (bytes: number): string => {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
};

// --- Paragraph extraction from full_text ---

const PARAGRAPH_PATTERN = /<var>§\s*(\d+[a-z]?)\s*<\/var>/gi;

export const extractParagraphs = async (
  source: SourceInfo,
  citace: string,
  paragraphs: string[],
): Promise<{
  citace: string;
  nazev: string | null;
  found: Array<{ paragraph: string; text: string }>;
  missing: string[];
}> => {
  const actsTable = resolveTable(source, 'acts');
  const { rows } = await source.pool.query<{ nazev: string; full_text: string | Buffer }>(
    `SELECT nazev, full_text FROM "${actsTable}" WHERE citace = $1 LIMIT 1`,
    [citace],
  );
  const row = rows[0];

  if (!row?.full_text) {
    return { citace, nazev: row?.nazev ?? null, found: [], missing: paragraphs };
  }

  // full_text may come as Buffer (bytea) — convert to string
  const fullText = row.full_text instanceof Buffer ? row.full_text.toString('utf-8') : String(row.full_text);

  const positions: Array<{ num: string; start: number }> = [];
  let match: RegExpExecArray | null;
  const regex = new RegExp(PARAGRAPH_PATTERN.source, 'gi');
  while ((match = regex.exec(fullText)) !== null) {
    positions.push({ num: match[1], start: match.index });
  }

  const found: Array<{ paragraph: string; text: string }> = [];
  const missing: string[] = [];

  for (const p of paragraphs) {
    const num = p.replace(/§\s*/g, '').trim();
    const idx = positions.findIndex((pos) => pos.num === num);

    if (idx === -1) {
      missing.push(p);
      continue;
    }

    const start = positions[idx].start;
    const end = idx + 1 < positions.length ? positions[idx + 1].start : Math.min(start + 10000, fullText.length);
    let text = fullText.slice(start, end).trim();

    text = text
      .replace(/<br\s*\/?>/gi, '\n')
      .replace(/<\/p>/gi, '\n\n')
      .replace(/<\/div>/gi, '\n')
      .replace(/<\/li>/gi, '\n')
      .replace(/<\/tr>/gi, '\n')
      .replace(/<[^>]+>/g, '')
      .replace(/\n{3,}/g, '\n\n')
      .trim();

    found.push({ paragraph: `§ ${num}`, text });
  }

  return { citace, nazev: row.nazev ?? null, found, missing };
};

// --- Search (Typesense + ILIKE fallback) ---

export interface FtsResult {
  rows: Record<string, unknown>[];
  rowCount: number;
  engine?: 'typesense' | 'ilike';
  warning?: string;
}

/**
 * Search across specified columns.
 * Uses Typesense for indexed tables (judikaty_decisions, esbirka_acts),
 * falls back to ILIKE for others.
 */
export const ftsSearch = async (
  source: SourceInfo,
  table: string,
  query: string,
  columns: string[],
  limit: number = 20,
  filter?: string,
): Promise<FtsResult> => {
  table = table.replace(/_fulltext_fts$|_fts$/, '');
  const resolvedTable = resolveTable(source, table);

  if (searchClient && hasSearchIndex(resolvedTable)) {
    try {
      return await typesenseSearch(resolvedTable, query, columns, limit, filter);
    } catch (e) {
      logger.warn({ err: e }, 'Typesense search failed, falling back to ILIKE');
    }
  }

  return ilikeSearch(source, resolvedTable, query, columns, limit, filter);
};

/** Typesense search with highlight → _snippet conversion. */
async function typesenseSearch(
  collectionName: string,
  query: string,
  columns: string[],
  limit: number,
  filter?: string,
): Promise<FtsResult> {
  const config = SEARCH_INDEXES[collectionName];

  const cleanQuery = query
    .replace(/AND|OR|NOT|NEAR(?:\/\d+)?/gi, ' ')
    .replace(/[*^(){}:]/g, '')
    .replace(/"/g, '')
    .trim();

  if (!cleanQuery) return { rows: [], rowCount: 0 };

  // Convert SQL-style filter to Typesense syntax: "source = 'nsoud'" → "source:=nsoud"
  let tsFilter: string | undefined;
  let warning: string | undefined;
  if (filter) {
    const parts = filter.split(/\s+AND\s+/i);
    const validParts: string[] = [];
    const dropped: string[] = [];
    for (const part of parts) {
      const match = part.trim().match(/^(\w+)\s*(=|!=|<>|>|<|>=|<=)\s*'([^']*)'\s*$/i);
      if (match && config.filterableFields.includes(match[1])) {
        const op = match[2] === '=' ? ':=' : match[2] === '!=' || match[2] === '<>' ? ':!=' : `:${match[2]}`;
        validParts.push(`${match[1]}${op}${match[3]}`);
      } else {
        dropped.push(part.trim());
      }
    }
    if (validParts.length > 0) tsFilter = validParts.join(' && ');
    if (dropped.length > 0) {
      warning = `Filter conditions ignored (not filterable or unsupported): ${dropped.join(', ')}`;
    }
  }

  const queryBy = columns.filter((c) => config.searchableFields.includes(c));
  if (queryBy.length === 0) return { rows: [], rowCount: 0, warning };

  const result = await searchClient!
    .collections(collectionName)
    .documents()
    .search({
      q: cleanQuery,
      query_by: queryBy.join(','),
      filter_by: tsFilter,
      highlight_fields: queryBy.join(','),
      highlight_start_tag: '>>>',
      highlight_end_tag: '<<<',
      per_page: limit,
      drop_tokens_threshold: 1,
    });

  // Return metadata fields + snippets only — exclude full content of searched columns to keep response small
  const searchedSet = new Set(queryBy);
  const rows = (result.hits ?? []).map((hit) => {
    const row: Record<string, unknown> = {};
    for (const [key, val] of Object.entries(hit.document as Record<string, unknown>)) {
      if (!searchedSet.has(key)) row[key] = val;
    }
    for (const col of columns) {
      const hl = hit.highlights?.find((h: any) => h.field === col);
      row[`${col}_snippet`] = hl?.snippet ?? '';
    }
    return row;
  });

  return { rows, rowCount: rows.length, engine: 'typesense', warning };
}

/** ILIKE-based search fallback for tables without Meilisearch index. */
async function ilikeSearch(
  source: SourceInfo,
  resolvedTable: string,
  query: string,
  columns: string[],
  limit: number,
  filter?: string,
): Promise<FtsResult> {
  const tableColumns = await getTableColumns(source, resolvedTable);
  if (tableColumns.length === 0) return { rows: [], rowCount: 0 };
  const validColumns = columns.filter((c) => tableColumns.includes(c));
  if (validColumns.length === 0) return { rows: [], rowCount: 0 };

  let warning: string | undefined;
  const filterConditions: string[] = [];
  const filterParams: string[] = [];
  let paramIdx = 1;

  if (filter) {
    const filterParts = filter.split(/\s+AND\s+/i);
    const dropped: string[] = [];
    for (const part of filterParts) {
      const match = part.trim().match(/^(\w+)\s*(=|!=|<>|>|<|>=|<=|LIKE)\s*'([^']*)'\s*$/i);
      if (match && tableColumns.includes(match[1])) {
        filterConditions.push(`"${match[1]}" ${match[2]} $${paramIdx++}`);
        filterParams.push(match[3]);
      } else {
        dropped.push(part.trim());
      }
    }
    if (dropped.length > 0) {
      warning = `Filter conditions ignored (use column = 'value' format): ${dropped.join(', ')}`;
    }
  }

  const words = query
    .replace(/AND|OR|NOT|NEAR(?:\/\d+)?|"/gi, ' ')
    .replace(/[*^(){}:]/g, '')
    .split(/\s+/)
    .filter(Boolean);
  if (words.length === 0) return { rows: [], rowCount: 0, warning };

  // Each word gets ONE param ($N), reused across all searched columns
  const wordConditions: string[] = [];
  const wordParams: string[] = [];
  for (const word of words) {
    const colOrs = validColumns.map((c) => `"${c}" ILIKE $${paramIdx}`);
    wordConditions.push(`(${colOrs.join(' OR ')})`);
    wordParams.push(`%${word}%`);
    paramIdx++;
  }

  const metadataCols = tableColumns
    .filter((c) => c !== 'id' && !validColumns.includes(c))
    .filter((c) => !/^raw_|^full_text$|^oduvodneni$|^image_urls$|^description$/.test(c))
    .slice(0, 8);

  const hasId = tableColumns.includes('id');
  const selectParts = [
    ...(hasId ? ['"id"'] : []),
    ...metadataCols.map((c) => `"${c}"`),
    ...validColumns.map((c) => `SUBSTRING("${c}", 1, 500) as "${c}_snippet"`),
  ];

  // OR between words: partial matches returned, ranked by number of matching words
  const rankExpr = wordConditions.map((c) => `(${c})::int`).join(' + ');
  const searchBlock = `(${wordConditions.join(' OR ')})`;
  const allConditions = [...filterConditions, searchBlock];
  const allParams = [...filterParams, ...wordParams, limit];

  const sql = `SELECT ${selectParts.join(', ')} FROM "${resolvedTable}" WHERE ${allConditions.join(' AND ')} ORDER BY (${rankExpr}) DESC LIMIT $${paramIdx}`;

  const { rows } = await source.pool.query(sql, allParams);
  return { rows, rowCount: rows.length, engine: 'ilike', warning };
}

// --- Decision lookup ---

export interface DecisionDetail {
  spisova_znacka: string | null;
  ecli: string | null;
  soud: string | null;
  source: string | null;
  datum_vydani: string | null;
  typ_rozhodnuti: string | null;
  oblast_prava: string | null;
  predmet_rizeni: string | null;
  klicova_slova: string | null;
  zminena_ustanoveni: string | null;
  pravni_veta: string | null;
  vyrok: string | null;
  oduvodneni: string | Buffer | null;
  raw_json: string | Buffer | null;
}

export const getDecision = async (
  source: SourceInfo,
  identifier: string,
  sections: 'all' | 'metadata' | 'pravni_veta' | 'vyrok' | 'oduvodneni' = 'all',
  maxLength: number = 5000,
): Promise<string | null> => {
  const decisionsTable = resolveTable(source, 'decisions');
  const selectCols = `spisova_znacka, ecli, soud, source, datum_vydani, typ_rozhodnuti,
              oblast_prava, predmet_rizeni, klicova_slova, zminena_ustanoveni,
              pravni_veta, vyrok, oduvodneni`;

  const q = async (where: string, params: unknown[]) => {
    const { rows } = await source.pool.query<DecisionDetail>(
      `SELECT ${selectCols} FROM "${decisionsTable}" WHERE ${where} LIMIT 1`,
      params,
    );
    return rows[0] ?? null;
  };

  // Exact matches in parallel (3 independent queries, 1 roundtrip via Promise.all), then fallback
  const [bySZ, byECLI, byJC] = await Promise.all([
    q('spisova_znacka = $1', [identifier]),
    q('ecli = $1', [identifier]),
    q('jednaci_cislo = $1', [identifier]),
  ]);
  const row =
    bySZ ||
    byECLI ||
    byJC ||
    (await q('spisova_znacka LIKE $1', [`${identifier}%`])) ||
    (identifier.length >= 10 ? await q('spisova_znacka LIKE $1', [`%${identifier}%`]) : null);

  if (!row) return null;

  const oduvodneni =
    tryGunzip(row.oduvodneni) ??
    (typeof row.oduvodneni === 'string' ? row.oduvodneni : null) ??
    (row.oduvodneni instanceof Buffer ? row.oduvodneni.toString('utf-8') : null);

  let text = `# ${row.spisova_znacka || row.ecli || 'Bez identifikace'}\n`;
  text += `**Soud:** ${row.soud || '?'} | **Datum:** ${row.datum_vydani || '?'} | **Typ:** ${row.typ_rozhodnuti || '?'}\n`;
  if (row.oblast_prava) text += `**Oblast práva:** ${row.oblast_prava}\n`;
  if (row.predmet_rizeni) text += `**Předmět řízení:** ${row.predmet_rizeni}\n`;
  if (row.klicova_slova) text += `**Klíčová slova:** ${row.klicova_slova}\n`;
  if (row.zminena_ustanoveni) text += `**Zmíněná ustanovení:** ${row.zminena_ustanoveni}\n`;
  text += '\n';

  const available: string[] = [];
  if (row.pravni_veta) available.push(`pravni_veta (${String(row.pravni_veta).length} zn.)`);
  if (row.vyrok) available.push(`vyrok (${String(row.vyrok).length} zn.)`);
  if (oduvodneni) available.push(`oduvodneni (${oduvodneni.length} zn.)`);
  if (available.length === 0) available.push('pouze metadata');
  text += `**Dostupné sekce:** ${available.join(', ')}\n\n`;

  if (sections === 'all' || sections === 'pravni_veta') {
    if (row.pravni_veta) text += `## Právní věta\n${row.pravni_veta}\n\n`;
  }

  if (sections === 'all' || sections === 'vyrok') {
    if (row.vyrok) {
      const vyrok = String(row.vyrok);
      const v =
        vyrok.length > maxLength ? vyrok.substring(0, maxLength) + `\n\n*[Zkráceno z ${vyrok.length} znaků]*` : vyrok;
      text += `## Výrok\n${v}\n\n`;
    }
  }

  if (sections === 'all' || sections === 'oduvodneni') {
    if (oduvodneni) {
      const o =
        oduvodneni.length > maxLength
          ? oduvodneni.substring(0, maxLength) +
            `\n\n*[Zkráceno z ${oduvodneni.length} znaků — zvyš max_length pro více]*`
          : oduvodneni;
      text += `## Odůvodnění\n${o}\n\n`;
    }
  }

  return text;
};

// --- Law context ---

interface LawRelationship {
  typ: string;
  pocet: number;
  dokumenty: Array<{ citace: string; nazev: string; stav: string; url: string }>;
}

export const getLawContext = async (source: SourceInfo, citace: string): Promise<string | null> => {
  const actsTable = resolveTable(source, 'acts');
  const { rows } = await source.pool.query<{
    citace: string;
    nazev: string;
    typ_aktu: string | null;
    typ_zneni: string | null;
    datum_platnosti: string | null;
    datum_zruseni: string | null;
    fragment_count: number | null;
    text_length: number | null;
    relationships_json: string | null;
    scraped_at: string | null;
  }>(
    `SELECT citace, nazev, typ_aktu, typ_zneni, datum_platnosti, datum_zruseni,
            fragment_count, length(full_text) as text_length, relationships_json, scraped_at
     FROM "${actsTable}" WHERE citace = $1 LIMIT 1`,
    [citace],
  );
  const row = rows[0];

  if (!row) return null;

  let text = `# ${row.nazev}\n`;
  text += `**Citace:** ${row.citace}\n`;
  if (row.typ_aktu) text += `**Typ:** ${row.typ_aktu}\n`;
  if (row.typ_zneni) text += `**Znění:** ${row.typ_zneni}\n`;
  text += `**Platnost od:** ${row.datum_platnosti || '?'}\n`;
  text += row.datum_zruseni ? `**ZRUŠEN:** ${row.datum_zruseni}\n` : `**Stav:** platný\n`;
  if (row.text_length) text += `**Rozsah:** ${(row.text_length / 1024).toFixed(0)} KB`;
  if (row.fragment_count) text += `, ${row.fragment_count} fragmentů`;
  text += '\n';
  if (row.scraped_at) text += `**Data k:** ${row.scraped_at}\n`;
  text += '\n';

  if (row.relationships_json) {
    try {
      const rels = JSON.parse(row.relationships_json) as LawRelationship[];
      for (const rel of rels) {
        text += `## ${rel.typ} (${rel.pocet})\n`;
        const docs = rel.dokumenty.slice(0, 15);
        for (const doc of docs) {
          text += `- ${doc.citace} — ${doc.nazev} (${doc.stav})\n`;
        }
        if (rel.pocet > 15) text += `- ... a ${rel.pocet - 15} dalších\n`;
        text += '\n';
      }
    } catch (parseErr) {
      // malformed relationships_json — skip rendering relationships but log for discoverability
      logger.debug({ citace, err: parseErr }, 'getLawContext: malformed relationships_json — skipping');
    }
  }

  return text;
};

/** For testing: inject mock Typesense client. */
export function _setSearchClient(client: Typesense.Client | null) {
  searchClient = client;
}
