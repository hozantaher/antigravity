# Brutal Test Harness — full-stack mail lifecycle simulation

**Status:** plánováno
**Datum založení:** 2026-04-29
**Trigger:** uživatel — "potřebujeme vymyslet způsob, kdy nasimulujeme odesílání e-mailů a odpovídání vč. všech funkcí systému. Vymysli brutální testovací systém, který otestuje naprosto všechny funkce našeho systému."

## Kontext

Existující testy pokrývají jednotlivé vrstvy: unit (sqlmock, vitest), kontrakt (BFF↔Go přes supertest), integration (pg-mem). E2E zatím jen Playwright pro UI happy-path. **Žádný test neexistuje, který by drovedl celý mail lifecycle skrz reálný stack od campaign create přes SMTP send + IMAP fetch + thread match + UI render až po DSR erase.**

Důsledek: integrační gapy jsou neviditelné. Příklad z dnešního auditu: `RecordInbound` ukládá jen 200-char preview, IMAP fetchne jen plain-text, UI rendruje subject místo body. Žádný unit test by tohle neodhalil — protože každá vrstva pracuje "správně" izolovaně. Jen E2E to chytne.

Cíl této iniciativy: **bezpečnostní síť, která pokryje 100 % kritických flows**, běží v CI nightly, a kterou nový PR musí projít před merge na main pro citlivé změny (orchestrator, relay, BFF, schema migrations).

## Měřitelné cíle

1. **Pokrytí všech kritických flows** — minimálně 30 scenarios pokrývajících: outbound (8), inbound (8), system health (6), GDPR (4), egress safety (4), real-time (3).
2. **Reálný stack** — testy jedou proti skutečnému `orchestrator + privacy-gateway + relay + BFF + dashboard + greenmail + mailpit + Postgres + Redis` v izolovaném docker network. Žádné mocky pro hot path.
3. **Chaos resilience** — ≥10 chaos scenarios (DB drop, SMTP timeout, IMAP auth fail, proxy exhaust, Redis down) — systém musí degradovat čitelně, ne tiše ztratit data.
4. **Property tests** — ≥5 generative property tests (thread matching idempotency, suppression UNION commutativity, MIME round-trip).
5. **Hermeticita** — žádný test nemá venkovní síťovou závislost (Mullvad, ARES, Anthropic). Stack běží na docker bridge bez egress; veškerá síť stub na lokální kontejnery.
6. **Reproducibilita** — `bash scripts/test-harness/run.sh` na čisté mašině zelená do 5 minut po prvním buildu (pak <2 min cache hit).
7. **CI signál** — nightly run + manual dispatch + per-PR pro citlivé paths (features/inbound/orchestrator, features/outreach/relay, scripts/migrations, server.js). Failure → auto-issue `kind/test priority/p1`.

Non-goals:
- Test reálné Mullvad/Seznam delivery (separátní synthetic monitoring v prod, mimo CI).
- Performance regression baseline — load testy běží, ale baseline je vodítko, ne gate (separátně).
- Mutation testing rozšíření — Stryker už existuje pro dashboard, mutation pro Go je další iniciativa.

## Architektura

```
                  ┌────────────────────────────────────────┐
                  │       services/test-harness (NEW)      │
                  │                                        │
                  │  cmd/runner    — orchestrator binary   │
                  │  internal/     ├ scenarios/  — 30+ specs│
                  │                ├ driver/    — DSL        │
                  │                ├ chaos/     — fault inj │
                  │                ├ assert/    — verify    │
                  │                └ report/    — JSON+md   │
                  └─────┬────────────────────────────┬─────┘
                        │ drive (writes)             │ verify (reads)
                        │                            │
              ┌─────────▼──────────┐       ┌─────────▼──────────┐
              │  HTTP API           │       │  SQL queries       │
              │  • BFF /api/*       │       │  • outreach_*      │
              │  • orchestrator     │       │  • message_attach. │
              │  SQL inserts        │       │  • leads, suppr.   │
              │  • seed contacts    │       │  HTTP probes       │
              │  • seed campaigns   │       │  • /healthz        │
              │  IMAP/SMTP          │       │  • /api/health/*   │
              │  • greenmail APPEND │       │  IMAP capture       │
              │    (deliver inbound)│       │  • mailpit msgs    │
              │  • mailpit clear    │       │  • greenmail INBOX │
              │  Chaos signals      │       │  Log scrape        │
              │  • toxiproxy fault  │       │  • slog op tags    │
              └─────────┬───────────┘       └─────────┬──────────┘
                        │                              │
                        ▼                              ▼
                ┌────────────────────────────────────────────┐
                │  System Under Test — docker compose       │
                │  (infra/docker/test-stack.yml, isolated   │
                │   bridge network, NO egress)              │
                │                                            │
                │  • outreach-orchestrator                   │
                │  • privacy-gateway                         │
                │  • anti-trace-relay (TRANSPORT_MODE=socks5,│
                │      WIREPROXY_CONFIG=stub localhost SOCKS)│
                │  • outreach-dashboard (BFF + Vite static)  │
                │  • greenmail (test recipient SMTP+IMAP)    │
                │  • mailpit (catch-all SMTP)                │
                │  • postgres-outreach (16-alpine)           │
                │  • postgres-firmy   (16-alpine)            │
                │  • redis (7-alpine)                        │
                │  • toxiproxy (chaos middleware)            │
                │  • dante / gost (stub SOCKS5 — nahrazuje   │
                │      wireproxy, drops outbound to ext IPs) │
                └────────────────────────────────────────────┘
```

### Klíčová rozhodnutí

| Téma | Volba | Odůvodnění |
|---|---|---|
| Driver jazyk | Go | Sdílí types s orchestrator/thread, `database/sql` pro reads, žádný extra runtime |
| Stack orchestrace | docker compose | Existující pattern (`infra/docker/docker-compose.yml`), operator už zná |
| Test recipient SMTP+IMAP | greenmail | Už v stacku; podporuje SMTP+IMAP+POP3, JMX/REST API pro driver |
| Chaos middleware | toxiproxy | TCP-level proxy, deterministic faults (latency, slicer, timeout, reset_peer); žádný source modifications |
| SOCKS5 stub místo wireproxy | gost / dante | Lokální SOCKS5 server forwarduje na docker bridge; relay si myslí že má egress, ale ven nikam nejde |
| Egress block | docker network `internal: true` + iptables OUTPUT DROP v test-runner kontejneru | Hermeticita |
| Reporter formát | structured JSON + Markdown summary | JSON pro programmatic, MD pro PR comment |
| Run mode | suite (full nightly) + filter (`--scenario=S07`) + watch (rerun on file change) | Operator UX |
| Fixture data | testdata/*.eml + scenario fixtures committed to repo | Reprodukovatelnost; žádný external download |

## Scenario Matrix (30+ scenarios)

### Outbound (S01-S08)

| ID | Název | Drive | Verify |
|---|---|---|---|
| S01 | Single send happy path | POST campaign, single contact | `outreach_messages.direction='outbound'`, mailpit má 1 mail s tracking pixel + click link |
| S02 | Campaign 10 contacts mailbox rotation | seed 10 contacts + 3 mailboxes, run | každý mailbox použit 3-4× (round-robin), 0 send_events nad cap |
| S03 | Daily cap enforcement | mailbox cap=2, queue 5 | 2 sent, 3 paused; cron heartbeat zachycený |
| S04 | Bounce 5xx → suppression | seed bouncing recipient, send | `outreach_suppressions` row, thread closed, 0 dalších send |
| S05 | Click tracking redirect | send mail, GET tracking URL `/c?t=...` | 302 redirect, `tracking_events.event='click'` row |
| S06 | Open tracking pixel | GET `/o?t=...` | 1×1 GIF response, `tracking_events.event='open'` row |
| S07 | Unsubscribe link cascade | GET `/unsubscribe?t=...` | suppression row + thread `status='closed'` + UI banner |
| S08 | Pre-send suppression filter | seed contact in suppression_list, queue send | 0 send_events, slog `op=campaign.run/suppressed` |

### Inbound (S09-S16)

| ID | Název | Drive | Verify |
|---|---|---|---|
| S09 | Plain reply matched via In-Reply-To | greenmail APPEND mail with In-Reply-To matching outbound | `outreach_messages` inbound row linked to thread |
| S10 | Reply matched via References fallback | mail with empty In-Reply-To, References has IDs | thread match correct |
| S11 | HTML + inline image + PDF attachment (S1.4 dependent) | APPEND multipart/mixed mail | `outreach_messages.body_html` sanitized + 2 `message_attachments` rows |
| S12 | No-match inbound → unmatched bucket | mail with foreign In-Reply-To | logged but no thread mutation; reply_inbox row only |
| S13 | Auto-classify "interested" → lead | reply with "yes please send pricing" | `leads.sentiment='interested'` row |
| S14 | Auto-classify "negative" → thread paused + suppression | reply with "remove me from list" | thread closed + suppression row + `events.LogComplained` |
| S15 | Oversize >25MB → skipped | APPEND 30MB attachment | no DB row, slog `op=imap.parseFetchResponse/oversize` warn |
| S16 | OOO auto-reply | reply with vacation responder phrase | thread paused 14 days, no lead created |

### System health (S17-S22)

| ID | Název | Drive | Verify |
|---|---|---|---|
| S17 | `/healthz` open while DB up | hit `/healthz` | 200 `{"status":"ok"}` |
| S18 | `/health` degraded with stale advisory lock | inject lock holder past TTL | response `status='degraded'`, `stale_advisory_lock_ids=[...]` |
| S19 | SSE mailbox health stream | open EventSource, trigger /full-check | client receives `event: mailbox` within 2s |
| S20 | Watchdog cron heartbeat | wait 60s, check cron_heartbeats | `last_status='ok'`, `last_run_at` recent |
| S21 | BFF cron logs duration | trigger known cron | slog line `[cron] <name> duration_ms=<n>` present |
| S22 | Sender daemon recovery after panic | inject panic via test endpoint | supervise restarts daemon within 30s |

### GDPR (S23-S26)

| ID | Název | Drive | Verify |
|---|---|---|---|
| S23 | Art. 15 access export | DSR endpoint with contact email | JSON has 8 sections (contacts, threads, messages, attachments, leads, suppr., bounces, tracking) |
| S24 | Art. 17 erasure 8-table cascade | DSR erase endpoint | all 8 tables 0 rows for that contact |
| S25 | Art. 17 cascade includes attachments (S1.6) | erase contact with inline images in thread | `message_attachments` 0 rows for that contact's threads |
| S26 | Audit log captured | erase + read audit_log | row with action='erase', counts JSON |

### Egress safety (S27-S30)

| ID | Název | Drive | Verify |
|---|---|---|---|
| S27 | TRANSPORT_MODE=direct refused | start relay with `direct` env | exit code != 0, slog `ErrDirectTransportForbidden` |
| S28 | wireproxy unavailable → relay startup blocks | stop SOCKS5 stub at boot | relay healthcheck red, no SMTP ever attempted |
| S29 | Send via SOCKS5 stub captured | full send | toxiproxy logs SOCKS5 CONNECT to mailpit IP only (no extern) |
| S30 | Egress to non-allowlisted host blocked | inject mail via test endpoint targeting IP outside docker net | DNS resolution fails, slog network error |

### Real-time (S31-S33)

| ID | Název | Drive | Verify |
|---|---|---|---|
| S31 | New inbound triggers PG NOTIFY (S3.2) | APPEND mail via greenmail | BFF SSE client receives event within 5s |
| S32 | ThreadDetail SSE auto-refresh (S3.3) | open SSE, send mail | DOM updates within 3s p95 |
| S33 | Mailbox auto-resume on healthy streak | inject 10 healthy probes after auth-fail | mailbox status flips to active |

## Chaos Scenarios (C01-C12)

| ID | Fault | Layer | Expected behavior |
|---|---|---|---|
| C01 | Postgres connection drop mid-send | DB | transaction rolled back, retry on next tick |
| C02 | SMTP RCPT TO timeout | mail | message stays in send_queue, exponential backoff |
| C03 | IMAP LOGIN wrong credential | mail | mailbox `degraded`, retry every 60s, no UID skip |
| C04 | SOCKS5 stub returns auth failure | proxy | relay error response, no SMTP attempted, slog clean |
| C05 | Redis disconnect | queue | SSE clients close gracefully, BFF reconnects on heartbeat |
| C06 | Greenmail rejects 4xx | mail | `outreach_bounces.bounce_kind='soft'`, retry 3x then give up |
| C07 | Greenmail rejects 5xx | mail | `bounce_kind='hard'`, suppression row created |
| C08 | Wireproxy stub crashes | proxy | relay healthcheck red within 30s, send paused |
| C09 | DB advisory lock orphaned (process killed mid-run) | DB | `/health` reports stale lock; runner refuses to start |
| C10 | Migration drift detected (sha mismatch) | DB | `scripts/migrations/run.sh` exits 4, no schema mutation |
| C11 | Tracking pixel pollution attempt (bogus token) | mail | `recordTrackingEvent` EXISTS guard rejects, no DB row |
| C12 | UI request timeout (BFF→Go) | API | dashboard shows degraded banner via `useOutreachHealth` |

## Property tests (P01-P05)

Vše via Go quick / fast-check (TS) podle layer:

| ID | Property | Implementation |
|---|---|---|
| P01 | `Parse(serialize(parsed)) ≡ parsed` MIME round-trip | `features/inbound/orchestrator/mime/parser_property_test.go` |
| P02 | Thread match je idempotentní (stejný (Message-ID, In-Reply-To, References) → stejný threadID) | `features/inbound/orchestrator/thread/match_property_test.go` |
| P03 | Suppression UNION je commutative + idempotent — `outreach_suppressions ∪ suppression_list` v jakémkoli pořadí dá stejnou množinu | `features/platform/outreach-dashboard/tests/property/suppression-union.test.ts` |
| P04 | Bounce classifier je deterministic — `Classify(x) == Classify(x)` for any x | Go quick test |
| P05 | Template render je size-bounded — pro rozumný (subject, body) input je výsledek < 256 KB | `features/platform/outreach-dashboard/tests/property/render-bounds.test.ts` |

## Load scenarios (L01-L05)

| ID | Load | SLO |
|---|---|---|
| L01 | 100 concurrent inbound messages append | všechny perzistované, 0 dupes na (mailbox, message_id), p95 process time <500ms |
| L02 | 1000-message thread render | ThreadDetail first paint <2s p95 (Playwright trace) |
| L03 | 24h continuous send 1/min | žádný memory leak (RSS plateau), 0 UID skips |
| L04 | Cron storm — heartbeats every 15s × 6 crons | DB CPU <30%, p99 query <100ms |
| L05 | 100 SSE clients on `/api/threads/stream` | žádný leak file descriptors, broadcast latency p95 <100ms |

---

## Plán (sprinty)

### Sprint T1 — Harness foundation (~3 dny)

- [ ] **T1.1** `services/test-harness` Go module skeleton — `cmd/runner/main.go`, `internal/{driver,assert,scenario,report,chaos}` packages. CLI: `runner --suite=outbound --scenario=S07 --report=md`.
- [ ] **T1.2** `infra/docker/test-stack.yml` — full stack na isolated bridge network, `internal: true` (no egress), explicit dependencies, healthchecks. SOCKS5 stub via `ginuerzh/gost` image.
- [ ] **T1.3** `scripts/test-harness/up.sh` + `down.sh` — startup waits for healthy on každý service, teardown wipes volumes. Exit code 0/1/124 (timeout).
- [ ] **T1.4** Driver DSL — `driver.SeedContact(c)`, `driver.RunCampaign(name)`, `driver.SendInbound(eml)`, `driver.HitURL(...)`, `driver.NotifyOutreach(payload)`. Each method returns typed handle for verify steps.
- [ ] **T1.5** Assert library — `assert.DBQuery(sql, args, ...)`, `assert.HTTPGet(url, expectStatus, ...)`, `assert.GreenmailMessages(filter, ...)`, `assert.SlogContains(op, ...)`. Failures collect into `Report`.
- [ ] **T1.6** Reporter — JSON output + Markdown summary; PR comment template; failure stack trace + diagnostic dump (last 100 lines logs from each container, last 50 DB rows from key tables).

### Sprint T2 — Outbound + Inbound + System scenarios (~5 dní)

- [ ] **T2.1** S01-S08 (outbound, viz matice)
- [ ] **T2.2** S09-S16 (inbound) — depends on S1.3-S1.4 mail-client-fidelity (MIME parser + RecordInbound)
- [ ] **T2.3** S17-S22 (system health)

### Sprint T3 — GDPR + Egress + Real-time (~3 dny)

- [ ] **T3.1** S23-S26 (GDPR)
- [ ] **T3.2** S27-S30 (egress safety) — kritické, blokující prod release
- [ ] **T3.3** S31-S33 (real-time) — depends on S3.1-S3.3 mail-client-fidelity

### Sprint T4 — Chaos (~2 dny)

- [ ] **T4.1** Toxiproxy wiring — `chaos.NetworkFault(target, kind, ...)` API. Reset between scenarios.
- [ ] **T4.2** C01-C06 (DB, SMTP, IMAP, proxy basics)
- [ ] **T4.3** C07-C12 (advanced — orphaned locks, drift, pollution)

### Sprint T5 — Property + Load (~2 dny)

- [ ] **T5.1** P01-P05 property tests napříč jazyky
- [ ] **T5.2** L01-L05 load harness — `autocannon` pro HTTP, custom Go pool pro SMTP/IMAP

### Sprint T6 — CI integration (~1 den)

- [ ] **T6.1** `.github/workflows/test-harness.yml` — nightly cron + manual dispatch + per-PR pro citlivé paths. Cache docker layers.
- [ ] **T6.2** GH PR comment hook — pošle Markdown summary z reporteru. Compares scenario count delta vs. base branch.
- [ ] **T6.3** Failure → auto-issue (existující `triage-failures.mjs` rozšířit o `kind/test`).

---

## Rizika

- **Stack startup time** — 9+ kontejnerů zdravých = ~30s. Mitigation: persistent dev stack (operator drží stack mezi scenarios během; jen wipe DB mezi scenarios). CI: full teardown OK (cache hot images).
- **Greenmail behavior drift od reality** — SMTP behavior hlavně. Mitigation: dokumentovat omezení v `services/test-harness/README.md`, mít synthetic monitoring v prod jako 2nd layer.
- **Toxiproxy quirks** — TCP-level fault injection má omezení (např. nelze simulovat DNS resolution failure). Mitigation: pro DNS failures inject přes `/etc/hosts` v container.
- **Test flakiness** — async eventy (SSE, IMAP poll, cron) mají jitter. Mitigation: deterministic waits + polling pomoc helper `assert.Eventually(..., timeout=5s, interval=100ms)`. Žádné fixed sleeps.
- **CI runtime** — full suite by neměl překročit 15 min nightly, 5 min per-PR (filtered). Mitigation: parallel scenario execution v independent docker namespaces.
- **Zdrojový velikost** — harness binary + fixtures by neměl > 50 MB. Mitigation: no real-world `.eml` dump; generated fixtures.

## Závislosti

- **Mail-client-fidelity S1** — scenarios S11, S15, S31 depend on MIME parser + RecordInbound rozšíření. T2.2 + T3.3 mohou začít až po S1.4 mergnutí.
- **Žádné prod creds** — testy NIKDY nesahají na real Mullvad/Seznam/Gmail/Anthropic. Per memory `feedback_no_external_services`.
- **Memory rule `feedback_no_direct_smtp`** — driver SMTP přes greenmail/mailpit, **nikdy** přímý socket.

## Blokátory

- Žádné. Existující infra (greenmail, mailpit, redis, postgres) v `infra/docker/docker-compose.yml`. Toxiproxy + gost jsou veřejné docker images.

## Log

- 2026-04-29 — založeno; navrženo 30+ scenarios, 12 chaos, 5 property, 5 load = 52 testů. 6 sprintů, ~16 dní.
