# Plan + Sprints — 2026-04-23 → 2026-05-27 (5 sprint-týdnů)

**Status:** living. **Owner:** tomas. **Base:** `docs/initiatives/2026-04-22-discipline-and-domain-migration.md` (strategie) + `docs/initiatives/2026-04-22-send-pipeline-unblock.md` (SEND track).

Tento dokument je **taktický plán v týdenních sprintech**. Strategické "proč" zůstává v obou bázových iniciativách; tady jsou konkrétní deliverables s commit-level granularitou.

---

## Plan — velký obrázek

| Milník | Scope | Status (2026-04-23) |
|--------|-------|---------------------|
| M0     | Discipline + scaffolding + service template | ✅ hotovo |
| M1     | `features/outreach/mailboxes/` (mailbox, watchdog, bounce) | ✅ M1a-e hotovo |
| M2     | `features/outreach/relay/` + proxy reorganizace | 🟡 rename ✅, reorg pending (#84) |
| M3     | `features/outreach/campaigns/` (campaign, sender, warmup, token) | 🟡 M3.1+M3.2 ✅, M3.3-4 pending |
| M4     | `features/acquisition/contacts/` (enrichment, lead, prospect, segment) | 🟡 M4.1-3 ✅, M4.4+ pending (#86) |
| M5     | `features/inbound/inbox/` (imap, thread, reply) | 🟡 M5.1+M5.2a-b ✅, M5.2c-4 pending |
| M6     | Dashboard shell cleanup (UI → `services/*/ui/`) | ⏳ pending (#88) |
| M7     | `modules/outreach/` smazání | ⏳ pending (#89) |

**M5 prep side-effect:** 6 pkgs promoted out of `internal/` (health, humanize, alert, imap, thread, llm) + 4 M3.2 pkgs (warmup, token, sender, campaign). Only web handlers + 8 leaf pkgs zůstávají v `internal/`.

**Paralelní SEND track:**

| SEND step | Status | Gate |
|-----------|--------|------|
| S1 real creds do DB | ⏳ user-side (#99) | — |
| S2 AUTH probe + circuit reset | ✅ | endpoint + UI button shipped |
| S3 E2E self-send | ⏳ blocked by S1 (#101) | script ready |
| S4 window + warmup audit | ✅ | — |
| S5 first pilot | ⏳ blocked by S1-S3 (#103) | FIRST-CAMPAIGN-PLAN |
| S6.1-6.5 guardrails + badges | ✅ | CI guard, banner, runbook |

---

## Sprint 1 — 2026-04-23 → 2026-04-29 "Close M3 + M5 code moves"

**Goal:** Každý pkg co patří do domain service je public (nebo moved). Web handlers + go.mod další sprint.

### Deliverables

- **M3.3** — carve `web/campaigns.go` + `web/segments.go` handlers do `features/outreach/campaigns/internal/web/`. Baseline: 2527 tests → očekáváno 2527 (refaktor bez změny testů).
  - A1: create `features/outreach/campaigns/internal/web/` pkg
  - A2: move 15 handler funkcí (GET /api/campaigns, POST, PATCH, DELETE, status, preflight, steps, contacts, send-log, …)
  - A3: update cmd/outreach/main.go routing table
  - A4: `go test -count=1 ./...` stable

- **M5.2c** — carve reply classification slice z `outreach/llm` (nebo dedicated `reply/` pkg) → `features/inbound/inbox/reply/`.
  - B1: identify slice (`ClassifyReply`, reply-specific prompts)
  - B2: extract do `features/inbound/inbox/reply/` + `reply_test.go` same-count
  - B3: intelligence loop import path update

- **M5.3** — carve web handlers `/api/inbox/*`, `/api/replies/*`, `/api/threads/*` → `features/inbound/inbox/internal/web/`.

- **UI-1** — Vitest property test pro `schrankaWord` + `verbForm` helpers (fast-check ranges 0..200, explicit 11-14 edge).
- **UI-2** — E2E Playwright spec: `/campaigns/:id/preflight` gate lock (T-U01) — 5 contract checks + 3 state transitions.

**Done = DoD:**
- [ ] All new `services/*` pkgs have service.yaml + README
- [ ] Tests same-count baseline verified per commit
- [ ] PR open with Sprint 1 bundle; Chat B covers with `Needs-Tests:` trailers
- [ ] BOARD synced

---

## Sprint 2 — 2026-04-30 → 2026-05-06 "services own go.mod"

**Goal:** `features/outreach/campaigns/` a `features/inbound/inbox/` mají vlastní `go.mod`, zaregistrované v root `go.work`.

### Deliverables

- **M3.4** — `features/outreach/campaigns/go.mod` + replace ve `modules/outreach/go.mod`. Pattern proven v `features/outreach/mailboxes` M1d.
- **M5.4** — `features/inbound/inbox/go.mod` + replace. Include imap + thread + reply.
- **Contract discipline** — `go mod verify` na root; CI guard že v `modules/outreach/go.mod` není cyklická závislost.
- **UI-3** — Playwright spec `/api/campaigns/:id` happy path (create → status=active → pause → delete). Run mod 18175/18001.
- **UI-4** — Component test: `CampaignDetail` preflight widget — render all 5 check states × failing/passing.

**Done = DoD:**
- [ ] `go work sync` čistý
- [ ] Tests 2527+ napříč všemi moduly
- [ ] Railway build čistý (services deploy jako sub-service, single railway.json)

---

## Sprint 3 — 2026-05-07 → 2026-05-13 "SEND pilot live"

**Goal:** První skutečná kampaň běží na 4 mailboxech. Unblock #99 (user) + #101 (S3) + #103 (S5).

### Deliverables

- **SEND-S1** uživatel doplní reálná Seznam credentials (blocker — Claude nemůže). Preflight UI badge ověří `has_valid_password=true` pro 4 mailboxes.
- **SEND-S3** E2E self-send: run `scripts/send-probe-all-mailboxes.sh` proti prod relay, pak `curl /submit` self-to-self, verify Inbox.
- **SEND-S5** první pilot — kampaň #1 "Strojírenství — první kontakt", 10 kontaktů, canary window. Monitor auth-fail-alert banner, proxy-exhaust banner, mailbox health.
- **SEND-S6.6** nový — banner "Canary mode active" když `canary_remaining > 0` na aktivním mailboxu.
- **UI-5** — E2E `campaign-lifecycle.spec.ts` extend: active → send-log populated → replies visible.
- **UI-6** — Property test: Czech pluralization helper centralizovaný do `lib/czech-plural.js`, vystaven oběma bannerům + contact counts + reply counts.

**Done = DoD:**
- [ ] At least 5 deliveries logged v `send_events`
- [ ] No AUTH-fail alert during the campaign window
- [ ] Proxy pool nepoklesne pod 15 working proxies
- [ ] Replies (if any) properly classified a zobrazené v `/replies`

---

## Sprint 4 — 2026-05-14 → 2026-05-20 "M6 dashboard shell cleanup"

**Goal:** `features/platform/outreach-dashboard` je jen routing shell; UI per doména žije v `services/*/ui/`.

### Deliverables

- **M6.1** — `features/outreach/campaigns/ui/` pnpm package: `Campaigns.jsx`, `CampaignDetail.jsx`, preflight widgets. Publish jako `@hozan/campaigns-ui`.
- **M6.2** — `features/inbound/inbox/ui/` pnpm package: `Replies.jsx`, thread drawer.
- **M6.3** — `features/acquisition/contacts/ui/` finalize (M4.4+).
- **M6.4** — `features/platform/outreach-dashboard/src/pages/*.jsx` redukovat na thin wrapper: `export { default } from '@hozan/<domain>-ui'`.
- **UI-7** — Playwright visual regression snapshots každá main page → zabrání CSS regresi při šití.
- **UI-8** — E2E navigation.spec extend: assert `window.__HOZAN_UI_PKG__ = '@hozan/campaigns-ui'` (debug metadata for ownership provenance).

**Done = DoD:**
- [ ] `features/platform/outreach-dashboard/src/pages/` < 10 souborů
- [ ] pnpm workspace čistý (`pnpm install` → zero warnings)
- [ ] Tests napříč balíčky OK

---

## Sprint 5 — 2026-05-21 → 2026-05-27 "M7 smazání + final validation"

**Goal:** `modules/outreach/` neexistuje. Vše žije v `services/*/` nebo `apps/*/`.

### Deliverables

- **M7.1** — `cmd/outreach/main.go` přesun do `features/inbound/orchestrator/` (nebo každá doména vlastní binary).
- **M7.2** — remove `modules/outreach/` directory.
- **M7.3** — root `go.work` zmrazený — only `services/*` + `apps/*`.
- **M7.4** — `docs/architecture/DOMAIN-MAP.md` finalize all domains as `active`.
- **Closure** — uzavřít #88, #89, #90 (P2-1 merge gate), #66 (CI zelený na main).

**Done = DoD:**
- [ ] CI green na main
- [ ] PR from wm/development → main merged
- [ ] Weekly rollup `docs/rollups/2026-05-27.md` captures 5-sprint arc

---

## Cross-cutting priorities (per sprint)

| Tag | Scope | SLA |
|-----|-------|-----|
| P0-1 | PR #8 merge (blocked by CI) | unblock do S1 |
| P0-2 | GitHub Actions billing fix | user-side, S1 |
| P0-5 | Rotate 3 leaked secrets | before S3 pilot |
| P1-4 | Secret hygiene sweep | S2 |
| P2-1 | Merge gate CI | S5 |

**Testing discipline (všechny sprinty):**
- TDD red-green-refactor per feature
- ≥10 test cases per substantive change (per HARD RULE v memory)
- E2E lock pro každý nový UI banner / operator action
- Contract tests v BFF reflect každý nový route
- Same-count Go test baseline per migration commit

---

## Signals (BOARD sync každý sprint end)

- Chat A trailer: `Needs-Tests: <modul> <popis>` na každý non-trivial feature commit
- Chat B trailer: `Resolves-Trailer: Needs-Tests: …` když E2E/integration hotové
- `Breaks-Contract: <api|event|schema>` při změně API shape → Chat B update contract snapshot

---

## References

- **Strategie:** `docs/initiatives/2026-04-22-discipline-and-domain-migration.md`
- **SEND track:** `docs/initiatives/2026-04-22-send-pipeline-unblock.md`
- **Domain map:** `docs/architecture/DOMAIN-MAP.md`
- **BOARD:** `docs/handoff/BOARD.md`
- **Weekly rollups:** `docs/rollups/TEMPLATE-weekly.md`
