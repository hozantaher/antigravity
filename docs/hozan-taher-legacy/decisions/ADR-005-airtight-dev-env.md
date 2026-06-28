# ADR-005 — Airtight dev env (kill switch proti reálnému emailu)

**Status:** Proposed (Phase 4 dokumentace; Phase 2 kód-gate v fázi AT2.x)
**Date:** 2026-04-30
**Supersedes:** —
**Related:**
- [ADR-002 — Autonomous Ops Architecture](ADR-002-autonomous-ops-architecture.md)
- [ADR-004 — Mail Lab profile API + Operator Practice](ADR-004-mail-lab-and-operator-practice.md)
- Initiative: `docs/initiatives/2026-04-30-airtight-dev-env.md`
- Memory rules: `feedback_no_direct_smtp`, `feedback_campaign_send`, `project_b2b_transport_mode`

## Kontext

Outreach pipeline (features/outreach/campaigns/sender) drží production credentials
pro Seznam SMTP přes anti-trace-relay. Pět vrstev disciplíny zatím chrání
před omylným sendem do real prospects:

1. `feedback_campaign_send` HARD RULE — operátor (memory) blokuje
   `pnpm campaign:send` bez explicit consent
2. `feedback_no_direct_smtp` HARD RULE — žádný `openssl s_client smtp.*`
3. `project_b2b_transport_mode` — `TRANSPORT_MODE=direct` BANNED v kódu;
   produkce výhradně `proxy` (Mullvad wireproxy)
4. ML5.1 labhook (`features/inbound/orchestrator/labhook`) — soft pre-send
   evaluator (rozhodne lab-side accept/reject); fail-open v produkci
5. Code review + git pre-push hook na `main`

Žádný hard kill switch v kódu. Operator může spustit `LAB_ONLY=1
pnpm campaign:send` v misconfig prostředí (typo'd env, prod credentials
loadnuté omylem) → engine pošle real SMTP.

ADR-004 zachytila Mail Lab provider simulation + Operator Practice
training. Tato ADR řeší **runtime gate**: jak garantovat, že dev/test
iteraci na hot-path send pipeline nikdy nedoletí na real Seznam.

## Rozhodnutí

### D1 — Třívrstvý kill switch (boot + per-send + audit)

```
┌────────────────────────────────────────────┐
│ Layer 1 — Boot gate                         │
│ features/outreach/campaigns/sender/engine.go init    │
│                                             │
│ if LAB_ONLY=1 && TRANSPORT_MODE != "lab":  │
│   log.Fatal("airtight: refusing real SMTP  │
│             dial under LAB_ONLY=1")         │
│ Exit code 47 (lab-only mismatch).           │
└────────────────────────────────────────────┘
                  ↓
┌────────────────────────────────────────────┐
│ Layer 2 — Per-send labhook (existing ML5.1) │
│                                             │
│ engine.Run() → labhook.ShouldSkip(ctx, msg) │
│ ShouldSkip=true  → record verdict, no send  │
│ ShouldSkip=false → antiTrace.Send(...)      │
│ Fail-open při labhook timeout — Layer 1+3   │
│ to chytí pokud něco unikne.                 │
└────────────────────────────────────────────┘
                  ↓
┌────────────────────────────────────────────┐
│ Layer 3 — Discipline ratchet test           │
│ features/outreach/campaigns/sender/airtight_audit_   │
│ test.go scans .go files in package for:    │
│   net.Dial("tcp", "smtp.*")                 │
│   smtp.Dial(...)                            │
│   Custom transport bypass                   │
│ Any unguarded match → test FAIL.            │
│ Allow-list comment `// airtight-allowed:`   │
│ pro explicit exceptions s důvodem.          │
└────────────────────────────────────────────┘
```

**Důvod:** každá vrstva má distinct selhání. Layer 1 chytí 99 % případů
(typo env, wrong .env profile). Layer 2 chytí runtime path že engine
neumí se ptát labhook (network race, lab API down). Layer 3 chytí code
drift — nový kontributor přidá `smtp.SendMail()` v helper, oba
předchozí gate by to nezachytili (Layer 1 vyhodnotí jen na boot,
Layer 2 jen v .Run()). Audit test chrání proti regresi v dalším PR.

### D2 — `TRANSPORT_MODE` discrete enum, ne boolean

`SendingConfig.TransportMode string` přijímá jen `"lab" | "proxy" |
"direct"` (poslední je BANNED v `LoadFromEnv`, refusal exit 48). Ne
boolean `LabMode bool` protože production budoucí mode (např. `tor`,
`vpn-pool`, ...) by potřebovaly další boolean → kombinatorický
explose. String enum s explicit refusal pro neznámé hodnoty je
extensible.

### D3 — `LAB_ONLY=1` je opt-in, default off

Production deploy nikdy `LAB_ONLY` nesettuje. Operátor v dev terminálu
explicit `export LAB_ONLY=1` před `pnpm dev`. Ne default-on protože:

- Production `LoadFromEnv` by ležící neaktualizovaná `.env` na disku
  mohla zaktivovat → CI/CD by spadlo, ale ne s jasným důvodem
- Default-on porušuje "explicit > implicit" v config

Recovery při typu na produkci: engine `log.Fatal(...)` s konkrétní
zprávou + exit 47 → dashboard + Sentry alert + operator runbook bod
"airtight refusal" → operator unset env, restart.

### D4 — Audit test ratchet, ne hard-zero

Existující codebase má historicky volání `smtp.SendMail(...)` v
`features/outreach/campaigns/sender/sender.go` (legitimní production path).
Audit test ne-counts jako violation — zachycuje **delta** od baseline
(`tests/audit/.airtight-baseline.json`). První run zafrízuje N=K
existujících. Další PR co přidá K+1 → FAIL. PR co odstraní jeden →
baseline reset commit.

Vzor: `features/outreach/campaigns/sender/slog_op_audit_test.go` (existující,
ratchet pro `op` field discipline).

## Důsledky

### Pozitivní

- Tři disjoint vrstvy chrání proti omylům (typo env, code drift,
  network race) bez výkonové penalty (Layer 1 jen boot, Layer 2 už
  existuje, Layer 3 jen v CI)
- Production unaffected — `LAB_ONLY` unset, `TRANSPORT_MODE=proxy` je
  current state, žádná migrace
- Discipline test ratchet pattern shoduje s
  `slog_op_audit_test.go` — operator zná interpretaci

### Negativní

- Boot gate refusal exit non-zero v dev při typu — operator musí
  rozumět chyb messagi (mitigace: explicit exit codes 47/48 + runbook
  diagnostic)
- Discipline test má escape hatch (`// airtight-allowed:`) — kontributor
  může nadužívat (mitigace: code review enforcement, PR template
  ptátka)
- Layer 2 fail-open — pokud labhook nedostupný, engine pokračuje s
  Layer 1 už passed, takže by mohl poslat. Layer 1 + Layer 3 to
  hard-block jen na production-deploy hot path; v dev (LAB_ONLY=1) i
  Layer 2 fail-open znamená že misconfig dev pošle do labu, ne na
  Seznam — acceptable degradation

### Neutrální

- Operator runbook (`docs/playbooks/operator-practice.md`) získá nový
  oddíl "airtight workflow" — viz update v PR #(this-pr-number)

## Recovery procedura

### Případ 1 — Misconfig na dev (LAB_ONLY=1, TRANSPORT_MODE=proxy)

Symptom: `pnpm dev` (nebo `go run cmd/orchestrator/main.go`) padá
ihned s
`FATAL airtight: refusing real SMTP dial under LAB_ONLY=1 (mode=proxy)`.

Recovery:
```bash
# Either: drop LAB_ONLY (work proti production-shape, careful!)
unset LAB_ONLY
# Or: switch transport to lab (recommended)
export TRANSPORT_MODE=lab
# Then restart
```

### Případ 2 — Misconfig na prod (LAB_ONLY=1 unintended)

Symptom: deploy boot fails, Sentry alert
`OUTREACH_BOOT_FAILURE airtight_refusal`.

Recovery:
```bash
# Unset LAB_ONLY in Railway / k8s env config
# Force redeploy (no code change needed)
```

Tato chyba je **expected fail-loud** — lepší než tichý send do real
Seznamu při pomotaným profile.

### Případ 3 — Discipline test FAIL po refactoru

Symptom: PR CI red, `airtight_audit_test.go FAIL: 5 unguarded
net.Dial calls (baseline=4)`.

Recovery (autor PR):
1. Identifikuj kterou novou volání přidalo `git diff` vůči base
2. Buď gate-it (`if cfg.TransportMode == "lab" { ... }`) nebo
   anotuj `// airtight-allowed: <důvod>` s linkem na issue / spec
3. Pokud anotace → reviewer schválí důvod
4. Pokud gate → test pass automaticky

## Rejected alternatives

### A — Boolean `LabMode` flag místo string enum

Odmítnuto (D2): future-proof obavy (tor, vpn-pool modes by potřebovaly
další booleany).

### B — Pouze ML5.1 labhook (per-send), bez boot gate

Odmítnuto: labhook fail-open znamená že downtime lab API → produkce
fallback na real send. Boot gate to zachytí dřív (engine refuses
init).

### C — Network namespace isolation (Linux only)

Odmítnuto: nepřenositelné na macOS dev, vyžaduje root v CI, false
sense of security (operator může unset namespace).

### D — Default `LAB_ONLY=1` always-on, opt-out for prod

Odmítnuto (D3): porušuje explicit > implicit, prod-failure mode horší
(stale .env on disk auto-aktivuje).

## Implementation plan

| Sprint | Obsah | Dependency |
|---|---|---|
| AT2.1 | ML5.2 wire labhook into engine.Run | ML5.1 landed |
| AT2.2 | TransportMode + LAB_ONLY + boot gate | AT2.1 |
| AT2.3 | airtight discipline test + baseline | AT2.1 |
| AT3.1 | mail-lab-ci.yml runs green | AT1.x landed |
| AT3.2 | CI integration (LAB_ONLY=1 → 0 sockets) | AT2.x |
| AT4.1 | **THIS ADR + operator runbook update** | AT2.x design known |

Issues `[AT2.1]`-`[AT4.1]` v GH backlog (#288 - #293).

## Reference

- ADR-002 — multi-agent ops kontext
- ADR-004 — Mail Lab + Operator Practice (sourcing pro lab transport)
- Memory: `feedback_no_direct_smtp`, `feedback_campaign_send`,
  `project_b2b_transport_mode`
- Initiative: `docs/initiatives/2026-04-30-airtight-dev-env.md`
- `features/outreach/campaigns/sender/slog_op_audit_test.go` (vzor pro ratchet)
