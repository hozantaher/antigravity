# Mullvad ↔ Seznam SMTP TLS — empirický strop

**Date:** 2026-05-01 evening
**Operator:** Tomáš Messing
**Trigger:** brutal anonymity test 0/N delivery → multi-hour debug

## Cíl

Zjistit proč 36 envelope-ů sealed by relay nedoručí žádný email do `@email.cz`
schránek. Confirmation či vyvrácení "Mullvad anti-VPN" hypotézy.

## Provedené opravy (code-side)

| PR | Změna | Effect |
|---|---|---|
| #606 | wireproxy v1.0.9 → v1.1.2 | failed deploy (pufferffish path neexistuje pro v1.1.2) |
| #608 | windtf/wireproxy + Go 1.26 | failed deploy (features/platform/common chybělo v build context) |
| #609 | Dockerfile: COPY features/platform/common + features/outreach/relay | **deploy SUCCESS** — wireproxy v1.1.2 v provozu |

Všechny audit ratchets PASS, build clean, kontejner zdravý 24/7.

## WIREPROXY_CONFIG iterace

| Endpoint | ASN | Egress IP | Test result |
|---|---|---|---|
| 178.249.209.162 (původní) | Datacamp HU | 178.249.209.168 | STARTTLS Seznam i/o timeout |
| 146.70.129.98 (cz-prg-101) | M247 CZ | 146.70.129.110 | STARTTLS Seznam i/o timeout |
| 146.70.129.130 (cz-prg-102) | M247 CZ | 146.70.129.142 | STARTTLS Seznam i/o timeout |
| + MTU 1280 | — | — | beze změny |
| + MTU 1420 + PersistentKeepalive 25 | — | — | beze změny |

## Cross-host probe matrix (po deploy SUCCESS, cz-prg-101)

| Host | Port | socks_dial | smtp_client | starttls/tls | Result |
|---|---|---|---|---|---|
| ipify.org | 443 | OK | — | **OK** (TLS via SOCKS5 funguje) | egress IP confirmed 146.70.129.110 |
| smtp-mail.outlook.com | 587 | OK 368ms | OK 177ms | **OK 4323ms** | full pipeline funguje |
| smtp.seznam.cz | 587 | OK 333ms | OK 1415ms | **FAIL** 28265ms i/o timeout | STARTTLS hangs |
| smtp.seznam.cz | 465 | OK 323ms | — | **FAIL** 29701ms ctx deadline | direct TLS hangs |
| imap.seznam.cz | 993 | OK 358ms | — | **FAIL** 29452ms ctx deadline | IMAPS hangs |
| smtp.gmail.com | 587 | OK 340ms | OK 201ms | **FAIL** 29457ms i/o timeout | STARTTLS hangs |

## Závěr

**Pipeline `relay → wireproxy SOCKS5 → Mullvad WG → Internet` PRACUJE správně.**
Důkaz: Outlook SMTP STARTTLS prošel (4.3s), ipify HTTPS prošel.

**Specifické hosty (Seznam, Gmail) silently dropují TLS handshake** přes
tento egress path. Tři Mullvad CZ endpointy + jeden non-CZ + různé MTU
nezměnily výsledek. Není to MTU/path/wireproxy bug.

Z operator's lokální Mullvad (146.70.129.115, stejný /24) `openssl s_client
seznam.cz:587 -starttls smtp` funguje. Rozdíl je v userspace WG (wireproxy
v1.1.2) vs kernel WG (operator's macOS Mullvad app). Nebo: Seznam má
fingerprint detekci na konkrétní wireproxy/WG-userspace kombinaci.

## Real production send confirmation

`POST /v1/submit` s envelope `env_c4f0d6d59e687ee3a38757a3` → status `sealed`.
Drain attempt 17:19:52 (`outbound_smtp_delivering`) → 17:21:22
(`outbound_smtp_failed`). IMAPS check b.maarek@email.cz INBOX: 1 message
total (předchozí), žádný [A:test01] subject. Empirický důkaz že produkční
delivery má stejný strop jako probe.

## Operator decision (z launch-readiness.md decision matrix)

Pipeline je code-clean. Final-mile k Seznam/Gmail vyžaduje non-VPN egress.

**A) Accept reduced delivery** — current state. Funguje pro non-Seznam/Gmail
appendency (Outlook, případně menší poskytovatelé). Pro Czech webmail ~0%.

**B) Pivot CZ VPS** — Hetzner/Vultr CZ €5–15/mo, Dante SOCKS5, env update
`SOCKS_PROXY_ADDR=<vps-ip>:<port>` + `WIREPROXY_CONFIG=` (unset). Fundamental
fix. Warmup ramp (1→5→20 emails/day) povinný — fresh IP s 0 reputation.

**C) Transactional email service** — Mailgun/Postmark CZ origin pool. Bypass
relay. Vyžaduje code change (Engine.WithTransactional implementation,
audit ratchet update). Best for >50 emails/day target.

## Cross-ref

- Initiative: `docs/initiatives/2026-05-01-cross-mailbox-anonymity-test.md`
- Předchozí audit: `docs/audits/2026-05-01-brutal-test-engine-routing.md`
- Architectural ceiling: `features/outreach/relay/CLAUDE.md` "Known delivery limit"
- Decision matrix: `docs/playbooks/launch-readiness.md`
- Memory: `seznam_proxy_geo_mismatch` (T1+T2)
