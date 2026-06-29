# Contract Test Triage — 2026-05-05

**Trigger:** GitHub issue #763 — 17 pre-existing contract failures on main  
**PR:** `test(bff): triage 17 pre-existing contract failures (#763, Sprint 1.3)`  
**Baseline before sweep:** 79 failed | 2086 passed (full contract scope)  
**After sweep:** 62 failed | 2103 passed (17 fixed; 62 remaining are pre-existing in files outside #763 scope)

---

## Per-file categorization

### 1. `tests/contract/anonymity-latest.contract.test.ts` — 12 failures

**Category:** TEST-SETUP-DRIFT  
**Root cause:** `anonymityLatest.js` exports a comment stub but not the actual
`_resetRateLimit()` / `_setLastRunAt(ts)` functions the test calls in `beforeEach`.
The module-level variable `_lastRunAt` was added in Sprint S5 along with the route,
but the test helper exports were omitted from the final commit.  
**Fix:** Added `export function _resetRateLimit()` and `export function _setLastRunAt(ts)`
at the end of `src/server-routes/anonymityLatest.js` (lines 265–266).  
**All 12 tests now pass.**

---

### 2. `tests/contract/bff-diagnostics.contract.test.ts` — 0 failures

**Actual status on triage run:** PASS (14) FAIL (0)  
**Conclusion:** Already passing. Included in issue by mistake or was fixed by an
earlier unrelated merge. No action needed.

---

### 3. `tests/contract/bff-threads-g3-extract.contract.test.ts` — 0 failures

**Actual status on triage run:** PASS (12) FAIL (0)  
**Conclusion:** Already passing. The G3 extraction settled correctly after the
module was wired in Sprint G3. No action needed.

---

### 4. `tests/contract/bff-campaigns-send-test.contract.test.ts` — 4 failures

**Category:** TEST-SETUP-DRIFT  
**Root cause:** Vite's `loadEnv` repopulates `ANTI_TRACE_URL` from `.env` during the
`await import('../../server.js')` call in `beforeAll`. The `.env` file has
`ANTI_TRACE_URL=https://anti-trace-relay-production-a706.up.railway.app`. After the
import the test's mock fetch (which intercepts only `relay.test`) was bypassed:
the handler called the production relay instead of the test stub.

This caused:
- `envelope_id` to be a real production envelope ID instead of `env_kt_a5`
- `relayCalls.length === 0` (mock never called)
- 502-on-relay-failure tests to get 200 (production relay accepted the request)

**Fix:** Added `process.env.ANTI_TRACE_URL = 'https://relay.test'` and
`process.env.ANTI_TRACE_TOKEN = 'kt-a5-token'` AFTER the `import('../../server.js')`
call, plus explicit `delete` of `ANTI_TRACE_RELAY_URL` / `ANTI_TRACE_RELAY_TOKEN`
to clear any loadEnv-injected aliases  
(pattern mirrors the `GO_SERVER_URL` note in `tests/contract/setup.ts`).  
**All 16 tests now pass.**

---

### 5. `tests/contract/bff-mailbox-healing-cron.contract.test.ts` — 0 failures

**Actual status on triage run:** PASS (13) FAIL (0)  
**Conclusion:** Already passing. Issue #763 listed "4 failures" but the fixes
shipped in earlier PRs (full-check + UPDATE flow refactor) must have already
landed before this sweep. No action needed.

---

### 6. `tests/contract/bff-mailboxes-extended.contract.test.ts` — 0 failures

**Actual status on triage run:** PASS (103) FAIL (0)  
**Conclusion:** Already passing. The `502 when relay env not configured` assertion
was widened to `expect([200, 502]).toContain(res.status)` before this sweep,
which covers the case where the mailbox send-test handler falls through to the
direct-SMTP path (SOCKS5 not configured → 400, not 502). The test accepts both
outcomes. No further action needed.

---

### 7. `tests/contract/bff-threads-stream.contract.test.ts` — 1 failure

**Category:** STALE-ASSERTION  
**Root cause:** Sprint G3 (2026-05-03) extracted the `/api/threads/stream` SSE
handler from `server.js` into `src/server-routes/threads.js`. Test 7 and 8
("SOURCE AUDIT") read `server.js` directly and asserted that `app.get('/api/threads/stream'`
and `setInterval` / `: hb` were present in that file. After extraction, the pattern
is in `threads.js`, not `server.js`.  
**Fix:** Updated tests 7 and 8 to read `src/server-routes/threads.js` instead.
Added a comment noting the G3 extract context.  
**All 10 tests now pass.**

---

## Summary counts

| Category            | Files | Tests fixed |
|---------------------|-------|-------------|
| STALE-ASSERTION     | 1     | 1           |
| TEST-SETUP-DRIFT    | 2     | 16          |
| Already passing     | 4     | 0 (17 listed in issue — delta: triage found 0 failures in those 4) |
| **Total fixed**     |       | **17**      |

No REAL-REGRESSION findings. No production handler code was modified.

---

## Remaining failures (outside #763 scope)

The full `pnpm test:contract` suite shows 62 failures across 17 other files
(pre-existing, not introduced by this PR). These are tracked separately and
not part of this triage sweep.
