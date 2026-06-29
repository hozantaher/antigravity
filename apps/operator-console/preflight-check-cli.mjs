// Standalone preflight CLI for ops use.
// Usage: node preflight-check-cli.mjs <campaign-id>
//
// Reads DATABASE_URL from env (defaults to local railway proxy) and prints
// the same JSON shape as GET /api/campaigns/:id/preflight.

import pg from 'pg';
import { computeCampaignPreflight } from './campaignPreflight.js';

const { Pool } = pg;
const id = parseInt(process.argv[2] || '0', 10);
if (!id) {
  console.error('Usage: node preflight-check-cli.mjs <campaign-id>');
  process.exit(2);
}
const pool = new Pool({
  connectionString: process.env.DATABASE_URL ||
    'postgresql://outreach:outreach_053ff0c20c74809c@junction.proxy.rlwy.net:54755/outreach?sslmode=disable'
});
try {
  const r = await computeCampaignPreflight(pool, id);
  console.log(JSON.stringify(r, null, 2));
  process.exit(r?.ok ? 0 : 1);
} finally {
  await pool.end();
}
