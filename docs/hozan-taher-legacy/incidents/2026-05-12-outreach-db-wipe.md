# Incident: outreach-db data wipe

**Datum:** 2026-05-12 (00:30 - 02:15 UTC)
**Severita:** P0 — complete data loss
**Status:** Recovered (partial — historical send/suppression data permanently lost)

## TL;DR

Restart Railway `outreach-db` service způsobil ztrátu 16 GB outreach dat (companies, contacts, campaigns, send_events, watchdog_events, mailboxes). Persistent volume byl attached, ale restart provedl initdb (fresh data dir). Žádný Railway snapshot backup neexistoval. 95% schema + 60k+ target pool obnoveno z legacy `Postgres` service (`firmy_cz_businesses` source) + eWAY-CRM XLSX import. Historické send-events + pre-incident suppression list permanentně pryč.

## Timeline

| UTC | Event |
|-----|-------|
| ~22:30 | Operator request: Railway cost optimization wave 2 (memory caps via env vars). |
| ~22:50 | Agent applied NODE_OPTIONS / GOMEMLIMIT to 6 services via `railway variable set --skip-deploys`. |
| 23:05 | Agent issued `railway service restart --service outreach-db --yes` to apply DB tuning. |
| 23:07:22 | Postgres started fresh (`pg_postmaster_start_time` confirms). Data directory empty after initdb. |
| 23:18 | Operator noticed BFF logs full of `relation "campaigns" does not exist`. |
| 23:25 | Forensic confirms: outreach DB = 7.5 MB (was 16 GB hour earlier). Volume attached but Postgres uses empty pgdata. |
| 23:30 | No backups in repo, no Railway snapshots. Permanent loss confirmed. |
| 00:05 | Recovery wave 1: applied 97 migrations → 80 tables schema restored. |
| 00:30 | Recovery wave 2: streamed 426k rows `firmy_cz_businesses` (legacy Postgres) → `companies`. |
| 00:45 | Recovery wave 3: heuristic NACE classification (112k B2B sector match). |
| 01:50 | eWAY XLSX import → 2271 CRM clients + 1728 suppressed emails + 975 suppressed domains. |
| 02:10 | pg_dump baseline (59 MB) + launchd daily backup (03:15 local). |
| 02:15 | Recovery complete. Memory T0 HARD RULE added. |

## Root cause

1. **Agent destructive op without persistent-volume check.** `railway service restart --service outreach-db --yes` issued without verifying that the service had a working persistent volume containing real data.
2. **Railway managed Postgres + restart edge case.** Volume `outreach-db-volume` was attached to mount `/var/lib/postgresql/data`. `PGDATA=/var/lib/postgresql/data/pgdata` (subdirectory). On restart, the container's `docker-entrypoint.sh` saw an empty `pgdata` subdirectory and ran `initdb`, populating it with fresh empty cluster — the actual outreach data lived elsewhere on the volume or was wiped during reattachment.
3. **No backup strategy.** No `pg_dump` schedule, no Railway snapshots, no replica. Recovery hinged entirely on the legacy `Postgres` service still having `firmy_cz_businesses` raw scrape data.

## Permanently lost data

- `send_events`: complete history (every email sent, opens, clicks)
- `outreach_messages`: thread history
- `watchdog_events`: incident audit log
- `mailbox_warmup`: warmup state for 2 mailboxes
- `outreach_score_history`: 244 MB of mailbox health timeline
- `outreach_suppressions` pre-2026-05-12: any user who unsubscribed before wipe
- `suppression_list` historical: campaign-scoped suppressions
- Campaign 457 in-flight state: 22+ sent emails today + 200+ pending contacts

## Recovered (post-incident state)

| Table | Rows | Source |
|---|---|---|
| `companies` | 426,296 | streamed from legacy `firmy_cz_businesses` (35 GB raw scrape), dedup ICO |
| `contacts` | 426,296 | derived 1:1 from companies, email_status=valid |
| `crm_clients` | 2,271 | eWAY-CRM XLSX export (Klienti_výběr.xlsx + Obchodní_případy_výběr.xlsx, 2026-05-05 export) |
| `outreach_suppressions` | 1,728 emails + 975 domains | eWAY active clients suppressed |
| `suppression_list` | 1,728 | mirror table (per `project_two_suppression_tables`) |
| `outreach_mailboxes` | 2 | manual skeleton restore (passwords via operator) |
| `email_templates` | 4 | seeded migrations + intro_machinery from conversation transcript |
| `campaigns` | 1 | campaign 457 skeleton (paused) |

Heuristic NACE classification (sector_source='heuristic_category_path_2026-05-12'):
- construction 41,821 / machinery_manufacturing 40,266 / auto_service 7,546 / forestry_wood 6,253 / agriculture 6,185 / transport_logistics 5,637 / landscaping 3,939 / waste_recycling 969 / mining_quarry 77 = **112,693 B2B target pool**

After CRM exclude + suppression filter + sector filter: **56,498 clean campaign-ready contacts**.

## Action items

### Done

- [x] Schema restored via migrations
- [x] Companies + contacts backfilled
- [x] CRM clients + suppression list imported (eWAY XLSX)
- [x] `contacts.crm_client_id` backfilled via ICO match (per memory `project_crm_integration` HARD RULE)
- [x] pg_dump baseline (59 MB) saved to `~/outreach-backups/outreach-recovery-20260512T000916Z.sql.gz`
- [x] Daily launchd backup `~/Library/LaunchAgents/com.hozan.outreach-backup.plist` scheduled 03:15 local, 30d rotation
- [x] T0 memory rule `feedback_verify_volume_before_db_restart`: HARD RULE — verify persistent volume + backup before any DB-touching restart

### Pending (before any campaign send)

- [ ] Verify intro_machinery template content matches operator intent (re-inserted from conversation history, may need polish)
- [ ] Operator activate 2 mailboxy via UI (currently `status=paused`)
- [ ] Mailbox warmup state setup (decision: use lifecycle_phase='production' since accounts have history, or restart warmup_d0)
- [ ] Test send via UI (synthetic `[TEST]` to `messing.tomas@gmail.com`) — verify SMTP/IMAP works with new DB
- [ ] Re-enroll campaign_contacts from segment_query (operator decides which sectors to target first)
- [ ] Wait for Go orchestrator intelligence loop to overwrite heuristic NACE with real classification (6h cron)

### Prevention

- [x] Local daily pg_dump backup (launchd)
- [ ] Railway-side scheduled backup (Pro plan snapshots — needs operator dashboard configuration)
- [ ] CI test that asserts `outreach-db` service has attached volume + Railway snapshot configured
- [ ] Audit ratchet against `railway service restart --service <db>` without `--check-volume` flag (custom wrapper)

## Lessons

1. **Railway managed Postgres ≠ guaranteed persistent.** Volume can be attached but `pg_dump` test write/read should be in pre-deploy invariants.
2. **Cost-optimization sprints touch infra.** Pre-flight check: any service marked `database` or with `postgres`/`mysql`/`redis` in name = require backup attestation before any change.
3. **`--yes` on DB ops = banned without backup snapshot.** Now T0 hard rule in memory.
