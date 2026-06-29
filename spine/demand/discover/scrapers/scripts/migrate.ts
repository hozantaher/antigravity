/**
 * Run all SQL migration files in scripts/migrations/ in lexicographic order.
 *
 * Usage:
 *   DATABASE_URL=postgres://... pnpm db:migrate
 */

import { readdir, readFile } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import pg from 'pg';

const DATABASE_URL = process.env.DATABASE_URL;
if (!DATABASE_URL) {
  console.error('Error: DATABASE_URL environment variable is not set.');
  process.exit(1);
}

const MIGRATIONS_DIR = resolve(import.meta.dirname, 'migrations');

const pool = new pg.Pool({ connectionString: DATABASE_URL });

async function run(): Promise<void> {
  const files = (await readdir(MIGRATIONS_DIR))
    .filter((f) => f.endsWith('.sql'))
    .sort();

  if (files.length === 0) {
    console.log('No migration files found in', MIGRATIONS_DIR);
    return;
  }

  const client = await pool.connect();
  try {
    for (const file of files) {
      const filePath = join(MIGRATIONS_DIR, file);
      const sql = await readFile(filePath, 'utf8');
      console.log(`Running migration: ${file}`);
      await client.query(sql);
      console.log(`  ✓ ${file}`);
    }
    console.log('All migrations completed successfully.');
  } finally {
    client.release();
    await pool.end();
  }
}

run().catch((err: unknown) => {
  console.error('Migration failed:', err);
  process.exit(1);
});
