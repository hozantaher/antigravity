import Database from 'better-sqlite3';
import { readdirSync, statSync } from 'fs';
import { gzipSync } from 'zlib';
import { resolve } from 'path';

const DATA_DIR = resolve('data');
const BATCH_SIZE = 500;

/** Columns to compress per table suffix. Matches both prefixed and unprefixed names. */
const COMPRESS_COLUMNS_BY_SUFFIX: Record<string, string[]> = {
  businesses: ['raw_html', 'raw_jsonld'],
  decisions: ['raw_json', 'oduvodneni'],
  listings: ['raw_jsonld', 'raw_specs_json', 'raw_technical_data', 'raw_key_features'],
  acts: ['raw_metadata_json'],
};

/** Get compress columns for a table (matches by suffix: firmy_cz_businesses → businesses) */
function getCompressColumns(tableName: string): string[] | undefined {
  for (const [suffix, columns] of Object.entries(COMPRESS_COLUMNS_BY_SUFFIX)) {
    if (tableName === suffix || tableName.endsWith('_' + suffix)) {
      return columns;
    }
  }
  return undefined;
}

/** Check if a Buffer starts with gzip magic bytes */
function isGzipped(value: unknown): boolean {
  if (value instanceof Buffer) {
    return value.length >= 2 && value[0] === 0x1f && value[1] === 0x8b;
  }
  return false;
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(0)} MB`;
  return `${(bytes / 1024 / 1024 / 1024).toFixed(1)} GB`;
}

function compressColumn(
  db: Database.Database,
  table: string,
  column: string,
): { compressed: number; skipped: number; savedBytes: number } {
  // Check if table and column exist
  const tableExists = db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(table);
  if (!tableExists) return { compressed: 0, skipped: 0, savedBytes: 0 };

  const colExists = (db.prepare(`PRAGMA table_info('${table}')`).all() as Array<{ name: string }>).some(
    (c) => c.name === column,
  );
  if (!colExists) return { compressed: 0, skipped: 0, savedBytes: 0 };

  // Count rows with non-null, non-gzipped data
  const total = (
    db.prepare(`SELECT COUNT(*) as cnt FROM ${table} WHERE ${column} IS NOT NULL`).get() as { cnt: number }
  ).cnt;

  if (total === 0) return { compressed: 0, skipped: 0, savedBytes: 0 };

  const update = db.prepare(`UPDATE ${table} SET ${column} = ? WHERE id = ?`);

  let compressed = 0;
  let skipped = 0;
  let savedBytes = 0;
  let offset = 0;

  while (offset < total) {
    const rows = db
      .prepare(`SELECT id, ${column} FROM ${table} WHERE ${column} IS NOT NULL LIMIT ? OFFSET ?`)
      .all(BATCH_SIZE, offset) as Array<{ id: number; [key: string]: unknown }>;

    if (rows.length === 0) break;

    const batchUpdate = db.transaction(() => {
      for (const row of rows) {
        const value = row[column];

        // Skip already gzipped
        if (isGzipped(value)) {
          skipped++;
          continue;
        }

        // Skip non-string values
        if (typeof value !== 'string') {
          skipped++;
          continue;
        }

        const original = Buffer.byteLength(value, 'utf-8');
        const gz = gzipSync(value, { level: 6 });

        // Only store compressed if it's actually smaller
        if (gz.length < original) {
          update.run(gz, row.id);
          savedBytes += original - gz.length;
          compressed++;
        } else {
          skipped++;
        }
      }
    });

    batchUpdate();
    offset += rows.length;

    if (offset % 5000 === 0 || offset >= total) {
      process.stdout.write(
        `\r      ${offset.toLocaleString()} / ${total.toLocaleString()} (${compressed.toLocaleString()} compressed, saved ${formatBytes(savedBytes)})`,
      );
    }
  }

  if (total > 0) console.log('');

  return { compressed, skipped, savedBytes };
}

function main() {
  console.log('SQLite Raw Column Compression\n');

  const dbFiles = readdirSync(DATA_DIR).filter((f) => f.endsWith('.db'));
  if (dbFiles.length === 0) {
    console.log('No .db files found in data/');
    return;
  }

  let totalSaved = 0;

  for (const dbFile of dbFiles) {
    const dbPath = resolve(DATA_DIR, dbFile);
    const sizeBefore = statSync(dbPath).size;
    console.log(`\n=== ${dbFile} (${formatBytes(sizeBefore)}) ===`);

    const db = new Database(dbPath);
    db.pragma('journal_mode = WAL');
    db.pragma('cache_size = -64000');

    // Disable FTS triggers during compression to avoid errors
    // (raw_* columns are not in FTS indexes, but UPDATE triggers fire on any column change)
    const triggers = db
      .prepare("SELECT name, sql FROM sqlite_master WHERE type='trigger' AND name LIKE '%_fts_%'")
      .all() as Array<{
      name: string;
      sql: string;
    }>;
    if (triggers.length > 0) {
      console.log(`  Disabling ${triggers.length} FTS triggers...`);
      for (const t of triggers) {
        db.exec(`DROP TRIGGER IF EXISTS "${t.name}"`);
      }
    }

    // Find which tables this DB has
    const tables = (
      db
        .prepare(
          "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite%' AND name NOT LIKE '%_fts%'",
        )
        .all() as Array<{ name: string }>
    ).map((t) => t.name);

    let dbSaved = 0;

    for (const table of tables) {
      const columnsToCompress = getCompressColumns(table);
      if (!columnsToCompress) continue;

      for (const column of columnsToCompress) {
        console.log(`  [${table}.${column}]`);
        const result = compressColumn(db, table, column);

        if (result.compressed === 0 && result.skipped === 0) {
          console.log('      (not found or empty)');
        } else {
          console.log(
            `      Done: ${result.compressed.toLocaleString()} compressed, ${result.skipped.toLocaleString()} skipped, saved ${formatBytes(result.savedBytes)}`,
          );
        }

        dbSaved += result.savedBytes;
      }
    }

    // Re-create FTS triggers
    if (triggers.length > 0) {
      console.log(`  Re-creating ${triggers.length} FTS triggers...`);
      for (const t of triggers) {
        try {
          db.exec(t.sql);
        } catch (e) {
          console.error(`    WARNING: Could not recreate trigger ${t.name}: ${(e as Error).message}`);
        }
      }
    }

    if (dbSaved > 0) {
      console.log(`\n  Compressed: saved ${formatBytes(dbSaved)} in data`);

      // VACUUM to reclaim disk space
      const sizeBeforeVacuum = statSync(dbPath).size;
      console.log(`  VACUUM (${formatBytes(sizeBeforeVacuum)})...`);
      const t0 = performance.now();
      db.exec('VACUUM');
      const sizeAfterVacuum = statSync(dbPath).size;
      const vacuumSaved = sizeBeforeVacuum - sizeAfterVacuum;
      console.log(
        `  VACUUM done in ${((performance.now() - t0) / 1000).toFixed(0)}s: ${formatBytes(sizeBeforeVacuum)} → ${formatBytes(sizeAfterVacuum)} (freed ${formatBytes(vacuumSaved)})`,
      );
    }

    db.close();
    totalSaved += dbSaved;
  }

  console.log(`\n${'='.repeat(50)}`);
  console.log(`Total saved: ${formatBytes(totalSaved)} (in data, before VACUUM reclaim)`);
}

main();
