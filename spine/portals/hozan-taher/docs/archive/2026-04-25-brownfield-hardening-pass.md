---
date: 2026-04-25
status: in-flight
parent: docs/initiatives/2026-04-23-plan-v2.md
goal: Brownfield hardening of campaign critical path before first real send
---

# Brownfield Hardening Pass — Critical Path

## Cíl

Připravit kód kritické cesty (campaign → relay → IMAP → reply) na první
ostrý send. Ne přidávat nové funkce — **vylepšit existující** pomocí:

1. Strukturovaných chybových typů (typed errors → caller-friendly retry)
2. Strukturovaných slog polí (campaign_id + contact_id všude pro audit trail)
3. Last-line compliance gate (suppressions check at send-time, nejen
   enrollment-time)
4. Operator-visible audit_log (per-tick aggregate, ne per-contact spam)
5. Defense in depth — nenápadné code-smell findings (stale refs, double-write)

## Kontext

- 7313 testů zelených napříč 99 packages před hardening pass.
- 4 services ≥ 98% coverage (campaigns 98.1%, mailboxes 98.0%, contacts 97.9%, inbox 100%).
- Existující plány: FIRST-CAMPAIGN-SUPERPLAN/SPRINTS/PLAN, SEND-OPERATIONS, MVP-ADR-POC-RULES.
- Blocker pro real send: SEND-S1 (operator musí zadat Seznam app passwords pro mb=631+632).
- Stávající state (z `pnpm report`): 24/24 probes green, 0 alerts, 2 active mailboxes (warmup d2+d6),
  2 paused mailboxes (AUTH fails), 1 paused campaign.

## Co se udělalo (2026-04-25)

### A. campaigns/sender/antitrace.go — typed errors + observability

**Problém:** Send error byl plain `fmt.Errorf("anti-trace HTTP %d: %s", ...)` →
caller (engine) mohl jen `result.Error != nil`, neuměl rozlišit:
- 429 (back off) vs 5xx (retry) vs transport (DNS/TLS) vs request-build chyba

**Změny:**
- Přidány sentinel errors: `ErrAntiTraceMarshal`, `ErrAntiTraceRequest`,
  `ErrAntiTraceTransport`, `ErrAntiTraceRateLimited`, `ErrAntiTraceHTTPStatus`.
- Errors wrapped pomocí `%w` → `errors.Is(err, ErrAntiTraceRateLimited)` funguje.
- Slog calls obohacené o `campaign_id`, `contact_id`, `step`, `recipient_domain`,
  `mailbox` — Sentry bude grupovat per-campaign místo "anti-trace HTTP 500" floodu.
- `MailboxUsed` v `SendResult` opravený: dříve `c.fromAddr` (mohlo být stale),
  teď resolved `fromAddr` (req.SMTPUsername || c.fromAddr).
- Non-JSON 2xx response: dříve silent (Unmarshal err drop'd), teď slog.Warn
  s body length pro detekci contract drift při relay deploy.
- `domainOf(email)` helper — privacy-friendly tag pro Sentry (domain místo
  full email).

**Tests:** `antitrace_hardening_test.go` (7 cases) lockuje typed-error contract.

### B. campaigns/campaign/runner.go — suppression filter at send time

**Problém (compliance gap):** `SuppressEmail()` v `features/acquisition/contacts/enrichment/suppress.go`
updatuje:
1. ✅ INSERT outreach_suppressions (Schema B)
2. ✅ UPDATE outreach_contacts.status = 'suppressed' (Schema B)
3. ✅ UPDATE outreach_threads (cascade)
4. ❌ **NEUPDATUJE** `contacts.status` v Schema A!

`RunCampaign` SELECT dotaz filtruje **pouze podle Schema A** `c.status NOT IN (...)`.
Důsledek: contact, který odpověděl "unsubscribe me" → reply classifier zavolá
`SuppressEmail` → **next tick ho znovu vybere a pošle email**.

**Fix:** Přidán `AND lower(trim(c.email)) NOT IN (SELECT email FROM outreach_suppressions WHERE email IS NOT NULL)`
do RunCampaign SELECT. Defense in depth.

**Tests:**
- `runner_suppression_test.go::TestRunCampaign_SuppressionFilter_AppliedAtSend` — sqlmock regex matcher confirms filter IS in query.
- `TestRunCampaign_SuppressionFilter_QueryStringContainsCheck` — discipline test
  reads `runner.go` and asserts `outreach_suppressions` substring is in
  RunCampaign body. Catches accidental removal during refactor.

### C. campaigns/campaign/runner.go — slog structure consistency

Drobné fixy: scan error, render error, send-window postpone, recalc panic
recovery — všechny teď mají `campaign_id` (chybělo) + `template`/`step` kde
relevantní. Sentry grouping = per campaign tick, ne globální flood.

### D. common/audit/log.go — Execer interface

**Problém:** `audit.Log` vyžadoval `*sql.DB`. campaigns/campaign.Runner má
`DB` interface (testability), ne `*sql.DB`. Nemohl tedy psát do audit
logu bez leaknutí typu.

**Fix:** Změněn signature na `Execer` interface (jen `ExecContext`). `*sql.DB`
splňuje, takže existing callers nezměněni. Runner teď může volat
`audit.Log(ctx, r.db, ...)`.

### E. campaigns/campaign/runner.go — operator audit row per RunCampaign tick

Operator dashboard reads `operator_audit_log`. Po RunCampaign tick s
`enqueued > 0` se zapíše:

```
action: "campaign_tick_completed"
actor: "campaign_runner"
entity_type: "campaign"
entity_id: <campaignID>
details: {campaign_name, enqueued, duration_ms}
```

**Granularita:** per-tick aggregate, ne per-contact. Pro velkou kampaň by
per-contact rows explodovaly tabulku. Per-skip reasons jsou v slog →
Sentry → ELK / log search.

### F. features/platform/outreach-dashboard/scripts/system-report.mjs — port mismatch

**Problém:** Script default port `3001`, BFF default `18001` (server.js),
CLAUDE.md říká `3100`. Drift způsobil `pnpm report` standalone vrací
"BFF error: fetch failed" pro proxy-pool.

**Fix:** Aligned na `18001`. PORT env var stále wins (Railway prod není
ovlivněn).

## Co se NEUDĚLALO (vědomě)

- ❌ Per-contact audit rows — explosion risk for large campaigns. Per-tick
  aggregate je správná granularita, per-contact info je v slog → Sentry.
- ❌ Coverage push na 98% pro privacy-gateway / relay / orchestrator —
  blokovaný cmd/main.go (untestable bez refaktoru) a integration paths
  (testcontainers needed). Plán dokončen v plan-v2.md.
- ❌ Real network testing (live SMTP/IMAP probe) — vyžaduje běžící relay +
  prod credentials. Out of scope pro brownfield code-side hardening.
- ❌ Dashboard UI změny — out of scope; existing wm/development tasks pokrývají.

## Test results

Před hardening: 7313 passed / 99 packages.
Po hardening: **7321 passed / 99 packages, 0 fails** (+8 nových testů).

```
campaigns 1179 passed (added 9 hardening tests)
mailboxes  656 passed (no change)
contacts  2785 passed (no change)
inbox       44 passed (no change)
common     635 passed (no change after audit.Execer refactor)
relay     1361 passed (no change)
orchestrator 1520 passed (no change)
privacy-gateway 661 passed (no change)
```

## Critical Path Status

| Komponenta | Hardening | Status |
|------------|-----------|--------|
| campaigns/sender/antitrace | typed errors, struct logs, MailboxUsed fix | ✅ |
| campaigns/sender/engine.Run | logs already structured | ✅ |
| campaigns/campaign/runner | suppression filter, audit_log, log fixes | ✅ |
| mailboxes/watchdog/daemon | already well-hardened (audit confirmed) | ✅ |
| mailboxes/mailbox/* | 98% coverage, prod-ready | ✅ |
| orchestrator/imap/poller | exponential backoff, deadlines, ctx-aware | ✅ |
| orchestrator/imap/extractMailBody | bounded read (2000 char) | ✅ |
| inbox/reply/classify | 100% coverage | ✅ |
| relay/anti-trace + transport | 84% coverage, well-tested | ✅ (good enough) |

## Připraveno k merge

- 6 souborů změněno, 1 nový test soubor (antitrace_hardening_test.go),
  1 nový test soubor (runner_suppression_test.go), 1 dokument (tento).
- Všechny testy zelené napříč 99 packages.
- Žádné production-API breaking changes (audit.Execer je strict relaxation).
- HARD RULE compliance: žádný campaign send proběhl, code-only changes.

## Další kroky (mimo tento pass)

1. **SEND-S1 unblock** — operator musí zadat 4 Seznam app passwords v
   dashboardu (Claude nemůže — destructive op s credentials).
2. **Live SMTP probe** — po S1 spustit `pnpm send` na vlastní email s 1
   active mailboxem, ověřit že:
   - antitrace_hardening_test typed errors fire jak má
   - audit.Log řádek se zapíše do operator_audit_log
   - suppression filter SELECT viditelný v Postgres logs
3. **Dry-run kampaň** — `CAMPAIGN_DRY_RUN=true` → 0 emailů odejde, ale
   audit_log + slog audit kompletní.
4. **Soft launch** — 5 testovacích kontaktů (vlastní emaily) → ověření
   real-world flow.
5. **Full first campaign** — po user approval gate, viz FIRST-CAMPAIGN-SUPERPLAN.
