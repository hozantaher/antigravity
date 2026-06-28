# UX dekompozice & konsolidace — v2 jako jediný povrch

> **Status:** Active · **Datum:** 2026-06-02 · **Trigger:** operátor — "ux/ui je
> komplexní, rozpadlé, potřebuje expand-then-contract … zmapuj celou aplikaci
> a rozděl ji do menších celků, které budeme jednotlivě vyvíjet — cíl je
> komplexnost, avšak zjednodušit ux/ui" (#1586).
>
> **Cíl:** zachovat **funkční komplexnost** (nic neztratit), ale **zjednodušit
> UX** na jeden čistý povrch (v2). Aplikaci rozkládáme na malé, nezávisle
> vyvíjitelné **jednotky** — každá = 1 PR s vlastním smoke + screenshot gate.
>
> Companion: `docs/audits/ux-surface-map.md` (Phase 1 EXPAND audit, fakta).

## Proč (z auditu)

Dashboard běží **dvě paralelní generace UI**: v1 (22 stránek, shell `Layout`,
**3 token namespacy** `--`/`--c-`/inline px, default `/`) a v2 (9 stránek, shell
`AppShellV2`, **1 čistý** `--v2-*`, sibling `/v2`, bez redirectu). 7 konceptů
duplikováno. v2 = čistá reference, v1 = dluh. Navíc existující v2 povrchy mají
vlastní bugy (viz Jednotka R1).

## Princip dekompozice

Každá **jednotka** je samostatný balík: jedna v2 stránka/surface nebo jedno
sdílené primitivum. Vyvíjí se izolovaně, mergí samostatně. Komplexita zůstává
(stejné funkce, stejné API), mění se jen **povrch** — jeden konzistentní v2.

## Jednotky

### R — Remediace existujících v2 povrchů (PŘED expanzí)
Existující v2 stránky mají UX bugy co dělají povrch "nesmyslným". Opravit první.

| # | Jednotka | Co | Velikost |
|---|---|---|---|
| **R1** | Odpovědi — čtecí panel | `ChatThread` ukazuje quotnutý originál (`> Od/Komu/Datum: 24.0`) místo reálné odpovědi; outbound bubliny = jen subjekt "Dotaz"; duplicitní auto_send bubliny. Strip quotes (`lib/quoteStrip.js`), zdroj inbound těla = `reply_inbox.body_text` (čisté), dedup outbound, lepší prázdné stavy. | M |
| R2 | Audit ostatních v2 povrchů | rychlý průchod V2Vozidla/Firmy/Kontakty/Crm/Kampane/Kvalita/Hledat — najít podobné "nesmysly" | S |

### A — Scaffolding (sdílená primitiva, PŘED porty)
Vytáhnout duplikovaná CSS/JSX do `v2-shared.css` + `src/v2/components/`, ať je
každý port mechanický.

| # | Primitivum | Šablona z | 
|---|---|---|
| A1 | `<V2DetailAside>` | `.v2-vozidla__aside` |
| A2 | `<V2Table>` (sortable) | `.v2-table` ve v2-vozidla |
| A3 | `<V2ListRow>` | `.v2-row` ve v2-odpovedi |
| A4 | `<V2StatStrip>` | `.v2-stat` ve v2-odpovedi |

### P — Porty chybějících povrchů (v2 nemá, v1 ano)
Pořadí dle operator-value + závislostí. Každý = 1 PR.

| # | Jednotka (v2) | Nahrazuje v1 | Velikost | Pozn. |
|---|---|---|---|---|
| P1 | V2Schranky (mailboxy) | Mailboxes + Watchdog-alerts + hesla | L | 429/425 shapes |
| P2 | V2Sablony | Templates | M | AR2/AR5 render-guard hlášky |
| P3 | V2Nastaveni | Settings (3 taby) | M | re-tokenize ScoreRangeSlider |
| P4 | V2KampanDetail | CampaignDetail + CampaignSegment | L | **run/pause + preflight + X-Confirm-Send verbatim** |
| P5 | V2Analytika | Analytics (4 taby) + observability | M | re-token chart barvy |
| P6 | V2Diagnostika + V2DedupGuard | DiagnostikaAnonymita, DedupGuard | M | dep #1585/#1321 (DNS panel) |
| P7 | V2TopTargets + V2Segmenty + V2SegmentBuilder | TopTargets, Segments, SegmentBuilder | M | leady jsou mrtvé — neoživovat |
| P8 | V2Notifikace | Notifications | S | nejmenší, dobrý warm-up |

Pozn. Home: v1 widget grid > V2Home 4 karty → rozhodnout fold-vs-accept před cutoverem.

### C — Cutover (až VŠECH 11 povrchů žije ve v2)
| # | Jednotka | Co |
|---|---|---|
| C1 | Default flip | `main.jsx`: `/` → v2; v1 routes → v2 redirecty; safety gate = test že každá v1 route má v2 ekvivalent zelený ve smoke |

### D — Contract / smazat (po zapečení cutoveru)
| # | Jednotka | Co |
|---|---|---|
| D1 | Smazat service barrels | `services/*/ui/src/*` re-exporty (jinak build break) |
| D2 | Smazat `src/pages/*` (22) + `--`/`--c-` token soubory + `Layout.jsx` | |
| D3 | Smazat mrtvý test debt | ~10 `/priprava` e2e specs + v1 page specs (nahradit v2 smoke, ne jen smazat) |
| D4 | Ratchet update (stejný PR) | `no_deleted_pages`, `page_loc_ceiling`, `ui-page-needs-smoke-row`, a11y route list → přesměrovat na `src/v2/pages` |

## Quality gate (každý PR jednotky)
Playwright smoke (goto + headline + klíčová interakce) · screenshot light+dark
(`data-testid=v2-theme-toggle`) · no console error (console-guard fixture) ·
0 critical axe · v2 page ≤ 800 LOC (split do `src/v2/components/`).

## Rizika
1. **P4 CampaignDetail** — run/pause proxuje na Go + direct-DB fallback, gated
   preflight + `X-Confirm-Send`. Mis-port = neguarded reálný send. Port gate verbatim.
2. **Service barrels** — `@hozan/*-ui` re-exportují zpět do `src/pages/*`. Mazat barrels PRVNÍ (D1 před D2).
3. **Token-coupled v1 komponenty** — child taby čtou `--`/`--c-`/inline px, nedědí do `.v2-app`. Re-tokenize, nereuse.
4. **Ratchet whiplash** — `page_loc_ceiling`/`ui-page-needs-smoke-row` pinnuté na `src/pages`; zčervenají při vyprázdnění → repoint ve stejném PR.

## Pořadí
**R1 → R2 → A1-A4 → P8 → P2 → P1 → P3 → P5 → P6 → P7 → P4 → C1 → D1-D4.**
(R první = opravit co je rozbité; A scaffolding; pak porty od nejlehčích/nejhodnotnějších; P4 nejtěžší předposlední; cutover až vše žije; delete naposled.)

## Závislosti
#1585 (dns-audit 2 cesty) + #1321 (DNS UI) blokují P6 plnou paritu.
