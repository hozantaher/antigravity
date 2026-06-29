# SMTP Egress Lockdown — Call-Site Audit (R1)

> Scope: every `net.Dial`/`net.connect`/`tls.connect`/`smtp.NewClient`/proxy-probe site in the repo that opens TCP/TLS to a mail service (SMTP 25/465/587, IMAP 143/993). Sister plan: `SMTP-EGRESS-LOCKDOWN-SPRINTS.md`.
>
> Audit date: 2026-04-21. Branch: `wm/egress-lockdown`.
>
> Sprint legend:
> - **R2** pre-commit guard (fixture only, no code move)
> - **R3** relay API extension (new relay endpoints)
> - **R4** remove Go engine direct fallback
> - **R5** BFF consolidation (delete duplicates + forward to relay)
> - **R6** validation probe migration
> - **R7** runtime dial guard
> - **R8a/b/c** DNS blackhole / firewall / IP rotation
> - **KEEP** legitimate, stays in `anti-trace-relay` / `privacy-gateway`

---

## 1 — Direct TCP / TLS egress (NO proxy) — **highest priority**

| # | file | line | symbol | what | sprint |
|---|------|------|--------|------|--------|
| 1 | `modules/outreach/internal/sender/engine.go` | 336-362 | `Engine.Start` else-branch | Fallback path when `antiTrace==nil`. Calls `e.send(ctx, mailbox, req)` which does raw `net.Dial` to mailbox SMTP host. | **R4** delete else |
| 2 | `modules/outreach/internal/sender/engine.go` | 408-421 | `send()` dial closure | `net.Dial(network, address)` when `mailbox.ProxyURL == ""`. Also direct when proxy-URL parse fails (`perr != nil`). | **R4** delete with send() |
| 3 | `modules/outreach/internal/sender/engine.go` | 425-463 | `send()` SMTP client wiring | `tls.Client(rawConn, …)` (port 465), `smtp.NewClient(...)` + `StartTLS` (port 587). Chained from dial closure above — dies when else-branch deletes. | **R4** delete with send() |
| 4 | `modules/outreach/internal/validation/smtp_probe.go` | 49-65 | `SMTPProbeValidator.Validate` | `net.Dialer.DialContext(ctx, "tcp", mx:25)` then fallback to `mx:587`. Email verification RCPT-TO probe. | **R6** reroute to relay `/v1/verify` OR flag-disable |
| 5 | `features/platform/outreach-dashboard/src/lib/emailProbe.js` | 63-128 | `probeRCPT(mxHost, ...)` | `net.createConnection({ host: mxHost, port: 25 })` + RCPT-TO handshake. Email verification. | **R6** reroute to relay `/v1/verify` OR flag-disable |
| 6 | `features/platform/outreach-dashboard/server.js` | 2824-2900 | `smtpCheck(host, port, …)` | Direct TCP/`tls.connect` to mailbox SMTP host when called without proxy. All `full-check` calls without proxy go here. This is the exact path that leaked our IP during the 2026-04-21 incident. | **R5** delete, forward to relay `/v1/probe` |

---

## 2 — SOCKS5-wrapped egress (duplicates relay's `RotatingProxyTransport`)

| # | file | line | symbol | what | sprint |
|---|------|------|--------|------|--------|
| 7 | `features/platform/outreach-dashboard/server.js` | 2058-2072 | `socks5Probe(proxyHost, proxyPort, …, targetHost, targetPort)` | Hardcoded default `smtp.seznam.cz:465`. Used to validate that a SOCKS5 proxy can reach our SMTP. Duplicates relay probe. | **R5** delete, forward to `/v1/proxy-pool` health |
| 8 | `features/platform/outreach-dashboard/server.js` | 2691-2748 | `smtpAuthProbe(proxyAddr, smtpHost, …)` | SOCKS5 → TLS → SMTP AUTH probe. Used in `assignBestProxy` and `bulk-check`. Duplicates relay's SMTP deliverer auth-check. | **R5** delete, forward to `/v1/auth-check` |
| 9 | `features/platform/outreach-dashboard/server.js` | 2149-2485 | `proxyCache`, `refreshProxyPool`, `rankProxies`, `isBlacklisted`, `getProxyCache` | Parallel proxy pool maintained in BFF. Reimplements `features/outreach/anti-trace-relay/internal/transport/proxy_pool.go`'s `RotatingProxyTransport`. | **R5** delete, forward to `/v1/proxy-pool` |
| 10 | `features/platform/outreach-dashboard/server.js` | 3648-3671 | `assignBestProxy(mailboxId)` | Iterates 95+ working proxies with `smtpAuthProbe` each (10-20s) → 50s timeout problem. Duplicates relay's round-robin pick. | **R5** delete, forward to `/v1/auth-check` |
| 11 | `features/platform/outreach-dashboard/server.js` | 2216 | `applyAutomationRules` → `assignBestProxy` | Self-heal logic in BFF reassigns proxy on failure. Logic layer stays in BFF; only probe source moves to relay. | **R5** keep logic, swap data source |
| 12 | `features/platform/outreach-dashboard/server.js` | 2953-3317 | IMAP probe variants (`tls.connect({ socket: sock, …})` at lines 2953, 2966, 2990, 3084, 3182, 3227, 3262, 3317) | Multiple IMAP ports 143/993 probes over SOCKS5. Mailbox `full-check` IMAP subcheck. | **R5** delete, forward to `/v1/probe` |
| 13 | `features/platform/outreach-dashboard/server.js` | 4118-4166 | `bulk-check`/`full-check` branch selection | Routes to `smtpAuthProbe` (proxy) or `smtpCheck` (direct). The `smtpCheck` branch is the direct-egress risk; proxy branch is the duplicate. | **R5** delete, forward to `/v1/probe` |

---

## 3 — Relay-side constants & keep-as-is

| # | file | line | symbol | what | sprint |
|---|------|------|--------|------|--------|
| 14 | `features/outreach/anti-trace-relay/internal/transport/proxy_pool.go` | 24 | `probeTarget = "smtp.seznam.cz:465"` | Hardcoded probe target. Works today but couples relay to one provider. Consider config in follow-up. | **KEEP** (follow-up cfg) |
| 15 | `features/outreach/anti-trace-relay/internal/transport/proxy_pool.go` | 62-91 | `RotatingProxyTransport.DialContext` | Core SOCKS5 dial with fallback removal + round-robin. Legitimate. | **KEEP** + R7 wire guard |
| 16 | `features/outreach/anti-trace-relay/internal/transport/proxy_pool.go` | 82 | `NewSOCKS5Transport(proxy.addr, 30s)` + `socks.DialContext` | Inner SOCKS5 dial. Legitimate. | **KEEP** |
| 17 | `features/outreach/anti-trace-relay/internal/delivery/smtp.go` | — | `SMTPDeliverer.Send` | Uses `transport.DialContext()` (= SOCKS5-wrapped). Legitimate. | **KEEP** + R7 guard assertion |
| 18 | `features/outreach/anti-trace-relay/internal/transport/chain.go` | 110 | chain probe | Comments reference `smtp.seznam.cz:465`. Legitimate probe chain. | **KEEP** |
| 19 | `features/compliance/privacy-gateway/internal/mail/smtp_gateway.go` | — | privacy-gateway SMTP path | End-of-chain delivery using bridged credentials. Legitimate. | **KEEP** |
| 20 | `features/compliance/privacy-gateway/internal/mail/smtp_resolver.go` | — | DNS resolution for provider `smtp.*` | Inside gateway boundary. Legitimate. | **KEEP** (exempt from DNS blackhole) |

---

## 4 — HTTP API surface — relay endpoints to **add** (R3)

Relay HTTP today lives at `features/outreach/anti-trace-relay/internal/httpapi/server.go`. Existing `/v1/submit` + `/healthz` work. Add these:

| verb | path | purpose | replaces BFF site |
|------|------|---------|--------------------|
| POST | `/v1/probe` | full mailbox health check (SMTP+IMAP+proxy subchecks), drop-in BFF schema | `smtpCheck` + full-check branch |
| POST | `/v1/auth-check` | SMTP AUTH probe through proxy | `smtpAuthProbe` + `assignBestProxy` |
| GET  | `/v1/proxy-pool` | expose `RotatingProxyTransport` state (working count, candidates, last_probe_at) | `proxyCache`, `refreshProxyPool`, `rankProxies` |
| POST | `/v1/verify` | RCPT-TO probe for email validation | `probeRCPT` (JS) + `SMTPProbeValidator` (Go) |

All require `X-Gateway-Key` header. Contract test: `privacy_gateway_contract_test.go` already in place for `/v1/submit`; extend pattern for the 4 new endpoints.

---

## 5 — Config / constants to relocate

| constant | current | target | sprint |
|---|---|---|---|
| `smtp.seznam.cz:465` literal | `server.js:2058`, `proxy_pool.go:24`, `chain.go:110` | Env `RELAY_PROBE_TARGET` or config | follow-up after R5 |
| `SMTP_PORT = 25` literal | `emailProbe.js:14` | Relay `/v1/verify` | R6 |
| `SMTP_TIMEOUT_MS = 8_000` | `emailProbe.js:13` | Relay | R6 |
| `PROXY_PROBE_TOP_N`, `PROXY_TTL` | `server.js` near 2438/2475 | Relay | R5 |

---

## 6 — Test files — **excluded** from banned patterns

These reference `smtp.*:port` literals in test setup or integration fixtures. They are legitimate.

| file | context |
|------|---------|
| `features/platform/outreach-dashboard/src/test/setup.js:8,9,18` | test fixtures for mailbox rows |
| `features/platform/outreach-dashboard/src/pages/Mailboxes.components.test.jsx:19,20,29` | React component test fixtures |
| `features/platform/outreach-dashboard/src/lib/mailboxUtils.test.js:252,313,316` | util tests |
| `modules/outreach/internal/validation/smtp_probe_test.go:181` | probe test |
| `modules/outreach/internal/imap/imap_test.go:21` | IMAP config test |
| `modules/outreach/internal/imap/conn_test.go:585,593` | port-stringify edge-case test |
| `modules/outreach/internal/config/config_test.go:171,384,412` | config-parse test |
| `modules/outreach/internal/sender/engine_send_gaps_test.go:163,216,228` | engine gap tests using 127.0.0.1 listeners |
| `modules/outreach/internal/sender/coverage_gap_test.go:384` | engine coverage test |
| `features/outreach/anti-trace-relay/internal/transport/transport_test.go:749` | relay probe test |

R2 hook ALLOW regex: `_test\.(go|js|ts|jsx|tsx)$` excludes all of these.

Docs allow: `^docs/` excludes this audit + sister plans.

Relay allow: `^services/(anti-trace-relay|privacy-gateway)/` excludes KEEP rows.

---

## 7 — Cron jobs touching mail egress

| file | line | job | action |
|---|---|---|---|
| `features/platform/outreach-dashboard/server.js` | 5121, 5126 | proxy-refresh cron | delegate to `/v1/proxy-pool` (R5) |
| `features/platform/outreach-dashboard/server.js` | 5261, 5276, 5306 | `runConfigDrift` | passes `getProxyCache` — swap to relay client (R5) |
| `features/platform/outreach-dashboard/server.js` | (full-check cron at ~4090/4269) | mailbox health every 4h | delegate to `/v1/probe` (R5) |

---

## 8 — Summary counts

- Direct TCP/TLS egress sites (leak risk): **6** — engine.go ×3, smtp_probe.go ×1, emailProbe.js ×1, server.js `smtpCheck` ×1
- SOCKS5-wrapped duplicate sites: **7 region-classes** spanning ~20 line ranges in `server.js`
- Relay endpoints to add: **4**
- Relay keep-as-is sites: **5** (legitimate egress boundary)
- Config literals to externalize: **4**

After R4+R5+R6 the final grep gate:

```sh
grep -rnE '(net|tls)\.(connect|createConnection|Dial|DialContext|SendMail)' \
  features/platform/outreach-dashboard/server.js \
  features/platform/outreach-dashboard/src/lib/emailProbe.js \
  modules/outreach/internal/sender/engine.go \
  modules/outreach/internal/validation/smtp_probe.go \
  | grep -iE '(smtp|imap|:465|:587|:993|:25|:143)'
```

Must return empty. Current output: ~30 matches.

---

## 9 — Corrections vs plan V2

- Plan V2 line 162 said `features/outreach/anti-trace-relay/internal/api/handlers.go`. Correct path is `features/outreach/anti-trace-relay/internal/httpapi/server.go`. No `internal/api/` directory exists. R3 task targets the httpapi package instead.
- Plan V2 line 137 extends `.githooks/pre-commit`. Only `.githooks/pre-push` exists today. R2 creates a new `pre-commit` file.
- Plan V2 lines 40 said `server.js:2058-2072`. Actual `socks5Probe` body ends ~2083; table-7 line range corrected.
