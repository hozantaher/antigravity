# Garaaage Launch Plan v3 — post S0/S1/S3

> **Aktualizováno**: 2026-04-25 po dokončení 3 sprintů.
> **Branch**: `feat/brownfield-hardening-2026-04-25` — PR #25 (19 commitů, 1206 tests race-clean)
> **Změna oproti v2**: S0 + S1 + S3 hotové, focus přesouván na S2 (launch) + S4 (UI bridge) + S5 (security)

## 1. Aktuální stav

### ✅ Hotovo

| Komponenta | Status | Commit |
|---|---|---|
| Send pipeline (relay → Seznam SMTP) | proven (3 emails delivered live) | (validated) |
| Mailboxy mb=631/632 active + creds | working | (operator) |
| Persony (B. Maarek) v DB | populated | (db) |
| Suppression UNION (čl. 21) | both tables filtered at every read | `e000fb9`, `caba00a` |
| Campaign 455 (draft, 20 enrolled) | ready | (sql bypass) |
| Brownfield hardening (8 commitů) | 1206 tests race-clean | `e000fb9..c508366` |
| **S0** Per-recipient unsub token | HMAC-SHA256, base URL env | `f798595` |
| **S0** BFF /unsubscribe endpoint | rate-limited, idempotent, audited | `f798595` |
| **S0** Compliance footer v templatu | placeholdery `[IČO]` `[sídlo]` | `f798595` |
| **S0** LIA-001 + ROPA + privacy policy | drafty s `[OP]` placeholdery | `f798595` |
| **S1** Reply Sentry alerts | každý non-ooo reply → ops issue stream | `710a54d` |
| **S1** Forward-to-Garaaage stub | manual handoff audit trail | `710a54d` |
| **S3** GDPR DSR access endpoint | 8 tabulek aggregate | `710a54d` |
| **S3** GDPR DSR erase endpoint | transactional cascade, suppression kept | `710a54d` |
| **S3** DSR runbook (Czech) | čl. 15/16/17/21 workflows | `710a54d` |

### ❌ Otevřené sprinty

| Sprint | Cíl | Effort | Blokuje |
|---|---|---|---|
| **S2** | First send (kampaň 455) | 30 min | nic (S0 hotov) |
| **S4** | Cesta B: UI campaign flow | 2–3 dny | Cesta A retire |
| **S5** | Security hardening | 1–2 dny | scale ≥50/měsíc |
| **S6** | Scale-readiness | 3–4 dny | growth |
| **S7** | Maintenance debt | 2 dny | nothing critical |

## 2. S2 — First send (NEXT critical action)

### Operator-only kroky před launch
1. Replace placeholders v `features/outreach/campaigns/configs/templates/initial.tmpl`:
   - `IČO_PLACEHOLDER` → reálné IČO Garaaage s.r.o.
   - `SÍDLO_PLACEHOLDER` → reálné sídlo
2. Commit + push
3. Deploy Railway (auto z PR po merge / manual z branch)
4. Set Railway env `UNSUBSCRIBE_BASE_URL` na BFF public URL
5. Test unsub link manually (curl)
6. Activate: `UPDATE campaigns SET status='running' WHERE id=455`

### Exit
- [ ] 20 send_events status='sent' (max 1h od activate)
- [ ] Bounce rate < 5%
- [ ] Žádný auto-paused mailbox
- [ ] Footer renderuje s reálnými IČO/sídlo
- [ ] Unsub link funkční

### Risks
- **R2.1**: Footer s placeholdery → spam-flag + reputační hit. Hard pre-req: replace before send.
- **R2.2**: BFF nedeployed na Railway → /unsubscribe = 404. Lokální BFF (běží teď na :18001) není public.
- **R2.3**: Bounce spike → watchdog auto-pause (existing mechanism).

## 3. S4 — Cesta B: UI campaign flow

### Cíl
Operator vytvoří kampaň přes UI. Cesta A SQL retired.

### Scope
- BFF `POST /api/campaigns` proxies do Go service
- UI Step3: multi-checkbox sectors místo segment_id dropdown
- Contract test alignment
- Drop dead `campaign_enrollments`
- Archive `scripts/campaigns/launch-001-*.sql`

### Exit
- [ ] Operator vytvoří kampaň 456 přes UI s 20+ enrolled
- [ ] Žádný direct-DB INSERT do campaigns/campaign_contacts v BFF
- [ ] `campaign_enrollments` dropped, no runtime errors

## 4. S5 — Security hardening

### Scope
- pgcrypto column-level encrypt `outreach_mailboxes.password`
- Decrypt helper v `features/outreach/mailboxes/mailbox/postgres.go`
- Secret v Railway env `MAILBOX_SECRET_KEY`
- Retention cron (denně 03:00 Prague)
- Better proxy provider (paid CZ-region SOCKS5)
- DPA s proxy provider

## 5. S6 — Scale-readiness

### Scope
- DPIA-001 dokument
- 3+ nové Seznam mailboxy
- Multi-step sequence (followup1, final)
- Refresh ETL automation (quarterly cron)
- SCC dokumentace pokud Railway non-EU
- Reply triage UI expand (photo+TP preview)

## 6. S7 — Maintenance debt

### Scope
- IMAP poller delta-detection (#27): schema migrace `last_processed_uid` + `uid_validity`
- contacts.first_name cleanup (regex bad-pattern → NULL, ~600k rows v 50k chunks)
- 10 pre-existing failing JS tests triage
- BFF send-test gate fix (honor anti-trace-relay configured)
- Mailbox warmup ramp test

## 7. Operator-supplied placeholders

| Field | Kde | Blokuje |
|---|---|---|
| IČO Garaaage s.r.o. | `initial.tmpl`, `lia-001`, `ropa`, `privacy-policy` | **S2** |
| Sídlo (ulice, město, PSČ) | tytéž | **S2** |
| Kontaktní email pro DSR | `privacy-policy.md` | nice-to-have |
| Phone strategy (776 299 933?) | `initial.tmpl` | LOW |
| Railway region | `ropa` + `privacy-policy` | S5 SCC pokud non-EU |
| Garaaage portal listing flow | S1 forward-to-garaaage real | S6 scale |

## 8. Critical path

```
S0 ──┐
S1 ──┤
S3 ──┤   ├─> [op fills IČO+sídlo] ─> S2 ── first send ──> retro decision
                                                              │
                                                              ├─> S4 (UI flow)
                                                              ├─> S5 (security)
                                                              ├─> S7 (debt)
                                                              │
                                                              ▼
                                                           S6 (scale)
```

## 9. Risk register

| ID | Risk | Likelihood | Impact | Mitigation |
|---|---|---|---|---|
| R2.1 | IČO/sídlo placeholdery nereplaced před send | HIGH | spam flag, brand damage | hard pre-launch check |
| R2.2 | BFF /unsubscribe není public na Railway | HIGH | unsub klik = 404 | deploy BFF na Railway před S2 |
| R2.3 | Bounce > 5% | MED | watchdog auto-pause | existing mechanism |
| R4.1 | Go service unreachable z BFF | LOW | proxy fails | fallback native bridge |
| R5.1 | Encrypt migration loses passwords | LOW-CRIT | sends fail | transactional + backup |
| R6.1 | Scale before hardening done | HIGH | repeated violations | DoD gate |
| R7.1 | Garaaage portal neexistuje | HIGH | reply conversion = 0 | manual ops bridge documented |

## 10. Immediate next actions

| # | Action | Owner | Blokuje |
|---|---|---|---|
| 1 | Replace IČO/sídlo placeholders v `initial.tmpl` | **OP** | S2 |
| 2 | Deploy BFF na Railway (public URL) | **OP** | S2 unsub link |
| 3 | Set `UNSUBSCRIBE_BASE_URL` env na Railway | **OP** | S2 token URL |
| 4 | Replace `[OP]` placeholders v compliance docs | **OP** | LIA/ROPA accuracy |
| 5 | Test unsub link manually (curl) | Claude | S2 confirmation |
| 6 | Activate kampaň 455 | **OP** | S2 launch |
| 7 | 24h monitoring + retro | OP+Claude | S6 gate |
| 8 | S4 BFF→Go bridge | Claude | future campaigns |
| 9 | S5 mailbox encryption | Claude | scale prep |
| 10 | S7 maintenance debt | Claude | code quality |
