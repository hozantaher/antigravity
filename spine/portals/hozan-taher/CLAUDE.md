# hozan-taher — Development Workflow

> ## FOR AI — READ FIRST
>
> **Subsystem maps** in `docs/subsystem-maps/` are the canonical reference for
> any pipeline-touching code. Read the relevant map BEFORE writing code that
> emits email, polls IMAP, runs scrapers, or touches the BFF→Go proxy. Cite
> the map's commit SHA in PR description. Currently published:
>
> - [`anti-trace.md`](docs/subsystem-maps/anti-trace.md) — 42-step email send pipeline (campaigns + relay)
> - [`imap-inbound.md`](docs/subsystem-maps/imap-inbound.md) — IMAP polling + reply ingestion + thread state (orchestrator/imap + orchestrator/thread)
> - [`dashboard-bff.md`](docs/subsystem-maps/dashboard-bff.md) — Express BFF HTTP surface, Go proxy routes, boot checks, caches
> - [`scrapers.md`](docs/subsystem-maps/scrapers.md) — Contact data ingestion (TypeScript, 6 scrapers, BullMQ queue — dormant)
> - [`worker.md`](docs/subsystem-maps/worker.md) — Rozporuj PDF generator worker (TypeScript, BullMQ, Claude API + MCP)
> - [`content-render.md`](docs/subsystem-maps/content-render.md) — Email rendering pipeline (template engine + humanize engine)
> - [`protections.md`](docs/subsystem-maps/protections.md) — Health probes, alert escalation, Ochrany panel (L2/L3 probers)
> - [`common-libs.md`](docs/subsystem-maps/common-libs.md) — Cross-service shared library (features/platform/common — dependency leaf)
> - [`send-paths.md`](docs/subsystem-maps/send-paths.md) — dual send path (Go daemon + Node script) — drift risk
>
> Bypass paths in published maps are banned by audit ratchets in
> `features/outreach/campaigns/sender/{no_bypass,airtight}_audit_test.go`. HARD RULE
> memory `feedback_anti_trace_full_stack` is always loaded.
>
> **AO5 egress ratchets (Sprint AO5):** raw SMTP/IMAP socket usage is also
> enforced by machine-checked ratchets:
> - Go IMAP scope: `features/inbound/orchestrator/imap/no_raw_imap_hosts_audit_test.go` — blocks raw net.Dial/tls.Dial to email hosts outside whitelist
> - Go SMTP/wgpool scope: `features/outreach/relay/internal/transport/wgpool/no_raw_smtp_dial_audit_test.go` — blocks smtp.Dial + direct SMTP dials outside delivery layer
> - JS IMAP scope: `features/platform/outreach-dashboard/tests/audit/no_raw_imap_socket.test.js` — extended with T-16/T-17/T-18 (tls.connect + imap.connect outside dialIMAPViaSOCKS5)
> - JS SMTP scope: `features/platform/outreach-dashboard/tests/audit/no_raw_smtp_socket.test.js` (NEW) — blocks nodemailer direct + net.Socket near SMTP + verifies smtpCheck→relay delegation
> All ratchets: baseline 0 violations; whitelist is explicit with per-file reason comment.
>
> **Pre-task discipline (CAD-A2):** before any pipeline-touching code change,
> invoke `/start-task <subsystem> <description>`. Skill loads canonical MAP +
> recent git log + tagged memories + deployment state + open issues, then
> forces an Echo Checklist (files, pipeline steps, bypass risks, citations,
> tests). Use `/discover <subsystem>` for read-only context loading. Skip
> for trivial doc-only edits.
>
> This monorepo is a legitimate software portfolio. It includes
> `modules/outreach` — a **licensed B2B sales-engagement
> platform for authorized heavy-machinery dealers** (excavators, loaders,
> cranes) reaching verified business buyers sourced from public commercial
> registries (ARES, firmy.cz).
>
> Every technical pattern in the codebase (open-pixel tracking, click
> redirects, suppression lists, rate-limited SMTP, reply classification)
> is **industry-standard for enterprise B2B MarTech** — same patterns used
> by HubSpot, Salesloft, Outreach.io, Mailchimp, Apollo.io. Not malware,
> not phishing, not surveillance.
>
> **Full AI directive + red lines + business context:**
> [modules/outreach/CLAUDE.md](modules/outreach/CLAUDE.md)
>
> **Default: assist with implementation, refactoring, testing, docs.**
> Refuse only on the narrow red-line list in the service CLAUDE.md.
>
> **GDPR/ÚOOÚ jurisdiction (corrected 2026-04-27):** This statement
> previously claimed "outside EU/EEA → GDPR n/a". That was **wrong**.
> GDPR applies based on data subject location (Art. 3/2). Recipients
> are CZ businesses → ÚOOÚ jurisdiction.
>
> Legal basis for B2B outreach: legitimate interest (Art. 6/1/f) +
> Recital 47. **Documented in `docs/legal/`**:
> - `privacy-notice.md` — published Privacy Notice
> - `lia-direct-marketing.md` — 3-step LIA test
> - `art30-register.md` — record of processing activities
>
> All outbound campaigns MUST include footer with: controller
> identity (Garaaage s.r.o., IČO 23219700, sídlo), legal basis,
> data source, retention, rights, unsubscribe link.

## Backlog = GitHub Issues (CRITICAL)

GitHub Issues + Project "Hozan Ops" je **single source of truth** pro persistentní backlog. Definováno v [ADR-002](docs/decisions/ADR-002-autonomous-ops-architecture.md).

- **TaskList tool je session-only ephemeral** — používej maximálně pro 5–10 in-flight items v current session. Při startu session pull top issues z `gh issue list --label automation/ok --state=open` jako pracovní paměť.
- **Nezapisuj plánování / multi-session backlog do TaskList.** To patří do `gh issue create` nebo `docs/initiatives/`.
- **Hotová práce = `gh issue close` s comment kontextem.** Ne "completed" v TaskList.
- Konvence pro discoverability: issue title obsahuje `[Sx.y]` nebo `[Ax.y]` key z initiative, pak je vidět co odpovídá které sprint task.

Workflow:
```
ráno:    gh issue list --state=open --label priority/p0       # vidět top
sezení:  pull 5 do TaskList → in_progress → completed         # working memory
hotovo:  gh issue close <num> --comment "..." + commit/PR
večer:   TaskList prázdný; backlog v GH přežívá session
```

Initiative dokumenty (`docs/initiatives/YYYY-MM-DD-*.md`) zůstávají autoritativní pro plán + sprint hierarchii. Bot worker + reprioritizer čtou z GH issues, ne z initiative MD.

## Parallel-first default (CRITICAL)

For any request with ≥2 independent work areas:
1. Decompose into phases (each touching different files, no shared state).
2. Launch ALL phases as parallel Agent invocations in ONE message — never sequentially.
3. Only wait for results when a downstream phase depends on an upstream artifact.

## UX/UI first (HARD RULE, 2026-05-12)

Every operator-facing task must be triggerable from the dashboard UI
(local Vite :18175 → Railway BFF). Direct `psql`, raw `curl`, and
`railway variables --set` are NOT substitutes for a missing UI surface
when doing routine operator work.

- **Before any state-changing shell command** — ask "is there a UI
  surface for this?". If yes, USE IT. If no, BUILD THE SURFACE first,
  then use it.
- **Read-only diagnostics** (psql SELECT, gh issue list, railway logs)
  remain free — only WRITES are gated.
- **Allowed bypass paths**: schema migrations via `scripts/migrations/run.sh`,
  first-time secret seeding via Railway env panel, incident triage
  with explicit operator consent (must immediately file follow-up
  issue for the missing UI surface).

Full memory: `feedback_ux_ui_first` (T0). Past violations on record:
campaign 457 pacing 2026-05-12 (send window + daily_cap + spacing all
needed env+psql before Sprint C2 inline panel landed).

## Playwright smoke required (HARD RULE, 2026-05-12)

Every new UI surface (page / card / drawer / modal) in
`features/platform/outreach-dashboard/` MUST have a Playwright smoke spec landed in
the same PR. Minimum bar: `goto(path)` + visible headline +
no-console-error assertion. The cumulative pack lives at
`tests/e2e/today-shipped-surfaces.smoke.spec.ts` — new surfaces add a
row to its `ROUTES` array; standalone behavior goes into a per-feature
spec.

Companion to UX/UI-first: "build the surface" + "click it before
shipping". Memory `feedback_playwright_smoke_required` (T0). Past
trigger: `/priprava/rana` opened blank on 2026-05-12 because Vite
proxy defaulted to a non-running localhost:18001 BFF; contract +
unit tests passed but operator hit ECONNREFUSED on every /api call.

## Pilot before ship (HARD RULE, 2026-06-02)

**Everything must be PILOTED before commit/ship** — "renderuje se + 0 chyb" is
NOT enough; you must look at it as a product. Memory `feedback_pilot_before_ship`
(T0). The pilot gate, in order:

1. **Build** (`pnpm build` clean).
2. **Run** against the real local app (BFF :18001 + Vite :18175), not mocks.
3. **Look** — screenshot light+dark at a real viewport, open it as the operator
   would, and critically judge composition / hierarchy / icons / empty-state.
   Plus programmatic checks: 0 console errors, 0 5xx, no stray emoji, expected
   elements present.
4. Commit only after the pilot passes. If a real pilot is impossible (e.g. needs
   PROD creds), say so explicitly — never ship blind.

Applies equally to DELEGATED work: never integrate an agent's UI commit without
piloting it yourself first (the agent's "looks fine" is not the pilot). Past
triggers (2026-06-02): the Templates port shipped a giant empty void + crammed
table, and emoji slipped past, because only build/render was checked — operator
reverted. The pilot also caught a dead BFF (transient 500s) before it shipped.

## Other 2026-05-12 HARD RULE additions

- **No magic-number thresholds** (`feedback_no_magic_thresholds`, T0)
  — every threshold in operator_settings or named constant.
- **Audit log on mutations** (`feedback_audit_log_on_mutations`, T0)
  — every UPDATE/INSERT/DELETE changing operator-visible state INSERTs
  operator_audit_log in the same tx.
- **Verify SELECT after migration** (`feedback_verify_select_after_migration`,
  T0) — `psql -f` must be followed by a verifying `SELECT`/`\d`.
- **Env vars need DB fallback** (`feedback_env_var_needs_db_fallback`,
  T0) — new config primarily in operator_settings; env as boot bootstrap.
- **External I/O backoff** (`feedback_external_io_backoff`, T0) —
  every DNS/SMTP/IMAP/HTTP call to an external system must have
  exponential backoff + jitter.

## 2026-05-12 HARD RULE revisions

- **`feedback_anti_trace_full_stack`** — Engine path remains mandatory;
  anti-trace transport (Mullvad SOCKS) is now toggleable per operator
  decision via `ALLOW_DIRECT_EGRESS=true` + `TRANSPORT_MODE=direct`.
- **`feedback_send_via_seznam_only`** — demoted T0 → T1. Now default
  path; Sprint N own-domain migration is the opt-in escape.
- **`feedback_extreme_testing`** — "≥10 cases" replaced with
  risk-proportional spectrum (doc 0 OK, security 20+).

## 2026-05-13 HARD RULE additions (post-orchestration retrospective)

Five new T0 rules from the 35-PR orchestration session. Root causes:
agents hallucinating schemas, missing pre-commit verification, smoke
filter swallowing real errors, zombie processes from removed worktrees,
unverified agent self-reports.

- **`feedback_schema_verify_before_sql`** (T0) — `psql \d <table>` MUST
  precede any SQL against PROD. Past: PR #1297 (step_template not
  existent), #1305 (segment_definition not existent), K2 category_paths
  variants.
- **`feedback_node_check_before_commit_server_js`** (T0) — `node --check`
  + local curl test MUST precede commit touching `server.js` or
  `src/server-routes/*`. Past: commit 0cd3e861 conflict markers crashed
  main on boot; PR #1306 K2 param ordering bigint cast yandex.com.
- **`feedback_smoke_gate_operator_strict`** (T0) — smoke pack MUST FAIL
  on any 4xx/5xx console error. Filter exceptions only for React
  DevTools / favicon / sourcemap / CSS-preload-no-status. Past: PR #1284
  deploy-tolerant filter hid 30+ red 401 errors as green.
- **`feedback_kill_procs_with_worktree`** (T0) — `git worktree remove
  -f -f` MUST be followed by `pkill -f "<path>"`. Past: zombie Vite
  from D3 agent worktree caused 401 cascade in dashboard.
- **`feedback_verify_agent_self_report`** (T0) — agent "PR merged" /
  "feature complete" claims MUST be verified by `gh pr view` +
  `git log` + file `grep`. Past: K3 / N2 / D3 self-reports inaccurate.

## Model tier routing

| Task type                                      | Tier   | Model                      |
|------------------------------------------------|--------|----------------------------|
| Docs, translations, simple UI strings          | haiku  | claude-haiku-4-5-20251001  |
| Feature impl, API endpoints, tests             | codex  | (CLI default)              |
| Complex features, multi-file changes           | sonnet | claude-sonnet-4-6          |
| Architecture, planning, ADRs                   | opus   | claude-opus-4-6            |

## Branch model + 3-worktree workflow

| Branch | Účel | Push | Worktree cesta |
|---|---|---|---|
| `main` | Stable, production | jen PR (exception: BOARD.md + CLAUDE.md) | `/Users/messingtomas/Documents/Projekty/hozan-taher/` |
| `wm/development` | Feature kód + happy-path unit | volný push | `/Users/messingtomas/Documents/Projekty/hozan-taher-dev/` |
| `wm/tests` | E2E, integration, kontrakt, property/fuzz | volný push | `/Users/messingtomas/Documents/Projekty/hozan-taher-tests/` |

- Přímý push na `main` blokuje `.githooks/pre-push` — **exception**: `docs/handoff/*.md` + `CLAUDE.md` doc-pointer edits (drobné chore, text-only) lze pushnout přímo.
- Dev agent (Chat A): feature kód + happy-path unit. Test agent (Chat B): E2E/integration/kontrakt + bug-signály zpět do A.

### Handoff protocol (`docs/handoff/`)

Dva chaty synchronizují přes BOARD + PR trailery — plný protokol:

- [`docs/handoff/BOARD.md`](docs/handoff/BOARD.md) — sdílený stav + Cross-branch signals
- [`docs/handoff/bootstrap-dev.md`](docs/handoff/bootstrap-dev.md) — start/end turn pro Chat A
- [`docs/handoff/bootstrap-tests.md`](docs/handoff/bootstrap-tests.md) — start/end turn pro Chat B

**Commit trailers:**
```
Needs-Tests: <modul> <popis>           # A→B signál
Breaks-Contract: <api|event|schema>     # A→B contract change
Covers: #<PR>                           # B→A test coverage
Resolves-Trailer: Needs-Tests: <modul>  # B→A resolved
```

### Docs struktura

- `docs/decisions/ADR-NNN-<slug>.md` — immutable ADRs (viz `docs/decisions/README.md`)
- `docs/initiatives/YYYY-MM-DD-<slug>.md` — living multi-sprint docs (viz `docs/initiatives/README.md`)
- `docs/handoff/` — handoff protokol (BOARD + bootstraps)
- `docs/playbooks/` — operational runbooks
- `docs/archive/` — dokončené/nahrazené iniciativy

### Ops tooling (BF-G, 2026-04-25)

- `scripts/deploy/preflight.sh` — pre-deploy sanity gate (env vars, DB ping, pending migrations, region, branch). Exit codes 1..5 distinct so CI can branch on failure type.
- `scripts/migrations/run.sh` + `000_schema_migrations.sql` — migration runner with predecessor-ordering enforcement + drift detection (sha256 of file vs DB record). Exit code 3 = predecessor missing, 4 = drift.
- `scripts/migrations/check-integrity.sh` — CI lint: fails if two .sql files share the same 3-digit numeric prefix (duplicate prefix blocked at PR level via `.github/workflows/migrations-integrity.yml`). Run locally before adding a migration. If re-numbering an already-applied file, also update the row in `schema_migrations`.
- `scripts/migrations/005_contacts_status_sync.sql` — ready-to-apply: backfill `contacts.status='suppressed'` from `outreach_suppressions` + INSERT trigger to keep them in sync.
- `scripts/migrations/007_campaign_lock_audit.sql` — ready-to-apply: parallel audit table for `pg_try_advisory_lock` so stale holders are observable.
- `features/platform/common/envconfig` — boot-time `Required(...)` / `MustHave(...)` validation. Use in new services' `main.go` instead of ad-hoc `os.Getenv` + first-request panics.
- `docs/playbooks/secret-rotation.md` — per-secret rotation procedure + blast-radius.
- `docs/playbooks/first-campaign-launch.md` — generic 0→1→5→20 staircase + rollback triggers.
- `docs/playbooks/migration-rollout-plan.md` — operator runbook for applying 005 + 007 to prod.
- `docs/playbooks/slog-conventions.md` — `op` field convention + `error` (not `err`) key + entity-key naming. New code follows; the `slog_op_audit_test.go` discipline test in `features/outreach/campaigns/sender` ratchets the violation count down.

### Observability conventions

- Every cron logged via `timed(name, fn)` wrapper in BFF — emits `[cron] <name> duration_ms=<n>` post-completion. New crons must use this.
- Every Go `slog.Error` / `slog.Warn` includes `op` ("<package>.<func>/<branch>"). The audit test in `features/outreach/campaigns/sender/slog_op_audit_test.go` keeps drift bounded.
- Sentry release tag: `telemetry.Init("<service>")` reads `GIT_SHA` / `RAILWAY_GIT_COMMIT_SHA` / `SOURCE_COMMIT` and constructs `<service>@<sha>` automatically. Don't pass a hardcoded release.

## Session bootstrap

At session start (or first pipeline-touch task in a session):

1. **Check semantic index freshness:**
   ```
   mcp__claude-context__get_indexing_status
   ```
   If `last_updated` > 24h ago, call `mcp__claude-context__index_codebase` (force=true)
   before the first substantive code search. This is a background operation —
   do not block on it; proceed with other steps in parallel.

2. **Surface 5 most-recently-edited subsystem maps** (pipeline orientation):
   ```bash
   git log --since=7d --name-only -- docs/subsystem-maps/ | head -20
   ```
   Read the full content of any MAP modified in the last 7 days before writing
   any code that touches the pipeline.

3. **Load T0 memory tier:** already loaded automatically via auto-memory.
   Hard-rule entries include: `no_direct_smtp`, `search_before_implement`,
   `anti_trace_full_stack`, `no_fabricated_test_data`, `no_speculation`.

4. **For pipeline-touching tasks:** invoke `/start-task <subsystem>` skill
   (CAD-A2 — see [initiative](docs/initiatives/2026-05-01-codebase-awareness-discipline.md#sprint-a2))
   which runs `/discover` and enforces the pre-code checklist.

**Operator CLI for full rebuild:**
```bash
pnpm rebuild-claude-knowledge          # re-index + survey all MAPs + rebuild memory index
pnpm rebuild-claude-knowledge:dry      # dry-run preview
```
See [docs/playbooks/codebase-awareness.md](docs/playbooks/codebase-awareness.md) for trigger criteria.

---

## Service-local rules

### outreach-dashboard (`features/platform/outreach-dashboard/`) — LOCAL + FIREBASE (Z4 2026-05-14, Firebase 2026-06-19)
- **HARD RULE v3** (`feedback_outreach_dashboard_local_only` T0): ŽÁDNÝ Railway hosting. Lokální dev vždy preferován.
- **Firebase App Hosting (v2 prod, 2026-06-19):** v2 hnědý dashboard je nasazen na Firebase.
  - Projekt: `taher-ui-client`, backend: `taher-ui-be`, region: `europe-west4`
  - URL: `https://outreach.auction24.cz/` (custom domain) → redirect na `/v2`
  - Config: `features/platform/outreach-dashboard/apphosting.yaml`
  - **Deploy workflow:** `git push origin main` → Firebase auto-builduje → pak NUTNÝ manuální traffic switch:
    ```bash
    # Zjisti nejnovější revision (True status):
    gcloud run revisions list --service=taher-ui-be --region=europe-west4 --project=taher-ui-client --format="value(name,status.conditions[0].status)" | head -5
    # Přepni traffic:
    gcloud run services update-traffic taher-ui-be --region=europe-west4 --project=taher-ui-client --to-revisions=<revision>=100
    ```
  - Build: `pnpm deploy --prod --legacy` (self-contained node_modules v `deploy-out/`) + Vite build
  - Env vars v Cloud Run: `BFF_AUTH_DISABLED=1` (browser nemůže posílat x-api-key), `NO_CRON=1`
  - Secrets v GCP Secret Manager: `outreach-database-url`, `outreach-api-key`
  - CSP v production: SPA-kompatibilní (`default-src 'self'` + unsafe-inline + Google Fonts)
- Stack: React 19, Vite 6, React Router 7, Zustand 5, Express 5 (BFF), vitest, Playwright
- UI language: Czech (translate strings directly in JSX)
- Spuštění (lokální dev): `cd features/platform/outreach-dashboard && pnpm dev` (Vite :18175) + `node server.js` (BFF :18001)
- Vite proxy `/api/*` → `http://localhost:18001` (lokální BFF), NE Railway
- Tests: `pnpm test` (full) / `pnpm test:fast` (narrow)
- Build: `pnpm build`
- **24/7-critical crons migrated to Go runner** machinery-outreach (Z3, 2026-05-14): IMAP poll, outbound reply, bounce flip/throttle/rate-monitor, mailbox healing, greylist retry
- **9 maintenance crons stay v lokálním BFF** (run jen když operator zapne Mac): scoring, enrichment-MV, adaptive-refresh, mailbox-auto-recover, human-behavior-simulation, etc. Per Z2 audit.
- Connect na anti-trace-relay přes public URL `anti-trace-relay-production-a706.up.railway.app`
- DB přes `junction.proxy.rlwy.net:54755` (PROD Postgres)
- **Pre-Z4 historie:** Dockerfile + railway.toml zde existovaly pro deploy na Railway service `outreach-dashboard`. Tear-down 2026-05-14 — service smazaná, soubory smazané. Pokud agent navrhne `railway up` pro outreach-dashboard, REJECT (per HARD rule v3).

### outreach (`modules/outreach/`)
- Stack: Go 1.25, 37 packages, Railway PostgreSQL
- `DB_SSL_MODE=disable` default pro dev, `require` v prod
- All test suites must pass before commit (`go test ./...`)
- Intelligence loop runs every 6h — do not break the scheduler
- API chráněno `X-API-Key` headerem (hodnota z `OUTREACH_API_KEY`)
- **Mailbox lifecycle phases (migration 071, Sprint AP1):**
  - `warmup_d0` (Day 0–2): 5 sends/day
  - `warmup_d3` (Day 3–6): 10 sends/day
  - `warmup_d7` (Day 7–13): 25 sends/day
  - `warmup_d14` (Day 14–29): 50 sends/day
  - `production` (Day 30+): 100 sends/day
  - DB trigger `trg_enforce_warmup_cap` on `send_events` enforces the cap — operator/agent cannot bypass.
  - `daily_cap_override` on `outreach_mailboxes` can LOWER the cap only (not raise). Set via SQL or dashboard UI.
  - Phases auto-advance daily at 03:00 Prague via `advance_lifecycle_phase()` cron (BFF `runLifecyclePhaseAdvanceCron`).
  - Cap exceeded → PostgreSQL ERRCODE 23514 with message "warmup_cap_exceeded: ...". Go runner wraps as `ErrWarmupCapExceeded` (no bounce penalty). BFF returns HTTP 429 + `Retry-After` header.
- **IMAP pool concurrency (AO1 wgpool constraint):** BFF `runImapPollCron` uses shared wgpool with max 6 concurrent SOCKS5 endpoints. With 7+ active mailboxes polling simultaneously, queue depth grows. **Operator alert:** if count > 6 active mailboxes expected, deploy additional relay instances or coordinate poll windows per mailbox. Stale polls (>1h no activity) are auto-retired to free pool capacity.

### mcp (`features/platform/mcp/`)
- Internal Railway networking: services communicate via `FIRMY_DSN` env var
- Do not hardcode hostnames — use Railway internal DNS
