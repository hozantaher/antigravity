# Iniciativa AH — UX/UI gap remediation

**Status:** Active  
**Datum:** 2026-05-15  
**Trigger:** Hloubková UX analýza po nočním provozu odhalila 110 operator manual SQL ops za 24h kvůli chybějícím UI surfaces. 18 z 27 `operator_settings` keys vůbec není v UI surfacích. Hard rule `feedback_ux_ui_first` (T0) porušen 4× typu mutací.

## Severní hvězda

Eliminate operator psql round-trips za týden. Každá mutace přes UI s audit logem. UI surface coverage 9/27 → 27/27 operator_settings keys.

## Fáze

### P0 — Týden 1 (3 tracky paralelně + cleanup)

**Sprint AH1 — `/settings/thresholds` operator panel**
- BFF endpointy už existují (`GET/PUT /api/operator-settings/:key` v `operatorSettings.js`)
- FE: rozšířit `SettingsBranding` o grouped sections, nebo nová page `/settings/thresholds`
- Group keys: Bounce/Spam, Distribution/Capacity, Toggles (boolean), Pre-send probe, GDPR/Branding
- Per-key: input + last-edited badge + ⓘ tooltip + audit emit
- Playwright smoke + 25+ unit tests

**Sprint AH2 — Skip-by-domain drawer + auto-detect cron**
- BFF endpoint `POST /api/campaigns/:id/skip-by-domains` (reason, status_filter, dry-run preview)
- FE: drawer v CampaignDetail (Akce menu)
- Go cron `domain_overlap_detector` 2× denně, emit `operator_notifications` při >5 contacts same domain
- Companion: reuse audit pattern z existující `unskip` endpoint

**Sprint AH3 — MailboxDrawer lifecycle phase + status edit**
- BFF `PATCH /api/mailboxes/:id/lifecycle-phase` (X-Confirm-Send + reason + audit)
- BFF `PATCH /api/mailboxes/:id/status` (generic unpause)
- FE: rozšířit DailyLimitCard o "Pokročilá změna fáze" sekci s consent modal
- Visible breakdown "Phase cap 5, override 420, LEAST = 5" pro debug clarity

**Sprint AH4 — Quick cleanup (sólo)**
- Vite scaffold (App.jsx + assets) DELETE
- OchranyPanel.jsx + hook + index.css block DELETE
- Stale `features/inbound/inbox/ui/` barrel DELETE
- 3 orphan routes decide (surface nebo delete)

### P1 — Týden 2 (po P0)

**Sprint AH5 — `<StatusPill>` primitive**
- Extract `<StatusPill tone="green|amber|red|grey">` z 5 worst pages
- Remove 300+ inline `style=` objektů
- Codemod: replace inline pill styles s primitive

**Sprint AH6 — Engine sustained-rate widget na Home**
- Existující `daily-summary` widget pokrývá yesterday; chybí live current sustained rate
- Card: "Cluster sends/h" + per-mb breakdown
- ROI: operator vidí throughput dip okamžitě (jako AG3 noční incident)

### P2 — Deferred (operator decision)

**Sprint AH7 — MailboxHealthBoard consolidation**
- 3 pool/health widgety scattered v Analytics/Companies/Mailboxes
- Konsolidovat do jednoho `<MailboxHealthBoard>` panel-strip
- Decide: kde mount (Home? Analytics?)

## Predikce hodnoty

| Sprint | Manual ops covered | Audit log gap closed | Effort |
|---|---|---|---|
| AH1 thresholds panel | 10 (50% dnešních) | 10 audit gaps | 1-2 dny |
| AH2 skip-by-domain | 104 contactů + auto-detect | 1 audit gap | 1-2 dny |
| AH3 mailbox actions | 6 | 6 audit gaps | 0.5 dne |
| AH4 cleanup | 0 | 0 | 1h |
| **P0 total** | **120/110** | **17 audit gaps** | **3-5 dní** |

Pokrytí: 100% včerejších manual ops by mělo UI surface po dokončení P0.

## Hard rules

- `feedback_ux_ui_first` T0 — všechny mutace přes UI
- `feedback_audit_log_on_mutations` T0 — každý PUT/PATCH/UPDATE emit operator_audit_log v stejné tx
- `feedback_no_magic_thresholds` T0 — všechny named, operator-editable
- `feedback_playwright_smoke_required` T0 — každý nový surface smoke spec landed in same PR
- `feedback_schema_verify_before_sql` T0 — `psql \d` před každou SQL change

## Operator decisions pending

1. **AH1** — rozšířit existující `SettingsBranding` (current path), nebo nová page `/settings/thresholds`?
2. **AH4** — 3 orphan routes (`/launch-readiness`, `/operator/queue`, `/companies/:id/timeline`) — surface (kde?) nebo delete?
3. **AH7** — MailboxHealthBoard konsolidace — kde mount? Home, Analytics, nebo /mailboxes?

Default decisions (pokud operator nezvolí):
1. Nová page `/settings/thresholds` (čistá architektura, SettingsBranding zůstane GDPR-focused)
2. Delete všech 3 orphan routes (scaffolding, žádný operator path) — Track B M+3 plans deferred
3. Mount v /mailboxes (operator už tam chodí pro mailbox health)
