# BFF Cron Migration Audit (Z2)

> Status: Active
> Datum: 2026-05-14
> Trigger: HARD rule v3 `feedback_outreach_dashboard_local_only` — outreach-dashboard (UI + BFF + crons) běží jen lokálně na operátor Macu; vypínán večer → 24/7-critical crony musí migrate na Railway-hosted Go service (`machinery-outreach` / orchestrator).

## Scope

Audit pokrývá **22 cronů** registrovaných ve `features/platform/outreach-dashboard/server.js:4806-5160` (`startCronEngine()`). Zadání jmenovalo 19 — během auditu se objevily 3 další, ale nejsou v zadání jako CRITICAL kandidáti: `runFolderOperationsCron`, `runEgressChaosDetectionCron`, `runWarmupAdvanceCron`. Klasifikace pokrývá jen 19 + `runContactVerifyCron` (= 20). Ostatní 2 (folderOps + egressChaos) jsou už vázané na relay/folder service a mimo scope tohoto sprintu.

Citace zdrojů: file:line v `features/platform/outreach-dashboard/server.js` a `features/platform/outreach-dashboard/src/crons/*.js`.

## Summary

- **7 crons CRITICAL** → migrate to Go orchestrator (estimate ~30 agent-hours)
- **9 crons MAINTENANCE** → keep BFF lokálně OK (operator-time-aware)
- **4 crons NICE-TO-HAVE** → ponechat lokálně nebo zvážit delete

| Bucket | Crons | Hours est. |
|---|---|---|
| CRITICAL | 7 | ~30 |
| MAINTENANCE | 9 | 0 (no migration) |
| NICE-TO-HAVE | 4 | 0 (or 2h delete review) |
| **Total agent-hours** | 20 | **~30** |

---

## Per-cron classification

### CRITICAL (must run 24/7)

#### 1. `runImapPollCron` — 5 min (server.js:4877)

- **Co:** Pollu­je IMAP přes relay `/v1/imap-fetch` pro všechny production mailboxy (status NOT IN retired/auth_locked), ingestuje nové replies/bouncy, klasifikuje (Haiku LLM), drafting AI suggestion (src/crons/runImapPollCron.js:16-80+).
- **Závislosti:** `outreach_mailboxes` read, `mailbox_imap_state` (UID watermark RW), `mailbox_imap_circuit` (RW), `mailbox_op_rate_log` (RW), `reply_inbox` (W), volá relay `/v1/imap-fetch`.
- **Side effect bez cron:** replies/bouncy zůstávají v IMAP serveru nepřečtené → operator nevidí B2B odpovědi do dashboard → propášený lead nebo opožděný refund. Sentinel test: 12+h delay = bad.
- **Migration target:** `features/inbound/orchestrator/imap/poller.go` (existující Go IMAP code, viz `aw7_socks_failfast_*.go`, `poll_once_test.go`).
- **Effort:** MEDIUM (~6h). Go code existuje, ale BFF má LLM classification + AI draft path navíc — buď port do orchestrator/intelligence, nebo orchestrator zachová raw ingest a klasifikaci přebere BFF na-demand až operator otevře `/replies`.

#### 2. `runOutboundReplyCron` — 90 s (server.js:4881)

- **Co:** Picknout pending `manual_reply_outbox` rows (operator drafted reply), poslat přes relay `/v1/submit` (src/crons/runOutboundReplyCron.js:10-60+).
- **Závislosti:** `manual_reply_outbox` (RW attempts/sent_at), `reply_inbox`, `send_events`, `outreach_mailboxes`, `manual_reply_outbox_attachments` (R), relay `/v1/submit`.
- **Side effect bez cron:** Operator klikne Send v UI, reply visí v outboxu, recipient ji nikdy nedostane → ztracený lead/eskalace.
- **Migration target:** Nový Go modul `features/inbound/orchestrator/outbound/reply_worker.go` (paralel s existující `features/outreach/campaigns/sender` engine path).
- **Effort:** MEDIUM (~5h). Reply path je menší než campaign send — relay submit je už definovaný; jen DB select/update + base64 attachment encoding.

#### 3. `runBounceFlipCron` — 15 min (server.js:4952)

- **Co:** Najít nedávno hard-bounced send_events, flipnout `companies.email_status='invalid'`, zalogovat do `email_verification_log` (src/crons/runBounceFlipCron.js:7-54).
- **Závislosti:** `send_events`, `contacts`, `companies` (RW), `email_verification_log` (W), `outreach_config` (RW watermark).
- **Side effect bez cron:** Hard-bouncy se hromadí, příští campaign znova posílá na neexistující adresy → bounce rate roste → mailbox auto-pause kaskáda.
- **Migration target:** Nový Go cron v `features/inbound/orchestrator/intelligence/bounce_flip_loop.go` nebo součást stávajícího mailbox score loop.
- **Effort:** TRIVIAL (~2h). Čistý SQL job, žádné externí I/O.

#### 4. `runMailboxBounceThrottleCron` — 30 min (server.js:4953)

- **Co:** Throttle/pauznout mailboxy podle bounce rate (S11). Logic v `src/mailboxBounceThrottle.js`, cron file je jen wrapper.
- **Závislosti:** `outreach_mailboxes` (RW), `send_events` (R).
- **Side effect bez cron:** Mailbox s vysokým bounce rate dál posílá → sender reputation damage → Seznam blokace celého domain pool.
- **Migration target:** Go port jako součást orchestrator bounce monitor cluster.
- **Effort:** MEDIUM (~4h). SQL + status_reason update; threshold knobs z operator_settings.

#### 5. `runBounceRateMonitorCron` — 30 min (server.js:4955)

- **Co:** AR11 auto-pause mailboxů s 24h bounce rate ≥5% (hard + soft 4xx kombinováno), Sentry alert (src/server-routes/bounceRateMonitor.js:27-60+).
- **Závislosti:** `send_events` (R), `outreach_mailboxes` (RW), Sentry.
- **Side effect bez cron:** Same as #4 — sender reputation collapse v noci kdy operator spí.
- **Migration target:** Go cron v orchestrator/intelligence; logic se překládá 1:1.
- **Effort:** TRIVIAL (~2h). Pure SQL + Sentry SDK.

#### 6. `runMailboxHealingCron` — 15 min (server.js:4956)

- **Co:** Auto-unpause mailboxů s `status_reason LIKE 'auto:%'` 10+ min pauzovaných, full-check ověří SMTP, pokud OK → `status='active'` (src/crons/runMailboxHealingCron.js:7-47).
- **Závislosti:** `outreach_mailboxes` (RW), volá lokální `/api/mailboxes/:id/full-check`.
- **Side effect bez cron:** Mailbox po transient SMTP failu zůstane paused → daily cap nevyužitý → propášené sendy v UTC noci.
- **Migration target:** Go cron + Go-native full-check (existuje v `features/inbound/orchestrator/protections`).
- **Effort:** MEDIUM (~4h). Závisí na Go-native full-check — pokud chybí, MEDIUM+; pokud existuje, TRIVIAL.

#### 7. `runGreylistRetryCron` — 10 min (server.js:5048)

- **Co:** Retry `email_verify_queue` pro greylisting + mailbox greylist alerts (src/crons/runGreylistRetryCron.js:13-50+). Worker-safe FOR UPDATE SKIP LOCKED.
- **Závislosti:** `email_verify_queue` (RW), `companies` (RW), externí MX/SMTP verify probe.
- **Side effect bez cron:** Verify queue se hromadí, contacts zůstávají unverified → nemůžu je vložit do campaign.
- **Migration target:** Existuje `features/inbound/orchestrator/intelligence/email_verify*` — port + reuse.
- **Effort:** MEDIUM (~6h). Verify probe path má SOCKS5 dependency, ale Go orchestrator už má relay client.

---

### MAINTENANCE (BFF lokálně OK)

#### 8. `runStaleHealthCheckCron` — 1 min (server.js:4874)

- **Co:** Refresh stale `mailbox_check_cache` (>90s) pro UI tooltip čerstvost (src/crons/runStaleHealthCheckCron.js:9-35).
- **Side effect bez cron:** UI tooltipy se starší než 90s — operator nepozoruje, dokud manually nečekne. Nepoškozuje delivery.
- **Migration target:** Keep BFF. UI surface = operátorův dashboard, cache potřebná jen když operator se dívá.
- **Effort:** 0.

#### 9. `runMailboxHealthCycleCron` — 30 min (server.js:4950)

- **Co:** Full-check degraded mailboxů (score<50 OR auth_fail>0 OR consecutive_bounces>2) + auto-resume recovered (src/crons/runMailboxHealthCycleCron.js:11-50+).
- **Side effect bez cron:** Recovered mailboxy zůstanou paused do operator-time. Nejde o delivery degradation, jen o latency v recovery.
- **Migration target:** Keep BFF. Overlaps s #6 (healing) — pokud #6 migruje, tento je redundant subset.
- **Effort:** 0. Případně delete po #6 migraci.

#### 10. `runCampaignWatchdogCron` — 1 h (server.js:4951)

- **Co:** Auto-pause kampaní s bounce >5%, log low-reply-rate flag (src/crons/runCampaignWatchdogCron.js:9-50+).
- **Side effect bez cron:** Kampaň s vysokým bounce dál posílá. ALE: per-mailbox throttle (#4/#5) chytá problém na úrovni mailboxu rychleji — campaign-level watchdog je secondary defense.
- **Migration target:** Move s ostatními bounce monitors do Go, ale ne v prvním sprintu. Per-mailbox stačí pro reputation defense.
- **Effort:** 0 v Z3. Move v Z4+ (~3h).

#### 11. `runScoringRecomputeCron` — 1 h (server.js:5094)

- **Co:** Batch-recompute composite scores pro companies stale >24h (src/crons/runScoringRecomputeCron.js:12-29). Batch size `SCORING_BATCH_SIZE`.
- **Side effect bez cron:** Score čerstvost roste z 24h → 36h pokud operator zaspí. Ne kritické — campaign selectors používají score, ale lag <48h je akceptovatelný.
- **Migration target:** Keep BFF. Pure batch processing.
- **Effort:** 0.

#### 12. `runEnrichmentMVRefreshCron` — 10 min (server.js:5097)

- **Co:** `REFRESH MATERIALIZED VIEW CONCURRENTLY company_current_facts` (src/crons/runEnrichmentMVRefreshCron.js:9-19).
- **Side effect bez cron:** MV se nezrefreshne → operator vidí stale facts v UI. Žádný delivery impact.
- **Migration target:** Keep BFF.
- **Effort:** 0.

#### 13. `runEnrichmentWorkerTick` — 30 s (server.js:5100, def server.js:4634)

- **Co:** Tick enrichment workeru — fetch/parse enabled `enrichment_sources` pro stale companies, batch 25.
- **Side effect bez cron:** Enrichment data freshness klesá. Žádný delivery impact, jen UI signal.
- **Migration target:** Keep BFF. Pokud operator dělá enrichment průzkum večer, stačí ranní reboot.
- **Effort:** 0.

#### 14. `runAdaptiveRefreshCron` — 6 h (server.js:5103)

- **Co:** Enqueue `enrichment_jobs` pro stale (company, source) pairs (src/crons/runAdaptiveRefreshCron.js:9-40+).
- **Side effect bez cron:** Refresh planning lag → některé companies se refreshnou později. Žádný delivery impact.
- **Migration target:** Keep BFF.
- **Effort:** 0.

#### 15. `mailboxAutoRecover` — 6 h (server.js:5118, def server.js:5270)

- **Co:** Soft auto-recover mailboxů s score<50, status='active', no circuit open, žádný auto-heal v posledních 12h. UPDATE counters + INSERT watchdog_events.
- **Side effect bez cron:** Mailboxy s low-score nedostanou refresh canary_remaining/bounces — daily cap throttled. 6h lag akceptovatelný.
- **Migration target:** Keep BFF.
- **Effort:** 0.

#### 16. `runMullvadEndpointReputationCron` — 6 h (server.js:5152)

- **Co:** AR15 detekce per-endpoint elevated bounce rate vs fleet mean za 7d window (src/server-routes/endpointHealth.js:23-60+).
- **Side effect bez cron:** Single-IP blacklist signal lag 6h→12h. Detection sloužený UI flag, nepauzuje automaticky.
- **Migration target:** Keep BFF.
- **Effort:** 0.

---

### NICE-TO-HAVE (operator-time-aware, consider delete)

#### 17. `runHumanBehaviorSimulationCron` — 4 h (server.js:5140)

- **Co:** AR10 — sample 30% mailboxů, performovat mark-read/reply/archive/draft IMAP akce na UNSEEN messages přes SOCKS5 (src/crons/runHumanBehaviorSimulationCron.js:15-40+).
- **Side effect bez cron:** Mailbox bot-fingerprint signal stoupá — nikdy "neotevírá" maily → Seznam fraud detection může escalovat. Ale jen pokud running 0× za 24h.
- **Migration target:** Keep BFF. 4h interval znamená 6 ticků/24h; pokud operator drží Mac aktivní 8-16h/den, beží 2-4× → dost pro signal.
- **Effort:** 0. Pokud reálná detekce zhoršena, port do Go (~6h).

#### 18. `runImapIdleKeepAliveCron` — 30 min (server.js:5148)

- **Co:** AR14 — open IMAP IDLE pro mailboxy v jejich 2h nightly slot (src/crons/runImapIdleKeepAliveCron.js:11-40+). Bot-fingerprint defense.
- **Side effect bez cron:** "Nightly IDLE" pattern nesplněn → Seznam vidí mailbox jako bot (nikdy IDLE v noci). Ale když BFF lokálně off=noc, je tohle absurdní: nemůže IDLE když Mac sleeps.
- **Migration target:** Move to Go IF anti-fraud signal měřitelně klesne. Jinak DELETE — schedule žije v UTC noci ale operator Mac sleeps v té době.
- **Effort:** 2h delete review NEBO 6h port do Go.

#### 19. `runFullInboxScanCron` — 14:00 Prague daily (server.js:5144)

- **Co:** AR14 daily full INBOX scan posledních 7d (no state changes, jen behavioural signal pro Seznam) (src/crons/runFullInboxScanCron.js:11-30+).
- **Side effect bez cron:** Daily scan pattern chybí → bot signal. Lze run při operator boot (libovolný čas dne).
- **Migration target:** Keep BFF. 14:00 Prague = operator typicky aktivní. Migrate jen pokud operator chybí v daný den.
- **Effort:** 0.

#### 20. `runPoolCapacityCron` — 1 h (server.js:5158)

- **Co:** AS4 — alert Sentry když pinned_endpoints/pool_size ≥ 0.8 warn nebo ≥1.0 error (src/server-routes/poolCapacityMonitor.js:58-80+).
- **Side effect bez cron:** Pool exhaustion lag detected; ale wgpool má vlastní failover. Notifikace, ne enforce.
- **Migration target:** Keep BFF nebo move do Go orchestrator (cheap port).
- **Effort:** 0 nebo ~2h port.

---

## Migration roadmap (Z3+)

### Sprint Z3 — first wave (7 CRITICAL)

Bundling v PR groups dle DAG závislostí:

- **PR1 — IMAP ingest** (`runImapPollCron` + `runOutboundReplyCron`): single largest impact; reuse `features/inbound/orchestrator/imap/poller.go`. Estimate ~11h.
- **PR2 — Bounce defense** (`runBounceFlipCron` + `runMailboxBounceThrottleCron` + `runBounceRateMonitorCron`): SQL-only, no external I/O. ~8h.
- **PR3 — Mailbox healing** (`runMailboxHealingCron`): depends on Go-native full-check existence. ~4h.
- **PR4 — Greylist retry** (`runGreylistRetryCron`): SOCKS5 dependency. ~6h.

### Per-cron acceptance criteria (per spawn-first protocol)

1. machinery-outreach (`features/inbound/orchestrator/cmd/outreach`) startup logs show tick: `[cron] <name> duration_ms=<n>` (already a discipline test pattern).
2. BFF cron schedule gated by env `MIGRATED_<NAME>=true` (default off until verified).
3. After 24h stable Go tick, BFF cron explicitly deleted from `startCronEngine()` + tested by `tests/audit/ar6-cron-jitter.test.js` ratchet update.

### Cleanup phase (Z4)

- Drop `runCampaignWatchdogCron` after #4 +#5 in Go for 7d (campaign-level redundant once per-mailbox is 24/7).
- Review `runImapIdleKeepAliveCron` — delete vs port based on Seznam reputation signal change.
