# /mailboxes + Sidebar declutter

**Status:** plánováno
**Datum založení:** 2026-04-28
**Trigger:** uživatel — "celá záložka Schránky a hlavně Sidebar mi přijde extrémně nepřehledný, je tam toho extrémně moc."

## Cíl

Snížit kognitivní zátěž denního provozu na `/mailboxes` a v sidebaru. Daily-ops uživatel má vidět **jen seznam schránek + critical alerts**. Audit/diagnostic widgety musí jít za toggle.

Měřitelné cíle:
- Sidebar viditelně 6 položek (z 13)
- /mailboxes nad seznamem ≤ 4 vrstvy (z 10)
- 0 informačních duplicit napříč widgety
- Čas do první akce (klik "Přidat schránku" / scroll do tabulky) ≤ 1 vteřina vizuální přípravy

---

## Deep Inventory

### Sidebar (`features/platform/outreach-dashboard/src/components/Layout.jsx`)

13 nav itemů ve 3 skupinách + button + workspace menu:

| Skupina | Položka | Used daily? | Poznámka |
|---|---|---|---|
| _(top button)_ | "Nová kampaň" CTA | ✓ | OK, primary action |
| Primary 1 | Přehled (Cmd+1) | ✓ | hlavní landing |
| Primary 2 | Odpovědi (Cmd+2) | ✓ | inbox triage |
| Primary 3 | Kampaně (Cmd+3) | ✓ | core workflow |
| Primary 4 | Firmy (Cmd+4) | ✓ | core workflow |
| Primary 5 | Analytika (Cmd+5) | ◻ | týdenní review, ne daily |
| Data | Kontakty | ✓ | core workflow |
| Data | Uložené filtry | ◻ | per-page filter, ne standalone view |
| Data | Leady | ◻ | dosud experimentální |
| Nastavení | Schránky | ◻ | setup-time, ne daily |
| Nastavení | Šablony | ◻ | setup-time |
| Nastavení | Skórování | ◻ | konfig, occasional |
| Nastavení | Upozornění | ◻ | watchdog config |
| Nastavení | Pozorovatelnost | ◻ | dev/audit page |
| Foot | WorkspaceMenu | ✓ | OK, theme/help/palette |

→ **6 daily** (Přehled, Odpovědi, Kampaně, Firmy, Kontakty, "+ Nová kampaň") + **7 secondary**.

### `/mailboxes` page (`features/platform/outreach-dashboard/src/pages/Mailboxes.jsx`, 2172 řádků)

Top-down vrstvy nad seznamem:

| # | Vrstva | Soubor / lokace | Datový zdroj | Daily? | Komentář |
|---|---|---|---|---|---|
| 1 | `MissingPasswordBanner` | `components/MissingPasswordBanner.jsx` | `mailboxes` prop | conditional | ✓ kdy je třeba |
| 2 | `mb-sys-banner` (systemHealth alerts) | inline | `/api/health/system` 15s | conditional | duplikuje anonbar |
| 3 | `page-head .mb-stat-strip` | inline | `mailboxes`, `dailyCap`, `watchdogHealth` | ✓ | OK ale watchdog tu duplikuje |
| 3a | "Aktivní / Pozastavené / Celkem" | inline | `mailboxes` | ✓ | core stat |
| 3b | "E-mailů/den" | inline | součet `daily_cap_override` | ✓ | core stat |
| 3c | Watchdog heartbeat pill | inline | `/api/health/watchdog` 15s | ◻ | dev info, duplikuje anonbar |
| 4 | `page-head-actions` | inline | — | ✓ | "Import CSV" + "Přidat schránku" |
| 5 | `mb-toolbar` | inline | search/filter state | ✓ | OK |
| 5a | SearchInput | `components/SearchInput.jsx` | URL param `q` | ✓ | OK |
| 5b | Status filter `<select>` | inline | URL param `status` | ✓ | OK |
| 5c | Health band filter (3 buttons) | inline | `liveScores` | ✓ | OK |
| 5d | Refresh button | inline | manual | ✓ | OK |
| 5e | Density toggle (2 buttons) | inline | localStorage | ◻ | OK ale málo používané |
| 6 | Config drift banner (critical only) | inline | `/api/health/drift` 60s | conditional | OK |
| 7 | **`AnonymizationBar`** — 4 pills | inline ~1000–1100 | viz níže | ◻ | **operator-debug, ne daily** |
| 7a | Anti-trace pill | `/api/anti-trace/health` | once | ◻ | duplikuje OchranyPanel |
| 7b | Egress (proxy pool) pill | `/api/proxy-pool` 30s | ◻ | duplikuje PoolHealthWidget |
| 7c | Watchdog pill | `/api/health/watchdog` | ◻ | duplikuje page-head |
| 7d | Bounce guard pill | `mailboxes` | ◻ | duplikuje per-row badge |
| 8 | "Schránka potřebuje pozornost" alert | inline | `liveScores` | conditional | užitečné |
| 9 | **`OchranyPanel`** — 12-layer matrix | `components/OchranyPanel.jsx` (271 řádků) | `/api/protections/matrix` | ◻ | **audit-grade, denně nepotřebné** |
| 10 | `ProxyExhaustBanner` | `components/ProxyExhaustBanner.jsx` (44 řádků) | `/api/health/proxy-exhaust` 60s | conditional | **legacy** — Mullvad-only mode neexhausuje |
| 11 | **`PoolHealthWidget`** | `components/PoolHealthWidget.jsx` (181 řádků) | `proxyPool` prop | ◻ | duplikuje Egress pill |
| — | (sparkline `PoolTrendSparkline` uvnitř) | `components/PoolTrendSparkline.jsx` | `/api/proxy-pool-trend` 5min | ◻ | grafa pro deprekovaný rotating pool |
| 12 | Mailbox seznam (table/cards) | inline ~1100–1700 | `mailboxes` + `liveScores` | ✓ | core |
| 13 | Drawer (per-mailbox detail) | `MailboxDrawer` ~200–620 | per-mailbox API | conditional | OK, je v drawer |

### Dataflow + duplikace

| Informace | Zdroje |
|---|---|
| Watchdog heartbeat | `/api/health/watchdog` (15s) → page-head + anonbar pill |
| Egress / proxy pool | `/api/proxy-pool` (30s) + `/api/health/system` (15s) → anonbar Egress + PoolHealthWidget + OchranyPanel `proxy_pool` row |
| Anti-trace relay reachable | `/api/anti-trace/health` (once) + `/api/health/system` → anonbar Anti-trace + OchranyPanel `anti_trace` row |
| Per-mailbox health | `/api/mailboxes/health-summary` (30s) + SSE `/api/mailboxes/health-stream` → per-row score badge + bounce-hold count v anonbar |
| Bounce hold count | derived from `mailboxes` array → anonbar pill + per-row column |

**5 duplikujících os**, každá vyrenderovaná 2–3×.

### Sekundární páce (ne /mailboxes)

| Page | Status | Komentář |
|---|---|---|
| `Watchdog.jsx` | aktivní | sám má detail UI; sidebar item OK schovat |
| `Observability.jsx` | aktivní | dev/audit; přesunout pod "Více" |
| `Scoring.jsx` | aktivní | konfig stránka; ne primary nav |
| `Templates.jsx` | aktivní | setup-time |
| `Segments.jsx` | aktivní | per-page filter; nezasluhuje top-level slot |
| `Leads.jsx` | nedokončený | experimentální, schovat |

---

## Plán (S1–S4)

### S1 — Sidebar consolidation
**Soubor:** `features/platform/outreach-dashboard/src/components/Layout.jsx`
**Časový odhad:** 30 min

```
S1.1  Přesunout "Kontakty" z Data do PRIMARY_NAV (slot 5)
S1.2  Přesunout "Analytika" z PRIMARY_NAV do "Více" (Cmd+5 zachovat na Kontakty)
S1.3  Sloučit "Data" + "Nastavení" do single secondary skupiny "Více"
        - Default collapsed (localStorage flag)
        - Click "Více ▸" expanduje
S1.4  Odstranit "Uložené filtry" sidebar item (přesunout funkcionalitu — přístup z Kontakty/Firmy přes filter UI)
S1.5  Zvážit odstranění "Leady" pokud experimentální
S1.6  Update keyboard shortcuts: 1-5 = Přehled/Odpovědi/Kampaně/Firmy/Kontakty
S1.7  Update CommandPalette nav items (search-driven přístup k secondary)
```

**Acceptance:**
- Visible v sidebar default: 5 nav + "+ Nová kampaň" + "Více ▸" + footer
- Cmd+1..5 funguje pro všech 5 primary
- `pnpm test` zelené (sidebar tests update)
- Cmd+K Command Palette stále hledá all routes

### S2 — /mailboxes page-level deklarter
**Soubor:** `features/platform/outreach-dashboard/src/pages/Mailboxes.jsx`
**Časový odhad:** 60 min

```
S2.1  Odstranit AnonymizationBar (4 pills) z default zobrazení
        - Přesunout za toggle "Pokročilé ▾" (default off, localStorage)
        - Toggle umístění: vedle density buttons v toolbar
S2.2  Odstranit PoolHealthWidget z default
        - Stejný "Pokročilé" toggle
S2.3  Odstranit OchranyPanel z default
        - Stejný toggle (audit-grade view)
S2.4  Odstranit ProxyExhaustBanner natrvalo
        - Mullvad-only nepotřebuje, code dead
        - Soubor delete: components/ProxyExhaustBanner.jsx
        - Memory entry: project_proxy_exhaust_banner_deprecated
S2.5  Watchdog heartbeat sloučit:
        - Ponechat pouze v page-head (drobný badge)
        - Odstranit Watchdog pill z anonbar (= bod S2.1)
S2.6  Sloučit systemHealth banner s drift bannerem
        - Jeden "Status pásek" co aggreguje critical drifts + system alerts
        - Render jen když cokoli != ok
S2.7  Density toggle UX:
        - Přejmenovat na "Rows" + zmenšit
S2.8  Page-head daily-cap stat:
        - Ponechat (užitečné), ale možná zmenšit jako "X mailů/den" footer line
```

**Acceptance:**
- Default render nad seznamem: max 4 vrstvy (banner-row + page-head + toolbar + (no-extras))
- "Pokročilé" toggle přepíná mezi minimal / full audit view
- Žádný banner-noise když všechno OK
- E2E test ověří default = minimal, toggle = full

### S3 — Component extract + cleanup
**Časový odhad:** 45 min

```
S3.1  Extract MailboxStatStrip z page-head do components/
        Současný řádek 1764–1803 → samostatný komponent
S3.2  Extract MailboxToolbar z 1815–1894 → components/
S3.3  Extract MailboxAdvancedPanel — wrapper pro AnonymizationBar + 
        PoolHealthWidget + OchranyPanel s "open" prop
S3.4  Smazat ProxyExhaustBanner.jsx + související /api/health/proxy-exhaust 
        endpoint v server.js (Mullvad-only nepotřebuje)
S3.5  Aktualizovat Mailboxes.jsx imports + smazat dead state
S3.6  Mailboxes.jsx řádkový cíl: < 1500 (z 2172)
```

### S4 — Memory + docs
**Časový odhad:** 15 min

```
S4.1  Memory entry: project_ui_declutter_2026_04
        - Pravidla pro budoucí adds: nový widget = MUSI mít odůvodnění daily-ops
        - Anti-pattern: nepřidávat audit info na default view
S4.2  Update features/platform/outreach-dashboard/CLAUDE.md
        - "Default view = daily-ops only; audit-grade view za toggle"
S4.3  Smazat reference v existujících dokumentech na Anonbar/OchranyPanel jako "default"
```

## Per-sprint approval pattern (per CLAUDE.md)

```
OK S1                  # full sprint
OK S1.1, S1.4          # selected steps only
SKIP S1.5              # veto
EDIT S2.1: <text>      # tweak
```

Po každém sprintu commit + push + admin merge + deploy + summary + next-step-prompt.

## Globální acceptance

- [ ] Sidebar default ≤ 6 viditelných nav slotů
- [ ] /mailboxes default ≤ 4 vrstvy nad seznamem
- [ ] Žádné info-duplicity (každá metrika 1×)
- [ ] "Pokročilé" toggle pro audit view
- [ ] `pnpm test` zelené
- [ ] `pnpm build` zelené
- [ ] E2E `tests/e2e/mailboxes-*.spec.js` aktualizované
- [ ] Admin merge → Railway redeploy → live

## Mimo scope

- Refactor jiných pages (`Companies`, `Contacts`, `Campaigns`) — pokud vyplyne podobný feedback, samostatná initiative
- I18n — UI zůstává Czech-only
- Permission/role-based view — nyní stejný pro všechny operátory
