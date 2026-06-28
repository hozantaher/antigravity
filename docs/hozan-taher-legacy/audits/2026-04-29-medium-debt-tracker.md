# Sprint D — Quality debt tracker (post-2026-04-22 closure)

**Status**: triage complete (2026-04-29).
**Source**: memory entry `project_quality_debt_summary.md` — 13 MEDIUM
items deferred from the 2026-04-22 closure wave (61 HIGH/CRITICAL
already closed).
**Anchor doc**: `docs/initiatives/2026-04-29-ux-redesign-plan.md`
Sprint D placeholder.

This file replaces the Sprint D "TBD" with a per-item triage so each
of the 13 MEDIUM items has a documented decision: **fix-mechanical**,
**needs-design**, **accept-as-debt**, or **drop**.

---

## Decision summary

| Service | Item | Recommendation | Effort |
| --- | --- | --- | --- |
| worker | M1 — LLM timeout injection | ~~**fix-mechanical** (D-1)~~ ✅ shipped | (closed) |
| worker | M2 — p-limit cap value | **needs-design** ([#153](https://github.com/messingdev/hozan-taher/issues/153)) | policy decision (load test) |
| worker | M3 — Firebase upload collision guard | ~~**fix-mechanical** (D-2)~~ ✅ shipped | (closed) |
| worker | M7 — per-queue limiter | **needs-design** ([#154](https://github.com/messingdev/hozan-taher/issues/154)) | requires Redis-Lua or BullMQ-level config |
| worker | M9 — credential rotation hook | **accept-as-debt** | no measured incident |
| worker | M10 — Zod schema on job payload | **accept-as-debt** | breaking change risk; runtime guards in place |
| scrapers | M2 — robots.txt compliance | **needs-design** ([#155](https://github.com/messingdev/hozan-taher/issues/155)) | policy: polite-bot vs adversarial |
| scrapers | M3 — Redis-backed rate limiter | **needs-design** ([#156](https://github.com/messingdev/hozan-taher/issues/156)) | infra: standalone-process vs distributed |
| outreach Go | dropped ExecContext sites (~5) | **fix-mechanical** (Sprint D-3) | 1 day, audit + grep + add ctx |

**Distribution**: 3 fix-mechanical (TDD-able), 4 needs-design (block on
policy/infra decision), 2 accept-as-debt (no incident, breaking risk).

---

## Per-item triage

### ~~worker M1 — LLM timeout injection~~ ✅ shipped (D-1)

**Closed by**: Sprint D-1 PR. `streamMessage` now wraps each Anthropic
stream in an `AbortController` with `LLM_TIMEOUT_MS` (default 8 min).
Timeouts surface as `AbortError` and are explicitly NOT retried — a
backend that hung once will hang again, better to fail the job and
let BullMQ replay than extend the wedge.

5 unit tests cover: happy path, signal option propagated to SDK,
hang aborts after timeout, no retry on timeout, retry semantics
preserved for retryable APIErrors (5xx, 429).

---

### worker M2 — p-limit cap value

**State**: concurrency cap on PDF generation pipeline. Currently
hard-coded.

**Recommendation**: **needs-design**. Pick the cap based on:
- Worker CPU (Railway plan)
- LLM rate limit (Anthropic 50 RPM tier?)
- Firebase write throughput

**Blocker**: load test against prod Anthropic + Firebase under
real campaign volume. No data → no defensible cap.

---

### ~~worker M3 — Firebase upload collision guard~~ ✅ shipped (D-2)

**Closed by**: Sprint D-2 PR. New `uploadFileExclusive(storagePath,
buffer, contentType)` helper sets `ifGenerationMatch: 0` precondition
(GCS spec for "only write if file doesn't exist yet"). When two
parallel writers race on the same path, the loser's save returns
Firebase 412; we wrap that in a typed `FirebaseCollisionError`
carrying the path so callers branch on collision vs network errors.

5 unit tests cover: happy path (no collision), precondition opts
forwarded, 412 → FirebaseCollisionError, error carries path,
non-collision errors propagate as-is.

`uploadFile` (unguarded) stays for ergonomic-overwrite use cases;
new code on the PDF / DOCX path should prefer the exclusive variant.

---

### worker M7 — per-queue limiter

**State**: Single global concurrency cap. Should be per-queue
(generate-odpor, web-search, pdf-render each have different rate
profiles).

**Recommendation**: **needs-design**. Two paths:
1. **Redis-Lua**: per-queue token bucket in Lua, atomic. New
   dependency surface but precise.
2. **BullMQ rateLimit option**: built-in, less control.

**Blocker**: pick path (1) or (2). Author says (1) is overkill if
BullMQ rateLimit covers the tier.

---

### worker M9 — credential rotation hook

**State**: Anthropic / Firebase / OpenAI keys are env-loaded at
boot. No rotation pathway — to swap, restart pod.

**Recommendation**: **accept-as-debt**. Restart on Railway is
sub-second; no measured incident from missing rotation. If a key
ever leaks, Railway can swap env + redeploy in 30s.

**Re-open trigger**: any incident where slow restart matters (e.g.
when worker count grows past 1).

---

### worker M10 — Zod schema on job payload

**State**: BullMQ job payloads are typed via TypeScript interfaces
but not runtime-validated. A malformed payload from MCP could crash
the job runtime instead of failing the job and retrying.

**Recommendation**: **accept-as-debt**. The shape is producer-controlled
(MCP service); breaking-change risk on schema mismatches is real if
older MCP versions enqueue while new worker rolls out. Runtime
guards (try/catch in handlers) already prevent crash propagation.

**Re-open trigger**: any incident traced to bad payload that wasn't
surfaced as a clean retry.

---

### scrapers M2 — robots.txt compliance

**State**: scrapers don't currently parse `robots.txt` of target
sites. Crawl decisions are operator-driven (we know firmy.cz and
ARES allow our access).

**Recommendation**: **needs-design**. Two policies:
1. **Polite bot**: parse + respect `robots.txt`, skip disallowed
   paths. Defaults to permissive on parse failure.
2. **Adversarial-aware**: ignore `robots.txt`, use rate-limit +
   user-agent headers as the only signal.

We currently use (2) implicitly. (1) would be the right move if we
ever scrape sites we don't have a relationship with. Today: ARES
+ firmy.cz are explicit data sources.

**Blocker**: stakeholder decision on which policy to ship.

---

### scrapers M3 — Redis-backed rate limiter

**State**: `features/acquisition/scrapers/lib/utils.ts` `createRateLimiter` is
in-process (single-process Map). With multiple scraper pods, each
ratelimits independently → 2× the configured rate per target site.

**Recommendation**: **needs-design**. Currently single-pod, so this
is theoretical. If we scale to 2+ pods, Redis-backed limiter is
mandatory for ARES (their rate-limit is shared across IPs from
our infra).

**Blocker**: ops decision on horizontal scaling timeline. Until we
go multi-pod, the in-process limiter is fine.

---

### ~~outreach Go — dropped ExecContext sites (~5)~~ — CLOSED Sprint D-3

**State**: `services/outreach/server.go` H1-H6 closure (commit
`7648222`) handled the SEND-path ExecContext drops. ~5 lower-impact
sites remained in `features/outreach/campaigns/warmup/plan.go` (Daemon
methods) — Sprint D-3 closes them.

**Closure**: Sprint D-3 (TDD). Audit test
`features/outreach/campaigns/warmup/exec_context_audit_test.go` greps
`plan.go` for forbidden non-context patterns (`d.db.Exec`,
`d.db.Query`, `d.db.QueryRow`) and required
`d.db.ExecContext(ctx`/`d.db.QueryRowContext(ctx`. RED first,
then `Tick`/`EnrollMailbox`/`Pause`/`Resume`/`Reset`/`LimitForMailbox`
all accept `context.Context` and call `ExecContext`/`QueryRowContext`.
`mailbox.WarmupResetter` interface widened to take ctx;
backpressure call sites use the existing in-scope ctx; orchestrator
CLI dispatcher uses signal-rooted ctx; sender pickMailbox calls
through a small `warmupLimiterAdapter` (sender interface unchanged
because pickMailbox does not yet thread ctx).

---

## Sprint D follow-up plan

This tracker doc is **Sprint D-0** (PR #149-ish, this PR).

Each fix-mechanical item gets its own sub-sprint:

- ~~**D-1** — worker M1 LLM timeout~~ — CLOSED (PR #150)
- ~~**D-2** — worker M3 Firebase upload guard~~ — CLOSED (PR #151)
- ~~**D-3** — outreach Go ExecContext audit~~ — CLOSED (this PR)

Each needs-design item gets a GH issue with `needs-design` label and
a single-line summary linking back to the relevant section here.
Filed: [#153](https://github.com/messingdev/hozan-taher/issues/153)
worker M2, [#154](https://github.com/messingdev/hozan-taher/issues/154)
worker M7, [#155](https://github.com/messingdev/hozan-taher/issues/155)
scrapers M2, [#156](https://github.com/messingdev/hozan-taher/issues/156)
scrapers M3.

Each accept-as-debt item gets a memory note (`project_accepted_debt.md`)
with the re-open trigger so future agents don't re-litigate.

---

## How to read this file

- **fix-mechanical** = no policy decision; TDD-able; pick up + ship.
- **needs-design** = blocked on a stakeholder/ops decision; don't
  start coding until the design call is made.
- **accept-as-debt** = explicitly chosen risk; revisit only on
  documented incident.
- **drop** = was overstated in the audit; remove from tracking.

Whenever an item closes, update the row in the decision summary +
strike through the per-item section.
