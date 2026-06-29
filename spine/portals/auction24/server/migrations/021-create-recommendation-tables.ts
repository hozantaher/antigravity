import { type Kysely, sql } from 'kysely'

// Recommendation engine storage (docs/recommendation-algorithm.md §4): one append-only
// event log + four precompute tables refreshed by the build-recommendations cron.
// item_id/category_id are soft references (no FK) so rollups survive item deletion.

export const up = async (db: Kysely<unknown>): Promise<void> => {
  // §4.1 — append-only event log. PK (id) is the client UUID = idempotency key.
  await db.schema
    .createTable('recommendation_events')
    .addColumn('id', 'text', col => col.primaryKey())
    .addColumn('vid', 'text', col => col.notNull())
    .addColumn('user_id', 'text')
    .addColumn('session_id', 'text')
    .addColumn('type', 'text', col => col.notNull())
    .addColumn('item_id', 'text')
    .addColumn('category_id', 'text')
    .addColumn('value', sql`numeric(20, 4)`)
    .addColumn('surface', 'text')
    .addColumn('position', 'integer')
    .addColumn('propensity', sql`numeric(10, 6)`)
    .addColumn('meta', 'jsonb')
    .addColumn('occurred_at', 'timestamptz', col => col.notNull())
    .addColumn('created_at', 'timestamptz', col => col.notNull().defaultTo(sql`now()`))
    .execute()
  await db.schema
    .createIndex('reco_events_vid_idx')
    .on('recommendation_events')
    .columns(['vid', 'occurred_at'])
    .execute()
  await db.schema
    .createIndex('reco_events_item_idx')
    .on('recommendation_events')
    .columns(['item_id', 'occurred_at'])
    .execute()
  // TTL prune scans by age.
  await db.schema.createIndex('reco_events_occurred_idx').on('recommendation_events').column('occurred_at').execute()
  await sql`
    CREATE INDEX reco_events_user_idx ON recommendation_events (user_id, occurred_at)
    WHERE user_id IS NOT NULL
  `.execute(db)

  // §4.2 — aggregated taste profile per visitor.
  await db.schema
    .createTable('visitor_profiles')
    .addColumn('vid', 'text', col => col.primaryKey())
    .addColumn('user_id', 'text')
    .addColumn('features', 'jsonb', col => col.notNull())
    .addColumn('top_makes', 'jsonb', col => col.notNull().defaultTo(sql`'[]'::jsonb`))
    .addColumn('n_eff', sql`numeric(20, 6)`, col => col.notNull().defaultTo(0))
    .addColumn('alpha', sql`numeric(10, 6)`, col => col.notNull().defaultTo(0))
    .addColumn('last_event_at', 'timestamptz')
    .addColumn('updated_at', 'timestamptz', col => col.notNull().defaultTo(sql`now()`))
    .execute()
  await sql`CREATE INDEX visitor_profiles_user_idx ON visitor_profiles (user_id) WHERE user_id IS NOT NULL`.execute(db)
  await db.schema.createIndex('visitor_profiles_updated_idx').on('visitor_profiles').column('updated_at').execute()

  // §4.3 — item feature vector + popularity.
  await db.schema
    .createTable('item_features')
    .addColumn('item_id', 'text', col => col.primaryKey())
    .addColumn('vector', 'jsonb', col => col.notNull().defaultTo(sql`'{}'::jsonb`))
    .addColumn('pop_score', sql`numeric(20, 6)`, col => col.notNull().defaultTo(0))
    .addColumn('trend_score', sql`numeric(20, 6)`, col => col.notNull().defaultTo(0))
    .addColumn('engagement_sum', sql`numeric(20, 6)`, col => col.notNull().defaultTo(0))
    .addColumn('impression_count', sql`numeric(20, 6)`, col => col.notNull().defaultTo(0))
    .addColumn('distinct_viewers', 'integer', col => col.notNull().defaultTo(0))
    .addColumn('quality_score', sql`numeric(10, 6)`, col => col.notNull().defaultTo(0))
    .addColumn('updated_at', 'timestamptz', col => col.notNull().defaultTo(sql`now()`))
    .execute()
  await db.schema.createIndex('item_features_updated_idx').on('item_features').column('updated_at').execute()

  // §4.4 — collaborative attribute-level co-engagement (top-K neighbors per value).
  await db.schema
    .createTable('attribute_affinity')
    .addColumn('dimension', 'text', col => col.notNull())
    .addColumn('value_a', 'text', col => col.notNull())
    .addColumn('value_b', 'text', col => col.notNull())
    .addColumn('score', sql`numeric(10, 6)`, col => col.notNull())
    .addColumn('updated_at', 'timestamptz', col => col.notNull().defaultTo(sql`now()`))
    .addPrimaryKeyConstraint('attribute_affinity_pk', ['dimension', 'value_a', 'value_b'])
    .execute()
  await sql`CREATE INDEX attribute_affinity_lookup_idx ON attribute_affinity (dimension, value_a, score DESC)`.execute(
    db,
  )

  // §4.5 — popularity "average" per segment (cold start).
  await db.schema
    .createTable('popularity_segments')
    .addColumn('segment_key', 'text', col => col.primaryKey())
    .addColumn('ranking', 'jsonb', col => col.notNull().defaultTo(sql`'[]'::jsonb`))
    .addColumn('updated_at', 'timestamptz', col => col.notNull().defaultTo(sql`now()`))
    .execute()
}

export const down = async (db: Kysely<unknown>): Promise<void> => {
  await db.schema.dropTable('popularity_segments').ifExists().execute()
  await db.schema.dropTable('attribute_affinity').ifExists().execute()
  await db.schema.dropTable('item_features').ifExists().execute()
  await db.schema.dropTable('visitor_profiles').ifExists().execute()
  await db.schema.dropTable('recommendation_events').ifExists().execute()
}
