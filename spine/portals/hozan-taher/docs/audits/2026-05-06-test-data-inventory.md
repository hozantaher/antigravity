# Deep inventory testovací data — středa 6.5.2026 00:30

**Status:** Pre-launch audit
**Trigger:** Operator chce vědět co je test/dev/seed vs reálná production data před aktivací campaign 457.

## TL;DR

| Kategorie | Stav |
|---|---|
| **Production data v DB** | 1.08M companies + 524k contacts (firmy.cz + ARES scrape, real CZ businesses) |
| **Pre-launch seed** | 100 contacts v campaign 457 (top by composite_score) |
| **Test residual** | 252 outbound messages z anonymity-test runs (1.-2.5.) + 17 anonymity_test_messages + 38 audit_log entries |
| **Templates** | 6 (3 production: intro_machinery + 2 follow-ups, 3 test fixtures: id 1, 63, 65) |
| **Test fixtures v repu** | ~40 .eml soubory (orchestrator/mime, inbox/reply, blockdetect adversarial cases) + 6 placeholder .eml v tests/fixtures/operator-replies |
| **Seed scripts** | 8 SQL/MJS files + Go seed package (`features/inbound/orchestrator/seed/`) |

## DB rows per major table (snapshot 00:30)

| Table | Rows | Klasifikace |
|---|---|---|
| companies | **1 087 178** | PROD scrape (firmy.cz + ARES) |
| contacts | **524 523** | PROD scrape |
| outreach_contacts | 524 519 | Schema B sibling, sync via email_hash |
| segment_memberships | 45 855 | Segment #7 (Strojírenství) — PROD selection |
| crm_clients | **4 079** | eWAY-CRM XLSX import 2026-05-05 |
| suppression_list | 1 745 | Auto-backfill from CRM (1728) + manual (17) |
| outreach_messages | 252 | **Test sends** z anonymity-test 1.-2.5. (direction=outbound) |
| outreach_threads | 193 | Spawned by anonymity-test runs |
| email_templates | 6 | 3 prod + 3 test |
| campaign_contacts | **100** | Pre-launch seed pro campaign 457 |
| outreach_mailboxes | 4 | Production Seznam accounts |
| operator_audit_log | 38 | Today's session activity |
| anonymity_test_messages | 17 | Brutal e2e PR #885 results |
| outreach_suppressions | 17 | Schema B suppressions |
| campaigns | 1 | Pre-launch (#457 draft) |
| segments | 1 | Pre-launch (#7) |
| bounce_events | 0 | None yet |
| send_events | 0 | **Žádné production sendy ještě** |
| tracking_events | 0 | None |
| reply_inbox | 0 | None |
| leads | 0 | None |
| unmatched_inbound | 0 | None (table created v PR #888) |

## Companies kvalita (1 087 178 řádků)

| Metrika | Hodnota |
|---|---|
| Validní ICO (8 digits) | 826 142 (76%) |
| Zaniklé (datum_zaniku NOT NULL) | 0 |
| email_status='valid' | 615 214 (57%) |
| Test-named (test/demo/sample/seed) | 836 (0.08%) |
| Fake email domain (@example/@test/@localhost) | 5 (rounding error) |

**Verdict:** Produkční data, < 0.1% test residual. Real CZ business universe.

## Mailboxy (4 active)

| ID | Address | Status | Total sent | Bounced |
|---|---|---|---|---|
| 1 | mb1@redacted | active | 64 | 0 |
| 3 | mb3@redacted | active | 67 | 0 |
| 631 | mb631@redacted | active | 64 | 0 |
| 632 | mb632@redacted | active | 63 | 0 |

`total_sent` 63-67 jsou kumulativně z anonymity-test runs (memory `mb_to_mb_anonymity_ceiling` + `seznam_silently_drops_burst`). Žádný real production send.

## Suppression list breakdown (1745)

| Reason | Count | Source |
|---|---|---|
| crm_active_client | 1 728 | Auto z eWAY-CRM XLSX import (CRM-4) |
| internal-domain | 8 | Manual config (přesměrování interních adres) |
| role-account | 4 | Manual (info@/admin@ generic) |
| spamtrap | 2 | Manual |
| bounce | 2 | Manual |
| sender-self | 1 | Self-protection (1 ze 4 mailboxů) |

## Email templates (6)

| ID | Name | Body length | Created | Type |
|---|---|---|---|---|
| 1 | Test šablona | 25 chars | 2026-04-18 | **TEST** (placeholder) |
| 63 | E2E šablona 1776546590503 | 57 | 2026-04-18 | **TEST** (Playwright e2e) |
| 65 | E2E šablona 1776546705540 | 57 | 2026-04-18 | **TEST** (Playwright e2e) |
| 1889 | intro_machinery | 1446 | 2026-04-24 | **PROD** |
| 1890 | followup_1 | 564 | 2026-04-24 | PROD (sequence step 2) |
| 1891 | followup_2 | 397 | 2026-04-24 | PROD (sequence step 3) |

3 test templates jsou orphan z dev/Playwright runs. Můžou být po launchi smazány (nepoužívají je žádné kampaně).

## Test fixtures v repu

### Email .eml fixtures (~40 souborů)

- `features/inbound/orchestrator/mime/testdata/` — 7 souborů (plain, html, multipart-alt, nested-multipart, attachments, quoted-printable, inline-image) — MIME parser test fixtures
- `features/inbound/inbox/reply/testdata/adversarial/` — 13 souborů (out-of-office, empty-body, rtl-bidi, deep-quote-chain, base64-in-textplain, atd.) — reply classifier robustness
- `features/acquisition/contacts/internal/blockdetect/testdata/adversarial/` — ~20 souborů (Cloudflare challenge, Turnstile, ARES legit JSON, rate-limit body markers) — block detection pre-WAF
- `tests/fixtures/operator-replies/` — 6 placeholder .eml + 6 empty subdirs (interested/not-interested/ooo/wrong-person/spam/ambiguous) pro operator-practice setup

### JSON / config fixtures
- `features/platform/outreach-dashboard/tests/e2e/_fixtures/` — Playwright e2e setup
- `tests/fixtures/operator-replies/README.md` — protokol pro humans-add-real-replies

### Seed scripts

| Script | Účel | Last touched |
|---|---|---|
| `scripts/seed-firmy-local.sql` | Bootstrap firmy data lokálně | dev only |
| `scripts/seed-dashboard.sql` | Dashboard demo seed | dev only |
| `scripts/migrations/006_seed_multi_mailbox_pool.sql` | Mailbox seed (legacy) | applied |
| `scripts/migrations/008_seed_heavy_templates.sql` | Template seed | applied |
| `scripts/launch/seed-campaign-457.sql` | **Pre-launch seed (top 100 contacts)** | dnes ráno |
| `scripts/operator-practice/seed-replies.mjs` | Operator practice harness | dev only |
| `scripts/mail-lab/seed.sh` | Mail-lab demo data (operator + 5 prospects) | mail-lab only |
| `scripts/mail-lab/seed-replies.sh` | Mail-lab reply scenarios | mail-lab only |
| `features/inbound/orchestrator/seed/` (Go pkg) | Programmatic seed | unit tests |
| `features/inbound/orchestrator/seed/prodlike/` | Prod-like generator (synthetic) | tests |

## Anonymity test residual (252 outbound + 17 scored)

Z anonymity-test runs 1.-2.5. před current launch prep:
- 252 outbound v `outreach_messages` (test message ID s `X-Test-Run-ID` header)
- 193 threads in active status
- 17 scored v `anonymity_test_messages` (z brutal e2e PR #885 dnes večer)
- mb-to-mb internal pairs, max anonymity score 60/100 (memory ceiling)

**Ne-blokující pro launch** — runner gate filtruje by `cc.status IN ('pending','in_sequence')` a campaign_id=457 nemá tyto historické rows.

## Top 10 recipient domains v 100 seeded campaign 457

| Domain | Count | Note |
|---|---|---|
| sabata.cz | 14 | Multi-contact (high composite_score) |
| diamo.cz | 11 | Multi-contact |
| adoz.cz | 8 | Multi-contact |
| seznam.cz | 5 | Mix (operator + Seznam-hostovaní recipients) |
| sprako.cz | 5 | |
| aros-stav.cz | 4 | |
| uchytil.eu | 4 | |
| pmdp.cz | 4 | |
| elco.cz | 3 | |
| pla.cz | 3 | (3 unverified — runner skip per dnešní audit) |

Per-domain MaxPerDomainDay=5 limiter zajistí že max 5 sendů per domain per den. `sabata.cz`/14 → max 5 odeslaných (zbylých 9 v queue na další den). `diamo.cz`/11 → max 5 → zbylých 6 next day.

## Production-feel vs test-feel verdict

| Layer | Verdict |
|---|---|
| companies (1.08M) | PROD scrape, real businesses, < 0.1% test |
| contacts (524k) | PROD enrichment + scrape |
| crm_clients (4k) | PROD eWAY-CRM XLSX import dnes |
| suppression_list (1.7k) | PROD (1728 z CRM auto-backfill, 17 manual) |
| outreach_mailboxes (4) | PROD Seznam accounts |
| outreach_messages (252) | TEST RESIDUAL (anonymity-test 1.-2.5.) |
| outreach_threads (193) | TEST RESIDUAL |
| anonymity_test_messages (17) | TEST RESIDUAL (brutal e2e dnes) |
| email_templates | 3 PROD + 3 TEST |
| campaigns / segments | 1 PROD-pending / 1 PROD selection |
| campaign_contacts (100) | PRE-LAUNCH SEED |
| send_events / bounce_events / tracking_events | **0 — žádné production sendy ještě** |

**Repo není zaplněn synthetic data.** Production data převažují, test residual je marginalní.

## Cleanup recommendation post-launch (Tier 4)

| Item | Action | Severity |
|---|---|---|
| 3 test templates (id 1, 63, 65) | DELETE — nikdo je nepoužívá | LOW |
| 252 outreach_messages (test sends) | Keep nebo delete — operator decision (audit trail value vs noise) | LOW |
| 193 outreach_threads | Same as above | LOW |
| 17 anonymity_test_messages | Keep — baseline for ratchet PR #811 | KEEP |
| Test residual neničí production path — žádný urgentní cleanup | – | – |

## Pre-launch state — žádný blocker z testovacích dat

- ✅ campaign 457 seeded čisté top-100 contacts
- ✅ Žádné test contacts v segment_memberships #7
- ✅ Test templates nejsou wired do campaign 457 (uses `intro_machinery`)
- ✅ Test mailboxy neexistují — všechny 4 jsou production
- ✅ Žádné fake @example/@test domains v eligible recipients
