**Status:** Archived
**Datum:** 2026-04-22
**Trigger:** Discipline + domain migration work completed; order closed 2026-04-30 phase 0

# Discipline + Domain Migration

**Created:** 2026-04-22
**Owner:** tomas
**Kind:** cross-cutting multi-sprint

## Motivation

Projekt je v driftu napříč vrstvami:

- **Deploy ≠ repo**: prod `outreach-dashboard` běží Nuxt, repo má React (4/5 deploys 2026-04-21 FAILED)
- **CI broken**: 10/10 posledních runs FAILED, i na main
- **Quality debt**: ~65 auditovaných bugů (HIGH+MEDIUM) napříč 6 službami, 0 fixů v prod od 2026-04-17
- **PR #8 CONFLICTING**: 47 commits, blokuje další práci
- **Main worktree hanging state**: 13 modified + 4 orphan docs >8h uncommitted
- **Config drift**: 15+ NUXT_* env vars na Railway po dokončené migraci, MAILBOX_N_PASSWORD v plaintext env
- **wm/tests sedí**: 17 commits behind, test agent neaktivní, BOARD protokol jednosměrný

Doménová vrstva je rozeseta — "mailboxes" existuje ve 5 složkách (`modules/outreach/internal/mailbox/`, `bounce/`, `watchdog/`, `features/outreach/anti-trace-relay/`, `features/platform/outreach-dashboard/src/pages/Mailboxes.jsx`). Ownership rozmazaný, invarianty nehlídá nikdo.

## Cíle

1. **Zastavit krvácení** (CI červené, PR conflictuje, main worktree trčí)
2. **Stabilizovat rytmus** (discipline pravidla, gate na merge, secret hygiene)
3. **Přestavět po doménách** (každá doména = jedna složka v `services/`, pod-services pro cross-cutting komponenty)

## Non-goals

- Nepřestavovat deploy model (ponechat 10 Railway services)
- Nepřecházet na Kubernetes/microservices runtime
- Nepřepisovat do jiného jazyka
- Nepřidávat nové produktové features během reorganizace

## Architektonická rozhodnutí

| # | Decision | Hodnota |
|---|---|---|
| 1 | Go modules | per-service (pokračovat v `go.work`) |
| 2 | Relay umístění | top-level `features/outreach/relay/` (cross-cutting transport) |
| 3 | Deploy | zachovat 10 Railway services, review typesense+ollama zvlášť |
| 4 | První doména | mailboxes, rozsekaná na 5 PRs (M1a-M1e) |
| 5 | Dashboard | thin shell `apps/dashboard/`, UI packages v pnpm workspace, build-time compose |

## Cílový layout

```
services/
├── mailboxes/        (Go registry + selector + warmup + backpressure + bounce)
│   ├── service.yaml
│   ├── cmd/
│   ├── internal/
│   ├── sub-services/ (logický namespace, sdílí deploy)
│   ├── ui/           (pnpm package: @hozan/mailboxes-ui)
│   ├── api/          (Express BFF routery)
│   ├── schemas/      (DB migrace + OpenAPI)
│   └── tests/
├── campaigns/        (sequence + scheduler + runner + preflight)
├── contacts/         (registry + segments + enrichment + deliverability)
├── relay/            (bývalý anti-trace-relay, transport/proxy pool)
├── privacy-gateway/
├── inbox/            (IMAP, reply handling, thread)
├── intelligence/     (analytics, reporting, learning loop)
└── scrapers/

apps/
└── dashboard/        (thin shell, composes UI z services/*/ui/)

infra/                (CI/CD, deploy, shared config)
packages/             (sdílené knihovny: auth, logging, pg-wrapper)
_archive/             (dokončené věci)
```

## Fázování

### Fáze P0 — Stop bleeding (dnes, 4-6h)

Zavřít akutní zdroje driftu, aby se daly další kroky dělat na čisté základně.

| ID | Task | Priorita |
|---|---|---|
| P0-1 | Resolve PR #8 conflicts → rebase wm/development na main → merge | P0 |
| P0-2 | Opravit red CI (fix nebo skip s tasklink) | P0 |
| P0-3 | Uklidit main worktree — commit/revert 13 modified + 4 orphan docs | P0 |
| P0-4 | Zavřít task #39 (Seznam app-passwords) — rozhodnout DB-only flow, smazat MAILBOX_N_PASSWORD z Railway | P0 |
| P0-5 | Rotate 3 leaked secrets (ANTI_TRACE_TOKEN, DEV_API_TOKEN, OUTREACH_API_KEY — byly v session logu) | P0 |

**Exit criteria:** CI green na main ≥1 run, 0 open PRs s conflict, všechny worktree git status čisté.

### Fáze P1 — Stabilizace (1-3 dny)

Zřídit discipline pravidla a vyčistit accumulated cruft.

| ID | Task |
|---|---|
| P1-1 | Sepsat `docs/playbooks/DISCIPLINE.md` (merge rules, CI gate, audit SLA, secret rotation policy) |
| P1-2 | Reset wm/tests (rebase na main, rozhodnout: aktivovat Chat B nebo zrušit worktree) |
| P1-3 | Railway service audit — owner per service, last-deploy check, stale service → decision |
| P1-4 | Secret hygiene sweep — smazat všechny `NUXT_*` a `*_BOOTSTRAP_*` env vars na Railway, doplnit `.env.example` s placeholders ve všech services |
| P1-5 | Konsolidovat 3 overlapping initiatives (monorepo-stabilization, outreach-unblock, outreach-dashboard-quality) do jednoho živého dokumentu |

**Exit criteria:** CI green 5 dní v řadě, 0 plaintext Nuxt/bootstrap creds na Railway, 1 konsolidovaný initiative doc, 0 orphan docs.

### Fáze M0 — Domain foundation (3-5 dní)

Připravit půdu pro doménovou migraci bez přesunu kódu.

| ID | Task |
|---|---|
| M0-1 | Vytvořit `docs/architecture/DOMAIN-MAP.md` — tabulka domén s owner, current physical location, public API, dependencies |
| M0-2 | Vytvořit `_template/service/` s kostrou (README, service.yaml, Dockerfile, migrations/, tests/) |
| M0-3 | Vytvořit `docs/playbooks/DOMAIN-MIGRATION.md` — checklist jak migrovat doménu (test-to-test, PR size, rollback, docs update, owner sign-off) |
| M0-4 | Rozhodnout top-level vs sub-service pro všech ~10 kandidátů, zaznamenat do DOMAIN-MAP |

**Exit criteria:** Doménová mapa + template + playbook reviewed & committed.

### Fáze M1 — Mailboxes migrace (1-2 týdny, 5 PRs)

První doména. Rozsekaná aby každý PR byl ≤3 dny a rollback-ready.

| ID | Rozsah | Odhad | Risk |
|---|---|---|---|
| M1a | Vytvořit `features/outreach/mailboxes/` kostru, přesunout `modules/outreach/internal/mailbox/` → `features/outreach/mailboxes/internal/registry/`, update Go imports, CI green | 2 dny | L |
| M1b | Přesunout `modules/outreach/internal/watchdog/` → `features/outreach/mailboxes/internal/backpressure/` | 1 den | L |
| M1c | Přesunout `modules/outreach/internal/bounce/` → `features/outreach/mailboxes/internal/bounce/` (pozor na coupling s sender) | 2 dny | M |
| M1d | Extrahovat UI: `features/platform/outreach-dashboard/src/pages/Mailboxes*.jsx` → `features/outreach/mailboxes/ui/` jako pnpm package, update dashboard shell | 2-3 dny | M |
| M1e | service.yaml + README + API contract + smazat staré import cesty + commit | 1 den | L |

**Exit criteria per PR:** CI green, manual smoke test prod, owner sign-off, docs update v tom samém PR.
**Exit criteria M1:** `features/outreach/mailboxes/` obsahuje celou doménu, `modules/outreach/internal/mailbox|bounce|watchdog/` prázdné, dashboard importuje z `@hozan/mailboxes-ui`.

### Fáze M2 — Relay + proxy (1 týden)

| ID | Task |
|---|---|
| M2-1 | `git mv features/outreach/anti-trace-relay/` → `features/outreach/relay/` |
| M2-2 | Extrahovat proxy pool jako `features/outreach/relay/sub-services/proxy/` |
| M2-3 | Update anti-trace-relay → relay všude v docs, env var names, Railway service name (nebo alias) |

### Fáze M3 — Campaigns (1-2 týdny)

| ID | Task |
|---|---|
| M3-1 | `modules/outreach/internal/campaign/` → `features/outreach/campaigns/internal/` |
| M3-2 | `modules/outreach/internal/sender/` → `features/outreach/campaigns/internal/runner/` |
| M3-3 | `modules/outreach/internal/sequence/` → `features/outreach/campaigns/internal/sequence/` |
| M3-4 | UI: campaigns pages → `features/outreach/campaigns/ui/`, service.yaml + contracts |

### Fáze M4 — Contacts + enrichment (1-2 týdny)

| ID | Task |
|---|---|
| M4-1 | `modules/outreach/internal/enrichment/` → `features/acquisition/contacts/sub-services/enrichment/` |
| M4-2 | Lookalike + segment + scoring → `features/acquisition/contacts/internal/` |
| M4-3 | UI + API + contracts |

### Fáze M5 — Inbox + intelligence (1 týden)

| ID | Task |
|---|---|
| M5-1 | IMAP + reply + thread → `features/inbound/inbox/` |
| M5-2 | Analytics + reporting + learning loop → `services/intelligence/` |

### Fáze M6 — Dashboard shell cleanup (2-3 dny)

| ID | Task |
|---|---|
| M6-1 | Rename `features/platform/outreach-dashboard/` → `apps/dashboard/` |
| M6-2 | Dashboard package.json dependencies jen na `@hozan/*-ui` packages |
| M6-3 | BFF routery z `services/*/api/` mountovány v dashboard/server.js |

### Fáze M7 — modules/outreach cleanup (1 den)

| ID | Task |
|---|---|
| M7-1 | Ověřit `modules/outreach/internal/` je prázdný |
| M7-2 | Smazat `modules/outreach/`, update `go.work` |
| M7-3 | Update docs, remove legacy references |

### Fáze P2 — Trvalý rytmus (probíhá souběžně)

| ID | Task |
|---|---|
| P2-1 | Merge gate: pre-merge hook (CI green + žádný CONFLICTING > 24h) |
| P2-2 | Weekly rollup (30 min, co se zavřelo/zůstává/přidalo) |
| P2-3 | Definition of Done čeklist v `docs/playbooks/DISCIPLINE.md` |
| P2-4 | Deploy ownership v `docs/playbooks/SERVICES.md` |
| P2-5 | Memory hygiene (quality debt entries s OPEN/IN-PROGRESS/FIXED status) |

## Timeline

```
Týden 1   [P0] [P1...............][M0........]
Týden 2   [M0][M1a][M1b]
Týden 3   [M1c][M1d][M1e]
Týden 4   [M2.......][M3a...]
Týden 5   [M3.....][M4a....]
Týden 6   [M4.....]
Týden 7   [M5......][M6...]
Týden 8   [M7][cleanup]
P2 běží souběžně celou dobu.
```

Odhad: **8-10 týdnů** (s normální kapacitou, ne dedikovanou). Kritická cesta: P0 → P1 → M0 → M1 → zbytek paralelně s P2.

## Success metrics

Po 8 týdnech:

- ✅ CI green ≥90 % dní
- ✅ 0 open PRs starších 3 dny
- ✅ 0 HIGH audit bugs open > 14 dní
- ✅ Všechny top-level domény v `services/<doména>/` s service.yaml
- ✅ `modules/outreach/` smazáno
- ✅ Dashboard je thin shell importující UI packages
- ✅ 0 plaintext secrets v `.env` na disku, 0 NUXT_* na Railway
- ✅ Discipline playbook + Services playbook + Domain migration playbook committed

## Rollback

Každý sprint je samostatně revertovatelný (single PR merge). Při kritickém problému:

```
git revert <merge-commit>
```

Domain migration sprinty NEMĚNÍ runtime behavior, jen adresářovou strukturu + imports. Runtime regrese = bug v migraci, ne v design rozhodnutí.

## Odkazy

- P0 root cause: hloubková analýza ze 2026-04-22 (session s Claude Opus 4.7)
- Architektonická rozhodnutí: viz sekci "Architektonická rozhodnutí" výše
- Quality debt audity: `memory/project_*_quality_debt.md`
- Předchozí iniciativy (konsolidovány v P1-5 → přesunuty do `_archive/initiatives/`, otevřené tasky přešly do sekce "Historical backlog" níže):
  - `_archive/initiatives/2026-04-20-monorepo-stabilization.md`
  - `_archive/initiatives/2026-04-21-outreach-unblock.md`
  - `_archive/initiatives/2026-04-21-outreach-dashboard-quality-refactor.md`

## Historical backlog

Otevřené položky zděděné z archivovaných iniciativ. Každá položka má odkaz na zdrojovou iniciativu (pro plný kontext) a bude rozdělena do některé z P/M fází výše během planning sweepu.

### Z `_archive/initiatives/2026-04-20-monorepo-stabilization.md` (monorepo stabilizace)

Odhadnuté statusy: S1 (CI unblock + zombie removal) a velká část S2 (docs sync) hotové přes `af706ae` + PR #7. Otevřené zbytky:

- [ ] **S3-2 Vitest unify 4.x** — `features/platform/outreach-dashboard` stále na `^2.1.0`, upgrade zahrnuje 3196 testů (snapshot + config breaking changes). Přesouvá do M6 (dashboard cleanup) nebo P2 (stabilita).
- [ ] **S3-3 Sdílený tsconfig/vitest base** — `packages/tsconfig/` + `packages/vitest-config/` neexistují, copy-paste vitest configs zůstávají. Přesouvá do P2.
- [ ] **S3-4 CI security jobs** — `pnpm audit --audit-level=high` + `govulncheck` + `golangci-lint` nejsou ve workflow. Přesouvá do P2-1 (merge gate).
- [ ] **S3-5 CI pro `apps/extension/server/`** — extension nemá CI matrix item. Lowest priority.
- [ ] **S4-1 Root `package.json` s meta skripty** (`test:all`, `typecheck:all`, `lint:all`, `build:all`) — chybí. Ulehčí P2.
- [ ] **S4-2 Legacy Nuxt stubs cleanup** — `features/platform/outreach-dashboard/app/` stále existuje jako "reference only". Řešit během M6 (dashboard shell rename).
- [ ] **S4-3 `lib/pq` → `pgx` migrace v modules/outreach** — deprecated driver. Přesouvá do M3 (campaigns migrace) nebo samostatný PR.
- [ ] **S4-4 Pin Docker base images** — `golang:alpine` bez verze v `modules/outreach/Dockerfile:7` + audit ostatních Dockerfiles. Přesouvá do P2.
- [ ] **S4-5 Minor dep drift sjednocení** — `express`, `dotenv`, `pg` mají drift mezi services. Přesouvá do P2.
- [ ] **S4-6 `.DS_Store` purge** — `git rm --cached $(git ls-files --cached "*.DS_Store")` + global .gitignore update.

### Z `_archive/initiatives/2026-04-21-outreach-unblock.md` (outreach kampaň #1 unblock)

Stav při archivaci: S2 (pool expansion) a S3 (observability + preflight endpoint) hotové. T-U01 (UI wiring preflight gate) vyřešeno commitem `c821d26`. Otevřené:

- [ ] **S1 Sending path unblock** — gated na user doložení real seznam.cz creds pro mb 631/632/1/3. Bez tohoto kampaň #1 nejde unpausnout. Po creds: assign-proxy × 4, full-check × 4, test email × 4, unpause + 15-min watch healing_log.
- [ ] **S4 Test coverage A→B signály** (Chat B work):
  - [ ] `classifyProbeReason` fuzzy test nad reálnými seznam error stringy + 503 body shape integration test na `POST /api/mailboxes/:id/assign-proxy`
  - [ ] `TestVerifyTLSHandshake_*` doplnit `bad_cert` classification case (self-signed proxy)
  - [ ] Property test `Run(ctx)` engine: canceled ctx ve všech backoff stavech returns do 100ms
  - [ ] E2E ověření `WithProxyPool` wiring: boot relay → GET `/v1/proxy-pool` → count > 0 když transport attached
- [ ] **S5 Long-tail hardening** (po S1 unblock):
  - [ ] Intelligence loop 48h miss check (`scheduler_miss` v logs)
  - [ ] ARES sync freshness (`outreach_ares_subjects` fresh v 7d)
  - [ ] IMAP replies smoke pro mb 631 po prvním odeslání
  - [ ] Mailsim bouncer re-validace v dev
- [ ] **T-U02 Full S5 smoke** po S1 unblock.

### Z `_archive/initiatives/2026-04-21-outreach-dashboard-quality-refactor.md` (dashboard quality refactor)

Stav při archivaci: W0-W2 plně hotové (primitives + critical lies + data integrity); W3 ~60 % (3/5 stránek); W4 částečně (primitiva nasazená, e2e + audit zbývá). Implementační commit `9c1fdd0`. Otevřené:

- [ ] **W3 dokončení** `useResource` migrace:
  - [ ] `/schedule` kalendář (stále na ad-hoc `useEffect`)
  - [ ] `/campaigns` list + detail (po dokončení T-U01 preflight UI — hotovo ✅, lze startovat)
  - [ ] Settings page (nižší priorita)
- [ ] **W4 polish zbytek**:
  - [ ] `/api/jobs` cleanup ticker e2e test s klokem (TTL 1h)
  - [ ] Alert dedup coverage audit — migrovat zbývající raw `INSERT INTO outreach_mailbox_alerts` přes `createMailboxAlert`
- [ ] **T-Q01 Go-side audit** — `modules/outreach/` projít na silent `err` + optimistic HTTP response. Přesouvá do M3 (campaigns migrace) jako pre-work.
- [ ] **T-Q02** — W3 migrace `/schedule` a `/campaigns` (duplicita W3 dokončení výše).
- [ ] **T-Q03 Chat B kontraktní testy** — `/api/health/write-errors` response shape + `/api/jobs/:id` lifecycle.
- [ ] **T-Q04 E2E `runJob` + poll protokol** — vitest nebo Playwright (rozhodnout při psaní).
- [ ] **T-Q05 Settings page migrace** (low priority).
- [ ] **T-Q06 Alert dedup coverage** (duplicita W4 výše).
- [ ] **T-Q07 Operational runbook** do `docs/playbooks/` — "jak číst `/api/health/write-errors` když operátor vidí podivný stav".
