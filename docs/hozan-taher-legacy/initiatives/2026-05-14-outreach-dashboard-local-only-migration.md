# Outreach-dashboard local-only migration

> **Status:** Active
> **Datum:** 2026-05-14
> **Trigger:** Operator HARD rule v3 (T0 `feedback_outreach_dashboard_local_only`) — celé `outreach-dashboard` (UI Vite + BFF Express + crons) běží **VÝHRADNĚ lokálně**, ŽÁDNÝ Railway. Posílají Railway BFF deploy 6× FAILED 2026-05-14 → operator explicit korekce.

## Cíl

Tear down Railway service `outreach-dashboard`. Migrate jeho 19 cronů buď:
- **24/7-critical** → Go service `machinery-outreach` (Railway-hosted, working)
- **Operator-time-aware** → BFF zůstává lokálně, běží pouze když operator startuje

## Aktuální incident (Y stav)

- Railway BFF `outreach-dashboard` **6× FAILED deploys** 2026-05-14 12:00-12:34
- Service teď DOWN, žádný container
- Verify cron fix v main (commit b9686dd8) ale nedeploynutý → cohort verify queue zaseknutý (31189 pending)
- Lead-score, send-batch endpoints, /replies UI proxy — všechno mrtvé
- Local Vite (`pnpm dev` :18175) má /api proxy na Railway → 404

## 4 sprints

### Z1 — Immediate recovery (P0, 30 min)

Spustit lokální BFF, aby operator měl funkční UI hned.

Steps:
1. Operator otevře `features/platform/outreach-dashboard/.env` — verify DB credentials, OUTREACH_API_KEY, ANTI_TRACE_URL
2. `cd features/platform/outreach-dashboard && node server.js` — start BFF na :18001
3. Vite proxy v `vite.config.js` switch z Railway URL → `http://localhost:18001`
4. `pnpm dev` → UI :18175 → API :18001
5. Verify endpoints fungují (`curl localhost:18001/api/health`)
6. Verify cron schedule funguje (`[boot] contactVerifyCron scheduled` v BFF logu)

Acceptance: operator otevře `localhost:18175` → vše funguje, verify queue začne ubírat (31189 → klesne).

### Z2 — Audit 19 crons (P0, 1 hod)

Klasifikace každého cronu:

**24/7-critical (Go runner candidates):**
- `runImapPollCron` (5 min) — detekce odpovědí; bez něj operator nevidí replies real-time
- `runMailboxHealthCycleCron` (30 min) — health degradation detekce
- `runBounceFlipCron` (15 min) — bounce processing → email_status='bounce_hold'
- `runMailboxBounceThrottleCron` (30 min) — auto-pause threshold
- `runOutboundReplyCron` (90s) — manual reply send queue drain
- `runBounceRateMonitorCron` (30 min) — alert generation

**Operator-time-aware (BFF lokálně OK):**
- `runStaleHealthCheckCron` (1 min) — diagnostic
- `runScoringRecomputeCron` (1h) — batch
- `runEnrichmentMVRefreshCron` (10 min) — MV refresh
- `runEnrichmentWorkerTick` (30s) — enrichment queue
- `runAdaptiveRefreshCron` (6h)
- `mailboxAutoRecover` (6h)
- `runHumanBehaviorSimulationCron` (4h)
- `runImapIdleKeepAliveCron` (30 min)
- `runMullvadEndpointReputationCron` (6h)
- `runPoolCapacityCron` (1h)
- `runGreylistRetryCron` (10 min)
- `runCampaignWatchdogCron` (1h)
- `runContactVerifyCron` (1h) — verify pipeline

Acceptance: dokument `docs/audits/2026-05-14-cron-migration-classification.md` se přiřazením + reason per cron.

### Z3 — Migrate 6 critical crons → Go runner (P1, 8-12 hod)

Pro každý z 6 kritických cronů:
1. Read BFF JS implementation
2. Port na Go ekvivalent v `features/inbound/orchestrator/cmd/outreach/main.go` (where cron daemons already exist)
3. Reuse existing helpers (mailbox/, campaigns/, etc.)
4. Add tests in Go style
5. Single PR per cron OR bundle into "machinery-outreach takes BFF crons"
6. Deploy machinery-outreach (works reliably per dnes)

Each cron is 100-300 LOC port — manageable.

Acceptance: 6 cronů reportují tick v machinery-outreach logs. BFF cron versions deletednebo gated z `if (env.MIGRATED) skip`.

### Z4 — Tear down Railway outreach-dashboard (P2, 30 min)

Once Z3 deployed + stable for 24h:
1. Stop Railway service `outreach-dashboard` (Railway UI → service → Settings → Stop/Delete)
2. Smaž `features/platform/outreach-dashboard/Dockerfile` (BFF Railway-specific)
3. Smaž `features/platform/outreach-dashboard/railway.toml`
4. Update CLAUDE.md `outreach-dashboard` section → "Local-only. UI via `pnpm dev`, BFF via `node server.js`"
5. Update playbooks (`docs/playbooks/preflight-campaign-457-launch.md`, `new-mailbox-provisioning.md`)
6. Migrate Vite proxy config default → `localhost:18001`

Acceptance: Railway project má jen 4 services (machinery-outreach, anti-trace-relay, outreach-db, garaaage-*). outreach-dashboard zmizel.

## Riziko

| Riziko | Likelihood | Mitigation |
|---|---|---|
| Operator vypne Mac → critical crons stop (před Z3) | HIGH (každý den) | Z1 immediate, Z3 spěchat |
| Go runner přidá 6 cronů → nestabilní | MEDIUM | Per-cron PR, deploy incrementally |
| Migrate breaks something | MEDIUM | Hold old BFF cron + add `if MIGRATED skip` gate před delete |
| Anti-trace egress (Mullvad) — BFF lokálně neuvidí | LOW | BFF connectuje na `anti-trace-relay-production-*.up.railway.app` přes public URL |

## Cross-reference HARD rules

- [[feedback_outreach_dashboard_local_only]] (T0 v3) — autoritativní
- [[feedback_engine_path_test]] (T0) — production sends přes engine
- [[project_bff_imap_cross_service_broken]] (T1) — cross-service IMAP issue (řeší se po migraci IMAP cron na Go)
- [[feedback_railway_redeploy_uses_old_image]] (T1) — důvod proč chceme tear-down

## Operator path right now

Pro **dnes** (než Z3 hotov):

1. Pustit lokální BFF (Z1) — `node server.js`
2. Vite proxy switch na localhost
3. Verify, kampaň 457, IMAP poll — vše lokálně
4. Operator's Mac běží přes den, večer pause campaign

Pro **tento týden** (Z2 + Z3):

1. Agent: audit 19 cronů, dokument classification
2. Agent: migrate 6 critical → Go (PR per cron, 2-3 agents paralelně)
3. Deploy machinery-outreach (working path)

Pro **příští týden** (Z4):

1. Tear down Railway outreach-dashboard
2. Update docs + playbooks
