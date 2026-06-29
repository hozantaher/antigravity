# Chatwoot-style split-pane inbox pro Odpovědi

**Status:** active
**Vlastník:** Produkční raketa loop
**Datum založení:** 2026-05-31
**Datum uzavření:** —

## Kontext

Operátor tráví většinu času v Odpovědích — triáž příchozích odpovědí na hot
leady (odpověď → vozidlo). Dnešní tok je **seznam → klik na řádek → celostránkový
`/replies/:id` → zpět → další**. Každé otevření znamená navigaci pryč ze seznamu,
ztrátu scroll pozice a kontextu, a návrat.

Inspirace Chatwoot (shared inbox): **tři sloupce na jedné obrazovce** — vlevo
seznam konverzací, uprostřed vlákno vybrané konverzace, vpravo kontext panel
(firma / kontakt / vozidlo / kampaň). Operátor přepíná mezi vlákny šipkami/j-k
bez navigace pryč; kontext je vždy po ruce.

Tohle je největší zbývající UX win, ale je to redesign **denně-kritického
surface** — nesmí se rozbít stávající tok (bulk akce, filtry, klávesové zkratky,
deep-linky). Proto fázovaně: každá fáze je samostatně shippable + brutálně
otestovaná + nerozbíjí předchozí stav. Žádný blind rewrite.

## Co už máme (deep inventory 2026-05-31)

- **Seznam** `RepliesTable` (563 ř.): avatar + sender + subject + body-snippet
  preview + hover-preview. Řádek-klik → `navigate('/replies/:id')` (Replies.jsx:673).
- **Vlákno** `ThreadDetail` (pages/ThreadDetail.jsx): čte `id` z `useParams()`
  (route-coupled) — kontext panel vpravo už existuje (Firma/CRM/Zdrojová odpověď,
  viz minulé screenshoty). Je to fakticky 2-pane stránka, jen ne vedle seznamu.
- **Klávesnice** `useRepliesShortcuts`: už má `j`/`k` (+ šipky) navigaci v seznamu,
  `[`/`]` stránkování, `?` nápověda — Chatwoot-like základ hotový.
- **Selection** `selectedIds` infra pro bulk akce (oddělené od řádek-kliku).

→ Architektura je blízko Chatwoot patternu; chybí hlavně **vedle-sebe layout** a
odpojení `ThreadDetail` od routy, aby šel vykreslit inline.

## Cíle (měřitelné)

- Na širokém viewportu (≥ ~1100px) `/replies` ukáže seznam vlevo + vybrané vlákno
  vpravo, bez navigace pryč; výběr řádku / `j`-`k` mění pravý panel.
- Na úzkém viewportu zůstává stávající celostránkový `/replies/:id` (žádná
  regrese na mobilu).
- Deep-link `/replies/:id` funguje dál (otevře split-pane s předvybraným vláknem
  na širokém, celostránku na úzkém).
- Klidné loading/empty/error stavy v pravém panelu, nikdy falešná 0.
- Žádná regrese: bulk akce, filtry, stránkování, klávesové zkratky, smoke testy.

## Plán (fáze — každá = jeden reviewable commit s důkazem)

### Fáze 1 — `ThreadDetail` ovladatelný propem (enabler) ✅ HOTOVO (commit 7af7f7c0)
- [x] `ThreadDetailInner` přijme volitelný prop `replyId`; když chybí, fallback na
  `useParams()` (stávající chování beze změny).
- [ ] `embedded` prop (skrýt back/PageHead, zúžit padding) — odloženo na Fázi 3
  (back-button v panelu navigující na /replies = funkční "zavřít").
- [x] Unit: render z propu i z routy (ThreadDetail.test 14→16).

### Fáze 2 — split-pane layout na `/replies` (širký viewport) ✅ HOTOVO
- [x] `useMediaQuery('(min-width:1100px)')` přepínač: ≥1100px → dvousloupec
  (seznam vlevo ~min(46%,560px) | `<ThreadDetail replyId={active}/>` vpravo),
  jinak stávající celostránka.
- [x] Řádek-klik / Enter / O na širokém: `openReply(id)` → `setActiveId` (lokální
  state); na úzkém: stávající `navigate('/replies/:id')`. (URL `?id=` deep-link
  v split modu odloženo na Fázi 3 — vyhnutí se konfliktu s useRepliesUrlState.)
- [x] Otevřený řádek zvýrazněn (RepliesTableRow `isActive`).
- [x] Prázdný pravý panel: "Vyber odpověď vlevo pro zobrazení vlákna."
- [x] Playwright dark+light ověřeno: wide → split + klik mění panel + seznam drží
  + 0 console errors; narrow → celostránka /replies/:id. RepliesTableRow onOpen
  unit guard. 27 replies test souborů zelených (288 pass).
- Mitigace: localStorage flag `inboxSplitPane` (`'off'` vypne bez deploye); úzký
  viewport fallback; failed-sends panel se nesplituje.

### Fáze 3 — URL deep-link + auto-open j/k + embedded chrome ✅ HOTOVO
- [x] `?id=` v URL (refresh + share drží otevřené vlákno; merge s ostatními params).
- [x] j/k auto-otevírá další vlákno v split modu (selected=activeId).
- [x] ThreadDetail `embedded`+`onClose`: back čistí `?id` (ne navigace pryč), tighter padding/maxWidth pro panel.
- [x] E2E: deep-link ?id → vlákno v panelu, narrow ignoruje ?id, 0 console errors; 290 replies testů zelených.

### Fáze 3b — kontext jako třetí sloupec (volitelné rozšíření)
- [ ] Na velmi širokém (≥1500px) rozdělit prostřední vlákno a pravý kontext
  (Firma/Vozidlo/Kampaň) do tří sloupců à la Chatwoot. Jinak kontext zůstává pod/
  v rámci vlákna.
- [ ] Rychlé akce z panelu: "Zapsat vozidlo", "Předat CRM", klasifikace —
  deterministické zápisy, LLM jen návrh (operátor-confirm).

### Fáze 4 — leštění + contract (probíhá)
- [x] List-column density: split-pane `compact` mode skryje Kampaň sloupec
  (je v thread kontextu) → sender + subject čitelné v úzkém ~560px sloupci.
- [ ] Konzistentní typografie/spacing s Claude-app klidem; přechody panelů.
- [ ] Embedded thread: collapsed context-sidebar default (méně sloupců v split).
- [ ] A11y: focus management při přepnutí vlákna, aria-live pro pravý panel.

## Blokátory

- Žádné technické. ThreadDetail je už komponenta, seznam má selection+klávesy.

## Log

- 2026-05-31: Iniciativa založena. Deep inventory potvrdil, že architektura je
  blízko Chatwoot patternu (ThreadDetail = 2-pane stránka, seznam má j/k). Hlavní
  práce = odpojit ThreadDetail od routy (Fáze 1) + vedle-sebe layout (Fáze 2).
  Předchozí ticky vyčistily UX defekty (false-0, thread 500, breadcrumby,
  Analytics honesty) → surface je stabilní základ pro redesign.
- 2026-05-31: Fáze 1 + Fáze 2 HOTOVO v jednom tahu (operátor: "měj větší plány,
  nedrbej se v detailech"). /replies na širokém viewportu je teď Chatwoot
  split-pane: seznam vlevo, vybrané vlákno + kontext + Ollama AI-návrh odpovědi
  + composer vpravo, vše na jedné obrazovce; klik/Enter mění panel bez navigace;
  úzký viewport beze změny. Zbývá Fáze 3 (3. sloupec kontextu na ≥1500px, URL
  deep-link, embedded chrome) + Fáze 4 (leštění typografie/spacing, a11y focus).
- 2026-05-31: Fáze 4 (částečně) — compact list pro split mode. Při 560px byl
  seznam hutný (Kampaň 140px sloupec dusil sender/subject). `compact` prop na
  RepliesTable/Header/Row skryje Kampaň v split modu (kampaň je vidět v thread
  kontextu vpravo). Sender + subject teď čitelné. Header+Row compact testy.
  Zbývá: collapsed context-sidebar v embedded, typografie polish, a11y focus.
