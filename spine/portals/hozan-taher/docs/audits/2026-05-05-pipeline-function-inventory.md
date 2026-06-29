# Pipeline Function Inventory — 42-Step Anti-Trace Pipeline

**Generated:** 2026-05-05  
**Source:** Manual audit against `docs/subsystem-maps/anti-trace.md`  
**Scope:** Campaign send path from `RunCampaign` through relay delivery

---

## Layer G: Orchestrator / Engine (Engine.Run in sender/engine.go)

| Step | Pipeline Step | Function | File |
|------|--------------|----------|------|
| G0 | Anti-trace enforcement gate | `Engine.Run` — `ErrAntiTraceRequired` guard | `features/outreach/campaigns/sender/engine.go:507` |
| G1 | Calendar gate (CZ dead days) | `calendar.IsExtendedDeadDay` | `features/outreach/campaigns/campaign/runner.go:137` |
| G2 | Suppression filter | `suppressionFilterFor` → `sqlsuppression.NotInUnionWhere` | `features/outreach/campaigns/campaign/runner.go:190` |
| G3 | Dedup guard (8 axes) | `sender.CheckEligibility` | `features/outreach/campaigns/sender/dedup_guard.go:111` |
| G4 | Holding cluster cap | `seenParentICO[parentICO] >= HoldingClusterCap` | `features/outreach/campaigns/campaign/runner.go:299` |
| G5 | Domain rotation gate (per-tick) | `seenDomain[domain] >= MaxPerDomainPerTick` | `features/outreach/campaigns/campaign/runner.go:312` |
| G6 | Domain daily gate (24h) | `domainDayCount[domain] >= MaxPerDomainDay` | `features/outreach/campaigns/campaign/runner.go:346` |
| G7 | Send window gate | `calendar.InSendWindow` | `features/outreach/campaigns/campaign/runner.go:402` |
| G8 | Content render | `contentEngine.Render` | `features/outreach/campaigns/campaign/runner.go:385` |
| G9 | Enqueue to Engine | `engine.Enqueue(SendRequest{...})` | `features/outreach/campaigns/campaign/runner.go:441` |
| G10 | Mailbox selection | `Engine.pickMailbox` | `features/outreach/campaigns/sender/engine.go:841` |
| G11 | Domain circuit breaker | `Engine.allowDomain` | `features/outreach/campaigns/sender/engine.go:964` |
| G12 | Working hours gate (production) | `Engine.inWorkingHours` | `features/outreach/campaigns/sender/engine.go:288` |
| G13 | Per-mailbox anti-burst spacing | `Engine.mailboxSpacingOK` | `features/outreach/campaigns/sender/engine.go:340` |
| G14 | Pre-send hook (humanize) | `Engine.preSendHook` (humanize fingerprint) | `features/outreach/campaigns/sender/engine.go:646` |
| G15 | Anonymity headers bundle | `applyAnonymityHeaders` → BuildMessageIDHeader, BuildFromHeader, BuildDateHeader | `features/outreach/campaigns/sender/headers.go:217` |
| G16 | Mail Lab abort hook | `Engine.checkLabAbort` | `features/outreach/campaigns/sender/engine.go:684` |
| G17 | Subject marker scrub (production) | `Engine.scrubSubjectMarker` | `features/outreach/campaigns/sender/engine.go:240` |

---

## Layer T: Relay Intake (features/outreach/relay/internal/intake)

| Step | Pipeline Step | Function | File |
|------|--------------|----------|------|
| T1 | HTTP auth + rate limit | `auth.NewStaticTokenAuthenticator` + `abuse.NewLimiter` | `relay/cmd/relay/main.go:369` |
| T2 | Header sanitize (strip X-*, Received, etc.) | `sanitizer.NewService` → `sanitizeHeaders` / `stripPrivacyHeaders` | `relay/internal/delivery/privacy.go` |
| T3 | Identity aliasing (vault) | `identity.NewService` + vault lookup | `relay/cmd/relay/main.go:114` |
| T4 | Metadata minimization | `metamin.NewMinimizer` | `relay/cmd/relay/main.go:119` |
| T5 | Sealing (content encryption) | `contentenc.NewSealer` | `relay/cmd/relay/main.go:120` |
| T6 | Message bus publish | `bus.Submit` → `msgbus.TopicSealed` | `relay/cmd/relay/main.go:449` |
| T7 | Scheduler (random delay) | `relay.NewScheduler.Schedule` | `relay/cmd/relay/main.go:134` |
| T8 | Audit record | `audit.NewService.Record` | `relay/cmd/relay/main.go:129` |

---

## Layer D: Drain / Delivery (processDrainEnvelope in relay/cmd/relay/main.go)

| Step | Pipeline Step | Function | File |
|------|--------------|----------|------|
| D1 | Batch drain + shuffle | `traffic.NewBatchDrainer.DrainAndShuffle` | `relay/cmd/relay/main.go:491` |
| D2 | Cover traffic skip | `if env.IsCover { return }` | `relay/cmd/relay/main.go:1116` |
| D3 | Exit channel verify | `exitV.Verify` | `relay/cmd/relay/main.go:1122` |
| D4 | Unpadding | `minimizer.UnpadFromSizeClass` | `relay/cmd/relay/main.go:1176` |
| D5 | Content unmarshal | `json.Unmarshal` (recipient/subject/body/headers) | `relay/cmd/relay/main.go:1183` |
| D6 | Message assembly | `delivery.BuildMessage` (from/to/subject/body/headers) | `relay/cmd/relay/main.go:1203` |
| D7 | Credential resolution (inline creds) | `env.InlineCreds` → per-envelope SMTPConfig | `relay/cmd/relay/main.go:1202` |
| D8 | SMTP delivery via Mullvad SOCKS5 | `delivery.NewSMTPDeliverer.Deliver` | `relay/cmd/relay/main.go:1236` |

---

## Notes

- **G15→D6 chain break (BUG fixed 2026-05-05):** `applyAnonymityHeaders` writes `From: "Display Name <addr>"` into `req.Headers["From"]`, but relay's `BuildMessage` used the bare `from` parameter and skipped `headers["From"]`. Fixed: relay now uses `headers["From"]` when it contains `"<"` (display-name form). Regression tests: `T-BUILD-FROM-1..4` in `smtp_test.go`.

- **T2 strip gap (BUG fixed 2026-05-05):** `X-Test-Run-ID` was not in `privacySensitiveHeaders`. Delivered to real recipients. Fixed: added `"x-test-run-id": true` to the strip set. Regression tests: `T-A4-4`, `T-A4-5` in `privacy_test.go`, `T-BUILD-FROM-4` in `smtp_test.go`.

- **Harvest schema drift (BUG fixed 2026-05-05):** `anonymity-harvest` queried `se.template_name` and `se.headers` which don't exist in `send_events`. Fixed: use `se.subject`; Attempt 2 fallback rewritten to not use non-existent `headers` jsonb column.
