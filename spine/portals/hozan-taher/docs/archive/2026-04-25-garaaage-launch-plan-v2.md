# Garaaage Launch Plan v2 — Sprint Sequencing

> **Aktualizováno**: 2026-04-25 po důkazu funkčního send pipeline (live email delivery via anti-trace-relay → Seznam SMTP).
> **Reorganizace priorit**: reply ops + Garaaage portal #1 (conversion gate), compliance footer #2 (legal gate). Send pipeline = proven.
> **Branch**: `feat/brownfield-hardening-2026-04-25` (PR #25)

## Aktuální stav

| Komponenta | Stav |
|---|---|
| Send pipeline (relay → Seznam SMTP) | ✅ proven (3 emails delivered live) |
| Mailboxy mb=631, mb=632 | ✅ active, creds 19-char working |
| Persony / signatury (B. Maarek) | ✅ populated |
| Suppression UNION (commits e000fb9, caba00a) | ✅ both tables filtered |
| Campaign 455 v DB | ✅ draft, 20 unique-email enrolled |
| Template (Garaaage auction angle) | ✅ committed |
| Compliance footer | ❌ **chybí** (legal blocker) |
| Reply ops workflow | ❌ **neexistuje** (conversion gate) |
| Garaaage portal pro listing | ❓ stav neznámý |
| Cesta B (UI flow) | ❌ deferred po prvním sendu |

## Sprint inventář

| # | Sprint | Cíl | Effort | Owner |
|---|---|---|---|---|
| **S0** | Compliance footer + LIA + privacy | legal-safe send | 1–2h | Claude+Op |
| **S1** | Reply ops workflow | conversion (replies neumřou) | 1–2 dny | Claude+Op |
| **S2** | First send (kampaň 455) | 20 sendů live, metriky | 2h | Op+Claude |
| **S3** | GDPR rights endpoints (Art. 15/17) | DSR response | 1 den | Claude |
| **S4** | Cesta B: UI campaign flow | retire SQL bypass | 2–3 dny | Claude |
| **S5** | Security hardening | Art. 32 + scale-prep | 1–2 dny | Claude |
| **S6** | Scale-readiness | volume 50+/měsíc | 3–4 dny | Claude+Op |
| **S7** | Maintenance debt | IMAP fix, JS tests, data QA | 2 dny | Claude |

## Critical path

```
S0 ── compliance ─┐
                  ├─> S2 ── first send ──> S3 ── DSR ──┐
S1 ── reply ops ──┘                                   │
                                  S4 + S5 + S7 ───────┤
                                                      ▼
                                                   S6 (scale)
```

## Open questions blocking sprints

| # | Otázka | Blokuje | Priority |
|---|---|---|---|
| Q1 | IČO Garaaage s.r.o. | S0 footer | **HIGH** |
| Q2 | Sídlo Garaaage | S0 footer | **HIGH** |
| Q3 | garaaage.cz/privacy live? | S0 deploy | **HIGH** |
| Q4 | Phone strategy | S0 footer | MED |
| Q5 | Reply notif kanál | S1 | **HIGH** |
| Q6 | Garaaage portal listing flow | S1 | **HIGH** |
| Q7 | Appraisal logic | S1 | **HIGH** |

## Detail sprintů

### S0 — Compliance footer + LIA

**Výstupy**:
- `features/outreach/campaigns/configs/templates/initial.tmpl` — footer s identitou + zdroj + opt-out + privacy
- Per-recipient unsub token (HMAC-SHA256) v runner.go + TemplateVars
- BFF `GET /unsubscribe?t=TOKEN` — validate, suppression_list insert, status update
- `docs/compliance/lia-001-garaaage.md` — 3-prong test
- `docs/compliance/ropa-direct-marketing.md` — Art. 30 ROPA
- `docs/legal/privacy-policy.md` — minimum viable

**Exit**: send-test generuje email s validním unsub linkem; klik → suppression insert.

### S1 — Reply ops workflow

**Výstupy**:
- `features/platform/outreach-dashboard/src/pages/Replies.jsx` — operator triage UI s classification badges + actions
- BFF `POST /api/replies/:id/forward-to-garaaage` — handoff path (manual screenshot fallback)
- Sentry alert na nový reply (non-ooo) v `runImapPollCron`
- Reply classifier unit tests on real Czech B2B samples

**Exit**: operator vidí všechny repliky, classifies, forwards.

### S2 — First send

**Výstupy**:
- Status flip → 'running'
- 20 sendů live přes relay
- 24h monitoring queries
- Decision document (scale/iterate/stop)

**Exit**: 20 send_events, bounce < 5%, no auto-paused mailbox.

### S3 — GDPR rights endpoints

**Výstupy**:
- BFF `GET /api/dsr/access?email=X` (JSON dump 7 tables)
- BFF `POST /api/dsr/erase?email=X` (cascade DELETE, suppression_list zachovat)
- `docs/playbooks/dsr-runbook.md`

**Exit**: simulated DSR runs end-to-end.

### S4 — Cesta B: UI flow

**Výstupy**:
- BFF POST /api/campaigns proxies do Go service
- UI Step3: multi-checkbox sectors místo segment dropdown
- Contract test alignment
- Drop dead `campaign_enrollments` table
- Archive Cesta A SQL skripty

**Exit**: Operator vytvoří kampaň přes UI, 20+ enrolled.

### S5 — Security hardening

**Výstupy**:
- pgcrypto column-level encryption pro `outreach_mailboxes.password`
- Retention cron (24-month auto-delete)
- /unsubscribe rate limit (10/min/IP)
- Better proxy provider (paid CZ-region SOCKS) — replace proxifly/geonode/proxyscrape
- DPA s proxy provider

**Exit**: encrypted passwords, retention runs, proxy first-attempt > 90%.

### S6 — Scale-readiness

**Výstupy**:
- DPIA-001 (Art. 35)
- 3+ nové Seznam mailboxy + persony
- Multi-step sequence (followup1, final)
- Refresh ETL automation (quarterly)
- SCC if Railway non-EU

**Exit**: 5+ mailboxes pool, multi-step running, DPIA reviewed.

### S7 — Maintenance debt

**Výstupy**:
- IMAP poller delta-detection (#27)
- contacts.first_name cleanup (regex bad-pattern → NULL, ~600k rows)
- 10 failing JS tests triage
- BFF send-test gate fix (honor relay configured)
- Mailbox warmup ramp test

**Exit**: IMAP catches mark-read race, 90%+ first_name clean, all JS tests green.

## Risk register

| ID | Risk | Likelihood | Impact | Sprint | Mitigation |
|---|---|---|---|---|---|
| R0.1 | Op nedodá IČO/sídlo | MED | S0 blocked | S0 | priority komunikace |
| R1.1 | Garaaage portal neexistuje | HIGH | S1 conversion=0 | S1 | manual ops fallback |
| R2.1 | Bounce rate spike | MED | auto-pause | S2 | watchdog handles |
| R2.2 | Proxy roulette ~30% fail | HIGH | retry latency | S5 | better provider |
| R5.1 | Encrypt migration loses data | LOW-CRIT | password lost | S5 | transactional + backup |
| R6.1 | Scale before S0 done | HIGH | repeated violations | gate | S0 hard prereq |

## Definition of done

- [ ] S0–S5 completed (PR merged)
- [ ] Kampaň 455 + min 2 další proběhly end-to-end
- [ ] DSR endpoint testovaný
- [ ] Encrypted mailbox passwords v prod DB
- [ ] Retention cron běží 30+ dní bez incidentu
- [ ] Žádný open ÚOOÚ complaint
- [ ] Reply triage UI + Garaaage handoff documented

S6 + S7 = opt-in podle business signal po S2 retro.
