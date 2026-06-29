/**
 * DNS audit surface — operator visibility into SPF/DKIM/DMARC state
 * Sprint N2 — validates own-domain migration readiness + ongoing delegation
 *
 * GET /api/dns-audit — returns cached audit result or forces refresh
 */

import { exec } from 'node:child_process';
import { promisify } from 'node:util';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const execAsync = promisify(exec);

// HARD feedback_no_magic_thresholds: DNS audit cache TTL as named constant
const DNS_AUDIT_CACHE_TTL_MS = 24 * 60 * 60 * 1000; // 24 hours

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const scriptPath = path.resolve(__dirname, '../../../scripts/dns-audit/check-all-domains.js');

/**
 * Run DNS audit script as subprocess
 */
async function runDnsAuditScript(dbConnStr) {
  const { stdout, stderr } = await execAsync(`node "${scriptPath}" "${dbConnStr}"`, {
    maxBuffer: 10 * 1024 * 1024, // 10MB for large audit results
    timeout: 120 * 1000 // 2 minute timeout for full audit
  });

  if (stderr && !stderr.includes('Warning')) {
    throw new Error(`Script error: ${stderr}`);
  }

  return JSON.parse(stdout);
}

/**
 * Check cache and return or refresh
 */
async function getDnsAuditResult(db, forceRefresh = false) {
  const cacheKey = 'dns_audit_last_result';
  const timestampKey = 'dns_audit_last_run';

  // Check cache validity
  if (!forceRefresh) {
    const cached = await db.query(
      `SELECT value FROM operator_settings WHERE key = $1`,
      [cacheKey]
    );
    const timestamp = await db.query(
      `SELECT value FROM operator_settings WHERE key = $1`,
      [timestampKey]
    );

    if (cached.rows.length && timestamp.rows.length) {
      const lastRun = parseInt(timestamp.rows[0].value);
      const now = Date.now();
      if (now - lastRun < DNS_AUDIT_CACHE_TTL_MS) {
        return { result: JSON.parse(cached.rows[0].value), fromCache: true };
      }
    }
  }

  // Run fresh audit
  const dbConnStr = process.env.DATABASE_URL;
  if (!dbConnStr) {
    throw new Error('DATABASE_URL not configured');
  }

  const result = await runDnsAuditScript(dbConnStr);
  const now = Date.now();

  // Update cache in operator_settings
  await db.query(
    `INSERT INTO operator_settings (key, value, updated_at)
     VALUES ($1, $2, NOW())
     ON CONFLICT (key) DO UPDATE SET value = $2, updated_at = NOW()`,
    [cacheKey, JSON.stringify(result)]
  );

  await db.query(
    `INSERT INTO operator_settings (key, value, updated_at)
     VALUES ($1, $2, NOW())
     ON CONFLICT (key) DO UPDATE SET value = $2, updated_at = NOW()`,
    [timestampKey, now.toString()]
  );

  return { result, fromCache: false };
}

export function mountDnsAuditRoutes(app, deps) {
  /**
   * GET /api/dns-audit — retrieve cached or fresh DNS audit results
   * Query params:
   *   - force=true: bypass cache and run fresh audit
   */
  app.get('/api/dns-audit', async (req, res) => {
    try {
      const forceRefresh = req.query.force === 'true';
      const { result, fromCache } = await getDnsAuditResult(deps.db, forceRefresh);

      res.json({
        success: true,
        data: result,
        cached: fromCache,
        timestamp: new Date().toISOString()
      });
    } catch (error) {
      console.error('[dnsAudit] error:', error.message);
      res.status(500).json({
        success: false,
        error: error.message
      });
    }
  });
}
