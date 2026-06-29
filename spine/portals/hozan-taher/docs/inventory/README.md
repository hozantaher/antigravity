# Inventory Index

> **Read this BEFORE writing new code.** Most operational problems have existing solutions. This index points to per-domain inventories that catalog what exists.

Created 2026-04-27 after a session where the operator caught the AI duplicating an existing self-healing system (proxy reassignment, geo filtering — all already in the codebase). Going forward: check the relevant inventory first, find the existing endpoint/script/playbook, then call it.

## Sections

### [01 — Send Pipeline](01-send-pipeline.md) (111 lines)
Proxy pool management, mailbox self-healing watchdog, SMTP AUTH probing through relay, campaign preflight gate, transport modes, ops endpoints. **Key insight:** `bulk-assign-proxy` already exists; `/v1/admin/refresh-pool` exists; preflight gate has 6 checks. Don't write a new SQL UPDATE for proxy reassign.

### [02 — Suppression / GDPR / Unsubscribe](02-suppression-gdpr.md) (411 lines)
Dual-table suppression (outreach_suppressions + suppression_list) UNION'd at every send tick; HMAC-SHA256 unsubscribe token contract synced between Go + JS; full GDPR/DSR endpoints (Article 15 + 17 + 21); LIA + Art. 30 register + DPIA published; bounce → suppression cascade with hard/soft classification. Honeypot detection lib ready but not auto-suppressing.

### [03 — Reply Pipeline + IMAP](03-reply-pipeline.md) (116 lines)
IMAP poller with UID watermark + dedup; bounce detection PRE classification (avoids DSN misclassification); keyword classifier (Czech) + LLM semantic fallback (Ollama, confidence < 0.6 → regex); ReplyType switch dispatches actions (Negative→suppress, OOO→pause 14d, Later→pause 30d, Meeting/Interested→lead upsert). mailsim package generates synthetic replies + DSNs for testing.

### [04 — Observability + Healing Log](04-observability.md) (325 lines)
Sentry + Prometheus metrics (20+); Orchestrator `/health` with optional surfaces (stale_advisory_lock_ids, pending_envelopes, greylist_queue_depth); BFF has 11 health API routes; healing_log + watchdog_events tables queryable via `/api/healing/log` + `/api/healing/stats`; slog `"op"` field discipline ratcheted by test; synthetic smoke runs every 60s with 10 invariants.

### [05 — Ops Toolkit](05-ops-toolkit.md) (~330 lines)
~144 BFF endpoints in 15 categories (mailbox/campaign/proxy/contacts/templates/segments/analytics/DSR); 17 named cron jobs with `timed()` wrapper + cron_heartbeats audit; 11 SQL migrations with predecessor + drift detection; deploy preflight 6 mandatory checks; 30+ playbooks under `docs/playbooks/`. Common operations recipes section at the end.

### [06 — Testing Infrastructure](06-testing.md) (358 lines)
Single Vitest config with TEST_SCOPE switching (default/contract/integration/all/e2e); 337 frontend test files; 540 Go test files across 7 services; 4 shared helpers (slo, chaos-sim, state-machine, heal-fixtures); 7 audit tests as discipline ratchets (observability surfaces, SLO bounds, fixture isolation, hardening); pg-mem for integration; Playwright for E2E (memory: feedback_playwright_route_gotcha); Stryker mutation testing per-module (memory: project_stryker_setup).

---

## Quick decision matrix

| Symptom | Look first at |
|---|---|
| Mailbox stuck / proxy failing | `01-send-pipeline.md` § Mailbox self-healing |
| „nechci" / opt-out handling | `02-suppression-gdpr.md` |
| Reply not classified | `03-reply-pipeline.md` |
| Need a metric / alert | `04-observability.md` |
| Need to run an op without SQL | `05-ops-toolkit.md` |
| About to write a new test | `06-testing.md` |
| About to write new code | **All 6 — search first** |

## Update protocol

- When you find an existing solution that **isn't catalogued**, add it to the relevant section.
- When you find a catalogued solution that no longer exists, mark it `(removed)` and link to the commit.
- Don't let this index drift — it's load-bearing for keeping AI sessions efficient.

## Anti-patterns this index prevents

1. ❌ Writing new SQL UPDATE to fix mailbox state → ✅ POST `/api/mailboxes/:id/recover` or `/auth-reset`
2. ❌ Manual proxy fetch script + SQL assign → ✅ POST `/api/mailboxes/bulk-assign-proxy`
3. ❌ Custom geo filter on relay → ✅ `PROXY_COUNTRY_CODES` env + `PROXY_STRICT_GEO` already exist
4. ❌ New cron for X → ✅ check § 4 Crons in `05-ops-toolkit.md`; pattern is `timed(name, fn)` + cron_heartbeats
5. ❌ New keyword classifier → ✅ `features/platform/common/humanize/response.go` Czech keyword + LLM fallback
6. ❌ New test scope/folder → ✅ check `06-testing.md` for existing TEST_SCOPE values
7. ❌ Direct SMTP probe from BFF → ✅ HARD RULE: relay `/v1/auth-check`
8. ❌ New unsubscribe URL format → ✅ HMAC-SHA256 token contract is locked
9. ❌ Privacy notice / LIA / Art. 30 from scratch → ✅ already in `docs/legal/`
10. ❌ New observability dashboard → ✅ Observability.jsx + Watchdog.jsx pages exist
