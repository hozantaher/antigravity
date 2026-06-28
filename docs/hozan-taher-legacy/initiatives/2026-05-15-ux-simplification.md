# Iniciativa AJ — UX/UI Simplification

**Status:** Active  
**Datum:** 2026-05-15  
**Trigger:** Operator request "Proveď analýzu jak vylepšit UX/UI a co odebrat. Je potřeba se zaměřit na zjednodušování celého UX/UI." po 3-agent Deep Inventory audit (Page inventory + Component duplicity + IA/Nav friction).

## Severní hvězda

Snížit dashboard kód o ~32% (z 34,500 LOC na ~28,000) cestou DELETE + CONSOLIDATE. Zachovat 100% operator funkce; zlepšit discoverability eliminací 5 nav slotů a centralizace primitiv (Modal, StatusPill, Field).

## Audit summary

| Kategorie | Současný stav | Cíl | Savings |
|---|---|---|---|
| Pages | 26 routes / 17,914 LOC | ~22 routes / ~16,000 LOC | **1,875 LOC + 4 nav slots** |
| Components | 85 files / 16,500 LOC | ~70 files / 13,000 LOC | **~3,500 LOC + 15 files** |
| Modal centralizace | 3/26 pages | 26/26 | 120 LOC |
| Primitive adoption | StatusPill 3 callers | StatusPill 10+ callers | 200 LOC |
| Nav surfaces | 19 ve sidebar | 14 ve sidebar | −5 slotů |
| psql-fallback gaps | 4 confirmed | 0 | UI surfaces |

## Fáze

### P0 — Týden 1 (paralelní)

**Sprint AJ1 — Delete `/scoring`, fold weights do SettingsThresholds** (sólo)
- Move scoring weights jako "Skórování" sekci v `SettingsThresholds.jsx`
- DELETE `src/pages/Scoring.jsx` (380 LOC)
- Remove `/scoring` route v `main.jsx` + nav entry v `Layout.jsx`
- 301 redirect `/scoring` → `/settings/thresholds#scoring`
- Smoke spec update

**Sprint AJ2 — Delete `/leads`, redirect na `/contacts?status=lead`** (sólo)
- Ensure `Contacts.jsx` reads `status` URL param + applies as filter
- DELETE `src/pages/Leads.jsx` (217 LOC)
- Remove `/leads` route + nav entry
- 301 redirect `/leads` → `/contacts?status=lead`

**Sprint AJ3 — Settings 3→1 page s taby** (agent)
- New `src/pages/Settings.jsx` s `<TabBar>` "Entita | ICP | Provoz"
- Merge bodies z SettingsBranding/SettingsICP/SettingsThresholds
- Routes: `/settings`, `/settings/branding`, `/settings/icp`, `/settings/thresholds` všechny → Settings page s tab state
- Layout nav: 3 položky → 1 "Nastavení"

**Sprint AJ4 — Modal universal adoption** (agent)
- Refactor 6 bespoke modal shells → `<Modal>`: RotateApiKeyModal, LaunchConfirmModal, PreflightGateModal, WatchdogReaperBadge dialog, NotificationBell drawer, VerifikaceAdresCard modal
- ESC + backdrop + focus trap konzistentně

**Sprint AJ5 — StatusPill adoption v Mailboxes + Companies** (agent)
- Replace inline `borderRadius:9999; background:'var(--green)/.../...'` patterns
- Mailboxes 47× → StatusPill, Companies 18× → StatusPill
- Tone mapping: green/amber/red/grey

### P1 — Týden 2

**Sprint AJ6 — Fold `/watchdog` → Mailboxes tab "Upozornění"**
- Add TabBar to Mailboxes: "Stav | Upozornění | Skóre"
- Move Watchdog.jsx body do tab content
- DELETE `/watchdog` route + Engineering nav entry

**Sprint AJ7 — Fold `/priprava/hesla` → Mailboxes row action**
- Convert page do `<MailboxPasswordDialog>` triggered from Mailboxes row kebab
- Update Příprava blocker link na new dialog trigger
- DELETE `/priprava/hesla` page route

**Sprint AJ8 — Throughput widgets 5→1 konsolidace**
- New `<ThroughputBoard variant="home|observability|campaign">`
- Replace LiveClusterRateWidget + SendRateWidget + ActiveCampaignsLive + VerifyQueueWidget + ReplyLatencyWidget
- Polling consolidation 5 endpoints → 1 multiplex endpoint nebo per-variant

**Sprint AJ9 — PreflightGateModal helper split**
- Move `classifyChecks` do `src/lib/preflightChecks.js`
- DELETE modal body (dead — operator nikdy nevidí)
- DELETE 4 test files validating dead UX

**Sprint AJ10 — psql-fallback gap fixes**
- AJ10a: Global domain suppress UI (#1397) — drawer/panel v Companies row kebab + Replies thread
- AJ10b: Bulk segment expansion UI (#1398) — `<CategoryTreePicker>` multi-campaign mode

### P2 — Deferred

**Sprint AJ11 — Fold `/dedup-guard` → Companies tab**  
**Sprint AJ12 — Split oversized pages (Companies/Replies/ThreadDetail)** — 800-line rule violation  
**Sprint AJ13 — Re-merge CampaignDetail micro-extracts** (24 children → ~14)

## Predikce hodnoty

| Sprint | LOC out | Files out | Nav slots out | Risk |
|---|---|---|---|---|
| AJ1 scoring | 380 | 1 | 1 | low |
| AJ2 leads | 217 | 1 | 1 | low |
| AJ3 settings 3→1 | ~200 | 0 | 2 | medium (deep-link compat) |
| AJ4 modal adoption | 120 | 0 | 0 | low |
| AJ5 StatusPill adoption | 200 | 0 | 0 | low |
| AJ6 watchdog fold | 390 | 1 | 1 | medium |
| AJ7 hesla fold | 328 | 1 | 0 | low |
| AJ8 throughput konsolidace | 700 | 4 | 0 | medium |
| AJ9 preflight modal split | 150 | 1 + tests | 0 | low |
| AJ10 psql gaps | n/a | 0 (adds) | 0 | medium |
| **P0+P1 total** | **2,685** | **9** | **5** | — |

## Hard rules

- `feedback_ux_ui_first` T0 — všechny nové surface s same-tx audit log
- `feedback_playwright_smoke_required` T0 — každý nový surface s smoke spec PR
- `feedback_audit_log_on_mutations` T0 — psql-gap UI surfaces emit audit log
- `feedback_no_magic_thresholds` T0 — settings keys named v operator_settings
- `feedback_schema_verify_before_sql` T0 — psql \d před každý SQL change
- `feedback_search_before_implement` T0 — verify duplicity před new component
- `feedback_agent_isolation_default` T0 — všichni commit-capable agenti `isolation: "worktree"`

## Operator decisions pending

1. **AJ11 dedup-guard** — fold do Companies tab nebo nech v Engineering collapsed?
2. **AJ12 oversized pages** — split do sub-routes nebo internal Drawer/Tab struktura?
3. **AJ8 throughput** — single `<ThroughputBoard>` nebo zachovat per-variant samostatné komponenty?

Default decisions (pokud operator nezvolí):
1. Engineering collapsed default (lower risk, dedup-guard rare-use)
2. Internal Tab struktura (lower risk než sub-routes refactor)
3. Single ThroughputBoard (větší savings, jednodušší údržba)
