# Session Handoff Document

**Date:** 2026-04-21
**Předchozí handoff:** 2026-04-04 (nahrazeno)
**Session focus:** SMTP egress lockdown V2 (R1–R8c), branch consolidation, monorepo cleanup, workflow migration (3-worktree + BOARD protokol)

---

## Quick summary

Od 2026-04-04 proběhlo:

- **SMTP-EGRESS-LOCKDOWN V2** — 8 sprintů (R1–R8c): mandatory anti-trace, DNS blackhole, Railway firewall ops runbook, IP rotation + warmup plan (`fresh_ip_r8c`)
- **Branch consolidation** — 5 branchí → 3 (main / wm/development / wm/tests), 4 merged PRs
- **Monorepo cleanup** — 275 empty files smazáno (Nuxt→Vite residue), 45MB disk freed
- **Planning docs** — `development-plan.md` (v1.0), `superplan.md` (v2.0) — 28-milestone MVP roadmap
- **Tooling** — `pnpm report` unified diagnostic tool (12 protection layers)
- **Workflow migration** — 3-worktree (sibling dirs) + BOARD handoff protokol (převzato z garaaage-law)

---

## Repo

- **GitHub:** `messingdev/hozan-taher` (private monorepo)
- **Main branch HEAD:** `a73e260` (Merge PR #5 — scaffolding-docs)
- **Strategie:** squash-merge PR, force-with-lease rebase po merge

### Branches + worktrees

| Branch | HEAD | Worktree path |
|---|---|---|
| `main` | `a73e260` | `/Users/messingtomas/Documents/Projekty/hozan-taher/` |
| `wm/development` | `21e52f6` | `/Users/messingtomas/Documents/Projekty/hozan-taher-dev/` |
| `wm/tests` | `a73e260` | `/Users/messingtomas/Documents/Projekty/hozan-taher-tests/` |

**Claude-squad worktree** (`~/.claude-squad/hozan-taher/worktrees/wm/development-agent-*`) byl odstraněn 2026-04-21 — nahrazen sibling worktrees per nový workflow.

---

## Monorepo layout

```
hozan-taher/
├── apps/
│   ├── outreach-dashboard/     # React 19 + Vite 6 + Express 5 BFF
│   └── extension/              # browser extension
├── modules/
│   └── outreach/               # Go 1.25 — B2B sales engine (37 packages)
├── services/
│   ├── anti-trace-relay/       # SOCKS5 relay, probe endpoints
│   ├── privacy-gateway/        # email relay + alias management
│   ├── mcp/                    # Model Context Protocol server
│   ├── scrapers/               # ARES + firmy.cz scrapers
│   └── worker/                 # background jobs
├── infra/                      # Railway configs, migrations
├── packages/                   # shared TS libs
├── docs/
│   ├── handoff/                # BOARD + bootstraps (NEW 2026-04-21)
│   ├── decisions/              # ADR-NNN (NEW, replaces docs/adr/)
│   ├── initiatives/            # YYYY-MM-DD living docs (NEW)
│   ├── playbooks/              # operational runbooks
│   └── archive/                # superseded docs
└── specs/                      # API contracts
```

---

## Services

### modules/outreach (Go 1.25, 37 packages)

B2B cold email engine pro heavy-machinery dealers.

| Aspekt | Hodnota |
|---|---|
| Stack | Go 1.25, PostgreSQL 16 (Railway), SMTP (via anti-trace-relay) |
| API auth | `X-API-Key` header (env `OUTREACH_API_KEY`) |
| Scheduler | Intelligence loop každých 6h |
| DB SSL | `DB_SSL_MODE=disable` dev, `require` prod |
| Testy | `go test ./... -race` musí projít před commitem |

**Novinky od 2026-04-04:**
- R1: Audit + dokumentace egress vrstev
- R2: Pre-commit egress guard hook
- R3: Relay API rozšíření (probe + auth-check + proxy-pool + verify)
- R4: Mandatory anti-trace (odstraněn direct fallback)
- R5: BFF konsolidace (SMTP/proxy probes skrz anti-trace-relay)
- R6: Validation probe migrace (email probe přes anti-trace-relay)
- R7: Runtime `AssertSocks5` guard — runtime socks5 dial ověření
- R8a: DNS blackhole (outreach + dashboard domény)
- R8b: Railway egress firewall ops runbook
- R8c: IP rotation + warmup plan `fresh_ip_r8c` (1→10→25→25→50→50→400 přes 8 dní)

### features/platform/outreach-dashboard (React 19 + Vite 6 + Express 5 BFF)

Frontend pro operování outreach engine.

| Aspekt | Hodnota |
|---|---|
| Stack | React 19, Vite 6, React Router 7, Zustand 5, lucide-react, Express 5 (BFF), vitest, Playwright |
| UI language | Czech |
| Dev ports | Vite `:5175`, BFF `:3100` |
| BFF → Go | `GO_SERVER_URL` + `OUTREACH_API_KEY` (proxy přes `X-API-Key`) |
| Degraded UI | `useOutreachHealth` banner když Go není dosažitelný |

**Novinky:**
- Nuxt 3 → React 19 + Vite 6 migrace dokončena
- `pnpm report` / `pnpm report:json` — unified diagnostic tool přes 12 protection layers

### features/outreach/relay (Go)

Privacy-hardened communication relay. **Povinná** vrstva pro veškerý outreach SMTP + probe traffic od R4.

| Endpoint | Účel |
|---|---|
| `/probe/smtp` | SMTP probe skrz SOCKS5 |
| `/probe/proxy-pool` | Proxy pool health |
| `/probe/email-verify` | MX + SMTP RCPT check |
| `/auth-check` | Authentication test |

### features/platform/mcp (TypeScript)

Model Context Protocol server. Railway internal networking (`FIRMY_DSN` env, internal DNS).

### features/compliance/privacy-gateway, scrapers, worker

Viz jednotlivá `README.md` v jejich adresářích.

---

## Workflow (2026-04-21+)

### 3-worktree + BOARD handoff protokol

Převzato z `garaaage-law` projektu — dva Claude chaty synchronizují přes:

1. **Sibling worktrees** — `hozan-taher-dev/` + `hozan-taher-tests/` vedle main dir
2. **BOARD.md** — sdílený stav + Cross-branch signals ([`docs/handoff/BOARD.md`](handoff/BOARD.md))
3. **Bootstrap dokumenty** — start/end turn protokol ([`bootstrap-dev.md`](handoff/bootstrap-dev.md), [`bootstrap-tests.md`](handoff/bootstrap-tests.md))
4. **Commit trailers** — `Needs-Tests:`, `Breaks-Contract:`, `Covers:`, `Resolves-Trailer:`

### Role-split

- **Chat A (Dev)** — feature kód + happy-path unit testy, commituje na `wm/development`
- **Chat B (Tests)** — E2E/integration/kontrakt/property/fuzz, commituje na `wm/tests`
- Chat B NEPISE prod kód; pokud najde bug, signalizuje zpět Chatu A

### Merge flow

```
Chat A develop → PR wm/development→main → squash-merge
                                         ↓
Chat A post-sync: rebase + force-with-lease
                                         ↓
Chat B reads Needs-Tests: trailers → writes coverage
                                         ↓
Chat B → PR wm/tests→main → squash-merge
                                         ↓
Chat B post-sync: rebase + force-with-lease
```

### Exception z "no direct push to main"

`docs/handoff/*.md` + `CLAUDE.md` doc-pointer edits (drobné chore, text-only, low-risk) lze pushnout přímo na main. Vše ostatní vždy PR.

---

## Docs struktura (ADR-NNN, initiatives, handoff)

| Adresář | Obsah | Lifetime |
|---|---|---|
| `docs/decisions/` | ADR-NNN-slug.md (immutable) | forever (supersede-chain) |
| `docs/initiatives/` | YYYY-MM-DD-slug.md (living) | archive po dokončení |
| `docs/handoff/` | BOARD + bootstraps | evolving |
| `docs/playbooks/` | operational runbooks | evolving |
| `docs/archive/` | superseded docs | storage |

Viz [`docs/decisions/README.md`](decisions/README.md) a [`docs/initiatives/README.md`](initiatives/README.md).

---

## Aktivní iniciativy

- [`2026-04-22-discipline-and-domain-migration.md`](initiatives/2026-04-22-discipline-and-domain-migration.md) — discipline + doménová reorganizace (konsoliduje 3 předchozí iniciativy, viz jejich archivované verze v `_archive/initiatives/`)

---

## Open backlog (z TaskList)

### MVP-1..35 (hlavní roadmapa)

Plný seznam v [`docs/superplan.md`](superplan.md) (28 milestones). Aktuální stav:

- **Completed:** A1, A2, A3, A4, A5 (scheduler, gates, tokens, DNS audit, dedup), R1–R8c (egress lockdown), cleanup sprinty
- **In-progress:** MVP-01 (fix failing Mailboxes + Analytics tests), B1 RED (segment store tests)
- **Pending:** B2–B3, C1–C3 (campaigns), D1–D2 (heavy-machinery templates), E1–E3 (leads + inbox + threads), F1–F3 (segments + dryrun + preflight), MVP-02–35 (hardening)

### CROSS tasks

- Security audit new endpoints (A4/B1/C1/C2/E1/F1)
- Go race test full coverage
- Coverage ≥85% business logic, ≥80% per layer
- Migration 044 + 045 prodlike schema sync

---

## Non-obvious gotchas

1. **Pre-push hook** (`.githooks/pre-push`) blokuje direct push na main mimo `docs/handoff/*.md` + `CLAUDE.md` exception.
2. **Claude-squad** konflikt — pokud používáš claude-squad, NE spouštěj na hozan-taher; používej sibling worktrees přímo.
3. **`fresh_ip_r8c` warmup plan** má striktní harmonogram: 1→10→25→25→50→50→400 přes 8 dní. Nepřeskakovat kroky, jinak IP reputation score crashne.
4. **Anti-trace-relay** je povinná vrstva — od R4 není direct-SMTP fallback. Pokud relay down, outreach engine nesmí posílat.
5. **`.claude/settings.local.json`** — auto-modified claude-code permissions. `.gitignore`d od R8c cleanup.
6. **Pnpm workspaces** — root `pnpm-workspace.yaml` definuje: apps/*, modules/*, services/*, packages/*. Vždy instaluj z rootu: `pnpm install`.

---

## Live infrastructure (Railway)

| Služba | Status |
|---|---|
| outreach Go backend | Live |
| outreach-dashboard BFF + Vite build | Live |
| outreach-db PostgreSQL 16 | Live |
| anti-trace-relay | Live |
| privacy-gateway | Live |
| mcp | Live |
| scrapers (ARES + firmy.cz) | Live |
| worker | Live |

Detailnější infrastructure breakdown: viz předchozí HANDOFF (2026-04-04) archivovaný v [`docs/archive/HANDOFF-2026-04-04.md`](archive/HANDOFF-2026-04-04.md) (TODO: přesunout při nejbližší archive session).

---

## Next steps

1. **Chat A** — pokračovat MVP-01 (fix failing Mailboxes + Analytics tests), pak B1 GREEN → segment web handler
2. **Chat B** — napsat Needs-Tests: backlog z merged PR #2, #3, #4, #5; začít B1 RED → segment store CRUD tests
3. **Obě** — před první prací přečíst [`docs/handoff/bootstrap-dev.md`](handoff/bootstrap-dev.md) resp. [`bootstrap-tests.md`](handoff/bootstrap-tests.md), aktualizovat BOARD sekci
