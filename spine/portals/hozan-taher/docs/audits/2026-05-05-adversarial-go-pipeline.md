# Adversarial Go Pipeline Sweep — 2026-05-05

**Status:** Closed — all CRITICAL and HIGH items addressed in this PR.
**Date:** 2026-05-05
**Trigger:** Authorized red-team sweep on anti-trace pipeline before production launch.
**Scope:** `features/outreach/relay/`, `features/outreach/campaigns/sender/`, `features/outreach/campaigns/campaign/`

---

## Findings Table

| ID | Severity | Area | File:Line | Title | Status |
|----|----------|------|-----------|-------|--------|
| F1 | HIGH | relay/drain | `relay/cmd/relay/main.go:1210-1237` | Debug `DRAIN_DISPATCH_M5` lines emit SMTP credential metadata to stderr in production | Fixed in this PR |
| F2 | MEDIUM | sender/headers | `sender/headers.go:95` | `BuildFromHeader` does not strip CRLF from `displayName`; downstream `buildMessage` saves it, but public API contract is misleading | Fixed in this PR |
| F3 | MEDIUM | sender/dedup | `sender/dedup_guard.go:195-223` | Cross-campaign cooldown TOCTOU: check in `CheckEligibility` + commit in `campaign_contacts` INSERT are not in the same DB transaction | GH issue filed |
| F4 | LOW | sender/audit | `sender/airtight_audit_test.go` | Airtight ratchet only scans `features/outreach/campaigns/sender/*.go`; `delivery.NewSMTPDeliverer` in relay is not covered | Notes only |
| F5 | LOW | sender/engine | `sender/engine.go:725` | `antiTrace.fromAddr` mutation is unguarded by `e.mu`; safe today (single Run goroutine) but fragile if Engine gains a second sender goroutine | Notes only |
| F6 | LOW | relay/exec | `relay/transport/onion/manager.go`, `vpn/wireguard.go` | `os/exec` invocations of `tor` and `wg-quick` binaries exist; benign (Tor/VPN managers only start when `TOR_ENABLED=true` / `VPN_ENABLED=true`) | Notes only |

---

## F1 — HIGH: Debug stderr lines leak SMTP credential metadata

### Description

`processDrainEnvelope` in `features/outreach/relay/cmd/relay/main.go` emits four
`fmt.Fprintf(os.Stderr, ...)` trace lines added for Sprint M5 delivery debugging. They fire on every
outbound-smtp envelope in production and include:

```
DRAIN_DISPATCH_M5 env_id=<id> smtp_host_len=<n> smtp_pwd_len=<n> account_pool_nil=<bool>
DRAIN_DISPATCH_M5 env_id=<id> branch=ONESHOT
```

The `smtp_pwd_len` field leaks the byte-length of the SMTP password for every envelope. Even though
the password itself is not printed, the length is a meaningful signal in forensics/interception
scenarios — and the presence of the debug trace in production logs is a policy violation
(`slog_op_audit_test.go` ratchet mandates structured `slog.*` for all operator-visible output).

Railway pipes stderr to its log aggregator (Datadog / papertrail depending on plan). An attacker with
read access to logs could use `smtp_pwd_len` as an oracle to correlate credential changes.

### Reproduction

Deploy with `DELIVERY_MODE=outbound-smtp`, send any email. Four lines appear unconditionally in
Railway logs.

### Fix

Replace the four `fmt.Fprintf(os.Stderr)` lines with structured `logger.Info(...)` calls using the
existing `minlog` logger already threaded through `processDrainEnvelope`. Credential fields are
replaced with a boolean `has_inline_creds` so branch selection is still observable without leaking
length/content.

See `features/outreach/relay/cmd/relay/main.go` changes in this PR.

---

## F2 — MEDIUM: `BuildFromHeader` does not strip CRLF from display name

### Description

`BuildFromHeader(displayName, email string)` in `features/outreach/campaigns/sender/headers.go` does not
remove `\r` or `\n` from `displayName` before composing `"DisplayName <email>"`. The function is
called by `applyAnonymityHeaders` and the result is stored in `req.Headers["From"]`.

Downstream, `buildMessage` applies `stripCRLF` to the `from` parameter before writing the SMTP `From:` header, which prevents an actual SMTP header injection. However:

1. The `BuildFromHeader` function is exported (capital B); any future caller that doesn't route
   through `buildMessage` is silently vulnerable.
2. The `req.Headers` map is also forwarded to the relay's intake pipeline. If the relay ever writes
   headers from the map without stripping (e.g., when adding a future `buildProbeMessage` path that
   calls `BuildFromHeader` directly), the CRLF would survive.

### Reproduction

```go
result := BuildFromHeader("Jan Novak\r\nBcc: attacker@evil.com", "jan@firma.cz")
// Returns: "\"Jan Novak\r\nBcc: attacker@evil.com\" <jan@firma.cz>"
// After buildMessage.stripCRLF: "\"Jan NovakBcc: attacker@evil.com\" <jan@firma.cz>"
// No actual injection — but the raw result is unsafe if used directly
```

### Fix

Strip CRLF from `displayName` inside `BuildFromHeader` before any formatting, so the function
itself is safe regardless of call site. Add regression test `TestBuildFromHeader_CRLFInDisplayNameIsStripped`.

See `features/outreach/campaigns/sender/headers.go` and `headers_test.go` changes in this PR.

---

## F3 — MEDIUM: Dedup guard TOCTOU (cross-campaign cooldown)

### Description

In `campaign/runner.go:254`, `sender.CheckEligibility` checks whether a contact was recently sent to
across any campaign (axis 4: `cross_campaign_cooldown`). The check reads from `send_events` at one
point in time. If `campaign.Runner.RunCampaign` is called concurrently for two different campaigns
(two scheduler ticks overlap, both hold different advisory locks), both may observe `crossCampaignFound=0`
and proceed to enqueue the same contact — the INSERT into `send_events` only happens after the send
completes.

The advisory lock in `PostgresLocker` is per-campaign-ID. Two different campaigns can run the
dedup check simultaneously with no cross-campaign lock.

### Risk Assessment

Low exploitability in the current architecture: `Engine.Run` is a single goroutine, and both campaigns
share the same engine queue. The window for a double-send is small. However, with the new
multi-campaign scheduler in place this TOCTOU is real under high parallelism.

### Mitigation (deferred to GH issue)

A PostgreSQL advisory lock keyed on `contact_id` (not `campaign_id`) around the dedup check +
`campaign_contacts INSERT` would close the race, but requires a DB-level design change. Filed as
GitHub issue with label `priority/p1 security-hardening`.

---

## F4 — LOW: Airtight ratchet only covers sender package

The `airtight_audit_test.go` AST scan covers `features/outreach/campaigns/sender/*.go` only (non-test files).
The relay's `delivery.NewSMTPDeliverer` constructs real SMTP connections (via `net.Dial` under the
hood), but this is outside the scan scope. The relay's own tests cover this path through
`drain_envelope_test.go`. No bypass risk, but worth noting for future ratchet expansion.

---

## F5 — LOW: Unguarded `antiTrace.fromAddr` mutation

At `engine.go:725`:
```go
e.antiTrace.fromAddr = mailbox.Address
```

This mutation is not inside `e.mu.Lock()`. It is safe today because `Engine.Run` is always called in
a single goroutine. If a future refactor spawns multiple sender goroutines sharing the same `*Engine`,
this would be a data race on `AntiTraceClient.fromAddr`.

Mitigation: make `AntiTraceClient.Send` take `fromAddr` as a parameter instead of mutating shared
state. Not changed in this PR to avoid scope creep; flagged for the next Engine refactor.

---

## F6 — LOW: `os/exec` in relay transport managers

`relay/internal/transport/onion/manager.go` and `relay/internal/transport/vpn/wireguard.go` invoke
`exec.CommandContext` to start the `tor` binary and `wg-quick`. These are guarded by
`TOR_ENABLED=true` / `VPN_ENABLED=true` env flags and are only reached when the operator explicitly
enables those transports. Not a bypass vector in the default configuration (`TRANSPORT_MODE=socks5`).

---

## Attack vectors NOT found

- **Reflection bypass**: No `reflect.New` or `reflect.Call` in `features/outreach/campaigns/sender/` non-test files.
- **OS-level SMTP escape**: No `exec.Command` of `sendmail`, `mailx`, `swaks`, or `curl smtp:` in campaigns or relay packages.
- **Raw socket dialing**: No `net.Conn`, `tls.Conn`, or `bufio.NewWriter` in `features/outreach/campaigns/sender/` non-test files. Airtight ratchet baseline stays at 0.
- **Circuit breaker concurrent trip**: `recordSendResult` is only called from the single `Engine.Run` goroutine; all mutations are within `e.mu.Lock()`. Race detector confirms no race (`go test -race -count=10`).
- **Greylisting infinite retry**: `maxGreylistingAttempts=4` cap in `backoff.go:133` prevents unbounded retry. After 4 transient failures the domain escalates to SMTPPermanent.
- **Probe misclassified as production send**: `probe_adapter.go` (`BuildCanaryMessage`) only calls `buildMessage` to construct a bytes payload — it does not call `antiTrace.Send` or increment any rate-limit counters. Production sends and probe sends are orthogonal code paths.
