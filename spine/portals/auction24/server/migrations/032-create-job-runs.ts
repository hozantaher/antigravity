import { type Kysely, sql } from 'kysely'

// Per-run history of scheduled jobs (crons). Powers /admin/ops: an operator can see when each
// job last ran, whether it succeeded, and its result counts — so a silent failure (expired Fio
// token, stuck auction close) is visible instead of invisible. Append-only.
export const up = async (db: Kysely<unknown>): Promise<void> => {
  await db.schema
    .createTable('job_runs')
    .addColumn('id', 'bigserial', col => col.primaryKey())
    .addColumn('job', 'text', col => col.notNull())
    .addColumn('started_at', 'timestamptz', col => col.notNull().defaultTo(sql`now()`))
    .addColumn('finished_at', 'timestamptz')
    // null until finished; true/false once the job returns or throws.
    .addColumn('ok', 'boolean')
    // The job's result struct (counts) as jsonb; null on failure.
    .addColumn('counts', 'jsonb')
    .addColumn('error', 'text')
    .execute()

  // /admin/ops reads the latest run per job, newest first.
  await db.schema.createIndex('job_runs_job_started_idx').on('job_runs').columns(['job', 'started_at desc']).execute()
}

export const down = async (db: Kysely<unknown>): Promise<void> => {
  await db.schema.dropTable('job_runs').ifExists().execute()
}
