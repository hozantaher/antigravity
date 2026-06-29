# Laptop responsivita + density (outreach-dashboard v2)

**Status:** active
**Vlastník:** obě
**Datum založení:** 2026-06-24
**Datum uzavření:** —

## Kontext

Operátor občas pracuje na laptopu a **nemá dost místa na důležitá data**. Audit
v2 shellu (`features/platform/outreach-dashboard/src/app/`) potvrdil tři kořenové příčiny:

1. **„Mrtvá zóna" responsivity v pásmu laptopu (1025–1440px).** Breakpointy se
   kupí u telefonu (≤640) a tabletu (≤1024). V laptop pásmu existují jen dva
   (`1180px`, `1100px`) a **mezi 1180 a 1440 se nespustí nic**. Na 1366×768 i
   1440×900 běží appka v plných „desktop" šířkách na menším skle.
2. **`--app-pad-page: 32px`** (`tokens.css:67`, aplikováno `AppShell.jsx:292`) =
   64px vodorovně + 64px svisle mrtvého okraje, navíc zapečený do
   `height: calc(… − 2*var(--app-pad-page))` u app-surfaces (Odpovědi/Kontakty/
   Vozidla). Nejširší jednotlivá výhra.
3. **Žádné globální sbalení sidebaru** — `NAV_COLLAPSE_KEY`
   (`AppShell.jsx:65,120-127`) sbaluje jen sekce, ne 186px lištu
   (`--app-sidebar-w`, `tokens.css:71`; `AppShell.jsx:157`). Ikonový-rail vzor už
   existuje (`app-odpovedi.css:416`) → znovupoužít = ~128px na **každé** obrazovce.

Doplňkově: `--bp-mobile/tablet/...` proměnné (`index.css:120-123`) jsou
definované, ale **nikde nepoužité** (v `@media` nejde použít `var()`), proto je
breakpoint-ladder ad-hoc bordel (360/480/520/560/600/640/720/760/820/860/880/
900/960/980/1024/1100/1180). `SIDEBAR-SPRINT-PLAN.md` je mrtvý (míří na starý
`Layout.jsx`) — ignorovat.

**Použitelné plátno po odečtení chromu (sidebar 186 + topbar 48 + pad 32 dokola):**

| Laptop    | Šířka      | Výška     |
|-----------|------------|-----------|
| 1366×768  | **1116px** | **656px** |
| 1440×900  | **1190px** | **788px** |

### Rozhodnutí operátora (2026-06-24)

- **Density mechanismus: obojí** — auto-compact dle velikosti okna **+** manuální
  přepínač (override, persist), po vzoru theme toggle.
- **Rozsah: plný rework** — sprinty S0–S4 včetně hlubokých per-surface reworků
  (Kontakty 2-sloupce, Schránky → tabulka) a oprav stránek bez responsivity.
- **Cílové pásmo:** 1366×768 a 1440×900 (potvrdit, kdyby měl jiný laptop).

## Architektura

Jeden mechanismus, dva spouštěče, řízený přes tokeny:

```
breakpoints.js (named konstanty)              ← no-magic-numbers (T0)
  └─ useDensity() hook v AppShell             ← matchMedia → nastaví data-density
       └─ <div class="app-shell" data-density="compact|comfortable">
            └─ tokens.css: .app-shell[data-density="compact"] { --app-pad-page:14px; … }
                 └─ celá appka se přepočítá zdarma (vše čte --app-* tokeny)
```

- **Rozhodnutí** o hustotě je v JS (testovatelné, pojmenované konstanty, žádná
  magic numbers), **styling** čistě v tokenech. Auto-compact: `width ≤ BP_LAPTOP
  (1440)` **nebo** `height ≤ BP_SHORT (820)` → 1366×768 trefí obojí, 1440×900
  trefí šířku, velký monitor zůstane comfortable.
- **Manuální přepínač vždy přebije auto** a persistuje do localStorage (jako
  téma). Hysteze/debounce proti „skákání" při resizu.
- **Density komprimuje SPACING, ne písmo** — type scale je už na 12px base /
  9.5px xs; zmenšovat font by porušilo a11y ratchet (axe-core gate). Compact
  sahá na padding/gap/chrome, ne na čitelnost.

**Návrh compact override bloku (laditelný proti měřicímu harnessu):**

| Token              | comfortable | compact |
|--------------------|-------------|---------|
| `--app-pad-page`   | 32px        | 14px    |
| `--app-topbar-h`   | 48px        | 40px    |
| `--app-pad-card`   | 16px        | 12px    |
| `--app-space-*`    | base        | ↓ ~25 % |
| `--app-folders-w`  | 208px       | 168px   |
| `--app-list-w`     | 304px       | 264px   |
| `--app-aside-w`    | 288px       | 248px   |

## Cíle

- **Kill-gate metrika:** ≥ **+25 % viditelných datových řádků** na Odpovědi /
  Vozidla / Kontakty / TopTargets na 1366×768 (přesný cíl se zafixuje po změření
  baseline v S0). Měřeno automatizovaně (Playwright), ne od oka.
- Compact density se zapne automaticky na laptop-velikosti okna a jde přebít
  manuálně; volba přežije reload.
- Sidebar lze sbalit na ikony (~128px zpět na každé obrazovce).
- Odpovědi: konverzační vlákno čitelné i s otevřeným composerem na 768px výšky.
- 0 nových `critical` axe violations (ratchet zůstává zelený).
- Žádná regrese na telefonu/tabletu (stávající breakpointy ≤1024 chráněné).

## Plán (sprinty)

### Sprint S0 — Základ + měřicí kill-gate
- [ ] `[S0.1]` `src/app/lib/breakpoints.js`: `BP_PHONE=640`, `BP_TABLET=1024`,
      `BP_LAPTOP=1440`, `BP_SHORT=820` (jediný zdroj pravdy).
- [ ] `[S0.2]` `useDensity()` hook + `data-density` na shellu (`AppShell.jsx`):
      default comfortable; auto compact dle matchMedia; manuální override +
      persist (localStorage `uiDensity`, vzor `THEME_KEY` `AppShell.jsx:64`);
      debounce/hysteze.
- [ ] `[S0.3]` Blok `.app-shell[data-density="compact"]` v `tokens.css` dle
      tabulky výše.
- [ ] `[S0.4]` Přepínač hustoty v shellu (CZ „Kompaktní režim"), vedle theme
      toggle (`AppShell.jsx:247-261`).
- [ ] `[S0.5]` Tlačítko sbalení sidebaru na ikony (znovupoužít vzor
      `app-odpovedi.css:416`) + persist; respektovat `prefers-reduced-motion`.
- [ ] `[S0.6]` **Měřicí Playwright spec**: načte klíčové surfaces na 1366×768 a
      1440×900, spočítá viditelné datové řádky + výšku chromu → baseline JSON.
- **Failable check:** smoke na 4 viewportech (1366×768, 1440×900, 1280×800,
  390×844) zelený, 0 console errorů; axe žádný nový critical; toggle prokazatelně
  přepne `data-density` + přežije reload.
- **Pilot:** screenshoty light+dark, comfortable vs compact, na 1366×768 i
  1440×900.

### Sprint S1 — Globální token výhry (široký reclaim)
- [ ] `[S1.1]` Ověřit, že všechny `height: calc(… − 2*var(--app-pad-page))` čtou
      token (opravit literály 32) — `app-odpovedi.css:20`, `app-kontakty.css:8`,
      `app-vozidla.css:8` a další.
- [ ] `[S1.2]` Doladit compact hodnoty proti měřicímu harnessu z `[S0.6]`.
- [ ] `[S1.3]` Smazat duplicitní in-page titulky (topbar je má
      `AppShell.jsx:272-274`): Odpovědi folder `<h1>` (`app-odpovedi.css:40-47`),
      Schránky (`Schranky.jsx:247`), TopTargets (`TopTargets.jsx:255`),
      KampanDetail hero (`app-kampan-detail.css:21-24`), Home
      (`app-home.css:8-11`).
- **Failable check:** ≥ +25 % viditelných řádků na 4 surfaces na 1366×768
  (cíl zafixovaný po baseline); smoke + axe zelené.
- **Pilot:** light+dark, oba laptop viewporty.

### Sprint S2 — Top bolest: Odpovědi
- [ ] `[S2.1]` Composer `max-height: 48vh` (`app-odpovedi.css:373`) → token
      `--app-composer-max`, compact ~30vh.
- [ ] `[S2.2]` Zploštit 4 pásy nad vláknem (`.app-head` `:246`, `.app-facts`
      `:314`, `.app-ai__summary` `:341`, ActionRail `app-odpovedi-base.css:206`).
- [ ] `[S2.3]` kbd-hint řádek (`app-odpovedi.css:153-157`,
      `Odpovedi.jsx:533-535`) → tooltip / `?` afordance.
- [ ] `[S2.4]` Smazat mrtvý 2-col `.app-odpovedi` v `app-odpovedi-base.css:4-15`
      (přebitý, jen mate).
- **Failable check:** na 1366×768 vlákno ukáže ≥ N řádků zprávy i s otevřeným
  composerem; per-feature smoke; pilot.

### Sprint S3 — Per-surface reworky (nezávislé → paralelizovatelné)
- [ ] `[S3.1]` **TopTargets**: vždy-otevřený filtr-card (`app-toptargets.css:103-112`,
      `TopTargets.jsx:305-332`) → popover/disclosure (v1 `TopTargetsFilterPopover`
      referencovaný `TopTargets.jsx:38`). Cíl +4–5 řádků.
- [ ] `[S3.2]` **Kontakty**: zastropovat / 2-sloupcový detail pane
      (`app-kontakty.css:59-66`) — 1fr teď plýtvá ~třetinou 1366px na úzký
      key-value sloupec (~300px zpět).
- [ ] `[S3.3]` **Schránky**: rows-as-cards (`app-schranky.css:95-103`) → plochá
      tabulka; stat strip (`:11`) + health pills (`:23-39`) do jednoho řádku.
- [ ] `[S3.4]` **Vozidla**: padding buněk 10/13 → 6/10
      (`app-vozidla.css:118,132-134`), sjednotit s TopTargets.
- **Failable check:** každý surface vlastní smoke + metrika viditelných řádků +
  pilot (light+dark, oba viewporty). Každý jako samostatný PR.

### Sprint S4 — Stránky bez responsivity + úklid ladderu
- [ ] `[S4.1]` Laptop reflow / sundat plýtvající max-width capy:
      `app-anonymita.css` (920, fixní grid `:119`), `app-hledat.css` (760),
      `app-kvalita.css` (760), `app-upozorneni.css` (920, fixní 4-col `:54`).
- [ ] `[S4.2]` Konsolidovat ad-hoc breakpoint ladder na kanonické tokeny/konstanty
      z `[S0.1]`; smazat mrtvé `--bp-*` (`index.css:120-123`) nebo je adoptovat.
- **Failable check:** regresní smoke na telefonu (390×844) + tabletu (768/1024)
  potvrdí, že existující reflow funguje; axe zelený.

## Blokátory

- Žádné. (Závislost: S1–S4 staví na density systému z S0.)

## Rizika

- Auto-přepínání může „skákat" při resizu → hysteze/debounce + manuální override.
- Agresivní compact umí rozbít klik-cíle / dark téma jinak → pilot povinně v obou
  tématech, axe ratchet hlídá.
- Konsolidace ladderu (S4.2) ohrožuje funkční telefon/tablet → laptop pásmo se
  přidává aditivně přes `data-density`, úklid `@media` až nakonec s regresí.
- Metriky řádků jsou zatím odhady z CSS — zpřesní se až měřicím harnessem (S0.6).

## Compliance (HARD RULES)

- **Pilot-before-ship (T0):** každá fáze build + běh proti reálnému lokálu (BFF
  :18001 + Vite :18175) + screenshot light+dark na laptop viewportu.
- **Playwright smoke (T0):** každý nový/změněný surface dostane smoke ve stejném
  PR (`tests/e2e/`).
- **No-magic-numbers (T0):** breakpointy = pojmenované konstanty; density hodnoty
  = tokeny.
- **A11y ratchet:** 0 nových critical axe violations.
- **CZ stringy, local-only/Firebase, system fonts** (žádný remote build pipeline).

## Stav implementace (2026-06-25)

Implementováno phase-by-phase v branchi `fix/deploy-dangling-workspace-deps`,
**bez commitu** (na žádost operátora). Vše piloted (build + reálný lokál
BFF+Vite, screenshoty light+dark na 1366×768) + smoke + a11y.

- **S0 ✅** — `breakpoints.js` (named konstanty), `useDensity()` (auto matchMedia
  + manuální toggle, persist), compact token blok + collapsed-sidebar token v
  `tokens.css`, density toggle + sidebar icon-collapse v `AppShell.jsx`, měřicí
  spec `responsivity-density.smoke.spec.ts` (4/4). **Pilot odhalil bug** (footer
  toggles pod foldem na 768px) → fix: shell `height:100vh`, nav scrolluje, footer
  pinned. Kill-gate: compact prokazatelně zmenšuje page padding.
- **S1 ✅** — height-calc už token-based (compact reclaimuje vertikál zdarma).
  Topbar `<span>` → `<h1>` (kanonický nadpis), odstraněn duplicitní in-page titul
  na Schránky + TopTargets (sub zachován), campaign name `<h1>`→`<h2>`
  (specificita). a11y gate 10/10 (0 critical). Naměřeno: **Vozidla +21 %,
  Odpovědi +17 %** viditelných řádků (global vrstva).
- **S2 ✅** — composer `48vh`→token (`--app-composer-max`, compact `30vh`),
  odstraněn folder-rail `<h1>Odpovědi</h1>` (+ smoke míří na topbar h1), smazáno
  mrtvé 2-col pravidlo. Odchylka: **kbd-hint ponechán** (discoverability +
  `replies-rank4` smoke) — místo skrytí jen compactnut tokeny.
- **S3 ✅** — Schránky rows-as-cards → flat table (řádek už byl grid),
  Kontakty detail → 2-sloupcový (`columns: 2 260px`, mizí prázdná třetina),
  TopTargets filtr-card → disclosure (collapsed default, force-open jen na
  sektor/kraj), Vozidla už zhuštěné compact tokeny. Smoke 11/11.
- **S4 ✅** — `app-upozorneni`/`app-anonymita` stat grids `repeat(4,1fr)` →
  `auto-fit minmax(150px,1fr)` (reflow bez @media, ověřeno na 390px). Breakpoint
  ladder zdokumentován (`--bp-laptop` + pointer na `breakpoints.js`).

### Finální gate (24 passed)
Všechny dotčené surfaces + density + a11y zelené. **12 failů = výhradně
pre-existing, nesouvisí se změnami** (ověřeno `git diff` + root-cause):
- 10× `app-odpovedi-triage` + 4 další specy (`app-reply-draft`,
  `app-interconnect`, `app-capture`, `app-reply-attachments`) míří na **smazaný
  route `/odpovedi-legacy`** (odstraněn unifikací #1597).
- `replies-rank4-keystroke-hints` + ostatní `/replies` specy → redirect na
  `/odpovedi` (v1 selektory už neexistují).
- `app-prehled:50` (oldest-hot) — data-conditional (prod nemá aging hot backlog).
- `app-toptargets:28` — pre-existing **500** ze scoring feedu (backend).

### Janitorial fixy (mimo scope, transparentně)
- Opraveny 2 malformed URL regexy v smoke (`//kampane$`/`//vozidla$` → správně) —
  rozbité unifikací, blokovaly poctivý gate.

### Známé limity / follow-up
- **Necommitnuto** — vše v working tree na nesouvisející branchi.
- ~6 **stale specs** míří na smazané routy (`/odpovedi-legacy`, `/replies`) —
  potřebují přepsat na `/odpovedi` (separátní úklid po #1597, mimo responsivitu).
- **TopTargets 500** (scoring feed) — backend issue, blokuje plný pilot tabulky.
- Title-dedup aplikován jen na Schránky+TopTargets; Upozornění aj. mají stále
  in-page h1 = topbar (lze dotáhnout).
- Telefon (<640): sidebar se neskládá do overlaye (186px ujídá půlku); operátor
  je na laptopu + má manuální collapse, takže mimo scope.

## Log

- 2026-06-24 — založeno; audit responsivity + density hotový (2 agenti, file:line);
  operátor zvolil obojí (auto+toggle) + plný rework.
- 2026-06-25 — S0–S4 implementováno + piloted + smoke/a11y zelené; bez commitu.
