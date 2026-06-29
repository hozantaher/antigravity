#!/usr/bin/env node
/**
 * DNS audit script for SPF/DKIM/DMARC validation across all sending domains
 * Sprint N2 — validates own-domain migration readiness + ongoing delegation status
 *
 * Usage: node check-all-domains.js <db-connection-string>
 * Output: JSON to stdout with per-domain audit result
 */

import { promises as dns } from 'node:dns';
import pg from 'pg';

const { Client } = pg;

// HARD feedback_no_magic_thresholds: DNS query timeout as named constant
const DNS_QUERY_TIMEOUT_MS = 3000;
const DNS_RETRY_MAX = 3;
const DNS_RETRY_BACKOFF_BASE = 100; // ms

/**
 * Exponential backoff with jitter per feedback_external_io_backoff
 */
function getRetryDelay(attempt) {
  const exponentialDelay = DNS_RETRY_BACKOFF_BASE * Math.pow(2, attempt);
  const jitter = Math.random() * (exponentialDelay * 0.1);
  return exponentialDelay + jitter;
}

/**
 * Query DNS with timeout + retry logic
 */
async function queryDnsWithRetry(resolver, method, name) {
  let lastError;
  for (let attempt = 0; attempt < DNS_RETRY_MAX; attempt++) {
    try {
      const promise = resolver[method](name);
      const timeoutPromise = new Promise((_, reject) =>
        setTimeout(() => reject(new Error('DNS query timeout')), DNS_QUERY_TIMEOUT_MS)
      );
      return await Promise.race([promise, timeoutPromise]);
    } catch (error) {
      lastError = error;
      if (attempt < DNS_RETRY_MAX - 1) {
        await new Promise(resolve => setTimeout(resolve, getRetryDelay(attempt)));
      }
    }
  }
  throw lastError;
}

/**
 * Parse SPF record to determine enforcement level
 */
function parseSPFPolicy(txt) {
  if (!txt) return 'missing';
  const mechanisms = txt.split(' ');
  const hasHardFail = mechanisms.some(m => m.startsWith('-all'));
  const hasSoftFail = mechanisms.some(m => m.startsWith('~all'));
  if (hasHardFail) return 'pass';
  if (hasSoftFail) return 'soft_fail';
  return 'missing';
}

/**
 * Parse DMARC policy
 */
function parseDMARCPolicy(txt) {
  if (!txt) return 'missing';
  const policyMatch = txt.match(/p=([a-z]+)/i);
  if (!policyMatch) return 'missing';
  return policyMatch[1].toLowerCase();
}

/**
 * Audit single domain
 */
async function auditDomain(domain) {
  const resolver = new dns.Resolver();
  const result = {
    domain,
    spf: 'missing',
    dkim_present: false,
    dmarc_policy: 'missing',
    mx_records: [],
    last_checked: new Date().toISOString(),
    errors: []
  };

  try {
    // SPF record (TXT at domain root)
    try {
      const txtRecords = await queryDnsWithRetry(resolver, 'resolveTxt', domain);
      const spfRecord = txtRecords.find(rr => rr[0] && rr.join('').startsWith('v=spf1'));
      if (spfRecord) {
        result.spf = parseSPFPolicy(spfRecord.join(''));
      }
    } catch (error) {
      result.errors.push(`SPF lookup failed: ${error.message}`);
    }

    // DKIM record (default._domainkey.<domain>)
    try {
      const dkimName = `default._domainkey.${domain}`;
      const txtRecords = await queryDnsWithRetry(resolver, 'resolveTxt', dkimName);
      const dkimRecord = txtRecords.find(rr => rr[0] && rr.join('').startsWith('v=DKIM1'));
      result.dkim_present = !!dkimRecord;
    } catch (error) {
      // DKIM missing is not necessarily an error
      result.dkim_present = false;
    }

    // DMARC policy (_dmarc.<domain>)
    try {
      const dmarcName = `_dmarc.${domain}`;
      const txtRecords = await queryDnsWithRetry(resolver, 'resolveTxt', dmarcName);
      const dmarcRecord = txtRecords.find(rr => rr[0] && rr.join('').startsWith('v=DMARC1'));
      if (dmarcRecord) {
        result.dmarc_policy = parseDMARCPolicy(dmarcRecord.join(''));
      }
    } catch (error) {
      result.errors.push(`DMARC lookup failed: ${error.message}`);
    }

    // MX records
    try {
      const mxRecords = await queryDnsWithRetry(resolver, 'resolveMx', domain);
      result.mx_records = mxRecords.map(mx => ({
        exchange: mx.exchange,
        priority: mx.priority
      }));
    } catch (error) {
      result.errors.push(`MX lookup failed: ${error.message}`);
    }
  } catch (error) {
    result.errors.push(`Unexpected error: ${error.message}`);
  }

  return result;
}

/**
 * Main: fetch all domains from DB and audit each
 */
async function main() {
  const dbConnStr = process.argv[2];
  if (!dbConnStr) {
    console.error('Usage: node check-all-domains.js <db-connection-string>');
    process.exit(1);
  }

  const client = new Client({ connectionString: dbConnStr });
  try {
    await client.connect();

    // HARD feedback_no_pii_in_commands: extract domain only, not full email
    const result = await client.query(`
      SELECT DISTINCT LOWER(SUBSTRING(email FROM POSITION('@' IN email) + 1)) AS domain
      FROM outreach_mailboxes
      WHERE email IS NOT NULL AND email != ''
      ORDER BY domain
    `);

    const domains = result.rows.map(r => r.domain);
    const auditResults = [];

    for (const domain of domains) {
      try {
        const auditResult = await auditDomain(domain);
        auditResults.push(auditResult);
      } catch (error) {
        auditResults.push({
          domain,
          spf: 'missing',
          dkim_present: false,
          dmarc_policy: 'missing',
          mx_records: [],
          last_checked: new Date().toISOString(),
          errors: [error.message]
        });
      }
    }

    // Output as JSON for caller to process
    console.log(JSON.stringify(auditResults, null, 2));
  } finally {
    await client.end();
  }
}

main().catch(error => {
  console.error('Fatal error:', error.message);
  process.exit(1);
});
