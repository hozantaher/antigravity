# Subsystem Map — Anti-Trace Email Pipeline

**Version:** 2026-05-08
**Owner:** features/outreach/campaigns + features/outreach/relay + features/inbound/orchestrator/imap
**Last verified:** 2026-05-08 via deep-read (AO/AP sprint code: poller.go, probe.go, pin.go, egress_observations.go, pool.go) + git log verification (PRs #1126, #1127, #1128, #1130, #1131, #1143)
**Refresh:** 2026-05-08 (AO/AP sprint additions: IMAP-via-SOCKS5, endpoint pin lifecycle, egress observation pipeline)

This document is the **canonical map** of the production email send pipeline. Any code that emits email MUST flow through this stack. Bypassing is a hard rule violation (see `feedback_anti_trace_full_stack` memory + `features/outreach/campaigns/sender/no_bypass_audit_test.go` audit ratchet).

> **Mandatory read:** before any code change in `features/outreach/campaigns/`, `features/outreach/relay/`, `features/inbound/orchestrator/imap/`, `features/inbound/orchestrator/cmd/anonymity-*`, or `cmd/*` that emits email or polls IMAP. Cite this doc's commit SHA in PR description.

## Pipeline — 47 numbered steps (42 original + 5 AO/AP additions)

### Layer 0 — Contact ingestion (before campaign exists)

| # | Step | File | Modifies | Gates |
|---|------|------|----------|-------|
| **E1** | `enrich.DetectHoneypot` — typo-domain Levenshtein, role-based prefixes (abuse@/postmaster@/noreply@), suspicious local parts (test/fake/null), all-numeric, RFC violations | `features/acquisition/contacts/enrichment/` (impl) + `features/inbound/orchestrator/honeypot/validation_test.go` (tests) | observe | drop at import |
| **E2** | `enrich.FixTypoDomain` — autocorrect gmail.con→gmail.com etc | same | email field | none |

### Layer 1 — Pre-launch verification (operator clicks "Activate")

| # | Step | File | Modifies | Gates |
|---|------|------|----------|-------|
| **P1** | `checkMailboxPasswords` — `length(password)>0` SQL probe, no SMTP login | `features/outreach/campaigns/campaign/preflight.go:154` | observe | block if 0 |
| **P2** | `checkSuppressionUnion` — UNION query smoke (`outreach_suppressions ∪ suppression_list`) | `preflight.go:194` | observe | block if SQL fails |
| **P3** | `checkTemplates` — render with neutral vars, catches spintax errors | `preflight.go:219` | observe | block on render error |
| **P4** | `checkPrivacyURL` — HEAD with 5s timeout, GET fallback on 405 | `preflight.go:265` | observe | block on 4xx/5xx |
| **P5** | `checkDNS` — LookupHost on sending domains | `preflight.go:333` | observe | block on resolve fail |

### Layer 2 — Runner per-tick (`campaign.RunCampaign`, 835 LoC)

| # | Step | File:Line | Modifies | Gates |
|---|------|-----------|----------|-------|
| **R1** | Load campaign + parse `sequence_config` jsonb | `runner.go:91` | observe | error → abort tick |
| **R2** | Status gate (`running`\|`draft`\|`active`) | `runner.go:104` | observe | abort if non-runnable |
| **R3** | First-tick `started_at = COALESCE(started_at, now())` | `runner.go:124` | persist | log only |
| **R4** | **Calendar gate** — `calendar.IsSendableDay()` (CZ holidays + weekend skip; `SKIP_CALENDAR_CHECK=1` bypass) | `runner.go:131` | observe | drop full tick |
| **R5** | Eligible contacts SELECT — defense in depth: status NOT IN (10 states) ∧ `sqlsuppression.NotInUnionWhere` (both tables) ∧ `next_send_at` past | `runner.go:160-178` | observe | exclude from batch |
| **R6** | **Mid-tick status re-check** — kooperativní pauza každých `statusCheckEvery` enqueues | `runner.go:198-216` | observe | break loop early |
| **R7** | `EmailStatusAllowed` — companies.email_status whitelist | `runner.go:237` | observe | skip contact |
| **R8** | **Holding-cluster gate** — `parent_ico` cap per tick (`HoldingClusterCap`) | `runner.go:243-250` | observe | skip contact |
| **R9** | **Domain rotation gate** — `MaxPerDomainPerTick` | `runner.go:255-263` | observe | skip contact |
| **R10** | **24h persistent domain limit (S20)** — JOIN send_events 24h, capped per `MaxPerDomainDay` | `runner.go:270-297` | observe | skip contact |
| **R11** | Step bounds check (`currentStep < len(steps)`) | `runner.go:300-311` | persist (mark completed) | skip contact |
| **R12** | **Unsubscribe HMAC token** — `token.BuildUnsubToken(camp,contact,email,secret)` → 16hex | `features/platform/common/token/unsub.go` | body (UnsubURL var) | none |
| **R13** | Render template — `content.Engine.Render` (subject spinner, spin syntax, contact var subst, `SkipHumanize` detection) | `runner.go:328` + `features/outreach/campaigns/content/template.go` | body, subject, headers (Content-Language: cs), SkipHumanize flag | error → skip contact |
| **R14** | **Send-window gate** — `calendar.InSendWindow(now, recipientTZ)` → postpone via `NextSendTime` | `runner.go:340-364` | persist (next_send_at) | skip contact this tick |
| **R15** | `engine.Enqueue(SendRequest)` — raw rendered, ne ještě humanized | `runner.go:385` | engine queue | none |
| **R16** | **Atomic step advance s CAS predicate** (`current_step = $oldStep`) — duplicate-send guard | `runner.go:443-471` | persist | skip if 0 rows (concurrent runner) |
| **R17** | Sentry breadcrumb (KT-A15) | `runner.go:477-496` | telemetry | none |
| **R18** | Per-tick `audit.Log("campaign_tick_completed")` OUTSIDE tx (BF-E6) | `runner.go:516-524` | persist | log only |

### Layer 3 — Engine.Run loop (parallel goroutine, 1156 LoC)

| # | Step | File:Line | Modifies | Gates |
|---|------|-----------|----------|-------|
| **G0** | **Hard gate:** `ErrAntiTraceRequired` if `antiTrace == nil` | `engine.go:329` | — | drop loop |
| **G1** | Business-hours check (1min sleep outside) | `engine.go:346-355` | — | defer |
| **G2** | Reset hourly counters | `engine.go:358` | observe | none |
| **G3** | **Global circuit breaker** (bounce-rate based) | `engine.go:361` | — | defer 1min |
| **G4** | Dequeue from in-memory queue | `engine.go:372` | engine queue | exit if empty |
| **G5** | **`pickMailbox` matrix** — Self-send guard ∧ Registry gate (D2.3 `outreach_mailboxes.status='active'`, 30s cache) ∧ Daily cap (in-memory + `DailyCapFunc` DB oracle) ∧ **WarmupLimiter** (mailbox_warmup ramp) ∧ Mailbox cooldown (3 fails → 30min) ∧ Round-robin rotation | `engine.go:387, 562-` | persist (registry) | skip + re-queue |
| **G6** | `allowDomain` (per-domain hourly rate) | `engine.go:401` | observe | re-queue |
| **G7** | **PreSendHook → `humanize.Engine.PrepareEmail`** — circadian send-time, bump/forward wrap, tone greetings/closings, imperfections (typos, casual phrasing), signature, fingerprint headers (Date, Message-ID, X-Mailer modeled na CZ webmail) | `engine.go:413-415` + `features/platform/common/humanize/engine.go` | subject, body, headers | bypass via `RenderedEmail.SkipHumanize=true` |
| **G8** | **LabAbortEvaluator (KT-A14)** — Mail Lab pre-send abort. `LAB_ONLY=1` → fail-closed, `LAB_ONLY=0` → fail-open | `engine.go:424` + `engine.go:506-546` | — | drop send |
| **G9** | Dry-run gate — synthetic SendResult, no relay call | `engine.go:447-462` | — | skip relay |
| **G9.5** | **Exactly-once send-claim gate (migration 171 `send_claims`)** — `e.sendClaim(ctx, req)` atomically claims `(campaign_id, contact_id, step)` immediately before the relay submit. This is the narrow waist BOTH send paths cross (Go daemon engine here; Node `campaign-send-batch.mjs` via `src/lib/sendClaim.js`); the UNIQUE constraint is the real mutex. Duplicate verdict → skip submit, NO `recordSendResult` (not an SMTP attempt). Fail-OPEN on a claim-table error. Dry-run never claims. Confirm/release happen in the orchestrator onSent callback. | `engine.go` (gate) + `features/outreach/campaigns/sender/sendclaim.go` | persist (`send_claims`) | skip submit on duplicate |
| **G10** | `AntiTraceClient.Send` → HTTP POST relay `/v1/submit` (30s timeout, Bearer auth, sentinel errors `ErrAntiTrace{Marshal,Request,Transport,RateLimited,HTTPStatus,EmptyEnvelope}`, F3-3 empty-envelope retry) | `engine.go:472` + `features/outreach/campaigns/sender/antitrace.go:95` | — | error → re-queue |
| **G11** | **`recordSendResult` + `backoff.ClassifySMTPError`** — per-domain bounce, mailbox cooldown, registry `RecordSuccess`/`RecordBounce` (auto-hold po `BackpressureThreshold`), SMTPClass mapping → greylist 15m/1h/4h/24h | `engine.go:474` + `features/outreach/campaigns/sender/backoff.go` | persist | indirect drop on Permanent |
| **G12** | `humanSendDelay` — Poisson distribution × time-of-day factor + jitter (S14 heat signature) | `engine.go:481` | timing | defer |

### Layer 4 — Anti-trace-relay intake pipeline (`intake.Pipeline.Process`)

| # | Step | File | Modifies | Gates |
|---|------|------|----------|-------|
| **T1** | `abuse.Limiter.Check(actor)` — sliding-window per-actor (`RATE_LIMIT_PER_MINUTE`) | `features/outreach/relay/internal/abuse/limiter.go` + `intake/handler.go:70` | observe | drop |
| **T2** | `sanitizer.SanitizeIntake` — strips invalid UTF-8 / control chars / HTML tags / `<script` / `javascript:` / `data:text/html` / 3rd-party tracking pixels / IP-leaking headers (X-Originating-IP, X-Mailer, X-Forwarded-For, etc.) | `features/outreach/relay/internal/delivery/sanitizer/sanitizer.go` + `intake/handler.go:77` | body, subject, headers | drop on `Status="blocked"` |
| **T3** | Vault — alias token issuance (anonymizace identity) | `features/outreach/relay/internal/vault/` (impl) + `intake/handler.go` step 2 | envelope metadata | error |
| **T4** | Envelope ID generation (random unique, klíč pro DSN bounce dedupe) | `intake/handler.go` step 3 | envelope.id | none |
| **T5** | `metamin.PadToSizeClass` — pads body to fixed size classes s 4-byte length prefix (obscures length) | `features/outreach/relay/internal/transport/metamin/minimizer.go` + `intake/handler.go:117` | body | none |
| **T6** | `contentenc.Sealer` X25519 encryption (volitelné — `else` branch ukládá padded-unencrypted pokud `len(RecipientKey) != 32`) | `intake/handler.go:129` | body (sealed) | none |
| **T7** | `metamin.MinimizeEnvelope` — buckets timestamps na 15-min windows (anti timing correlation) | `intake/handler.go:147` | envelope.bucketed_at | none |
| **T8** | `audit.Service.Record` + `msgbus.Publish(TopicSealed)` | `features/outreach/relay/cmd/relay/main.go:150,196` | persist + bus | none |

### Layer 5 — Relay scheduler + drain + deliver

| # | Step | File | Modifies | Gates |
|---|------|------|----------|-------|
| **D1** | `relay.Scheduler.Schedule` — encrypted JSON file queue, random delay `[RELAY_MIN_DELAY, RELAY_MAX_DELAY]` | `features/outreach/relay/internal/relay/scheduler.go` + `main.go:791` | persist (encrypted file) | defer |
| **D2** | `DrainAndShuffle` — batch shuffle (anti-burst) | `scheduler.go` + `main.go:953` | observe | order randomness |
| **D3** | `metamin.UnpadFromSizeClass` (reverse T5) | `main.go:1091` | body | none |
| **D4** | `boundary.ExitVerifier.Verify` — verifikuje exit channel před každým delivery | `main.go:1038` | observe | drop |
| **D5** | `delivery.privacy.sanitizeHeaders` — druhý pass header strip (Received, X-Originating-IP, X-Forwarded-For, X-Mailer, User-Agent); **anonymizuje Message-ID** na random 16-byte hex `<hash>@relay` | `features/outreach/relay/internal/delivery/privacy.go` + `delivery/smtp.go` | headers | none |
| **D6** | `delivery.BuildMessage` — multipart/alternative wrapping když HTML present | `delivery/smtp.go` + `main.go:1113` | body structure | none |
| **D7** | **`transport.BuildChain`** — selektor SOCKS5/Tor/VPN/VPN+Tor/wgpool. `direct` BANNED (`ErrDirectTransportForbidden`). `proxy` (free SOCKS5 pool proxifly/geonode/proxyscrape) BANNED (`ErrFreePoolForbidden`). Multi-endpoint pool: `features/outreach/relay/internal/transport/wgpool/pool.go` (per-envelope rotation across N Mullvad exits CZ/DE/NL/SE, SHA256 determinism on envelope_id||mailbox_id). Dormant free-pool code: `features/outreach/relay/internal/transport/proxy_pool.go` (1000+ LoC, legacy TLS probe). | `features/outreach/relay/internal/transport/chain.go:97-120` + `features/outreach/relay/internal/transport/wgpool/pool.go` + `cmd/relay/main.go:224` | observe | hard-fail boot |
| **D8** | SMTP DATA write → **wgsocks** userspace WG+SOCKS5 (127.0.0.1:1080 or 127.0.0.1:108x per wgpool) → Mullvad WG tunnel (netstack MTU=1100, PersistentKeepalive=5s per-instance) → recipient SMTP. Legacy wireproxy fallback available via `EGRESS_TRANSPORT=wireproxy` if regression detected. | `features/outreach/anti-trace-relay/entrypoint.sh` + `features/outreach/anti-trace-relay/wgsocks/main.go` (stdlib+wireguard-go, SOCKS5 CONNECT-only, CloseWrite half-close fix) + `features/outreach/relay/cmd/relay/main.go` (wgpool wiring) + `delivery/smtp.go` | network | error → bounce |

### Layer 6 — Background observability (parallel goroutines)

| # | Step | File | Modifies | Gates |
|---|------|------|----------|-------|
| **O1** | `imap.Poller` — UID watermark + Message-ID dedup (50k LRU), routes via `thread.InboundProcessor.ProcessReply` → may write to `outreach_suppressions` (negativní reply classification) | `features/inbound/orchestrator/imap/poller.go` | persist (suppression cascade) | none |
| **O2** | `audit.LogChannel` (Track E) na `channel_audit_log` | `features/platform/common/audit/channel.go` + `imap/poller.go:163` | persist | log only |
| **O3** | `protections.probe.Scheduler` — L2 (alive) + L3 (correct) probes | `features/inbound/orchestrator/protections/probe/probe.go` | persist (`protection_probes`) | none |
| **O4** | `protections.alert.Evaluator` — eskalace (3 errors → warn → critical po 2h, auto-resolve po 3 OK) | `features/inbound/orchestrator/protections/alert/evaluator.go` | persist (`protection_alerts`) | none |
| **O5** | Async `enrich.RecalculateOne` post-send (panic-recovered goroutine) | `runner.go:401-422` + `features/acquisition/contacts/enrichment/` | persist | none |

## IMAP via SOCKS5 (AO sprint, 2026-05-08)

Three new code paths ensure IMAP traffic routes through the same wgpool Mullvad tunnel as SMTP, preventing the multi-country login fingerprint that triggers Seznam fraud detection (CZ SMTP send + non-CZ IMAP poll = same account, two countries).

### AO1 — BFF IMAP dials via SOCKS5 (PR #1126)

| # | Step | File | Modifies | Gates |
|---|------|------|----------|-------|
| **AO1a** | `getMailboxSOCKS5Addr(mailboxRow)` — resolves SOCKS5 address for mailbox: reads `preferred_country`, calls relay `GET /v1/imap-socks-addr?preferred_country=XX`, returns `{socks_addr, country, label}`. Throws `imap_socks_unavailable` if relay unreachable or all endpoints quarantined. | `features/platform/outreach-dashboard/server.js` | observe | throws on failure |
| **AO1b** | `dialIMAPViaSOCKS5(socksAddr, host, port)` — opens SOCKS5 tunnel via wgpool endpoint (127.0.0.1:108X), wraps in TLS with SNI, returns TLS socket ready for IMAP protocol. Used by all 5 IMAP functions: `imapCheck`, `imapSearchUnseen`, `imapSearchUnseenUids`, `imapFetchHeaders`, `imapFetchByMessageId`. | `features/platform/outreach-dashboard/server.js` | network | error → caller |
| **AO1c** | Relay endpoint `GET /v1/imap-socks-addr?preferred_country=XX` — in wgpool mode calls `Pool.Pick("", "", country)`, returns loopback SOCKS5 addr. In single-endpoint mode returns `SOCKS_PROXY_ADDR`. No auth required (only returns 127.0.0.1:108X). Returns 503 when all endpoints quarantined. | `features/outreach/relay/web/probe.go:761` + `web/server.go:124` | observe | 503 on pool exhaustion |

Audit ratchet: `features/platform/outreach-dashboard/tests/audit/no_raw_imap_socket.test.js` — fails on any `new net.Socket()` in IMAP context. Baseline: 0 violations.

### AO2 — Go orchestrator IMAP dials via SOCKS5 (PR #1127)

| # | Step | File | Modifies | Gates |
|---|------|------|----------|-------|
| **AO2a** | `resolveImapSOCKSAddr(country)` — maps mailbox `preferred_country` ISO code to wgsocks bridge port: CZ → 127.0.0.1:1080–:1083; SK → 127.0.0.1:1084–:1085. Override via `IMAP_SOCKS_CZ` / `IMAP_SOCKS_SK` / `IMAP_SOCKS_DEFAULT`. Returns "" for unknown country → direct fallback with warn log. | `features/inbound/orchestrator/imap/poller.go:682` | observe | none |
| **AO2b** | `connect(ctx, mb)` — routes TCP dial through SOCKS5 when `resolveImapSOCKSAddr` returns non-empty addr: `proxy.SOCKS5("tcp", socksAddr, nil, baseDialer)` → requires `proxy.ContextDialer` interface. Falls back to direct dial with `imap_dial_direct_no_socks` slog warn. TLS on port 993: `tls.Client(tcpConn, ...)` + `HandshakeContext(ctx)` both honour context cancellation. | `features/inbound/orchestrator/imap/poller.go:598` | network | error → poller backoff |

### AO3 — Relay probe routes through wgpool per mailbox (PR #1128)

| # | Step | File | Modifies | Gates |
|---|------|------|----------|-------|
| **AO3** | `smtpAuthProbe` — when `req.MailboxID != ""` and wgPool configured: calls `s.wgPool.Pick("", mailboxID, preferredCountry)` for country-pinned endpoint (same path as drain). MUST NOT silently fallback to rotating pool — that would reintroduce multi-country signal. Emits `probe_wgpool_pick_failed` warn on error. Records `pickedCountry` + `pickedLabel` for AP4 egress observation. | `features/outreach/relay/web/probe.go:210` | observe + AP4 ring buffer | hard-fail on wgPool nil+mailboxID |

## Endpoint pin lifecycle (AP2 sprint, 2026-05-08)

Per-mailbox `pinned_endpoint_label` in `outreach_mailboxes` table. Pin is set on first successful probe or first send; once set, ALL sends and probes for that mailbox use the same Mullvad endpoint for the mailbox's lifetime. Operator can force-repin via `POST /api/mailboxes/:id/repin`.

| # | Step | File | Modifies | Gates |
|---|------|------|----------|-------|
| **AP2a** | `Pool.pickPinned(mailboxID)` — reads `PinReader.GetMailboxPinnedEndpoint(mailboxID)` from DB. If pinned endpoint is quarantined → returns `ErrPinnedEndpointQuarantined` — relay refuses delivery, never reroutes to another endpoint. If pinned label not in pool config → `ErrPinnedEndpointMissing`. Both errors propagate without fallback. | `features/outreach/relay/internal/transport/wgpool/pin.go:112` | observe | hard-fail: no silent reroute |
| **AP2b** | `smtpAuthProbe` AP2 pin-after-first-probe — on successful probe with wgPool: `s.wgPool.LabelBySocksAddr(proxyAddr)` → `SetPin(username, label, "probe_first")`. First-call wins; subsequent probes with `force=false` are no-ops. | `features/outreach/relay/web/probe.go:161` | persist (`outreach_mailboxes.pinned_endpoint_label`) | none |
| **AP2c** | `processDrainEnvelope` AP2 pin-after-first-send — same SetPin call on first successful delivery, actor `"drain_first_send"`. Ensures mailbox stays on the same exit IP after warmup pin. | `features/outreach/relay/cmd/relay/main.go` | persist | none |
| **AP2d** | BFF repin endpoint `POST /api/mailboxes/:id/repin` — operator-triggered forced repin to a named endpoint label. Calls relay `POST /v1/repin`, relay calls `SetPin(mailboxID, label, actorUID, force=true)` — overwrites existing pin, inserts audit row. | `features/platform/outreach-dashboard/src/server-routes/mailboxesRepin.js` + `features/outreach/relay/web/probe.go` | persist + audit | requires operator auth |

## Egress observation pipeline (AP4 sprint, 2026-05-08)

Ring buffer of per-mailbox egress observations (country + endpoint label + op_type) accumulated in relay memory and periodically drained by BFF to DB for chaos detection.

| # | Step | File | Modifies | Gates |
|---|------|------|----------|-------|
| **AP4a** | `Pool.RecordEgressObservation(mailboxID, country, endpointLabel, opType)` — appends `EgressObservation{MailboxID, Country, EndpointLabel, OpType, ObservedAt}` to in-memory ring buffer (cap 2000, ~16h at 2 probes/mailbox/30min). Thread-safe via pool mutex. | `features/outreach/relay/internal/transport/wgpool/pool.go:376` | ring buffer (in-memory) | none |
| **AP4b** | Relay endpoint `GET /v1/egress-observations[?drain=1]` — returns snapshot or drains ring buffer atomically. BFF calls `?drain=1` every 5 minutes. No auth required (returns opaque labels + country codes only). | `features/outreach/relay/web/egress_observations.go` + `web/server.go:128` | ring buffer drain | none |
| **AP4c** | BFF `runEgressObservationCron` — calls relay `GET /v1/egress-observations?drain=1` every 5 minutes, INSERTs rows into `mailbox_egress_observation`, then calls `SELECT detect_mailbox_egress_chaos(60)` Postgres function to flag mailboxes seen from 2+ countries in 60 minutes. | `features/platform/outreach-dashboard/server.js` (cron) | persist (`mailbox_egress_observation`) + chaos detection | none |
| **AP4d** | `detect_mailbox_egress_chaos(window_minutes)` — Postgres function: groups `mailbox_egress_observation` by `mailbox_id`, counts distinct `egress_country` in window. If count ≥ 2 → UPDATE `outreach_mailboxes SET status='egress_chaos_detected'`. Exempts mailboxes in `warmup_d0` phase (first 24h). | Postgres migration (AP4) | persist (mailbox status) | warmup_d0 exemption |

## Bypass paths — banned

These are paths that *exist* in the codebase but must NEVER be invoked from production code. Audit ratchet `features/outreach/campaigns/sender/no_bypass_audit_test.go` enforces.

| Path | Banned by | Notes |
|------|-----------|-------|
| `sender.NewAntiTraceClient(...)` direct construction outside `engine.go` | M3.1 audit ratchet (planned), `feedback_anti_trace_full_stack` HARD RULE | Engine is only legal construction site |
| `TRANSPORT_MODE=direct` | `chain.go:99` `ErrDirectTransportForbidden` + `config.ValidateAirtight` exit code 48 | Leaks Railway egress IP |
| `TRANSPORT_MODE=proxy` (free SOCKS5 rotating pool) | `chain.go:103` `ErrFreePoolForbidden` | Czech recipient SMTP servers reject free-proxy IPs regardless of geo |
| Direct SOCKS5Transport construction outside wgpool module | `features/outreach/relay/internal/transport/wgpool/wgpool_audit_test.go` | Audit ratchet: wgpool is sole legal site for 127.0.0.1:108x endpoints |
| `smtp.SendMail / smtp.Dial / net.Dial(":25"/":465"/":587") / tls.Dial(...:smtp...)` | `features/outreach/campaigns/sender/airtight_audit_test.go` (currently sender-only; M3.2 expands monorepo-wide) | All SMTP must flow through relay |
| Raw `http.Post` to relay `/v1/submit` outside `antitrace.go` | M3.1 audit ratchet (planned) | Bypasses sentinel error handling, retry policy |
| `RenderedEmail.SkipHumanize = true` from new templates | Operator review of every template that sets `{{/* humanize: off */}}` | Bypass entire humanize.Engine.PrepareEmail; designed only for legal/compliance verbatim notices |
| `suppression_list` alone (without `outreach_suppressions` UNION) | `sqlsuppression.EnsureContainsBothTables` discipline test | Halves the suppression gate |

## Architectural ceiling — known delivery limit

Documented in `features/outreach/relay/CLAUDE.md`:

> Even with Mullvad CZ exit, Seznam (and other Czech recipient SMTP servers) reject mail from Mullvad IPs as anti-VPN reputation. The egress architecture is operationally complete; final-mile delivery to Czech webmail providers requires a non-VPN sending IP (own CZ VPS / transactional email service).

**Tracked in memory `seznam_proxy_geo_mismatch.md`.** Operator decision matrix in `docs/playbooks/launch-readiness.md` (M2.4):
- A) Accept reduced delivery rate
- B) Pivot CZ VPS (own server as SOCKS5 endpoint, remove Mullvad)
- C) Transactional email service (Mailgun/Postmark/SendGrid CZ origin) — bypass relay entirely (architectural change)

## Required Railway env (anti-trace-relay service)

**Single-endpoint mode (legacy):**
```
TRANSPORT_MODE=socks5      # or legacy alias "tor"
SOCKS_PROXY_ADDR=127.0.0.1:1080
WIREPROXY_CONFIG=<multi-line WireGuard ini — consumed unchanged by wgsocks>
EGRESS_TRANSPORT=wgsocks   # (optional, default) or "wireproxy" for legacy fallback
TOR_ENABLED=false          # MUST stay off; embedded Tor breaks WG handshake
DELIVERY_MODE=outbound-smtp
```

**Multi-endpoint pool mode (per-envelope rotation):**
```
TRANSPORT_MODE=wgpool
WIREPROXY_POOL_PRIVATE_KEY=<account-level WG private key>
WIREPROXY_POOL_ADDRESS=10.x.x.x/32
WIREPROXY_POOL_CONFIG=[{"label":"cz5","peer_pubkey":"<wg>","peer_host":"cz5-wireguard.mullvad.net:51820"},...]
WIREPROXY_POOL_KEEPALIVE=5   # seconds (default); keeps Railway NAT mapping fresh
EGRESS_TRANSPORT=wgsocks   # (optional, default) or "wireproxy" for legacy fallback
DELIVERY_MODE=outbound-smtp
```

**Egress architecture:**
- **wgsocks** — in-house Go binary (stdlib + wireguard-go netstack, SOCKS5 CONNECT-only). Fixes wireproxy's 28s i/o timeout on STARTTLS via proper CloseWrite half-close. Netstack MTU hardcoded to 1100 (Railway egress path MTU defense, PR #628).
- **Pool rotation** — SHA256(envelope_id || mailbox_id) mod active_endpoints. Failing endpoints quarantine 5min. Max 10 endpoints. Pool size exposed at `GET /v1/proxy-pool` + `GET /v1/egress-debug` (mode=`wg-pool`).
- **Per-instance binding** — entrypoint.sh spawns N bridges on 127.0.0.1:108${i}; each instance has unique ListenPort=51820+${i}.

## Cross-cutting observations

- **Exactly-once send (migration 171/153, 2026-06-22):** `send_claims` (UNIQUE on `campaign_id, contact_id, step`) is the shared, durable, atomic gate both send paths acquire pre-submit (step G9.5) — it replaces the prior path-local guards (runner CAS / Node `operator_audit_log` read) that could not see each other. `send_events` additionally carries a partial-unique backstop (`uq_send_events_sent_cstep` WHERE `status='sent'`) so a duplicate 'sent' row can never be *recorded* even if the gate were bypassed; the two INSERT sites use `ON CONFLICT … DO NOTHING`. Confirm (`claiming→sent`) / release (`claiming→failed`) run in the orchestrator onSent callback; stale 'claiming' rows are expired by the in_flight reaper (`in_flight_reaper.go`) + the JS reclaim cron (`runCampaignContactsStaleReclaim.js`) so a crashed sender never blocks a contact forever. Node twin: `features/platform/outreach-dashboard/src/lib/sendClaim.js`. Residual window (process death between relay 202 and local confirm) is NOT closed — that needs a relay-side Idempotency-Key (deferred). This is technical idempotence, orthogonal to the `dedup_guard` re-contact policy. See [`send-paths.md`](send-paths.md).
- **Suppression dual-write:** filtered at runner SELECT (R5) AND backfilled by IMAP poller (O1) on negative replies. Race window between reply classification commit and next-tick SELECT exists; not mitigated by lock.
- **`SkipHumanize` is single-point bypass** of G7. No secondary guard.
- **Privacy-header strip happens twice:** T2 (intake) + D5 (drain). Double-strip is intentional defense.
- **`contentenc.Sealer` is conditional on RecipientKey length.** No 32-byte key = padded but plaintext. Production key provisioning unverified (open question).
- **`direct` transport doubly forbidden:** `config.ValidateAirtight` exit 48 + `transport.BuildChain` `ErrDirectTransportForbidden`. Both must be defeated to bypass.
- **wgsocks netstack MTU = 1100** — hardcoded in `main.go:87`. Drastically below RFC standard 1420 to fit Railway egress path quirks. Outer UDP datagram = 1128B (payload 1100 + 28 IP+UDP), safely below common path MTU breakpoints. See PR #628 rationale.
- **PersistentKeepalive = 5s per instance** — Railway SOCKS5 NAT mapping drops idle WG flows. Per-instance (not global) via entrypoint.sh `ListenPort=51820+${idx}`. See PR #625.
- **wgpool determinism:** SHA256(envelope_id || mailbox_id) ensures reproducible endpoint selection for retries / crash recovery without state externalization.

## Open questions (un-resolved as of 2026-05-01)

1. **`contentenc.Sealer` key provisioning** — which path sets `req.RecipientKey`? Without 32-byte key, envelopes are padded but readable in relay queue file.
2. **`DELIVERY_MODE=record-only` default** — is there a bootstrap guard failing relay startup when unset, or is silent no-op intended?
3. **Suppression race window** — between O1 InboundProcessor write and next R5 SELECT — DB advisory lock or recheck mid-batch?
4. **`modules/outreach/` legacy** — is any code in `modules/outreach/cmd/` or `internal/` still executed in production, or dead post-M3.3 carve?
5. **`relay-queue.json` persistence** — is `DATA_DIR` mapped to Railway persistent volume? If not, restart silently loses pending envelopes.
6. **DSR cascade pre-send** — `web/handler_dsr.go` erases 8 tables. Is there a lock preventing concurrent `RunCampaign` send to a contact mid-erasure? No pre-send DSR check found in `runner.go`.
7. **`boundary.ExitVerifier`** — what writes `exit-channels.json`? Verification source unclear.

## Maintenance

- **Drift detection** (planned A4.2): daily Explore agent diff against this MAP. PR description must reference this file's commit SHA.
- **Update on subsystem change**: PRs touching `features/outreach/campaigns/`, `features/outreach/relay/`, `features/inbound/orchestrator/imap/`, `features/inbound/orchestrator/honeypot/`, `features/inbound/orchestrator/protections/`, `features/platform/common/audit/`, `features/platform/common/humanize/`, `features/platform/common/token/`, `features/acquisition/contacts/enrichment/` MUST update this MAP if they add/remove/reorder any step.

## Cross-references

- HARD RULE memory: `feedback_anti_trace_full_stack` (always-loaded T0)
- Architectural ceiling memory: `seznam_proxy_geo_mismatch`, `egress_canonical`, `per_mailbox_proxy_deprecated`
- Existing CLAUDE.md: `features/outreach/campaigns/CLAUDE.md`, `features/outreach/relay/CLAUDE.md`, `features/inbound/orchestrator/CLAUDE.md`, `features/platform/outreach-dashboard/CLAUDE.md`
- Initiative: `docs/initiatives/2026-05-01-codebase-awareness-discipline.md`
- AO/AP sprint PRs: #1126 (AO1 BFF IMAP via SOCKS5), #1127 (AO2 Go orch IMAP via SOCKS5), #1128 (AO3 relay probe via wgpool), #1130 (AP2 endpoint pin lifecycle), #1131 (AP4 egress chaos detection)
- Fraud-lock recovery playbook: `docs/playbooks/mailbox-fraud-lock-recovery.md` (AO6)
