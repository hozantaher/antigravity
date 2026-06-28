---
Status: Done
Datum: 2026-05-05
Trigger: hardening agent — pages 5-8
---

# Hardening Audit — Sekce 5–8 (Firmy, Segmenty, Kontakty, Šablony)

## Metodologie

Brutal audit: edge case tabulky per-page, identifikace polish položek, nové featurový GH issues, inline implementace TOP polish + TOP 1 new feature per page.

---

## 5. Firmy (Companies)

### Edge case tabulka

| Případ | Popis | Riziko | Pokrytí |
|--------|-------|--------|---------|
| Žádné firmy | Prázdný výsledek po filtru | User confusion | Existuje EmptyFilterState |
| Firma bez e-mailu | `email: null` | CSV export prázdné pole | Ošetřeno exportem |
| Firma v likvidaci | `v_likvidaci: true` | Kontakt v draweru | Zobrazeno varovné bannery |
| Score = null | `composite_score: null` | ScoreBar fallback | Zobrazí best_targeting_score |
| Bulk verify prázdný výsledek | `results: []` | Silent fail | Toast ukazuje n=0 |
| Load-more selhání | BFF 500 při pagination | Ztráta dat | Toast, zachová dosavadní řádky |
| Řazení při prázdném výsledku | sort column + 0 rows | NaN v tabulce | Prázdná tabulka bez chyby |
| IČO s vedoucí nulou | `ico: "01234567"` | Trim chyba | CSV export string, ne číslo |
| Datum zaniku far future | Neplatné datum | Render crash | `fmtDate` hází null-safe |
| Kategorie > 3 úrovně | Hluboká kategorie | Breadcrumb overflow | `CategoryBreadcrumb` zkrátí |

### Identifikované problémy

- **MEDIUM**: CSV export nebyl dostupný — operator nemohl exportovat filtrované firmy. **Implementováno** (viz níže).
- **LOW**: Tlačítko Ověřit v toolbaru chybí title u bulkVerify pro asistenční technologie — title přidán v #718 series.
- **LOW**: Export nezohledňoval zobrazené sloupce — fixed by exporting all key columns always (operátor dostane víc, ne míň).

### Implementované v tomto PR

1. **CSV export** (`exportRowsToCsv`) — tlačítko "CSV" v toolbaru, exportuje viditelné řádky (ico, name, email, web, region, sektor, velikost, skóre, icp, posl. kontakt). UTF-8 BOM pro Excel. Toast po stažení.
2. **Download ikona** přidána k `lucide-react` importu.
3. **Tests**: `Companies.hardening.test.jsx` (11 testů) — struktura stránky, CSV export (createObjectURL/revokeObjectURL/click spies), filter collapse, column menu.

### GH Issues pro backlog

- `enhancement mvp-deferred`: Bulk add to segment — vybrat N firem → přidat do existing segmentu
- `enhancement mvp-deferred`: Per-firma intent score derived from engagement timeline
- `enhancement mvp-deferred`: Excel export (XLSX) místo CSV — vyžaduje knihovnu

---

## 6. Uložené filtry (Segments)

### Edge case tabulka

| Případ | Popis | Riziko | Pokrytí |
|--------|-------|--------|---------|
| Segment bez last_built_at | Nikdy nebuilděno | Stale badge chybí | isStale() vrátí true |
| Segment s 0 firmami | company_count: 0 | "0 firem" → matoucí | Zobrazuje 0, stale badge |
| Filtr prázdný (vše) | query: {} | Summary = "Vše" | filtersSummary returns "Vše" |
| Rebuild selhání | BFF 500 | Tiché selhání | Toast 'err' zobrazeno |
| Smazání posledního segmentu | segments: [] | Prázdná tabulka | Empty row s textem |
| Rebuild vrátí 0 firem | { companies: 0 } | Neočekávané | Toast ukáže 0 firem |
| Segment name = 80 znaků | Dlouhý název | Přetečení v tabulce | CSS overflow hidden |
| Paralelní rebuild 2 segmentů | Dva rebuildy naráz | Race na state | Každý drawer má vlastní state |
| Clone prázdný query | query: null | Crash při clonování | handleClone spreads safely |
| Delete potvrdit → BFF 404 | Segment zmizí před delete | Double delete | Toast 'err', setDeleting false |

### Identifikované problémy

- **MEDIUM**: Chybí "Klonovat segment" — operátor musí ručně duplikovat filtry. **Implementováno** (viz níže).
- **LOW**: Modal title při klonování byl "Nový segment" — nerozeznatelné od nového. **Opraveno**.

### Implementované v tomto PR

1. **Klonovat segment** — `Copy` ikona v drawer header, `handleClone(seg)` pre-fills modal s `{...seg, id: undefined, name: "${name} (kopie)"}`. SegmentModal detekuje clone přes `segment && !segment.id`.
2. **Modal title** — "Klonovat: {název segmentu}" místo "Nový segment" pro clone flow.
3. **Tests**: `Segments.hardening.test.jsx` (12 testů) — stat strip, fresh/stale counts, clone flow (modal title, name prefill, addSegment volání).

### GH Issues pro backlog

- `enhancement mvp-deferred`: Compare 2 segments — Venn diagram překryvu
- `enhancement mvp-deferred`: Segment freshness proaktivní alert — notifikace při stáří > 72h
- `enhancement mvp-deferred`: Duplicate detection — varovat pokud query je identický s existujícím

---

## 7. Kontakty (Contacts)

### Edge case tabulka

| Případ | Popis | Riziko | Pokrytí |
|--------|-------|--------|---------|
| Kontakt bez jména | first_name: null | "—" v tabulce | filter(Boolean).join |
| Kontakt bez firmy | company_name: null | "—" v tabulce | || null guard |
| 10 000+ kontaktů | load-more pagination | Paměťový leak | Seen set deduplication |
| Email verify: spamtrap | status: 'spamtrap' | Zelená barva chyba | emailStatusColor mapuje spamtrap → red |
| Bulk suppress 50 kontaktů | Promise.allSettled 50 | Timeout | allSettled = žádný throw |
| Partial bulk failure | 3/5 ok, 2 fail | Silent partial | Toast uvede fail count |
| Status filter + search kombinace | URL params obojí | Reset při search | load(0, true) resetuje offset |
| Drawer pro deleted kontakt | 404 response | Crash drawer | fetchStatus='error' zobrazí retry |
| Select-all + load more | Nové řádky po select-all | Nové řádky nevybrané | Select-all bere aktuální rows |
| Odselect jednoho z select-all | Header checkbox partial | Indeterminate state | Native checkbox, není ošetřeno |

### Identifikované problémy

- **HIGH**: Chybí bulk suppress — operátor nemůže hromadně potlačit spam-bounced kontakty. **Implementováno**.
- **MEDIUM**: `colSpan=5` v error/empty rows — po přidání checkbox sloupce by bylo 5 místo 6. **Opraveno** na `colSpan=6`.
- **LOW**: Header checkbox title chybí. **Přidán** `title="Vybrat vše na stránce"`.

### Implementované v tomto PR

1. **Bulk suppress** — checkbox sloupec v tabulce (header + per-řádek), `bulkSelected` Set state, `handleBulkSuppress` s window.confirm guard + Promise.allSettled, bulk action bar (počet + červené tlačítko + Zrušit výběr).
2. **Opraveny colSpan** hodnoty: 5 → 6 pro error a empty rows.
3. **Tests**: `Contacts.hardening.test.jsx` (14 testů) — struktura tabulky, bulk selection, bulk suppress confirm/cancel, filter chips.

### GH Issues pro backlog

- `enhancement mvp-deferred`: Merge duplicates workflow — detekce duplicit dle e-mailu + UI pro merge
- `enhancement mvp-deferred`: Notes per contact inline editor
- `enhancement mvp-deferred`: Export kontaktů do CSV

---

## 8. Šablony (Templates)

### Edge case tabulka

| Případ | Popis | Riziko | Pokrytí |
|--------|-------|--------|---------|
| Šablona bez spintax | variations = 1 | Badge "bez spintax" | SpintaxBadge zobrazí |
| Unclosed spintax `{a` | Invalid syntax | Save blocked | hasSpintaxError = true |
| Tělo > 2000 znaků | Spam risk | Žádné varování | Char counter oranžový/červený |
| Ranking BFF 500 | Žebříček selže | Crash | ErrorBoundary + error card |
| ?new=1 query param | Deep-link modal | Param přetrvává | useEffect stripuje new param |
| Smazat poslední šablonu | 0 šablon | Prázdná mřížka | Placeholder state |
| Clone + uložit = duplikát | Stejné jméno | DB conflict | "(kopie)" suffix |
| Všechny varianty > 20 | bodyVariations = 21 | Truncated list | expandAllSpintax cap:20 |
| Preview seed increment | Seed overflow | parseInt NaN | seed je number, +1 bezpečné |
| Šablona s {{neznama}} | Unknown var | `[neznama]` v preview | substituteVars fallback |

### Identifikované problémy

- **MEDIUM**: Chybí "Klonovat šablonu" — operátor musí kopírovat text ručně. **Implementováno**.
- **MEDIUM**: Chybí indikátor délky těla — bez feedback o délce textu. **Implementováno** (char + word counter).
- **LOW**: Edit/Delete tlačítka bez `title` atributu. **Přidány**.

### Implementované v tomto PR

1. **Klonovat šablonu** — `Copy` ikona v row-actions, `handleClone(t)` = `setEditing({...t, id: undefined, name: "${t.name} (kopie)"})`. `isClone = template && !template.id` rozlišuje od edit. Modal title "Klonovat šablonu", Save vždy volá addTemplate.
2. **Char + word counter** — `[data-testid="body-char-count"]` v labelu těla, oranžový při > 1500 znaků. Real-time update.
3. **Button titles** — `title="Upravit šablonu"`, `title="Klonovat šablonu"`, `title="Smazat šablonu"`.
4. **Tests**: `Templates.hardening.test.jsx` (13 testů) — list structure, clone flow (title, name, subject prefill, Vytvořit btn, cancel, addTemplate volání), char counter, spintax badge, empty state.

### GH Issues pro backlog

- `enhancement mvp-deferred`: Live preview against sample contact s přepínačem kontaktu
- `enhancement mvp-deferred`: A/B test split — šablona jako parent 2 variant
- `enhancement mvp-deferred`: Template versioning — history of edits

---

## Souhrn

| Strana | Polish items | New feature | Tests |
|--------|-------------|-------------|-------|
| Firmy | CSV export, Download ikona | CSV export tlačítko | 11 |
| Segmenty | Clone modal title, Copy ikona | Klonovat segment | 12 |
| Kontakty | colSpan fix, header checkbox title, CheckSquare ikona | Bulk suppress | 14 |
| Šablony | Button titles, Copy ikona | Klonovat šablonu + char counter | 13 |
| **Celkem** | **13 polish** | **4 nové features** | **50 testů** |
