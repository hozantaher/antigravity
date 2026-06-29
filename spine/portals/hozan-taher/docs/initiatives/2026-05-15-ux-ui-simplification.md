# Iniciativa AI — UX/UI simplification + testing depth

**Status:** Active  
**Datum:** 2026-05-15  
**Trigger:** Operator: "Proveď analýzu jak vylepšit UX/UI a co odebrat. Je potřeba se zaměřit na hloubkové testování a zjednodušování celého UX/UI."

## Severní hvězda

Hloubkové unit/integration coverage na pages s nízkou hloubkou + simplification pomocí extrakce duplicity (Modal, useResource, StatusPill primitive). Odstranit orphan/dead testy a obsah, který sám-sebe-replikuje.

## Vztah k AH

AH (předchozí) řeší **gap remediation** — chybějící UI surfaces (operator_settings 9/27 → 27/27, skip-by-domain drawer, mailbox lifecycle edit). AI navazuje s **testing depth + simplification** vrstvou: pages, které už UI surface mají, ale s nedostatečnou test depth a duplicitním JSX/fetch boilerplate.

## Fáze

### P0 — paralelní vlna (3 agenti + sólo)

**Sprint AI1 — Test coverage depth audit** (completed)
- Mapa všech `tests/unit/pages/*.test.jsx` s line count + assertion count + test/LOC ratio
- Identifikuje pages s nízkou depth (< 0.3 testů/100 LOC)
- Výstup: docs/audits/2026-05-15-test-coverage-depth.md

**Sprint AI2 — UI simplification + redundancy hunt** (completed)
- Component-tree audit: 3 inline `<div className="modal-bg">` duplikáty
- Inline fetch boilerplate count vs useResource adoption
- Brittle pattern instances (raw `style=` objects ≥ 10 lines, hardcoded oklch strings)
- Výstup: docs/audits/2026-05-15-ui-simplification.md

**Sprint AI3 — Orphan tests delete + smoke rows** (completed, PR #1390)
- Smaz orphan `tests/unit/pages/*.test.jsx` pages, které už neexistují
- 3 nové smoke rows: `/scoring`, `/settings/branding`, `/settings/icp`

**Sprint AI4 — Depth tests SettingsICP + Scoring** (completed, PR #1391)
- SettingsICP.deep.test.jsx + Scoring.deep.test.jsx
- 69 case-targeted assertions napříč: data fetch, error, audit log, mutation, ARIA

**Sprint AI5 — Layout tests + brittle pattern replacements** (in progress, background agent)
- Layout.jsx coverage: nav links, route segments, role=navigation/main
- Replace 10 worst brittle pattern instances (raw style → token-class)
- Owner: agent `a5675138d52a07697`

**Sprint AI6 — Inline fetch → useResource migration** (in progress, background agent)
- Top 5 pages s nejvyšším inline-fetch count
- Migrate na `useResource` hook (existující v `src/hooks/useResource.ts`)
- Owner: agent `a802ad31136ff83a6`

**Sprint AI7 — CampaignDetail 3 inline modaly → centralizovaný Modal** (completed, PR #1392)
- Reset časování, Pause confirm, Quality gate modaly → `<Modal>` komponent
- Modal API extended: `ariaLabel`, `testId` props
- ~15 LOC duplicit boilerplate odstraněno

### P1 — Po dokončení P0 agentů

**Sprint AI8 — useResource adoption ratchet test**
- `tests/audit/useResource-adoption.test.js` — počítá inline `useState + useEffect + fetch` páry v `src/pages/`
- Baseline = current count po AI6; one-way ratchet (může jen klesat)
- Zabraňuje regresi v budoucnu

**Sprint AI9 — StatusPill primitive global adoption**
- `<StatusPill tone>` extension: po AH5 landingu rozšířit napříč Companies/Mailboxes/Replies
- Odstranit per-page inline `style={{ background: …, color: … }}` pill replicating

### P2 — Deferred

**Sprint AI10 — Drawer primitive (ThreadDetail/Replies/Companies)**
- Extract `<Drawer>` z 3 pages s right-side detail panel
- Sjednotit ESC + close handler + ARIA

**Sprint AI11 — Refactor Mailboxes (1336 LOC)**
- Mailboxes.jsx je 4× větší než průměrná page
- Split do MailboxList + MailboxDrawer + DailyLimitCard + AuthLockCard

**Sprint AI12 — Layout/Spacing primitives**
- `<Stack gap>`, `<Inline gap>`, `<Cluster>` primitives
- Náhrada raw flexbox CSS napříč všemi pages

## Hard rules

- `feedback_playwright_smoke_required` T0 — každý nový surface s smoke
- `feedback_no_magic_thresholds` T0 — všechny thresholds named/operator-editable
- `feedback_efficient_execution` T1 — bundle related fixes, ne micro-PRs
- `feedback_spawn_first_solo_second` T1 — paralelní agenti pro independent surface

## Operator decisions pending

Žádné — initiative má self-contained scope, decisions byly udělány v inception fázi.

## Predikce hodnoty

| Sprint | Depth gain | Simplification | Risk |
|---|---|---|---|
| AI1 audit | 0 | maps gap | none |
| AI2 audit | 0 | maps duplicity | none |
| AI3 orphan delete | + smoke 3 routes | -0 LOC test, +3 smoke | very low |
| AI4 deep tests | +69 cases | 0 | low |
| AI5 Layout + brittle | TBD | TBD | medium (replaces patterns) |
| AI6 useResource | TBD | -inline fetch boilerplate | medium (refactor) |
| AI7 Modal | +consistent ARIA | -150 LOC duplicit | low |

**Celkový P0 outcome:** Depth coverage +69+ assertions, simplification -150 LOC duplicit + Modal/useResource adoption + 3 new smoke routes.
