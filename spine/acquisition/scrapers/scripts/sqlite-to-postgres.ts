/**
 * Migrate main content tables from garaaage.db (SQLite) to PostgreSQL.
 *
 * Skips operational tables (urls, scrape_runs, search_progress, search_segments)
 * and FTS5/sqlite internal tables.
 *
 * Usage:
 *   DATABASE_URL=postgres://... npx tsx scripts/sqlite-to-postgres.ts
 *   DATABASE_URL=postgres://... npx tsx scripts/sqlite-to-postgres.ts --table=judikaty_decisions
 *   DATABASE_URL=postgres://... npx tsx scripts/sqlite-to-postgres.ts --dry-run
 */

import Database from 'better-sqlite3';
import pg from 'pg';
import { existsSync } from 'fs';
import { resolve } from 'path';
import { parseArgs } from 'util';
import { DEFAULT_DB } from '../lib/db-prefix.js';

const { Pool } = pg;

const DATA_DIR = resolve('data');
// PG max params ~65535. With ~50 cols per table, 500 rows = 25K params (safe margin).
const BATCH_SIZE = 500;

const { values } = parseArgs({
  args: process.argv.slice(2).filter((a) => a !== '--'),
  options: {
    table: { type: 'string' },
    'dry-run': { type: 'boolean', default: false },
    'db-path': { type: 'string' },
    'drop-tables': { type: 'boolean', default: true },
  },
  strict: false,
});

const dryRun = values['dry-run'] as boolean;
const onlyTable = values.table as string | undefined;
const dropTables = values['drop-tables'] !== false;
const dbPath = (values['db-path'] as string) || resolve(DATA_DIR, DEFAULT_DB);

/** Table name suffixes to skip (operational/scraper tables). */
const SKIP_SUFFIXES = ['_urls', '_scrape_runs', '_search_progress', '_search_segments'];

/** Check if table is operational (should be skipped). */
function isOperationalTable(name: string): boolean {
  return SKIP_SUFFIXES.some((suffix) => name.endsWith(suffix));
}

/** Check if table should be migrated. */
function shouldMigrate(name: string): boolean {
  if (name.startsWith('sqlite')) return false;
  if (name.includes('_fts')) return false;
  if (isOperationalTable(name)) return false;
  return true;
}

interface ColumnInfo {
  cid: number;
  name: string;
  type: string;
  notnull: number;
  dflt_value: string | null;
  pk: number;
}

/** Map SQLite type to PostgreSQL type. blobCols overrides TEXT→BYTEA for columns with actual binary data. */
function mapType(col: ColumnInfo, blobCols?: Set<string>): string {
  const t = (col.type || 'TEXT').toUpperCase();

  if (col.pk && t.includes('INTEGER')) return 'SERIAL PRIMARY KEY';

  if (t.includes('INTEGER')) return 'INTEGER';
  if (t.includes('REAL') || t.includes('DOUBLE') || t.includes('FLOAT')) return 'DOUBLE PRECISION';
  if (t.includes('BLOB')) return 'BYTEA';
  // SQLite declares gzipped columns as TEXT, but they contain binary BLOBs
  if (blobCols?.has(col.name)) return 'BYTEA';
  return 'TEXT';
}

/**
 * Scan a table to find columns that actually contain Buffer/BLOB data
 * despite being declared as TEXT in the schema (common with gzip compression).
 */
function detectBlobColumns(sqlite: import('better-sqlite3').Database, table: string): Set<string> {
  const blobCols = new Set<string>();
  const row = sqlite.prepare(`SELECT * FROM "${table}" LIMIT 1`).get() as Record<string, unknown> | undefined;
  if (!row) return blobCols;

  for (const [col, val] of Object.entries(row)) {
    if (Buffer.isBuffer(val)) {
      blobCols.add(col);
    }
  }

  // Also check a few more rows — first row might have NULL where others have BLOBs
  const rows = sqlite.prepare(`SELECT * FROM "${table}" WHERE id > 1 LIMIT 10`).all() as Record<string, unknown>[];
  for (const r of rows) {
    for (const [col, val] of Object.entries(r)) {
      if (Buffer.isBuffer(val)) {
        blobCols.add(col);
      }
    }
  }

  return blobCols;
}

/** Map SQLite default value to PostgreSQL. */
function mapDefault(dflt: string | null): string | null {
  if (!dflt) return null;
  if (/datetime\s*\(\s*'now'\s*\)/i.test(dflt)) return 'NOW()';
  return dflt;
}

/** Generate PostgreSQL CREATE TABLE from SQLite PRAGMA table_info. */
function generateCreateTable(tableName: string, columns: ColumnInfo[], blobCols: Set<string>): string {
  const colDefs = columns.map((col) => {
    let def = `  "${col.name}" ${mapType(col, blobCols)}`;
    if (col.notnull && !col.pk) def += ' NOT NULL';
    const pgDefault = mapDefault(col.dflt_value);
    if (pgDefault && !col.pk) def += ` DEFAULT ${pgDefault}`;
    return def;
  });
  return `CREATE TABLE "${tableName}" (\n${colDefs.join(',\n')}\n)`;
}

/** Convert a SQLite CREATE INDEX to PostgreSQL syntax. */
function convertIndex(sql: string): string | null {
  // SQLite: CREATE INDEX IF NOT EXISTS idx_name ON table(col1, col2)
  // PostgreSQL: CREATE INDEX IF NOT EXISTS idx_name ON "table"(col1, col2)
  const match = sql.match(/CREATE\s+(?:UNIQUE\s+)?INDEX\s+(?:IF\s+NOT\s+EXISTS\s+)?(\S+)\s+ON\s+(\S+)\s*\(([^)]+)\)/i);
  if (!match) return null;

  const [, idxName, tableName, cols] = match;
  const unique = /UNIQUE/i.test(sql) ? 'UNIQUE ' : '';
  return `CREATE ${unique}INDEX IF NOT EXISTS "${idxName}" ON "${tableName}" (${cols})`;
}

async function main() {
  console.log('SQLite → PostgreSQL Migration');
  console.log(`Source: ${dbPath}`);
  if (dryRun) console.log('MODE: dry-run (DDL only, no data transfer)\n');

  if (!existsSync(dbPath)) {
    console.error(`Source database not found: ${dbPath}`);
    process.exit(1);
  }

  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl && !dryRun) {
    console.error('DATABASE_URL environment variable is required');
    process.exit(1);
  }

  // Open SQLite
  const sqlite = new Database(dbPath, { readonly: true });
  sqlite.pragma('busy_timeout = 5000');

  // Discover tables to migrate
  const allTables = (
    sqlite.prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name").all() as Array<{ name: string }>
  ).map((t) => t.name);

  const tablesToMigrate = allTables.filter((t) => {
    if (!shouldMigrate(t)) return false;
    if (onlyTable && t !== onlyTable) return false;
    return true;
  });

  if (tablesToMigrate.length === 0) {
    console.log('No tables to migrate.');
    if (onlyTable)
      console.log(
        `Table "${onlyTable}" not found or is operational. Available: ${allTables.filter(shouldMigrate).join(', ')}`,
      );
    sqlite.close();
    return;
  }

  console.log(`\nTables to migrate (${tablesToMigrate.length}): ${tablesToMigrate.join(', ')}`);
  console.log(`Skipped operational: ${allTables.filter(isOperationalTable).join(', ') || '(none)'}\n`);

  // Collect DDL + indexes
  const ddlStatements: Array<{ table: string; createSql: string; indexes: string[]; blobCols: Set<string> }> = [];

  for (const table of tablesToMigrate) {
    const columns = sqlite.prepare(`PRAGMA table_info("${table}")`).all() as ColumnInfo[];
    const blobCols = detectBlobColumns(sqlite, table);
    if (blobCols.size > 0) {
      console.log(`  ${table}: detected BLOB columns: ${[...blobCols].join(', ')}`);
    }
    const createSql = generateCreateTable(table, columns, blobCols);

    // Get indexes for this table
    const sqliteIndexes = sqlite
      .prepare("SELECT sql FROM sqlite_master WHERE type='index' AND tbl_name=? AND sql IS NOT NULL")
      .all(table) as Array<{ sql: string }>;
    const pgIndexes = sqliteIndexes.map((i) => convertIndex(i.sql)).filter((s): s is string => s !== null);

    ddlStatements.push({ table, createSql, indexes: pgIndexes, blobCols });
  }

  if (dryRun) {
    console.log('--- Generated DDL ---\n');
    for (const { table, createSql, indexes } of ddlStatements) {
      const rowCount = (sqlite.prepare(`SELECT COUNT(*) as cnt FROM "${table}"`).get() as { cnt: number }).cnt;
      console.log(`-- ${table} (${rowCount.toLocaleString()} rows)`);
      if (dropTables) console.log(`DROP TABLE IF EXISTS "${table}" CASCADE;`);
      console.log(createSql + ';\n');
      for (const idx of indexes) console.log(idx + ';');
      if (indexes.length > 0) console.log('');
    }
    sqlite.close();
    return;
  }

  // Connect to PostgreSQL
  const pool = new Pool({ connectionString: databaseUrl, ssl: { rejectUnauthorized: false } });
  const client = await pool.connect();

  const totalStart = performance.now();
  const summary: Array<{ table: string; rows: number; elapsed: number }> = [];

  try {
    for (const { table, createSql, indexes, blobCols } of ddlStatements) {
      const tableStart = performance.now();
      console.log(`\n=== ${table} ===`);

      // Create table
      if (dropTables) {
        await client.query(`DROP TABLE IF EXISTS "${table}" CASCADE`);
      }
      await client.query(createSql);
      console.log('  Table created');

      // Get column info for building INSERT
      const columns = sqlite.prepare(`PRAGMA table_info("${table}")`).all() as ColumnInfo[];
      const colNames = columns.filter((c) => !c.pk || mapType(c) !== 'SERIAL PRIMARY KEY').map((c) => c.name);
      const pkCol = columns.find((c) => c.pk && mapType(c) === 'SERIAL PRIMARY KEY');

      // If PK is SERIAL, we need to include it explicitly and set the sequence after
      const insertCols = pkCol ? [pkCol.name, ...colNames] : colNames;

      // Count total rows
      const totalRows = (sqlite.prepare(`SELECT COUNT(*) as cnt FROM "${table}"`).get() as { cnt: number }).cnt;
      console.log(`  Rows: ${totalRows.toLocaleString()}`);

      let migrated = 0;
      let lastId = 0;

      await client.query('BEGIN');

      while (migrated < totalRows) {
        const rows = sqlite
          .prepare(`SELECT * FROM "${table}" WHERE id > ? ORDER BY id LIMIT ?`)
          .all(lastId, BATCH_SIZE) as Record<string, unknown>[];

        if (rows.length === 0) break;

        // Build multi-row INSERT: INSERT INTO t (a,b) VALUES ($1,$2), ($3,$4), ...
        const allValues: unknown[] = [];
        const rowPlaceholders: string[] = [];
        let paramIdx = 1;

        for (const row of rows) {
          const cols: string[] = [];
          for (const col of insertCols) {
            const val = row[col];
            if (val === null || val === undefined) {
              allValues.push(null);
            } else if (Buffer.isBuffer(val)) {
              allValues.push(val);
            } else if (blobCols.has(col) && typeof val === 'string') {
              allValues.push(Buffer.from(val, 'utf-8'));
            } else {
              allValues.push(val);
            }
            cols.push(`$${paramIdx++}`);
          }
          rowPlaceholders.push(`(${cols.join(',')})`);
        }

        const batchInsertSql = `INSERT INTO "${table}" (${insertCols.map((c) => `"${c}"`).join(',')}) VALUES ${rowPlaceholders.join(',')}`;
        await client.query(batchInsertSql, allValues);

        migrated += rows.length;
        lastId = rows[rows.length - 1].id as number;

        const elapsed = (performance.now() - tableStart) / 1000;
        const rate = migrated / elapsed;
        const eta = totalRows > migrated ? ((totalRows - migrated) / rate).toFixed(0) : '0';
        process.stdout.write(
          `\r  ${migrated.toLocaleString()} / ${totalRows.toLocaleString()} (${rate.toFixed(0)}/s, ETA: ${eta}s)`,
        );
      }

      await client.query('COMMIT');
      console.log('');

      // Fix SERIAL sequence to max(id) so next insert gets correct value
      if (pkCol) {
        await client.query(
          `SELECT setval(pg_get_serial_sequence('"${table}"', '${pkCol.name}'), COALESCE((SELECT MAX("${pkCol.name}") FROM "${table}"), 0))`,
        );
      }

      // Create indexes
      for (const idx of indexes) {
        await client.query(idx);
      }
      if (indexes.length > 0) console.log(`  ${indexes.length} indexes created`);

      const tableElapsed = (performance.now() - tableStart) / 1000;
      summary.push({ table, rows: migrated, elapsed: tableElapsed });
      console.log(`  Done (${tableElapsed.toFixed(1)}s)`);
    }

    // ANALYZE
    console.log('\nRunning ANALYZE...');
    for (const { table } of ddlStatements) {
      await client.query(`ANALYZE "${table}"`);
    }
    console.log('ANALYZE done');
  } finally {
    client.release();
    await pool.end();
    sqlite.close();
  }

  const totalElapsed = (performance.now() - totalStart) / 1000;
  console.log(`\n${'='.repeat(50)}`);
  console.log('Summary:');
  for (const { table, rows, elapsed } of summary) {
    console.log(`  ${table}: ${rows.toLocaleString()} rows (${elapsed.toFixed(1)}s)`);
  }
  console.log(
    `\nTotal: ${summary.reduce((s, r) => s + r.rows, 0).toLocaleString()} rows in ${totalElapsed.toFixed(1)}s`,
  );
}

main().catch((e) => {
  console.error('Migration failed:', e.message);
  process.exit(1);
});
