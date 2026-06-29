import Database from 'better-sqlite3';
import { readdirSync, statSync } from 'fs';
import { resolve } from 'path';
import { gunzipSync } from 'zlib';

const DATA_DIR = resolve('data');

interface ColumnInfo {
  name: string;
  type: string;
}

interface TableInfo {
  name: string;
  columns: ColumnInfo[];
}

/** Get all user tables (excluding sqlite internals and FTS shadow tables) */
function getTables(db: Database.Database): TableInfo[] {
  const tables = db
    .prepare(
      `SELECT name FROM sqlite_master
       WHERE type='table'
       AND name NOT LIKE 'sqlite%'
       AND name NOT LIKE '%_fts%'
       AND name NOT LIKE '%\\_urls' ESCAPE '\\'
       AND name NOT LIKE '%\\_scrape\\_runs' ESCAPE '\\'
       AND name NOT LIKE '%\\_search\\_progress' ESCAPE '\\'
       AND name NOT LIKE '%\\_search\\_segments' ESCAPE '\\'
       AND name NOT IN ('urls', 'scrape_runs', 'search_progress', 'search_segments')`,
    )
    .all() as Array<{ name: string }>;

  return tables.map((t) => {
    const columns = db.prepare(`PRAGMA table_info('${t.name}')`).all() as Array<{ name: string; type: string }>;
    return { name: t.name, columns: columns.map((c) => ({ name: c.name, type: c.type })) };
  });
}

/** Check if a table/index/trigger exists */
function exists(db: Database.Database, name: string): boolean {
  const row = db.prepare(`SELECT 1 FROM sqlite_master WHERE name = ?`).get(name);
  return !!row;
}

/** Identify text columns suitable for FTS indexing */
function getFtsColumns(table: TableInfo): string[] {
  const skip = new Set([
    'id',
    'url',
    'scraped_at',
    'image_urls',
    'image_count',
    'raw_html',
    'raw_specs_json',
    'raw_jsonld',
    'raw_technical_data',
    'raw_key_features',
    'raw_metadata_json',
    'raw_json',
    'relationships_json',
    'categories_json',
    'same_as_json',
    'filters_json',
    'latitude',
    'longitude',
    'price',
    'price_eur',
    'price_eur_original',
    'price_czk',
    'price_currency',
    'rating_value',
    'rating_count',
    'review_count',
    'aggregate_rating',
    'mileage_km',
    'num_owners',
    'num_seats',
    'fragment_count',
    // Large text columns — too big for FTS (would add tens of GB to index)
    'oduvodneni',
    'full_text',
    'description',
    'opening_hours_detail',
    // ID/date columns — not useful for full-text search
    'external_id',
    'ecli',
    'jednaci_cislo',
    'datum_vydani',
    'datum_zverejneni',
    'datum_zapisu',
    'datum_platnosti',
    'datum_zruseni',
    'autoline_id',
    'mascus_id',
    'mobile_id',
    'firmy_id',
    'dealer_id',
    'seller_id',
    'slug',
    'eli',
    'sku',
    'vin',
    'registration_number',
  ]);

  return table.columns
    .filter((c) => {
      if (skip.has(c.name)) return false;
      if (c.type === 'REAL' || c.type === 'INTEGER') return false;
      return true;
    })
    .map((c) => c.name);
}

/** Create FTS5 virtual table + sync triggers */
function createFts(db: Database.Database, table: string, columns: string[]) {
  const ftsName = `${table}_fts`;
  const colList = columns.join(', ');
  const newColList = columns.map((c) => `new.${c}`).join(', ');
  const oldColList = columns.map((c) => `old.${c}`).join(', ');

  // FTS table
  if (exists(db, ftsName)) {
    console.log(`    SKIP ${ftsName} (already exists)`);
  } else {
    console.log(`    Creating ${ftsName} (${columns.length} columns)...`);
    const start = performance.now();
    db.exec(`
      CREATE VIRTUAL TABLE ${ftsName} USING fts5(
        ${colList},
        content='${table}',
        content_rowid='id',
        tokenize='unicode61'
      );
      INSERT INTO ${ftsName}(${ftsName}) VALUES('rebuild');
    `);
    console.log(`    OK (${(performance.now() - start).toFixed(0)} ms)`);
  }

  // Insert trigger
  const insertTrigger = `${table}_fts_insert`;
  if (!exists(db, insertTrigger)) {
    db.exec(`
      CREATE TRIGGER ${insertTrigger} AFTER INSERT ON ${table} BEGIN
        INSERT INTO ${ftsName}(rowid, ${colList}) VALUES (new.id, ${newColList});
      END;
    `);
    console.log(`    + trigger: ${insertTrigger}`);
  }

  // Delete trigger
  const deleteTrigger = `${table}_fts_delete`;
  if (!exists(db, deleteTrigger)) {
    db.exec(`
      CREATE TRIGGER ${deleteTrigger} AFTER DELETE ON ${table} BEGIN
        INSERT INTO ${ftsName}(${ftsName}, rowid, ${colList}) VALUES ('delete', old.id, ${oldColList});
      END;
    `);
    console.log(`    + trigger: ${deleteTrigger}`);
  }

  // Update trigger
  const updateTrigger = `${table}_fts_update`;
  if (!exists(db, updateTrigger)) {
    db.exec(`
      CREATE TRIGGER ${updateTrigger} AFTER UPDATE ON ${table} BEGIN
        INSERT INTO ${ftsName}(${ftsName}, rowid, ${colList}) VALUES ('delete', old.id, ${oldColList});
        INSERT INTO ${ftsName}(rowid, ${colList}) VALUES (new.id, ${newColList});
      END;
    `);
    console.log(`    + trigger: ${updateTrigger}`);
  }
}

/** Create contentless FTS5 index for gzip-compressed text columns (e.g. oduvodneni).
 *  Data is decompressed row-by-row during population. No triggers — rebuild needed after data changes. */
function createCompressedFts(db: Database.Database, table: string, columns: string[]) {
  const ftsName = `${table}_fulltext_fts`;

  if (exists(db, ftsName)) {
    console.log(`    SKIP ${ftsName} (already exists)`);
    return;
  }

  // Verify columns exist and have data
  const hasData = db
    .prepare(`SELECT COUNT(*) as cnt FROM "${table}" WHERE "${columns[0]}" IS NOT NULL LIMIT 1`)
    .get() as { cnt: number };
  if (hasData.cnt === 0) {
    console.log(`    SKIP ${ftsName} (no data in ${columns[0]})`);
    return;
  }

  console.log(`    Creating ${ftsName} (${columns.join(', ')}) — decompressing gzip...`);
  const start = performance.now();

  // Contentless FTS — no content table link, so snippet() won't work for display
  // but MATCH queries work and return rowids we can join with original table
  db.exec(`
    CREATE VIRTUAL TABLE ${ftsName} USING fts5(
      ${columns.join(', ')},
      content='',
      tokenize='unicode61'
    );
  `);

  // Populate by decompressing each row
  const insertSql = `INSERT INTO ${ftsName}(rowid, ${columns.join(', ')}) VALUES (${['?', ...columns.map(() => '?')].join(', ')})`;
  const insert = db.prepare(insertSql);

  const selectCols = columns.map((c) => `"${c}"`).join(', ');
  const rows = db
    .prepare(`SELECT id, ${selectCols} FROM "${table}" WHERE ${columns.map((c) => `"${c}" IS NOT NULL`).join(' OR ')}`)
    .all() as Record<string, unknown>[];

  let indexed = 0;
  const batch = db.transaction(() => {
    for (const row of rows) {
      const values: (string | null)[] = [];
      for (const col of columns) {
        const val = row[col];
        if (val instanceof Buffer && val.length >= 2 && val[0] === 0x1f && val[1] === 0x8b) {
          try {
            values.push(gunzipSync(val).toString('utf-8'));
          } catch {
            values.push(null);
          }
        } else if (typeof val === 'string') {
          values.push(val);
        } else {
          values.push(null);
        }
      }
      if (values.some((v) => v !== null)) {
        insert.run(row.id, ...values);
        indexed++;
      }
    }
  });
  batch();

  console.log(`    OK — ${indexed.toLocaleString()} rows indexed (${(performance.now() - start).toFixed(0)} ms)`);
}

/** Add useful indexes based on column names */
function addIndexes(db: Database.Database, table: string, columns: ColumnInfo[]) {
  const indexable = new Set([
    'source',
    'citace',
    'ico',
    'firmy_id',
    'category',
    'brand',
    'location_country',
    'address_locality',
    'mobile_id',
    'url_type',
    'eli',
    'spisova_znacka',
    'jednaci_cislo',
  ]);

  for (const col of columns) {
    if (indexable.has(col.name)) {
      const idxName = `idx_${table}_${col.name}`;
      if (!exists(db, idxName)) {
        console.log(`    + index: ${idxName}`);
        db.exec(`CREATE INDEX IF NOT EXISTS ${idxName} ON ${table}(${col.name});`);
      }
    }
  }

  // Composite index: source + id (for filtered pagination)
  if (columns.some((c) => c.name === 'source')) {
    const idxName = `idx_${table}_source_id`;
    if (!exists(db, idxName)) {
      console.log(`    + index: ${idxName}`);
      db.exec(`CREATE INDEX IF NOT EXISTS ${idxName} ON ${table}(source, id);`);
    }
  }
}

/** Apply PRAGMA optimizations (for this connection — FTS rebuild benefits) */
function applyPragmas(db: Database.Database, dbSize: number) {
  const mmapSize = Math.min(Math.floor(dbSize * 0.25), 2 * 1024 * 1024 * 1024);
  db.pragma(`mmap_size = ${mmapSize}`);
  db.pragma('cache_size = -64000');
  db.pragma('analysis_limit = 1000');
  console.log(`    mmap_size=${(mmapSize / 1024 / 1024).toFixed(0)} MB, cache=64 MB, analysis_limit=1000`);
}

// --- Main ---

function main() {
  console.log('SQLite Performance Optimization\n');

  const dbFiles = readdirSync(DATA_DIR).filter((f) => f.endsWith('.db'));

  if (dbFiles.length === 0) {
    console.log('No .db files found in data/');
    return;
  }

  console.log(`Found ${dbFiles.length} databases: ${dbFiles.join(', ')}\n`);

  for (const dbFile of dbFiles) {
    const dbPath = resolve(DATA_DIR, dbFile);
    console.log(`\n=== ${dbFile} ===`);

    try {
      const db = new Database(dbPath);
      db.pragma('journal_mode = WAL');

      const stat = statSync(dbPath).size;

      console.log(`  Size: ${(stat / 1024 / 1024).toFixed(0)} MB`);

      // PRAGMAs
      console.log('  Pragmas:');
      applyPragmas(db, stat);

      // Tables
      const tables = getTables(db);
      console.log(`  Tables: ${tables.map((t) => `${t.name} (${t.columns.length} cols)`).join(', ')}`);

      for (const table of tables) {
        console.log(`\n  [${table.name}]`);

        // Indexes
        addIndexes(db, table.name, table.columns);

        // FTS5
        const ftsColumns = getFtsColumns(table);
        if (ftsColumns.length >= 2) {
          createFts(db, table.name, ftsColumns);
        } else {
          console.log(`    FTS: skipped (only ${ftsColumns.length} text columns)`);
        }

        // FTS5 for compressed large text columns (oduvodneni, full_text)
        const compressedCols = table.columns
          .filter((c) => ['oduvodneni', 'full_text'].includes(c.name))
          .map((c) => c.name);
        if (compressedCols.length > 0) {
          createCompressedFts(db, table.name, compressedCols);
        }
      }

      // Run ANALYZE for query planner
      console.log(`\n  Running ANALYZE...`);
      const start = performance.now();
      db.exec('ANALYZE;');
      console.log(`  ANALYZE done (${(performance.now() - start).toFixed(0)} ms)`);

      db.close();
    } catch (e) {
      console.error(`  ERROR: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  console.log('\n\nDone! FTS5 tables created as <table>_fts.');
  console.log('Query examples:');
  console.log("  SELECT * FROM listings_fts WHERE listings_fts MATCH 'caterpillar excavator' LIMIT 10;");
  console.log("  SELECT * FROM decisions_fts WHERE decisions_fts MATCH 'odpovědnost AND škoda' LIMIT 10;");
  console.log("  SELECT * FROM acts_fts WHERE acts_fts MATCH 'zprostředkov*' LIMIT 10;");
  console.log("  SELECT * FROM businesses_fts WHERE businesses_fts MATCH 'restaurace Praha' LIMIT 10;");
}

main();
