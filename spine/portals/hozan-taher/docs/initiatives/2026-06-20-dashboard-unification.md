# Dashboard Unification — jeden dashboard (v1 → v2)

> **Status:** PROPOSED (plán k odsouhlasení) · **Datum:** 2026-06-20
> **Branch:** `feat/relay-decommission-imap-direct` (plán necommitnutý)
> **Cíl:** JEDEN dashboard — `AppShellV2` (hnědý, Claude.ai estetika, vlastní
> shell) + **všechny** funkce z v1, které v2 nemá. v1 `Layout` retired.
>
> **Navazuje na / konsoliduje:**
> - [`2026-05-31-ux-v2-claude.md`](2026-05-31-ux-v2-claude.md) — north star (warm Claude look, rebuild-clean, ne reskin)
> - [`2026-06-02-ux-v2-cutover.md`](2026-06-02-ux-v2-cutover.md) — jednotková dekompozice R/A/P/C/D + pořadí
>
> **Progress log:**
> - **2026-06-20** — R: 18 bug-fixů v2/v3 (předchozí práce). **S1** (error-boundary
>   per v2 child — oprava regrese), **S2** (grupovaná collapsible nav), **P8**
>   (`V2Upozorneni` na `/v2/upozorneni` — rebuild Notifications), **P2**
>   (`V2Sablony` na `/v2/sablony` — rebuild Templates: list + aside editor se
>   spintax preview + ranking) — vše build-verified. Další: P7.
>
> Tenhle dokument **nenahrazuje** cutover plán — **doplňuje** ho o (1) podloženou
> inventuru (skutečné LOC/komplexita/endpointy z code reconu 2026-06-20),
> (2) chybějící **S — shell-parity** stopu (chrome z v1 Layoutu, co AppShellV2
> nemá), (3) chybějící **Q — twin-parity** stopu (existující v2 dvojčata jsou
> lehčí než v1 a musí dohnat funkce, než se v1 smaže).

---

## 1. Strategie (potvrzeno, ne znovu otevíráno)

**Rebuild-clean, jednotka = 1 PR.** Každý v1 povrch se **přestaví načisto na v2
frame** (`--v2-*` tokeny, `useResource`, 4 stavy, query-param + aside idiom),
ne adoptuje. Operátor tuhle volbu udělal 2026-05-31 ("stop patching v1 layout",
`feedback_claude_style_means_anthropic`); v2 north star je *perfektní Claude.ai
look všude*.

> **Pozn. k reconu:** technicky by šla i levná **adopce** — `tokens-claude.css`
> přemapovává v1 proměnné (`--accent`, `--surface2`…) na Claude paletu a je
> globálně načtený, takže v1 stránka mountnutá pod `<Outlet/>` v2 shellu
> **renderuje a zdědí paletu**. ALE výsledek je hustý v1 chrome (těsné tabulky,
> pravé drawery, modály) v klidném v2 shellu = **není to Claude estetika**, jen
> obarvené v1. Proto adopci používáme **maximálně jako dočasný most** (viz
> Otevřené rozhodnutí #4), ne jako cíl. Cíl = rebuild.

**Klíčové architektonické zjištění (recon 2026-06-20):** `@hozan/*-ui` balíčky
jsou **jen re-export shimy** — veškerý zdroj je v `features/platform/outreach-dashboard/
src/pages/*.jsx` + `src/components/<domain>/*`. Není co „portovat z balíčku";
rebuild = nová `src/v2/pages/V2X.jsx` proti stejným `/api/*` endpointům.

---

## 2. Současný stav — podložená inventura

Routing realita (`src/main.jsx`): tři stromy za `RequireAuth` →
`/v2` (AppShellV2, 9 povrchů) · `/v3` (AppShellV2, jen Odpovědi redesign) ·
`/` (Layout = v1, 22 povrchů). `/` index redirectuje na `/v2`.

### 2A. NEEDS PORT — v2 nemá ekvivalent (net-new rebuild)

| Surface (v1) | Soubor | LOC (orch+sub) | Kompl. | Hlavní endpointy | Pozn. |
|---|---|---|---|---|---|
| **Mailboxes** (Schránky) | `pages/Mailboxes.jsx` + `components/mailboxes/*` | ~3934 | **XL** | `/api/mailboxes/*`, `health-stream` **SSE**, `/anti-trace/health`, `/proxy-pool`, `/health/*` | safety-critical: anti-trace egress, warmup caps, lifecycle fáze, bulk pause/resume (`X-Confirm-Send`) |
| **CampaignDetail** | `pages/CampaignDetail.jsx` + `components/campaigns/*` | ~2990 | **XL** | `/api/campaigns/:id/*` | 4 taby; **run/pause + preflight + `X-Confirm-Send`** — mis-port = neguarded send |
| **Settings** (Nastavení) | `pages/Settings.jsx` + `components/settings/*` | ~1300 | **XL** | `/api/operator-settings*`, `/api/icp-sectors` | 3 form taby (brand/ICP/thresholds) |
| **Analytics** (Analytika) | `pages/Analytics.jsx` + `components/analytics/*` | ~1700 | **XL** | `/api/analytics/*`, `/funnel/*`, `/health/*`, `/synthetic-runs` | 4 chart taby; **≠ Kvalita** (V2Kvalita = data-quality, jiná věc) |
| DiagnostikaAnonymita | `pages/DiagnostikaAnonymita.jsx` | 688 | L | `/api/anonymity/{all,run}` | probe matrix + 30s poll; dep #1585/#1321 |
| DedupGuard | `pages/DedupGuard.jsx` | 561 | L | `/api/dedup-guard/*` | block-axes funnel |
| SegmentBuilder | `pages/SegmentBuilder.jsx` | 523 | L | `/api/categories`, `/segments/preview` | live PII-safe count |
| Segments (Uložené filtry) | `pages/Segments.jsx` | 472 | L | `/api/segments*` | store-coupled (segments slice) |
| Templates (Šablony) | `pages/Templates.jsx` | 464 | L | `/api/templates*` | AR2/AR5 render-guard hlášky |
| TopTargets | `pages/TopTargets.jsx` | 464 | L | `/api/prospects/{top,stats}` | feeds „Nová kampaň" |
| CampaignSegment | `pages/CampaignSegment.jsx` | 172 | M | `/api/campaigns/:id/segment` | category tree picker |
| Notifications (Upozornění) | `pages/Notifications.jsx` | 259 | M | `/api/notifications*` | nejmenší — dobrý warm-up |

### 2B. PARTIAL TWIN — v2 dvojče existuje, ale **lehčí** (reconcile, ne greenfield)

| v1 surface (LOC) | v2 dvojče (LOC) | Co v2 dvojčeti CHYBÍ vs v1 |
|---|---|---|
| Campaigns list+wizard (755) | **V2Kampane (70)** | celý create-wizard, run/pause, **pause-all**, send-batch — v2 je jen read-only list |
| Companies (2215) | **V2Firmy (177)** | score-trends, bulk-verify-email, sloupce/drawer hloubka, category-tree filtry, CSV export |
| Contacts (742) | **V2Kontakty (257)** | DNT/GDPR Art.21 toggle, bulk-suppress, email-verify, send-history drawer (v2 má naopak bohatší cross-linking) |
| CrmClients (497) | **V2Crm (152)** | pipeline stats, freshness, linked-vehicles |
| Vehicles (446) + VehicleDetail (238) | **V2Vozidla (236)** | **nejblíž paritě** — v2 má i `?id=` aside; ověřit status-advance + price-edit |
| Replies table (1176) + RepliesChat (328) | **V3Odpovedi (387)** | bulk-revert, white-label handoff formy; V3 je single-screen redesign (jiný koncept) |
| ThreadDetail (486+4076≈4562) | V3 embed (částečný) | vehicle-capture handoff (load-bearing); **dropnout `/api/leads`** (mrtvá Schema-B cesta) |

### 2C. REDIRECT-ONLY — už collapsnuté, žádný port

`/` → `/v2` · `/scoring` → `/settings/thresholds` · `/watchdog` →
`/mailboxes?tab=alerts` · `/leads` → `/contacts` · `/observability` →
`/analytics?tab=crony` · `/priprava*` → … · `*` → `/`. (Po cutoveru se přepnou
na v2 cíle.)

---

## 3. Co AppShellV2 **postrádá** vs v1 Layout — **S (Shell-parity) stopa** ⚠️ NOVÉ

Toto cutover plán podcenil. Bez téhle stopy je „jeden dashboard" funkčně horší
než v1. Vše ověřeno v `src/components/Layout.jsx` vs `src/v2/AppShellV2.jsx`.

| # | Co chybí v AppShellV2 | Zdroj v1 | Priorita | Pozn. |
|---|---|---|---|---|
| **S1** | **Error-boundary per child** | `main.jsx:106` wrapuje jen shell-level; v2 děti (index/odpovedi/vozidla…) **nejsou** jednotlivě v `<RouteErrorBoundary>`, v1 děti ano (`:132+`) | **P0** | **regrese**: crash jedné v2 stránky strhne celý shell. Quick win. |
| **S2** | **Nav grouping** | `Layout.jsx:56-100` `PRIMARY_NAV` + `NAV_SECTIONS` (collapsible, `localStorage`) | **P0** | 8 flat položek → ~18 povrchů = nepoužitelný sidebar. Nutné PŘED porty. |
| S3 | `AuthFailAlertBanner` + `DegradedBffBanner` | `Layout.jsx:345-348` | P1 | global health bannery; `useOutreachHealth` store už existuje |
| S4 | `CommandPalette` (⌘K) + `HelpOverlay` (?) | `Layout.jsx:551-557` | P2 | rozhodnout zda nést (Otevřené rozhodnutí #1) |
| S5 | Topbar widgety: `DaemonStatusBadge`, `RelayBackpressureBadge`, `NotificationBell` | `Layout.jsx:491-493` | P2 | ops viditelnost |
| S6 | **Emergency Pause-All** | `Layout.jsx:266-286,477-490` → `/api/campaigns/pause-all` | P1 | safety; patří k Mailboxes/Kampaně portu |
| S7 | Global keyboard shortcuts (⌘K, ⌘1-5, ⌘N, ?, /) | `Layout.jsx:230-254` | P2 | |
| S8 | **Reply-stats SSE** `/api/threads/stream` | `Layout.jsx:207-228` | P2 | v2 má jen 60s poll; SSE = live push |
| S9 | `#topbar-toolbar` portal mount | `Layout.jsx:541` | P1 | stránky portálují toolbar do topbaru; bez něj porty nemají kam dát controls |
| S10 | Mobile sidebar drawer + skip-link + scroll-to-top | `Layout.jsx:154-163,340,543` | P2 | a11y/mobil |
| S11 | Theme target sjednotit | v1 `data-theme` na `<html>` (key `theme`) vs v2 `.v2-app` (key `v2Theme`) | P1 | zvolit v2 scoping, migrovat klíč |

**Už globální (router root, `main.jsx`) — přežívá netknuté, NEremontovat:**
Sentry boundary, `ToastProvider`, `SentryRouteTracker`, `AlertToastListener`
(alerts SSE), `Suspense`, `RequireAuth`. (Tj. toasty/Sentry/auth/mailbox-alert
notifikace fungují v každé v2 stránce už teď.)

---

## 4. Stopy (tracks) — konsolidace

| Stopa | Co | Stav |
|---|---|---|
| **R** — Remediace v2 | opravit bugy existujících v2 povrchů (cutover R1/R2) | **částečně hotovo v této branch** — 18 fixů (3 HIGH + 15 MED) napříč V2/V3Odpovedi, Vozidla, Firmy, Kontakty, Home, Kvalita, Kampane, auth. Zbývá R1 (ChatThread quote-strip) ověřit. |
| **S** — Shell-parity ⚠️ NOVÉ | §3 — chrome z v1 Layoutu do AppShellV2 | **S1 + S2 HOTOVÉ** (této branch); S3–S11 navrženo |
| **A** — Scaffolding | `<V2DetailAside>`, `<V2Table>`, `<V2ListRow>`, `<V2StatStrip>` (cutover A1-A4) | navrženo (zatím inline patterny dle V2Upozorneni) |
| **P** — Porty net-new | §2A — 12 chybějících povrchů (cutover P1-P8) | **P8 + P2 HOTOVÉ** (`V2Upozorneni`, `V2Sablony`); zbylých 10 navrženo |
| **Q** — Twin-parity ⚠️ NOVÉ | §2B — dohnat lehčí v2 dvojčata na paritu PŘED smazáním v1 | navrženo |
| **C** — Cutover | `/` → v2, v1 routes → v2 redirecty (cutover C1) | navrženo |
| **D** — Teardown | smazat shimy, `src/pages/*`, `--c-*` tokeny, `Layout.jsx`, repoint ratchety (cutover D1-D4) | navrženo |

---

## 5. Master sekvence (merged)

```
R (hotovo z větší části)
  → S1 (error-boundary per child)         ← P0 quick win, samostatný PR
  → S2 (nav grouping)                      ← P0, odblokuje všechny porty
  → A1-A4 (scaffolding primitiva)
  → S9 + S11 + S3 (topbar portal, theme key, bannery)   ← shell infra před porty
  → P8 Notifikace  (warm-up, S)
  → P2 Šablony     (M)
  → P7 TopTargets + Segments + SegmentBuilder  (M)
  → P5 Analytika   (XL, 4 taby)
  → P6 Diagnostika + DedupGuard  (M; dep #1585/#1321)
  → P3 Nastavení   (XL, 3 taby)
  → P1 Schránky    (XL, SSE + safety)  + S6 Pause-All
  → P4 KampaňDetail + CampaignSegment  (XL, send-confirm verbatim)  ← nejtěžší, předposlední
  → Q1-Q6 twin-parity (Kampaně/Firmy/Kontakty/Crm/Vozidla/Odpovedi dohnat)
  → S4/S5/S7/S8/S10 (palette, badges, shortcuts, SSE, mobil)  ← shell parity dokončit
  → C1 cutover (/ → v2, v1 → redirecty; gate: každá v1 route má zelený v2 smoke)
  → D1-D4 teardown (shimy → pages → tokeny → Layout; repoint ratchety)
```

Pořadí portů drží cutover logiku (nejlehčí/nejhodnotnější první, P4 předposlední).
**S1+S2 jdou úplně první** (odblokují vše). **Q jde až po P** (parita dvojčat se
řeší, až je shell hotový a porty doplněné). **D úplně naposled** a shimy PRVNÍ
v D (jinak build break).

---

## 6. Q — Twin-parity (detail) ⚠️ NOVÉ

Před C1 cutoverem (který v1 stránky nahradí redirectem) musí každé lehčí v2
dvojče buď **dohnat paritu**, nebo se **explicitně rozhodne** deltu zahodit.
Jinak cutover = tichá ztráta funkcí.

| # | Dvojče | Parita-gap k vyřešení | Velikost |
|---|---|---|---|
| Q1 | V2Kampane → Campaigns | create-wizard, run/pause, pause-all, send-batch (částečně = P4 + S6) | L |
| Q2 | V2Firmy → Companies | score-trends, bulk-verify-email, category-tree filtry, CSV, drawer | L |
| Q3 | V2Kontakty → Contacts | DNT/Art.21 toggle, bulk-suppress, email-verify, send-history | M |
| Q4 | V2Crm → CrmClients | pipeline stats, freshness, linked-vehicles | M |
| Q5 | V2Vozidla → Vehicles+Detail | ověřit status-advance + 3 ceny/marže edit (možná už hotovo) | S |
| Q6 | V3Odpovedi → Replies+ThreadDetail | bulk-revert, white-label handoff, vehicle-capture handoff; **dropnout `/api/leads`** | L |

---

## 7. Quality gate (každá jednotka = 1 PR) — HARD RULES

- **Playwright smoke** (goto + viditelný headline + klíčová interakce + no-console-error) — řádek v `tests/e2e/today-shipped-surfaces.smoke.spec.ts` nebo per-feature spec. *(feedback_playwright_smoke_required, T0)*
- **Pilot before ship** — build + běh proti reálnému BFF + screenshot light+dark (`v2-theme-toggle`) + kritický pohled na produkt. *(feedback_pilot_before_ship, T0)*
- **UX/UI-first** — povrch musí jít spustit z dashboardu, ne psql/curl. *(feedback_ux_ui_first, T0)*
- 0 critical axe · v2 page ≤ 800 LOC (split do `src/v2/components/`).
- **Re-tokenize, nereuse** — žádný `--c-*`/`--accent`/`--s-N`/`T.icon`/raw hex v portu; jen `--v2-*` (jinak nedědí dark `.v2-app[data-theme=dark]`). Mapping tabulka v reconu §4.

---

## 8. Rizika + guardrails

1. **P4 CampaignDetail + P1 Schránky = safety-critical.** Run/pause proxuje na
   Go + direct-DB fallback, gated preflight + `X-Confirm-Send`; Schránky frontují
   anti-trace egress + warmup caps + lifecycle fáze (HARD RULES AO1/AP3/AP6,
   `feedback_anti_trace_full_stack`). **Port = chování verbatim**, ne reinterpretace.
2. **S1 error-boundary** — než se přidá XL stránka, opravit S1, jinak její crash
   strhne celý dashboard.
3. **Service barrels mazat PRVNÍ (D1 před D2)** — `@hozan/*-ui` re-exportují zpět
   do `src/pages/*`; opačně = build break.
4. **Ratchet whiplash** — `page_loc_ceiling`/`ui-page-needs-smoke-row`/a11y route
   list pinnuté na `src/pages`; při teardownu zčervenají → repoint ve stejném PR (D4).
5. **Mrtvé cesty nenosit do v2** — `/api/leads` (Schema-B, mrtvá), leads funnel
   („leady JSOU vozidla"). ThreadDetail je referuje — dropnout při Q6.
6. **Parita-before-retire** (Pilot-before-ship) — v1 stránku NESMAZAT, dokud její
   v2 náhrada není ověřená zeleným smoke + pilotem (C1 safety gate).

---

## 9. Hrubé sizing

| Stopa | Jednotek | Velikost |
|---|---|---|
| S (shell) | 11 | S1/S2 malé ale P0; S3-S11 mix |
| A (scaffold) | 4 | S každá |
| P (porty) | 12 | 4× XL (Mailboxes, CampaignDetail, Settings, Analytics), 6× L/M, 2× S/M |
| Q (twin-parity) | 6 | 3× L, 2× M, 1× S |
| C + D | 5 | mechanické, ale ratchet-citlivé |

Nejdražší: P1 Schránky, P4 KampaňDetail, P5 Analytika, P3 Nastavení (~9000 LOC
rebuild dohromady) + Q1/Q2/Q6. Reálně multi-sprint (desítky PR).

---

## 10. Otevřená rozhodnutí (pro operátora)

1. **S4/S5/S7 chrome scope** — nést do v2 CommandPalette (⌘K), topbar health
   badges, global shortcuts? Nebo v2 záměrně minimalističtější?
2. **Q parita-depth** — u lehčích dvojčat dohnat **plnou** v1 paritu (bulk-verify,
   score-trends, DNT toggle, CRM stats…), nebo akceptovat jednodušší v2 a smazat
   v1 deep-features?
3. **Home** — v1 widget grid vs V2Home 4 karty: fold v1 widgety do V2Home, nebo
   akceptovat 4 karty? (cutover doc to nechal otevřené)
4. **Most během migrace** — kým žije rebuild, **dočasně adoptovat** chybějící v1
   povrchy pod v2 shell (`<Outlet/>` + bridge, hustý ale funkční) a postupně je
   nahrazovat rebuildy? Nebo nechat operátora padat do `/` (v1) na neportované
   věci až do cutoveru? Adopt-most = jeden shell hned, rebuild = postupně fidelity.
5. **Priorita** — držet cutover pořadí (Notifikace→…→KampaňDetail), nebo táhnout
   dopředu největší gap (Schránky / KampaňDetail), protože tam v2 nemá vůbec nic?

---

*Grounding: code recon 2026-06-20 (3 paralelní agenti) — `src/main.jsx`,
`src/components/Layout.jsx`, `src/v2/AppShellV2.jsx`, `src/v2/styles/tokens-v2.css`,
`src/styles/tokens-claude.css`, `src/pages/*`, `src/components/<domain>/*`,
`services/*/ui/src/*` (shimy). LOC = `wc -l` (orchestrator + sub-component tree).*
