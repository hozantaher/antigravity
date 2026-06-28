**Status:** Archived
**Datum:** 2026-04-25
**Trigger:** Launch plan v4 executed as master plan; superseded by 2026-04-30 master plan

# Garaaage Launch Plan v4 — Code complete, ops-blocked

> **Aktualizováno**: 2026-04-25 po 26 commitů na PR #25
> **Změna oproti v3**: 9 sprintů hotových, kód je production-ready, kritická cesta = operator action

## 1. Aktuální stav

**PR #25** branch `feat/brownfield-hardening-2026-04-25`:
- 26 commitů
- Go: 2474 tests race-clean (campaigns + contacts + sender)
- JS: 2363 tests passing (0 failing)
- Live email delivery proven (3 emails delivered přes anti-trace-relay)
- Kampaň 455 v DB, draft, 20 unique-email enrolled

### ✅ Hotovo (code-complete)

| Sprint | Co | Commit |
|---|---|---|
| Brownfield (8 prior) | suppression UNION, retry classifier, pause race, circuit reset, status vocab, recalc errors, registry panic recovery | `e000fb9..c508366` |
| S0 | Compliance: unsub token + endpoint + footer + LIA + ROPA + privacy | `f798595` |
| S1 | Reply ops: Sentry alerts + Garaaage forward stub | `710a54d` |
| S3 | GDPR DSR access + erase endpoints + runbook | `710a54d` |
| S4.1 | BFF→Go POST /api/campaigns proxy | `0e9a3ee` |
| S4.2 | BFF→Go run/pause proxy | `0e9a3ee` |
| S4.3 | UI multi-checkbox sectors (Step 3) | `69608de` |
| S4.4 | Drop dead campaign_enrollments (migration ready) | `2df4cea` |
| S4.5 | Archive Cesta A SQL scripts | `2df4cea` |
| S5.1 | Mailbox encryption phase 1+2 migrations + 4-phase runbook | `f6bca2a` |
| S7.1 | BFF send-test honor anti-trace-relay | `0e9a3ee` |
| S7.2 | contacts.first_name regex cleanup migration | `2df4cea` |
| S7.3 | Failing JS tests triage (10→0) | `ebc39e2` |

### ⏳ Otevřené sprinty

| Sprint | Status | Důvod |
|---|---|---|
| **S2** First send | operator-blocked | placeholdery + Railway deploy |
| **S5 phase 3** | code work autonomous + ops verification | Go-side encrypted reads with feature flag |
| **S5 phase 4** | 30+ dní po phase 3 | DROP plaintext column |
| **S6** Scale | gate S2 retro | depends on reply rate signal |
| **#27** IMAP delta | code autonomous | last_processed_uid tracking |
| **PR review** | — | merge gate |

## 2. Critical path

```
[Q1+Q2 fill IČO/sídlo] → [deploy BFF na Railway, set UNSUBSCRIBE_BASE_URL]
       → [test unsub link manually] → [activate kampaň 455]
              → [24h monitoring]
                     → [S2 retro decision: scale / iterate / stop]
                            ├─> S6 scale (if reply rate ≥ 1%)
                            ├─> S5 phase 3 (operator-coordinated, parallel)
                            └─> PR #25 review + merge
```

## 3. Sprinty

### S2 — First send (operator-driven, ~2h)

**Pre-requisites** (operator):
1. **Q1 IČO Garaaage s.r.o.** — replace `IČO_PLACEHOLDER` v `features/outreach/campaigns/configs/templates/initial.tmpl`
2. **Q2 Sídlo** — replace `SÍDLO_PLACEHOLDER` v initial.tmpl + LIA + ROPA + privacy
3. **Q3 garaaage.cz/privacy** live (nebo fallback GitHub Pages)
4. **Deploy BFF na Railway** s public URL (pro /unsubscribe link)
5. **Set `UNSUBSCRIBE_BASE_URL`** env na Railway

**Execution**:
1. Test unsub link manually (curl proti deployed BFF)
2. Send-test mb=631 + mb=632 → operator email (verify footer renders correctly)
3. Activate: `UPDATE campaigns SET status='running' WHERE id=455`
4. 24h monitoring (queries v `docs/playbooks/LAUNCH-CAMPAIGN-001.md`)

### S5 phase 3-4 — Mailbox encryption

Phased rollout per `docs/playbooks/S5-mailbox-encryption.md`:

**Phase 3** (autonomous code with feature flag):
- Update `features/outreach/mailboxes/mailbox/postgres.go` mailboxColumns to support encrypted reads
- Feature flag `MAILBOX_ENCRYPTION_ENABLED=1` opt-in
- Default off → no behavior change
- Operator flips on after S5 phase 2 migration verified

**Phase 4** (30+ days after phase 3):
- DROP COLUMN password (plaintext)

### S6 — Scale-readiness (decision gate after S2)

**Trigger**: S2 retro shows reply rate ≥ 1% AND bounce ≤ 3%

**Scope** (3-4 dny):
- DPIA-001 dokument (Art. 35 GDPR — required při >50 contacts/měsíc)
- 3+ nové Seznam mailboxy + persony
- Multi-step sequence (followup1.tmpl + final.tmpl s jiným angle než initial)
- Refresh ETL automation (quarterly cron z firmy.cz/ARES)
- SCC dokumentace pokud Railway region non-EU
- Reply triage UI expand: photo+TP attachment preview + Garaaage real handoff

### #27 — IMAP delta-detection (autonomous code)

**Issue**: Current logic uses `unseen > prev_unseen` count delta. Misses replies that arrive in same poll where another message was externally marked read.

**Fix**: Track `last_processed_uid` + `uid_validity` per mailbox.
- Schema migration ALTER TABLE mailbox_imap_state
- Logic update: process UIDs > last_processed_uid
- On UIDVALIDITY change, reset (treat as fresh mailbox)

## 4. Operator-supplied placeholdery

| Field | Kde | Blokuje |
|---|---|---|
| IČO Garaaage s.r.o. | `initial.tmpl`, `lia-001`, `ropa`, `privacy-policy` | **S2** |
| Sídlo (ulice, město, PSČ) | tytéž | **S2** |
| Kontaktní email pro DSR | `privacy-policy.md` | nice-to-have |
| garaaage.cz/privacy URL stav | privacy-policy hosting | **S2** |
| Phone strategy | `initial.tmpl` | LOW |
| Railway region | `ropa` + `privacy-policy` | S6 SCC |
| `MAILBOX_SECRET_KEY` env | Railway env | S5 phase 2 |
| Garaaage portal listing flow | S1 `/forward-to-garaaage` body | S6 scale-up |

## 5. Risk register

| ID | Risk | Likelihood | Impact | Mitigation |
|---|---|---|---|---|
| R2.1 | Footer s placeholdery odejde | HIGH if forgotten | brand damage | hard pre-launch check |
| R2.2 | BFF nedeployed → unsub link 404 | HIGH if skipped | compliance violation | Railway deploy required |
| R2.3 | Bounce > 5% | MED | auto-pause | watchdog handles |
| R5.3 | Phase 3 broken decrypt → sends fail | MED | hard outage | feature flag, rollback ready |
| R5.4 | MAILBOX_SECRET_KEY lost | LOW-CRIT | recovery impossible | 1Password backup |
| R6.1 | Scale before S2 retro signal | HIGH | wasted infra | gate enforced |
| R7 | Garaaage portal neexistuje | HIGH | reply conversion = 0 | manual ops fallback |

## 6. Definition of done — celý launch program

- [x] S0–S5.1 phase 1+2 hotové
- [ ] S2 — kampaň 455 odeslána, 20 sendů, retro doc
- [ ] DSR endpoint testovaný na real contact
- [ ] BFF deployed publicly na Railway
- [ ] S5 phase 2 migration run (encrypted populated)
- [ ] S5 phase 3 (Go decrypt with feature flag) — autonomous code, ops verifies
- [ ] PR #25 merged
- [ ] S5 phase 4 (drop plaintext) — weeks later
- [ ] #27 IMAP delta-detection — autonomous code
- [ ] Žádný open ÚOOÚ complaint

## 7. Immediate next actions

| # | Action | Owner | Effort |
|---|---|---|---|
| 1 | Reply Q1 (IČO) + Q2 (sídlo) | **OP** | 1 min |
| 2 | Replace placeholders v 4 souborech | **OP** | 5 min |
| 3 | Deploy BFF na Railway | **OP** | 15 min |
| 4 | Set UNSUBSCRIBE_BASE_URL env | **OP** | 1 min |
| 5 | Test unsub link manually (curl) | OP+Claude | 5 min |
| 6 | Send-test mb=631+632 → ověření footer | OP+Claude | 5 min |
| 7 | Activate kampaň 455 | **OP** | 1 min |
| 8 | 24h monitoring | OP+Claude | passive |
| 9 | S2 retro decision | **OP** | 30 min |
| 10 | PR #25 review + merge | **OP** | 1h |
| 11 | (parallel) Run migration 003 (column add) | OP | 1 min |
| 12 | (parallel) Set MAILBOX_SECRET_KEY env | **OP** | 5 min |
| 13 | (parallel) Run migration 004 (encrypt) | OP | 1 min |
| 14 | (Claude autonomous) S5 phase 3 code (feature flag) | Claude | 2h |
| 15 | (Claude autonomous) #27 IMAP delta-detection | Claude | 2h |
| 16 | (Claude autonomous) S6.1 multi-step templates | Claude | 1h |
| 17 | (Claude autonomous) S6.2 DPIA-001 draft | Claude | 1h |

## 8. Závěr

**Code-side převážně kompletní.** Branch je production-ready pending operator placeholder fills + Railway deploy. Zbytek autonomous code je #27 + S5 phase 3 + S6 prep.

**Akční bod #1 pro operátora**: Q1 + Q2 (IČO + sídlo Garaaage s.r.o.).
