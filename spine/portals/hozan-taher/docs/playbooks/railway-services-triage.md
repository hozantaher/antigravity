# Railway Services Triage & Decision Document

**Status:** Open
**Datum:** 2026-05-07
**Trigger:** Sprint M1 (H6.2) — Post-launch hardening initiative. Railway project `garaaage-mcp` contains all hozan-taher services; 2 currently in FAILED state.

## Service Inventory (2026-05-06 census)

Current railway service status per `railway service status --all`:

| Service | ID | Role | Current Status | Decision | Priority | Notes |
|---------|----|----|--------|----------|----------|-------|
| garaaage-scrapers | 38827d46-c74c-4620-b0e4-1237ad1a49d1 | Contact data ingestion (TypeScript, BullMQ) | SUCCESS | Keep + monitor | LOW | Per `features/acquisition/scrapers/` — dormant but functional |
| rozpor-worker | 162e3291-866f-45cc-b502-b51d56ce8f2e | PDF generator (Claude API + MCP) | SUCCESS | Keep | MEDIUM | Per `features/platform/worker/` — processes `modules/outreach` PDF orders |
| Redis | 44e46c12-35de-478c-8f17-ed33c6c31247 | Cache (general) | SUCCESS | Keep | HIGH | Shared by BFF + Go pipeline |
| garaaage-db-prod | 64e00b19-cd23-4a02-80b0-c1ab79ca7f6a | PostgreSQL (garaaage project) | SUCCESS | Investigate | LOW | Separate from hozan-taher; likely third-party project |
| ollama | 13887fe7-e31e-4af3-b76f-24e69be42057 | LLM inference (local) | SUCCESS | Investigate | LOW | Purpose unclear in context of hozan-taher |
| outreach-dashboard | 45324ce4-cfc0-4b2b-a065-db7d2092fa05 | OLD Nuxt UI (previous generation) | **FAILED** | **Decommission** | LOW | Replaced by React app in `features/platform/outreach-dashboard/` (Vite + React 19) |
| Postgres | 4646fb9f-3d33-4e9d-9b86-8338a5fd9e7c | PostgreSQL (generic name) | SUCCESS | Investigate | HIGH | Likely production DB; verify connection string + naming |
| anti-trace-relay | 0de8c681-c504-462e-aaeb-4cedfef55eff | SMTP relay (anti-trace pipeline) | SUCCESS | **Keep** | **CRITICAL** | Per `features/outreach/relay/` — essential for campaign delivery |
| privacy-gateway | 5ab4bdd4-8435-449d-aa3c-070ba2720263 | Privacy/anonymization gateway | SUCCESS | Keep | HIGH | Per `features/compliance/privacy-gateway/` docs |
| typesense | 59d01831-8e7d-48f2-a33f-54e20acc31b4 | Search engine | SUCCESS | Keep | MEDIUM | Indexed contact + company records |
| garaaage-redis | 896ebdcd-72d7-485d-b64c-2c0bcb250828 | Redis (garaaage project) | SUCCESS | Investigate | LOW | Separate from main Redis; likely third-party |
| garaaage-grafana | 4c0a67c8-0710-4343-af7b-db7bc04e7c43 | Grafana (monitoring) | SUCCESS | Keep | MEDIUM | Observability for production pipelines |
| searxng | e2fd7de5-bb82-4693-8d18-121df1f5034e | Metasearch engine | SUCCESS | Keep | LOW | Contact scraping support |
| outreach-db | 7c7f2814-2b26-4ec3-9276-d8a429e3af11 | PostgreSQL (hozan-taher production) | SUCCESS | **Keep** | **CRITICAL** | Primary database for campaigns + mailboxes + contacts |
| loki | 03e377c6-fcf6-42d4-974c-26c81fe92b85 | Log aggregation | SUCCESS | Keep | MEDIUM | Centralized logging |
| garaaage-db-test | 1708b099-f1dd-474a-b72a-c283944cd229 | PostgreSQL (test) | SUCCESS | Keep | LOW | Testing database |
| machinery-outreach | 1bee8f84-a9c4-4751-b72c-01b7ba0c4c0c | Go campaigns daemon (orchestrator) | **FAILED** | **Fix + Monitor** | **CRITICAL** | Per `features/inbound/orchestrator/cmd/outreach/` — intelligence loop + scheduler |

## FAILED Services Analysis

### 1. outreach-dashboard (Nuxt OLD UI)

**Status:** FAILED
**Last successful deploy:** 2026-04-17 (estimated from historical logs)
**Codebase:** Not found in current monorepo (no `services/outreach-dashboard/` or `apps/old-nuxt-dashboard/`)
**Current dashboard:** React 19 app in `features/platform/outreach-dashboard/` (Vite, Express BFF, not deployed to Railway)

**Root cause:** Legacy service from previous architecture iteration. Nuxt UI was replaced by React dashboard but Railway service was never decommissioned.

**Decision:** Decommission immediately.

**Action items:**
1. Verify no internal or external users depend on `https://<app>.up.railway.app/outreach-dashboard` URL
2. Execute: `railway service delete outreach-dashboard`
3. Free up Railway project resources
4. Close any associated DNS records

---

### 2. machinery-outreach (Go campaigns daemon)

**Status:** FAILED
**Last observed:** Multiple restart attempts visible in recent deploy logs
**Codebase:** `features/inbound/orchestrator/cmd/outreach/` — Go daemon handling IMAP polling + mail classification + reply ingestion
**Critical role:** Intelligence loop runs every 6 hours; campaigns depend on this scheduler

**Root cause candidates:**
- Boot-time environment variable validation failure (`features/platform/common/envconfig` required vars missing)
- Database connection error (`outreach-db` DSN misconfigured)
- IMAP credentials invalid or Network error
- Recent merge conflict or panic in orchestrator code

**Decision:** Requires investigation + fix before launch verification.

**Action items (prioritized):**
1. Check Railway deployment logs: `railway logs machinery-outreach --follow`
2. Verify all required env vars present: `IMAP_*`, `DB_*`, `API_KEY`, `SENTRY_DSN`
3. Verify `outreach-db` connectivity from machinery-outreach container
4. Check recent commits in `features/inbound/orchestrator/` for panics or broken imports
5. If still failed after above: redeploy with `railway redeploy machinery-outreach`
6. Monitor logs for 30min post-redeploy (must reach "listening on port" message)

---

## Dual Database Investigation

**Observation:** Three PostgreSQL services exist:
- `outreach-db` (hozan-taher production)
- `Postgres` (generic name, unclear owner)
- `garaaage-db-prod` (garaaage third-party project)

**Action items:**
1. Query active connections: Connect to each DB and count active sessions + last activity timestamp
2. Verify current production DSN: Check `OUTREACH_DATABASE_URL` env var in machinery-outreach + BFF
3. Document single source of truth for which DB is production
4. Decommission unused DB if any (coordinate with operator)

---

## Railway Naming & Service Reconciliation

**Current state:** Service names do not cleanly map to repo directory structure.

**Mapping verified:**
- `machinery-outreach` → `features/inbound/orchestrator/cmd/outreach/`
- `anti-trace-relay` → `features/outreach/relay/`
- `outreach-dashboard` (FAILED) → (no match; legacy)
- `rozpor-worker` → `features/platform/worker/`
- `garaaage-scrapers` → `features/acquisition/scrapers/`

**Services requiring clarification:**
- `ollama`, `searxng`, `privacy-gateway` — confirm these belong to hozan-taher (vs. shared tooling)

---

## Recommended Timeline

### Immediate (before launch — ~2 hours)

1. **machinery-outreach fix:**
   - Check logs
   - Verify env vars
   - Redeploy if needed
   - Monitor post-deploy

2. **outreach-dashboard decommission:**
   - Confirm no dependencies
   - Delete service
   - Update DNS

### Post-Launch (within 7 days)

3. **DB reconciliation:**
   - Identify production DB owner
   - Decommission redundant instances if applicable

4. **Service naming cleanup:**
   - Document which services belong to hozan-taher
   - Create reference table in ops playbook

### Sprint S4.3+ (not blocking launch)

5. **Update CI/CD pipeline:**
   - Include Railway service health probe in deployment gate
   - Alert on FAILED services

---

## Open Questions

1. Is React `features/platform/outreach-dashboard` deployed elsewhere (not Railway)? Or local-only for dev?
2. Do `ollama`, `searxng`, `privacy-gateway` belong to hozan-taher or shared infrastructure?
3. Is `Postgres` DB separate project or hozan-taher legacy naming?
4. What is the last known successful `machinery-outreach` deployment timestamp + commit SHA?

---

## References

- `features/inbound/orchestrator/cmd/outreach/main.go` — Daemon entry point
- `features/outreach/relay/` — Anti-trace relay service
- `features/platform/outreach-dashboard/` — Current React UI (not deployed to Railway as of 2026-05-06)
- `docs/subsystem-maps/anti-trace.md` — 42-step email pipeline (machinery-outreach is critical step)
- `docs/subsystem-maps/imap-inbound.md` — IMAP polling orchestration
