# Airtight dev environment — kill switch proti reálnému emailu

**Status:** Phase 2 + Phase 4 complete (2026-04-30 evening audit)
**Created:** 2026-04-30
**Owner:** Tomáš (gates: landing pass approval) + Chat A (autonomous: code + tests + docs)
**Trigger:** 2026-04-30 user otázka: "Dokážeme vyvíjet plně autonomně bez potřeby posílat někde e-mail?"

> **REALITY-CHECK 2026-04-30 (post `Tohle řešíme pořád dokola` audit):**
> AT2.1 + AT2.2 byly implementovány PŘED touto initiative — během auditního
> sweepu se ukázalo:
>
> - **AT2.1 ALREADY DONE** — `features/outreach/campaigns/sender/engine.go:123-264`
>   má `LabAbortEvaluator` interface + `Engine.labEvaluator` + `Engine.labOnly`
>   fields + `WithLabEvaluator(ev, labOnly)` method s fail-CLOSED/fail-OPEN
>   semantikou. Wired into Engine.Run send loop (line 507-510). KT-A14 sprint.
> - **AT2.2 ALREADY DONE** — `features/inbound/orchestrator/cmd/outreach/main.go:2891`
>   má `enforceAirtightGate(labOnly, transportMode)` se exit code 78. Volá se
>   v `main.go:97` na boot. Tests v `airtight_test.go`. `isLabOnlyTrue` helper
>   (line 2907). PR #393 omylem vytvořil paralelní implementaci v
>   `features/platform/common/config/config.go:ValidateAirtight()` s exit codes 47/48
>   — DUPLICATE, čeká na consolidation rozhodnutí.
> - **AT2.3 NEW** — PR #394 přidalo `features/outreach/campaigns/sender/airtight_audit_test.go`
>   discipline ratchet (baseline 0).
> - **AT4.1 DONE** — PR #390 ADR-005.
>
> Tato initiative description byla napsána před verifikací stavu kódu.
> Per memory `feedback_search_before_implement` — initiative dokumenty
> vyžadují search-verify proti aktuální `main` před implementací.

## Problém

Dnešní stav (2026-04-30, 23:00 CET):

- Infrastruktura postavená (24 PRs shipped)
- Mail Lab + mail-client-fidelity + Operator Practice **0 PRs merged do main**
- ML5.1 labhook (`features/inbound/orchestrator/labhook`) shipnutý jako **standalone** package — neintegruje se do skutečného send pathu
- `features/outreach/campaigns/sender/engine.go` při send-cyklu pořád volá `antiTrace.Send()` → real SMTP přes anti-trace-relay
- Žádný kill switch v kódu — kdo omylem spustí `pnpm campaign:send` v prod ENV → emailuje reálné prospekty

Bezpečnostní vrstvy co dnes EXISTUJÍ:

1. `feedback_campaign_send` HARD RULE — disciplinární, ne kódová
2. `feedback_no_direct_smtp` HARD RULE — disciplinární
3. `project_b2b_transport_mode` — `TRANSPORT_MODE=direct` BANNED v kódu (production proxy-only)
4. ML5.1 labhook fail-open — soft evaluator, blokuje *jen* lab-side rozhodnutí, neguarantuje že non-lab path neběží

**Hard kill switch chybí.**

## Cíl

**Airtight dev environment:** orchestrator / sender pipeline na boot odmítne dial real SMTP, pokud `LAB_ONLY=1` (nebo equivalent). Kód (ne jen policy) brání náhodnému zápisu do prod email infrastruktury během dev/test iterace.

Měřitelné:

1. `LAB_ONLY=1 ./features/inbound/orchestrator/...` → engine inicializace odmítne, pokud `TRANSPORT_MODE != lab` nebo lab API neresponse
2. CI pipeline `.github/workflows/mail-lab-ci.yml` boots stack + runs orchestrator s `LAB_ONLY=1` + asserts 0 reálných SMTP socket connections
3. Audit test grep zachytí jakýkoli nový code path co volá `net.Dial("tcp", "smtp.*")` bez lab-mode gate
4. Operator runbook explicit: dev workflow (boot lab → set LAB_ONLY=1 → vše ostatní safe)

## Non-goals

- Nedotýkat se prod orchestrator behavior (TRANSPORT_MODE=proxy jede beze změny)
- Nepřidávat nový external service (per `feedback_no_external_services`)
- Nepřepisovat existující stacků nad rámec ML5.2 wiring (per `feedback_no_speculation`)

## Constraints

| # | Pravidlo | Aplikace |
|---|---|---|
| 1 | Žádné spekulace | Každá AT-podsprint má konkrétní acceptance + ≥10 brutal asserts |
| 2 | Long stacks OK | Po landing pass se může stack znovu nahromadit; rebase-stack.sh řeší (#256) |
| 3 | No campaign send | Boot gate refuses real SMTP dial, ne jen policy |
| 4 | Fail-loud | Špatná konfigurace → boot exit non-zero, ne tichý fallback na real SMTP |
| 5 | Backward-compat | Production (TRANSPORT_MODE=proxy, LAB_ONLY unset) musí běžet identicky jako dnes |

## Architektura

### Třívrstvý kill switch

```
┌─────────────────────────────────────────────┐
│ Layer 1 — Boot gate (features/outreach/campaigns/    │
│   sender/engine.go init)                     │
│                                              │
│   if env.LAB_ONLY=1 && transportMode != lab  │
│     → log.Fatal("airtight: refusing real    │
│       SMTP under LAB_ONLY=1")                │
└─────────────────────────────────────────────┘
                  ↓
┌─────────────────────────────────────────────┐
│ Layer 2 — Per-send labhook (existující ML5.1)│
│                                              │
│   if labhook.ShouldSkip(...) → bypass send,  │
│     record verdict in send_events            │
└─────────────────────────────────────────────┘
                  ↓
┌─────────────────────────────────────────────┐
│ Layer 3 — Discipline test                    │
│                                              │
│   tests/audit/airtight-engine.test.go scans  │
│   features/outreach/campaigns/sender/*.go for:        │
│     - net.Dial("tcp", smtp.*)                │
│     - smtp.Dial(...)                         │
│     - Custom transport that bypasses lab     │
│   Refuses if any path lacks lab-mode gate    │
└─────────────────────────────────────────────┘
```

### Komponenty (existující vs nové)

| Komponenta | Stav |
|---|---|
| Mail Lab (3 provideři + DNS + lab API) | shipped, queue (#220-#225, #246) |
| mail-lab-api `/v1/profile/{domain}/evaluate` | shipped, queue (#253) |
| `features/platform/common/maillabclient` Go client | shipped, queue (#258) |
| `features/inbound/orchestrator/labhook` standalone | shipped, queue (#260) |
| **`features/outreach/campaigns/sender/engine.go` integrace** | ✅ **DONE** — `LabAbortEvaluator` + `WithLabEvaluator` (engine.go:123-264) |
| **`TRANSPORT_MODE` env validation** | ✅ **DONE** — `enforceAirtightGate` (main.go:2891) |
| **`LAB_ONLY=1` boot gate** | ✅ **DONE** — `enforceAirtightGate` + `isLabOnlyTrue` (main.go:97, 2907) |
| **Discipline test (engine cannot dial)** | ✅ **DONE** — PR #394 `airtight_audit_test.go` (baseline 0) |
| **`SendingConfig` struct fields (TransportMode/LabOnly)** | ⚠️ **DUPLICATE** — PR #393, čeká na consolidation rozhodnutí |
| **mail-lab-ci.yml runs green proti booted stacku** | dnes skip-pattern — AT3.1 |
| **CI integration test (LAB_ONLY=1 → 0 sockets)** | chybí — AT3.2 |

## Sprint plán — 10 atomic units

Per user direction "rozděl do desítky TODO":

### Phase 1 — Landing existing stacks (USER work, gated)

| ID | Subject | Owner | Dependencies |
|---|---|---|---|
| **AT1.1** | Land Mail Lab foundation chain (#220-#225, ~6 PRs) | Tomáš | — |
| **AT1.2** | Land Mail Lab profile API stack + ops (#248-#262, #256, #259, ~17 PRs) | Tomáš | AT1.1 |
| **AT1.3** | Land Operator Practice + ADR-004 (#263-#269, #281, #282) | Tomáš | AT1.1 |
| **AT1.4** | Land mail-client-fidelity stack (#210-#245, 17 PRs) — optional pre-AT2.1 | Tomáš | AT1.1 |

### Phase 2 — Hard-mode kill switch (Chat A autonomous)

| ID | Subject | Owner | Dependencies |
|---|---|---|---|
| **AT2.1** | ML5.2 — wire `features/inbound/orchestrator/labhook` into `features/outreach/campaigns/sender/engine.go` between PreSendHook and antiTrace.Send. Brutal: ≥15 asserts (skip path bypasses Send, accept proceeds, send_events records verdict, mock-friendly). | Chat A | AT1.2 (wants ML5.0 + ML5.1 landed), or build atop branch chain |
| **AT2.2** | `TRANSPORT_MODE` config field + `LAB_ONLY=1` boot gate. Add `TransportMode string` to `features/platform/common/config.SendingConfig`; `LoadFromEnv` parses both `TRANSPORT_MODE` (lab/proxy/direct) and `LAB_ONLY` (bool). Engine init refuses if mismatch. Brutal: ≥12 asserts (env parsing, refusal modes, prod backward-compat). | Chat A | AT2.1 |
| **AT2.3** | Discipline test `tests/audit/airtight-engine.test.go` scans `features/outreach/campaigns/sender/*.go` for unguarded `net.Dial`/`smtp.Dial`. Ratchet pattern (allow N existing violations, refuse new ones) per `features/outreach/campaigns/sender/slog_op_audit_test.go` style. Brutal: ≥10 asserts. | Chat A | AT2.1 (after wiring lands, ratchet baseline locks) |

### Phase 3 — CI validation (mixed)

| ID | Subject | Owner | Dependencies |
|---|---|---|---|
| **AT3.1** | `.github/workflows/mail-lab-ci.yml` runs green proti booted stacku — replace skip-patterns with real assertions. After AT1.x lands, the workflow no longer self-skips because preconditions are met. | Chat A | AT1.1, AT1.3 |
| **AT3.2** | CI integration test: spin orchestrator s `LAB_ONLY=1`, run dummy campaign, assert 0 real-SMTP socket connections via netstat / strace. Refuses to merge if real socket detected. | Chat A | AT2.1, AT2.2 |

### Phase 4 — Documentation

| ID | Subject | Owner | Dependencies |
|---|---|---|---|
| **AT4.1** | ADR-005 — airtight dev env design rationale + boot gate semantics + recovery if env misconfigured. ~150 lines. Update operator runbook (`docs/playbooks/operator-practice.md`) with "boot lab + set LAB_ONLY=1" workflow. | Chat A | AT2.x |

**Total: 10 atomic units (4 user landing + 4 Chat A code + 2 mixed CI + docs).**

## Acceptance celé iniciativy

- [ ] `LAB_ONLY=1 OUTREACH_BIN ...` exits non-zero if TRANSPORT_MODE missing/invalid
- [ ] CI workflow `mail-lab-ci.yml` runs the orchestrator with LAB_ONLY=1, completes without ever dialing a non-lab IP
- [ ] Audit test count: zero unguarded `net.Dial("tcp", "smtp.*")` calls outside lab-mode branch
- [ ] Production deploy (LAB_ONLY unset, TRANSPORT_MODE=proxy) behaves identically to before AT2.x landed
- [ ] Operator runbook documents one-command "safe dev start" sequence

## Risks + dependencies

### Závislosti
- AT2.1 hot path: touches `features/outreach/campaigns/sender/engine.go` (substantial existing code, complex test surface). Per memory `feedback_no_speculation`, change must be minimal + brutal-tested before merge.
- AT3.1 needs Mail Lab actually booting in CI — depends on AT1.1 landing
- AT3.2 needs network monitoring tooling (`tcpdump` / `strace` not always available in GH Actions runners) — fallback: in-process `net.Dial` mock interceptor

### Rizika
| Riziko | Mitigace |
|---|---|
| AT2.1 breaks existing send pipeline | Engine wiring as additive: new field defaults to nil, existing callers unaffected; add brutal tests proving zero-call-difference when Evaluator=nil |
| LAB_ONLY=1 typo in prod env → orchestrator refuses to start | Acceptable failure mode (fail-loud); log clearly + document recovery |
| Discipline test (AT2.3) too aggressive, blocks legitimate refactor | Ratchet pattern (allow baseline) + grep override comment `// airtight-allowed: ...` for explicit exceptions |
| CI integration (AT3.2) tooling gap | Fallback to in-process net.Dial monkey-patch via Go's `httptest.NewServer` analog |

## Open questions for user

| # | Question | Default if no answer |
|---|---|---|
| 1 | Landing pass start signál? | Tomáš pings with "land 17 PRs"; Chat A pause |
| 2 | LAB_ONLY=1 default value | Default "0" (off); operator opts in. Production never sets it. |
| 3 | Discipline test baseline reset acceptable? | Yes — first run captures baseline + commits as `tests/audit/.airtight-baseline.json` |
| 4 | ADR-005 vs amend ADR-004? | New ADR (different decision: airtight is policy + code gate, ADR-004 captures Mail Lab + Operator Practice architecture) |

## Status tracking

Per CLAUDE.md backlog protocol: 10 GH issues `[AT1.1]`-`[AT4.1]` s `priority/p1` + `automation/ok` (where Chat A can act) or `automation/needs-design` (Tomáš landing). PR titles include `[AT2.x]` etc. for discoverability.

## Připojení s ostatními iniciativami

- `2026-04-29-mail-lab.md` — provider-side simulation; AT depends on its stack landing
- `2026-04-30-operator-practice.md` — inbound/triage training; orthogonal to AT but shares Mail Lab dependency
- `2026-04-27-llm-reply-classifier.md` — classifier work; not affected by AT
- `2026-04-22-send-pipeline-unblock.md` — outbound real-send work; AT is the safety net, not replacement
