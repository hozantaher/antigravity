// segment-apply-priority.integration.test.js
//
// Real-Postgres regression guard for POST /api/campaigns/:id/segment/apply.
//
// WHY a real PG (not the mocked-pool contract tests, not pg-mem): the enroll
// INSERT + prune DELETE join `companies co ON co.ico = c.ico`. A historical bug
// joined on `c.company_ico` — a column contacts does NOT have — so the endpoint
// 500'd against the real schema on every call. Contract tests mock the pool, so
// the bad SQL never executed and the bug reached PROD. pg-mem can't run the route
// either (no `DELETE FROM tbl alias` support). A throwaway Postgres container runs
// the actual route SQL, so any join to a nonexistent contacts column fails loudly
// here. Also asserts insert-time machinery priority (enrolled rows carry
// compute_machinery_score(category_path), not the bare DEFAULT 0).
//
// Skips cleanly when Docker / testcontainers is unavailable (describe.skipIf).
// Locally needs DOCKER_HOST + TESTCONTAINERS_RYUK_DISABLED for colima/non-default
// runtimes; CI (dashboard-real-backend.yml) provides the runtime.

import { fileURLToPath } from 'node:url'
import { dirname } from 'node:path'
import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest'
import express from 'express'
import request from 'supertest'
import { startPostgres } from './_setup/postgres-container'
import { mountCategoryTreeRoutes } from '../../src/server-routes/categoryTree.js'

// Bare DB: point migrationsDir at this test's own folder (no .sql files) so the
// helper applies zero repo migrations — we create exactly the columns the route
// touches below, doubling as living documentation of the segment-apply contract.
const HERE = dirname(fileURLToPath(import.meta.url))
const ctx = await startPostgres({ migrationsDir: HERE, skipAuditShim: true })

describe.skipIf(!ctx)('segment-apply enroll/prune against real Postgres', () => {
  let app
  let pool

  beforeAll(async () => {
    pool = ctx.pool
    await pool.query(`
      CREATE TABLE IF NOT EXISTS companies (ico text PRIMARY KEY, category_path text);
      CREATE TABLE IF NOT EXISTS contacts (
        id bigint PRIMARY KEY, ico text, category_path text, email text);
      CREATE TABLE IF NOT EXISTS campaigns (
        id integer PRIMARY KEY, name text, status text, category_paths text);
      CREATE TABLE IF NOT EXISTS campaign_contacts (
        id serial PRIMARY KEY, campaign_id integer, contact_id bigint, status text,
        current_step integer, next_send_at timestamptz, priority real DEFAULT 0,
        details jsonb, created_at timestamptz DEFAULT now(), updated_at timestamptz DEFAULT now());
      CREATE TABLE IF NOT EXISTS category_tree (path text PRIMARY KEY, included boolean DEFAULT false);
      CREATE TABLE IF NOT EXISTS outreach_suppressions (email text);
      CREATE TABLE IF NOT EXISTS suppression_list (email text);
      CREATE TABLE IF NOT EXISTS operator_audit_log (
        id serial PRIMARY KEY, action text, actor text, entity_type text,
        entity_id bigint, details jsonb, created_at timestamptz DEFAULT now());
    `)
    // Stub scorer (this test validates the query wiring, not scorer branch logic).
    await pool.query(`
      CREATE OR REPLACE FUNCTION compute_machinery_score(p text) RETURNS real AS $$
        SELECT CASE WHEN p LIKE '%Stavebni-firmy%' THEN 0.80::real ELSE 0.50::real END
      $$ LANGUAGE sql IMMUTABLE;`)
    // Static fixtures: a high-machinery contact and a non-matching one.
    await pool.query(`INSERT INTO companies (ico, category_path) VALUES
      ('111','Root > Stavebni-firmy'),('222','Root > Salon') ON CONFLICT DO NOTHING`)
    await pool.query(`INSERT INTO contacts (id, ico, category_path, email) VALUES
      (1,'111','Root > Stavebni-firmy','a@example.com'),
      (2,'222','Root > Salon','b@example.com') ON CONFLICT DO NOTHING`)
    await pool.query(`INSERT INTO campaigns (id, name, status) VALUES (1,'t','draft') ON CONFLICT DO NOTHING`)

    app = express()
    app.use(express.json())
    mountCategoryTreeRoutes(app, {
      pool,
      capture500: (res, e) => res.status(500).json({ error: String(e?.message || e) }),
      safeError: (e) => String(e?.message || e),
    })
  })

  beforeEach(async () => {
    // Per-test isolation: clear enrollments + reset the tree selection to base.
    await pool.query(`TRUNCATE campaign_contacts`)
    await pool.query(`DELETE FROM category_tree`)
    await pool.query(`INSERT INTO category_tree (path, included) VALUES ('Root > Stavebni-firmy', true)`)
  })

  afterAll(async () => { await ctx?.cleanup?.() })

  it('enrolls only matched contacts, each with insert-time machinery priority', async () => {
    const r = await request(app).post('/api/campaigns/1/segment/apply').send({ source: 'category_tree' })
    expect(r.status, JSON.stringify(r.body)).toBe(200)
    const { rows } = await pool.query(`SELECT contact_id, priority FROM campaign_contacts WHERE campaign_id=1 ORDER BY contact_id`)
    expect(rows.map(x => Number(x.contact_id))).toEqual([1])     // Salon (222) excluded
    expect(Number(rows[0].priority)).toBeCloseTo(0.8, 5)         // insert-time score, not DEFAULT 0
  })

  it('prune drops pristine-pending rows whose company no longer matches the selection', async () => {
    await request(app).post('/api/campaigns/1/segment/apply').send({ source: 'category_tree' })
    // Re-scope to a disjoint path → contact 1 must be pruned, contact 2 enrolled.
    await pool.query(`UPDATE category_tree SET included=false WHERE path='Root > Stavebni-firmy'`)
    await pool.query(`INSERT INTO category_tree (path, included) VALUES ('Root > Salon', true)`)
    const r = await request(app).post('/api/campaigns/1/segment/apply').send({ source: 'category_tree' })
    expect(r.status, JSON.stringify(r.body)).toBe(200)
    const { rows } = await pool.query(`SELECT contact_id, priority FROM campaign_contacts WHERE campaign_id=1 ORDER BY contact_id`)
    expect(rows.map(x => Number(x.contact_id))).toEqual([2])
    expect(Number(rows[0].priority)).toBeCloseTo(0.5, 5)
  })
})
