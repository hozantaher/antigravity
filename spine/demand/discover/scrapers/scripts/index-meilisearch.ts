/**
 * Index judikaty_decisions and esbirka_acts from PostgreSQL into Typesense.
 *
 * Uses Typesense's JSONL import (multi-threaded on server, much faster than
 * Meilisearch's single-threaded indexer).
 *
 * Usage:
 *   DATABASE_URL=... TYPESENSE_URL=... TYPESENSE_API_KEY=... npx tsx scripts/index-meilisearch.ts
 *   ... --index=judikaty_decisions
 */

import pg from 'pg';
import Typesense from 'typesense';
import { parseArgs } from 'util';
import { SEARCH_INDEXES, getPgSelectColumns, createSearchClient, type SearchIndexConfig } from '../lib/meilisearch.js';
import { tryGunzip } from '../lib/utils.js';

const { Pool } = pg;
const BATCH_SIZE = 5000;

const { values } = parseArgs({
  args: process.argv.slice(2).filter((a) => a !== '--'),
  options: { index: { type: 'string' } },
  strict: false,
});

const onlyIndex = values.index as string | undefined;

async function indexTable(pool: pg.Pool, client: Typesense.Client, collectionName: string, config: SearchIndexConfig) {
  console.log(`\n=== ${collectionName} ===`);

  // Create or recreate collection
  try {
    const existing = await client.collections(collectionName).retrieve();
    if (existing.num_documents === 0) {
      // Empty — drop and recreate with latest schema
      await client.collections(collectionName).delete();
      throw new Error('recreate');
    }
    console.log(`  Collection exists: ${existing.num_documents?.toLocaleString()} docs`);
  } catch {
    await client.collections().create({
      name: collectionName,
      fields: config.fields,
      enable_nested_fields: false,
    });
    console.log('  Collection created');
  }

  const {
    rows: [{ count }],
  } = await pool.query<{ count: string }>(`SELECT COUNT(*) as count FROM "${collectionName}"`);
  const totalRows = parseInt(count, 10);
  console.log(`  PG rows: ${totalRows.toLocaleString()}`);

  const pgColumns = getPgSelectColumns(config);
  // Always include id for cursor pagination and Typesense document id
  if (!pgColumns.includes('id')) pgColumns.unshift('id');
  const selectCols = pgColumns.map((c) => `"${c}"`).join(', ');
  let lastId = 0;
  let sent = 0;
  let imported = 0;
  const start = performance.now();

  while (sent < totalRows) {
    const { rows } = await pool.query(
      `SELECT ${selectCols} FROM "${collectionName}" WHERE id > $1 ORDER BY id LIMIT $2`,
      [lastId, BATCH_SIZE],
    );
    if (rows.length === 0) break;

    // Build documents — decompress gzip, convert Buffers to strings, null → ''
    const documents = (rows as Record<string, unknown>[]).map((row) => {
      // Typesense requires `id` as string
      const doc: Record<string, unknown> = { id: String(row.id) };
      for (const col of pgColumns) {
        if (col === 'id') continue;
        const val = row[col];
        if (val === null || val === undefined) {
          doc[col] = '';
        } else if (config.compressedColumns.includes(col)) {
          doc[col] = tryGunzip(val) ?? (val instanceof Buffer ? val.toString('utf-8') : val);
        } else if (val instanceof Buffer) {
          doc[col] = val.toString('utf-8');
        } else {
          doc[col] = val;
        }
      }
      return doc;
    });

    // JSONL import — Typesense processes in parallel on all cores
    const jsonl = documents.map((d) => JSON.stringify(d)).join('\n');
    const results = await client.collections(collectionName).documents().import(jsonl, {
      action: 'upsert',
    });

    // Count successes and log first error
    const resultLines = typeof results === 'string' ? results.split('\n') : results;
    let batchImported = 0;
    let firstError: string | null = null;
    for (const r of resultLines as any[]) {
      const parsed = typeof r === 'string' ? JSON.parse(r) : r;
      if (parsed.success) {
        batchImported++;
      } else if (!firstError) {
        firstError = JSON.stringify(parsed);
      }
    }
    if (firstError && sent === 0) {
      console.log(`\n  First import error: ${firstError}`);
    }

    lastId = (rows[rows.length - 1] as Record<string, unknown>).id as number;
    sent += rows.length;
    imported += batchImported;

    const elapsed = (performance.now() - start) / 1000;
    const rate = sent / elapsed;
    const eta = totalRows > sent ? ((totalRows - sent) / rate).toFixed(0) : '0';
    process.stdout.write(
      `\r  ${sent.toLocaleString()} / ${totalRows.toLocaleString()} (${rate.toFixed(0)}/s, ETA: ${eta}s)`,
    );
  }

  console.log('');
  const collection = await client.collections(collectionName).retrieve();
  console.log(
    `  Typesense: ${collection.num_documents?.toLocaleString()} docs (${imported.toLocaleString()} imported this run)`,
  );
  console.log(`  Done (${((performance.now() - start) / 1000).toFixed(1)}s)`);

  return sent;
}

async function main() {
  console.log('Typesense Indexer');

  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) {
    console.error('DATABASE_URL is required');
    process.exit(1);
  }

  const client = createSearchClient();
  if (!client) {
    console.error('TYPESENSE_URL and TYPESENSE_API_KEY are required');
    process.exit(1);
  }

  // Health check
  const health = await client.health.retrieve();
  console.log(`Typesense: ${process.env.TYPESENSE_URL || process.env.MEILI_URL} (ok: ${health.ok})`);

  const pool = new Pool({ connectionString: databaseUrl, ssl: { rejectUnauthorized: false } });

  const indexEntries = Object.entries(SEARCH_INDEXES).filter(([name]) => !onlyIndex || name === onlyIndex);

  if (indexEntries.length === 0) {
    console.error(`Index "${onlyIndex}" not found. Available: ${Object.keys(SEARCH_INDEXES).join(', ')}`);
    process.exit(1);
  }

  const totalStart = performance.now();
  let totalDocs = 0;

  for (const [name, config] of indexEntries) {
    totalDocs += await indexTable(pool, client, name, config);
  }

  await pool.end();

  console.log(`\n${'='.repeat(50)}`);
  console.log(`Total: ${totalDocs.toLocaleString()} rows in ${((performance.now() - totalStart) / 1000).toFixed(1)}s`);
}

main().catch((e) => {
  console.error('Indexing failed:', e.message);
  process.exit(1);
});
