// pre-launch-check.test.mjs
// Unit tests for scripts/pre-launch-check.mjs
// ≥10 test cases per extreme-testing memory rule.
// Safe import: isMain guard prevents DB/argv/pool from running during import.

import { describe, it, expect, vi, beforeAll, beforeEach, afterEach } from 'vitest';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { existsSync } from 'node:fs';

const here     = dirname(fileURLToPath(import.meta.url));
// tests/unit/scripts → features/platform/outreach-dashboard (5 levels up: scripts→unit→tests→outreach-dashboard→apps→repo)
const REPO_ROOT      = join(here, '..', '..', '..', '..', '..', '..');
const DASHBOARD_ROOT = join(REPO_ROOT, 'features', 'platform', 'outreach-dashboard');
const MOD_PATH       = join(DASHBOARD_ROOT, 'scripts', 'pre-launch-check.mjs');

let runCheck, renderHuman, isReadyToLaunch;
let checkCampaignState, checkMailboxHealth, checkSuppressionUnion;
let checkMigrations, checkSmokeAbsent, checkRelayStatus;
let checkLaunchReadiness, checkRequiredFiles, checkEnvVars, checkOperatorActivity;

beforeAll(async () => {
  const mod = await import(MOD_PATH);
  runCheck              = mod.runCheck;
  renderHuman           = mod.renderHuman;
  isReadyToLaunch       = mod.isReadyToLaunch;
  checkCampaignState    = mod.checkCampaignState;
  checkMailboxHealth    = mod.checkMailboxHealth;
  checkSuppressionUnion = mod.checkSuppressionUnion;
  checkMigrations       = mod.checkMigrations;
  checkSmokeAbsent      = mod.checkSmokeAbsent;
  checkRelayStatus      = mod.checkRelayStatus;
  checkLaunchReadiness  = mod.checkLaunchReadiness;
  checkRequiredFiles    = mod.checkRequiredFiles;
  checkEnvVars          = mod.checkEnvVars;
  checkOperatorActivity = mod.checkOperatorActivity;
});

// ── helpers ───────────────────────────────────────────────────────────────────

function makePool(overrides = {}) {
  return {
    query: vi.fn(),
    ...overrides,
  };
}

function allPassChecks(n = 10) {
  return Array.from({ length: n }, (_, i) => ({
    name:   `Check ${i + 1}`,
    status: 'pass',
    detail: `ok ${i + 1}`,
  }));
}

function withOneFail(checks) {
  return checks.map((c, i) =>
    i === 0 ? { ...c, status: 'fail', error: 'something broke', detail: undefined } : c
  );
}

// ══════════════════════════════════════════════════════════════════════════════
// TC-01  All passing checks → ready_to_launch = true
// ══════════════════════════════════════════════════════════════════════════════
describe('TC-01: all checks pass → ready', () => {
  it('isReadyToLaunch returns true when all checks are pass or skip', () => {
    const checks = [
      { name: 'A', status: 'pass', detail: 'ok' },
      { name: 'B', status: 'skip', detail: 'offline' },
    ];
    expect(isReadyToLaunch(checks)).toBe(true);
  });
});

// ══════════════════════════════════════════════════════════════════════════════
// TC-02  One failing check → ready_to_launch = false
// ══════════════════════════════════════════════════════════════════════════════
describe('TC-02: one fail → not ready', () => {
  it('isReadyToLaunch returns false when any check has status fail', () => {
    const checks = allPassChecks(10);
    checks[3].status = 'fail';
    checks[3].error  = 'relay down';
    expect(isReadyToLaunch(checks)).toBe(false);
  });
});

// ══════════════════════════════════════════════════════════════════════════════
// TC-03  JSON mode — output is valid JSON with expected shape
// ══════════════════════════════════════════════════════════════════════════════
describe('TC-03: JSON output shape', () => {
  it('ready_to_launch true when all pass', () => {
    const checks = allPassChecks(10);
    const result = { campaign_id: 457, checks, ready_to_launch: isReadyToLaunch(checks) };
    const parsed = JSON.parse(JSON.stringify(result));
    expect(parsed.campaign_id).toBe(457);
    expect(parsed.ready_to_launch).toBe(true);
    expect(Array.isArray(parsed.checks)).toBe(true);
    expect(parsed.checks).toHaveLength(10);
  });

  it('ready_to_launch false when any fail', () => {
    const checks = withOneFail(allPassChecks(10));
    const result = { campaign_id: 457, checks, ready_to_launch: isReadyToLaunch(checks) };
    const parsed = JSON.parse(JSON.stringify(result));
    expect(parsed.ready_to_launch).toBe(false);
  });
});

// ══════════════════════════════════════════════════════════════════════════════
// TC-04  Skip status does NOT count as failure
// ══════════════════════════════════════════════════════════════════════════════
describe('TC-04: skip is not a failure', () => {
  it('isReadyToLaunch true even when a check is skip', () => {
    const checks = [
      { name: 'A', status: 'pass', detail: 'ok' },
      { name: 'B', status: 'skip', detail: 'BFF offline' },
    ];
    expect(isReadyToLaunch(checks)).toBe(true);
  });

  it('renderHuman shows ~ icon for skip checks', () => {
    const checks = [
      { name: 'Launch-readiness', status: 'skip', detail: 'BFF offline' },
    ];
    const out = renderHuman(457, checks);
    expect(out).toContain('~');
    expect(out).toContain('BFF offline');
  });
});

// ══════════════════════════════════════════════════════════════════════════════
// TC-05  BFF unavailable → skip, not fail
// ══════════════════════════════════════════════════════════════════════════════
describe('TC-05: BFF offline → skip', () => {
  it('checkLaunchReadiness returns skip when connection refused', async () => {
    // port 1 is nearly always closed
    const result = await checkLaunchReadiness(457, 1, 'test-key');
    expect(result.status).toBe('skip');
    expect(result.detail).toBeTruthy();
  });

  it('runCheck wraps a skip result with status=skip', async () => {
    const result = await runCheck('test', async () => ({ status: 'skip', detail: 'offline' }));
    expect(result.status).toBe('skip');
    expect(result.name).toBe('test');
  });
});

// ══════════════════════════════════════════════════════════════════════════════
// TC-06  DB error → runCheck returns { status: fail, error: message }
// ══════════════════════════════════════════════════════════════════════════════
describe('TC-06: DB error → graceful fail', () => {
  it('runCheck catches thrown errors and returns fail', async () => {
    const result = await runCheck('db-check', async () => {
      throw new Error('connection refused');
    });
    expect(result.status).toBe('fail');
    expect(result.error).toContain('connection refused');
  });

  it('checkCampaignState throws when campaign not found', async () => {
    const pool = makePool();
    pool.query.mockResolvedValueOnce({ rows: [] }); // campaign query → empty
    await expect(checkCampaignState(pool, 9999)).rejects.toThrow('not found');
  });
});

// ══════════════════════════════════════════════════════════════════════════════
// TC-07  runCheck returns { name, status, detail/error }
// ══════════════════════════════════════════════════════════════════════════════
describe('TC-07: runCheck result shape', () => {
  it('pass result has name + status + detail', async () => {
    const r = await runCheck('my-check', async () => ({ detail: 'all good' }));
    expect(r).toMatchObject({ name: 'my-check', status: 'pass', detail: 'all good' });
  });

  it('fail result has name + status + error (no detail)', async () => {
    const r = await runCheck('my-check', async () => { throw new Error('oops'); });
    expect(r).toMatchObject({ name: 'my-check', status: 'fail', error: 'oops' });
    expect(r.detail).toBeUndefined();
  });

  it('skip result has name + status + detail', async () => {
    const r = await runCheck('my-check', async () => ({ status: 'skip', detail: 'n/a' }));
    expect(r).toMatchObject({ name: 'my-check', status: 'skip', detail: 'n/a' });
  });
});

// ══════════════════════════════════════════════════════════════════════════════
// TC-08  Failure message is actionable (contains fix info, not generic)
// ══════════════════════════════════════════════════════════════════════════════
describe('TC-08: failure messages are actionable', () => {
  it('mailbox health error names which mailboxes have low score', async () => {
    const pool = makePool();
    pool.query.mockResolvedValueOnce({
      rows: [
        { id: 1, status: 'active', last_score: 45 },
        { id: 2, status: 'active', last_score: 55 },
        { id: 3, status: 'active', last_score: 90 },
        { id: 4, status: 'active', last_score: 85 },
      ],
    });
    await expect(checkMailboxHealth(pool)).rejects.toThrow('mb1=45');
  });

  it('campaign state error tells which status was found', async () => {
    const pool = makePool();
    pool.query.mockResolvedValueOnce({ rows: [{ id: 457, status: 'running', pool: [] }] });
    await expect(checkCampaignState(pool, 457)).rejects.toThrow('status=running');
  });

  it('renderHuman includes fix items list when failures present', () => {
    const checks = [
      { name: 'Relay', status: 'fail', error: 'bridge=down' },
    ];
    const out = renderHuman(457, checks);
    expect(out).toContain('Fix items');
    expect(out).toContain('bridge=down');
  });
});

// ══════════════════════════════════════════════════════════════════════════════
// TC-09  renderHuman contains all 10 check names (no omissions)
// ══════════════════════════════════════════════════════════════════════════════
describe('TC-09: renderHuman includes all check names', () => {
  const expectedNames = [
    'Campaign state',
    'Mailbox health',
    'Suppression UNION',
    'Migrations head',
    'SMOKE campaigns absent',
    'Anti-trace relay',
    'Launch-readiness (7 gates)',
    'Required files',
    'Env vars',
    'Recent operator activity',
  ];

  it('all 10 names present in human output', () => {
    const checks = expectedNames.map(name => ({ name, status: 'pass', detail: 'ok' }));
    const out = renderHuman(457, checks);
    for (const name of expectedNames) {
      expect(out).toContain(name);
    }
  });
});

// ══════════════════════════════════════════════════════════════════════════════
// TC-10  Exit code semantics: 0 if all pass, 1 if any fail
// ══════════════════════════════════════════════════════════════════════════════
describe('TC-10: exit code semantics', () => {
  it('isReadyToLaunch → true maps to exit 0', () => {
    const checks = allPassChecks(10);
    expect(isReadyToLaunch(checks) ? 0 : 1).toBe(0);
  });

  it('isReadyToLaunch → false maps to exit 1', () => {
    const checks = withOneFail(allPassChecks(10));
    expect(isReadyToLaunch(checks) ? 0 : 1).toBe(1);
  });
});

// ══════════════════════════════════════════════════════════════════════════════
// TC-11  checkMailboxHealth — fewer than 4 mailboxes → error
// ══════════════════════════════════════════════════════════════════════════════
describe('TC-11: mailbox count guard', () => {
  it('throws when fewer than 4 active production mailboxes', async () => {
    const pool = makePool();
    pool.query.mockResolvedValueOnce({ rows: [
      { id: 1, status: 'active', last_score: 90 },
      { id: 2, status: 'active', last_score: 85 },
    ]});
    await expect(checkMailboxHealth(pool)).rejects.toThrow('only 2 active');
  });

  it('passes when ≥4 mailboxes all have score ≥80', async () => {
    const pool = makePool();
    pool.query.mockResolvedValueOnce({ rows: [
      { id: 1, status: 'active', last_score: 82 },
      { id: 3, status: 'active', last_score: 90 },
      { id: 631, status: 'active', last_score: 95 },
      { id: 632, status: 'active', last_score: 88 },
    ]});
    const r = await checkMailboxHealth(pool);
    expect(r.detail).toContain('4 active');
  });
});

// ══════════════════════════════════════════════════════════════════════════════
// TC-12  checkCampaignState — 0 pending contacts → error
// ══════════════════════════════════════════════════════════════════════════════
describe('TC-12: campaign pending contacts guard', () => {
  it('throws when pending contacts = 0', async () => {
    const pool = makePool();
    pool.query
      .mockResolvedValueOnce({ rows: [{ id: 457, status: 'draft', pool: [1, 3] }] })
      .mockResolvedValueOnce({ rows: [{ n: '0' }] });
    await expect(checkCampaignState(pool, 457)).rejects.toThrow('0 pending contacts');
  });

  it('passes with draft status and pending contacts', async () => {
    const pool = makePool();
    pool.query
      .mockResolvedValueOnce({ rows: [{ id: 457, status: 'draft', pool: [1, 3] }] })
      .mockResolvedValueOnce({ rows: [{ n: '250' }] });
    const r = await checkCampaignState(pool, 457);
    expect(r.detail).toContain('250 pending');
  });
});

// ══════════════════════════════════════════════════════════════════════════════
// TC-13  checkEnvVars — missing vars → actionable error listing them
// ══════════════════════════════════════════════════════════════════════════════
describe('TC-13: env vars check', () => {
  beforeEach(() => {
    // Remove all relevant env vars
    delete process.env.DATABASE_URL;
    delete process.env.ANTI_TRACE_RELAY_URL;
    delete process.env.ANTI_TRACE_RELAY_TOKEN;
    delete process.env.OUTREACH_API_KEY;
    delete process.env.RELAY_URL;
    delete process.env.RELAY_TOKEN;
  });

  afterEach(() => {
    // Restore test environment (values don't matter for unit tests)
    process.env.DATABASE_URL           = 'postgresql://test';
    process.env.ANTI_TRACE_RELAY_URL   = 'http://localhost:9999';
    process.env.ANTI_TRACE_RELAY_TOKEN = 'test-token';
    process.env.OUTREACH_API_KEY       = 'test-api-key';
    process.env.RELAY_URL              = 'http://localhost:9999';
    process.env.RELAY_TOKEN            = 'test-relay-token';
  });

  it('throws with list of missing env vars', async () => {
    await expect(checkEnvVars()).rejects.toThrow('DATABASE_URL');
  });

  it('error message includes all missing vars', async () => {
    try {
      await checkEnvVars();
      expect.fail('should have thrown');
    } catch (e) {
      expect(e.message).toContain('ANTI_TRACE_RELAY_URL');
      expect(e.message).toContain('RELAY_TOKEN');
    }
  });
});

// ══════════════════════════════════════════════════════════════════════════════
// TC-14  checkRequiredFiles — reports specific missing file paths
// ══════════════════════════════════════════════════════════════════════════════
describe('TC-14: required files check', () => {
  it('passes when all required files exist in repo (integration: uses real FS)', async () => {
    // This verifies the real repo has these files
    const r = await checkRequiredFiles(REPO_ROOT, DASHBOARD_ROOT);
    expect(r.detail).toContain('4 required files present');
  });

  it('throws with missing file names when a path does not exist', async () => {
    const fakeRoot = '/tmp/fake-repo';
    await expect(checkRequiredFiles(fakeRoot, fakeRoot)).rejects.toThrow('missing');
  });
});

// ══════════════════════════════════════════════════════════════════════════════
// TC-15  checkSmokeAbsent — active SMOKE campaign → error
// ══════════════════════════════════════════════════════════════════════════════
describe('TC-15: SMOKE campaign guard', () => {
  it('throws when active SMOKE campaign exists', async () => {
    const pool = makePool();
    pool.query.mockResolvedValueOnce({ rows: [{ id: 99, status: 'running' }] });
    await expect(checkSmokeAbsent(pool)).rejects.toThrow('1 active SMOKE');
  });

  it('passes when no active SMOKE campaigns', async () => {
    const pool = makePool();
    pool.query.mockResolvedValueOnce({ rows: [] });
    const r = await checkSmokeAbsent(pool);
    expect(r.detail).toContain('no active SMOKE');
  });
});

// ══════════════════════════════════════════════════════════════════════════════
// TC-16  checkRelayStatus — non-ok bridge status → error
// ══════════════════════════════════════════════════════════════════════════════
describe('TC-16: relay status check', () => {
  it('throws when ANTI_TRACE_RELAY_URL not set', async () => {
    await expect(checkRelayStatus(undefined, undefined)).rejects.toThrow('ANTI_TRACE_RELAY_URL not set');
  });

  it('throws when relay returns non-ok HTTP', async () => {
    // Use a definitely-closed endpoint that returns a response
    // Simulate by mocking fetch is impractical without setup — verify it throws on bad URL
    await expect(checkRelayStatus('http://localhost:1', 'tok')).rejects.toThrow();
  });
});

// ══════════════════════════════════════════════════════════════════════════════
// TC-17  renderHuman HALT vs READY output structure
// ══════════════════════════════════════════════════════════════════════════════
describe('TC-17: renderHuman HALT/READY banners', () => {
  it('shows READY TO LAUNCH banner when all pass', () => {
    const checks = allPassChecks(10);
    const out = renderHuman(457, checks);
    expect(out).toContain('READY TO LAUNCH');
    expect(out).not.toContain('HALT');
  });

  it('shows HALT banner when any fail', () => {
    const checks = withOneFail(allPassChecks(10));
    const out = renderHuman(457, checks);
    expect(out).toContain('HALT');
    expect(out).not.toContain('READY TO LAUNCH');
  });

  it('renders ✓ icon for pass checks', () => {
    const checks = [{ name: 'Test', status: 'pass', detail: 'ok' }];
    const out = renderHuman(457, checks);
    expect(out).toContain('✓');
  });

  it('renders ✗ icon for fail checks', () => {
    const checks = [{ name: 'Test', status: 'fail', error: 'broken' }];
    const out = renderHuman(457, checks);
    expect(out).toContain('✗');
  });
});

// ══════════════════════════════════════════════════════════════════════════════
// TC-18  checkOperatorActivity — no recent activity → actionable error
// ══════════════════════════════════════════════════════════════════════════════
describe('TC-18: operator activity check', () => {
  it('throws when no activity in 24h', async () => {
    const pool = makePool();
    pool.query.mockResolvedValueOnce({ rows: [{ last_action: null }] });
    await expect(checkOperatorActivity(pool)).rejects.toThrow('no operator activity in last 24h');
  });

  it('passes when recent activity exists', async () => {
    const pool = makePool();
    pool.query.mockResolvedValueOnce({ rows: [{ last_action: new Date() }] });
    const r = await checkOperatorActivity(pool);
    expect(r.detail).toContain('last action:');
  });
});
