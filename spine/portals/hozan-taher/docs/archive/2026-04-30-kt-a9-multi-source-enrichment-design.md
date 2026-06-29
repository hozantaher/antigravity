# Sprint KT-A9 — Když ARES mlčí, zeptáme se firmy.cz; když firmy.cz mlčí, zeptáme se justice.cz

> **Status:** Design draft 2026-04-30. Kód v tomto sprintu nevzniká, jen plán. Předchůdci: KT-A7 (proxy rotation) + KT-A8 (block detection), navazuje sprint KT-A10.

---

## 1. Aktuální stav

Naše enrichment vrstva (`features/acquisition/contacts/enrichment/pipeline.go`) dnes ví o jednom autoritativním zdroji — **ARES**. `Pipeline.Enrich` pro každý kontakt s ICO zavolá `ares.Client.FetchSubject(ico)`, parsuje `SubjectData`, a doplní firmu o jméno, sídlo, NACE, právní formu. Pokud ARES vrátí `nil` (404 — ICO neexistuje), kontakt se označí příznakem `enrichment_status='not_found'` a pipeline pokračuje. Pokud ARES vrátí error (po vyčerpání retry), kontakt zůstane bez enrichmentu a pipeline ho příště zkusí znovu (dnes po několika hodinách).

firmy.cz scraper (`features/acquisition/scrapers/scrapers/firmy-cz/`) je dnes **úplně oddělený** systém. Má vlastní queue, vlastní DB tabulku `firmy_cz_businesses`, vlastní worker. Když dokončí scrape, data zůstanou ve své tabulce a **enrichment pipeline o nich neví**. Pokud kontakt přišel z ARES bez emailu (ARES email nemá, je to právní registr), enrichment skončí s `email IS NULL` a kontakt jde na bypass. Mezitím ve `firmy_cz_businesses` může ležet tatáž firma s validním emailem, vyparsovaným z mailto: linku — ale tahle vrstva spolu nemluví.

`features/acquisition/scrapers/scrapers/firmy-cz/scraper.ts` umí extrahovat: `name`, `description`, `website`, `telephone`, `email` (z mailto linků), `street_address`, `address_locality`, `postal_code`, `ico`, `datova_schranka`, `datum_zapisu`, `pravni_forma`, `velikost_firmy`, kategorie, otevírací doba, fotky. ARES naopak má autoritativní data o **právní existenci firmy** (IČO, DIČ, datum vzniku, sídlo, OKEC kódy = NACE, statutární orgán), ale **nemá kontaktní údaje** (žádný email, žádný telefon, žádný web).

V praxi tedy potřebujeme **kombinaci dvou zdrojů, ne výběr jednoho**:

- ARES — autoritativní pro identifikační údaje (IČO, DIČ, právní forma, datum vzniku, sídlo dle obchodního rejstříku, NACE/OKEC kódy).
- firmy.cz — autoritativní pro kontaktní údaje (web, email, telefon, otevírací doba, počet zaměstnanců odhad).

A když oba selžou nebo si protiřečí v jednom poli, je třeba mít definovanou **prioritu rozhodnutí** + audit, který zdroj data dodal.

V `features/acquisition/contacts/enrichment/CLAUDE.md` (resp. v hot-file komentářích) je naznačeno, že tahle multi-source vrstva má vzniknout, ale dnes neexistuje. Kód předpokládá ARES jako jediný zdroj. KT-A8 (block detection) navíc otevírá scénář, kdy ARES je dočasně blokovaný — a my potřebujeme **degraded enrichment** z firmy.cz, ne celý kontakt zahodit.

## 2. Proč tento sprint

Tři reálné scénáře, které dnes ztrácí kontakty:

**Scénář první — kontakt přišel z firmy.cz, ICO není v ARES.** firmy.cz má v sobě i právnické osoby, které v ARES neexistují (zaniklé, převedené, OSVČ s neunikátním ICO). Dnes pipeline: ARES vrátí 404 → enrichment_status=not_found → contact označen jako neenrichovaný → kampaň ho v dotazu odfiltruje (předpokládá enrichment). **Ztrácíme reálný kontakt s emailem, protože nemáme záložní zdroj.**

**Scénář druhý — ARES má firmu, ale bez kontaktu, firmy.cz má email.** Typický B2B B2B kontakt — Garaaage chce posílat email majiteli stavební firmy. ARES vrátí: jméno firmy, sídlo, NACE 41.20 (stavebnictví), statutární orgán Petr Novák. firmy.cz vrátí pro stejnou firmu: email `info@petrnovak-stavby.cz`, web, telefon. Dnes enrichment skončí na ARES s `email IS NULL`, kampaň kontakt přeskočí. **Po KT-A9: po ARES success se zavolá firmy.cz lookup podle ICO, doplní se email + web + telefon. Kontakt jde do kampaně.**

**Scénář třetí — ARES dočasně blokovaný (KT-A8 detection).** ARES vrátí Cloudflare challenge, KT-A8 to detekuje, alt source je už vyčerpaný, kontakt nedostane primární data. Dnes: enrichment selže, contact zůstává bez dat. **Po KT-A9: pipeline zavolá firmy.cz jako fallback, dostane alespoň jméno + adresu + NACE (firmy.cz to taky má), označí `enrichment_source_used='firmy_cz_fallback'`, kampaň pokračuje.**

**Reálný příklad scénáře, který KT-A9 řeší:**

> Kontakt s ICO 12345678 dorazí do queue. Pipeline volá ARES → 404 (ICO není v rejstříku). Pipeline volá firmy.cz lookup → najde firmu „Stavby Novák s.r.o.“, web, email, NACE 41.20. Pipeline merguje: jméno z firmy.cz (jediný zdroj), sídlo z firmy.cz (jediný zdroj), email + web z firmy.cz. NACE z firmy.cz. `enrichment_source_used` = `firmy_cz_only`. Audit row v `enrichment_history`. Contact dostane status=enriched a vstoupí do kampaně.
>
> Kontakt s ICO 87654321: ARES → success (jméno, sídlo, NACE). firmy.cz → success (email, telefon). Conflict v `pravni_forma`: ARES říká `s.r.o.`, firmy.cz říká `Společnost s ručením omezeným`. Resolver: ARES je autoritativní pro právní formu, použije se ARES hodnota. Conflict v `address_postal_code`: ARES `110 00`, firmy.cz `11000`. Resolver: ARES autoritativní pro sídlo. `merge_conflicts_json` = `[{"field":"pravni_forma","ares":"s.r.o.","firmy_cz":"Společnost s ručením omezeným","resolved":"ares"},{"field":"postal_code","ares":"110 00","firmy_cz":"11000","resolved":"ares"}]`.

Cíl sprintu je **postavit abstrakci `EnrichmentSource`** s definovanou prioritou per pole, vyjasnit cesty fallback chain, a zlogovat každý zdroj použitý při enrichmentu pro audit (kdy přišla data z čeho a proč).

## 3. Návrh

### 3.1 Interface `EnrichmentSource`

V `features/acquisition/contacts/enrichment/source.go` vznikne malé Go interface:

```go
type EnrichmentSource interface {
    Name() string                                                     // "ares" | "firmy_cz" | "justice_cz"
    Lookup(ctx context.Context, ico string) (*CompanyData, error)     // nil + nil = not found
    Health() float64                                                   // 0..1, success rate posledních 50 fetchů
    Priority() int                                                     // nižší = vyšší priorita (ARES=1, firmy.cz=2, justice.cz=3)
}
```

Tři implementace:

- `ARESSource` — wrapuje stávající `ares.Client`. `Name()="ares"`, `Priority()=1`, `Health()` čte z KT-A7 health monitoru.
- `FirmyCZSource` — nový adapter, volá tenkou Go vrstvu (gRPC/HTTP) nad TS scraperem, nebo přímo dotaz do `firmy_cz_businesses` PG tabulky (kterou TS scraper plní). Pro tento sprint preferuji **přímý SQL dotaz** — TS scraper běží asynchronně a plní DB, Go enrichment čte. Žádný cross-language RPC volání. `Name()="firmy_cz"`, `Priority()=2`.
- `JusticeCZSource` — fallback, justice.cz/or.justice (Obchodní rejstřík) má veřejné HTML stránky se základními údaji. **Implementace stub-only v tomto sprintu** — vrátí vždy `nil, nil` (not found). Plná implementace je samostatný budoucí sprint nebo součást KT-A11+. Důvod: justice.cz parsing je mnohem fragilnější (HTML scraping, anti-bot) a v tomto sprintu nestihneme. Stub zajistí, že interface je hotový a nový zdroj se přidá změnou jednoho souboru.

### 3.2 Per-field priorita

Každý zdroj má svůj `CompanyData` payload. Při merge do unified `EnrichedCompany` pipeline aplikuje **per-field rozhodnutí**:

| Pole | Autoritativní zdroj | Důvod |
|---|---|---|
| `ico` | ARES | Definice ICO je jenom v ARES, firmy.cz ho přebírá |
| `dic` | ARES | DIČ má jen ARES |
| `name` | ARES > firmy.cz | ARES je oficiální obchodní jméno, firmy.cz může mít zkrácenou verzi |
| `pravni_forma` | ARES | Oficiální právní forma |
| `datum_vzniku` | ARES | Oficiální datum |
| `sidlo` (street/city/zip) | ARES | Sídlo z OR |
| `nace` | ARES > firmy.cz | OKEC kódy z ARES, kategorie z firmy.cz jako enrichment |
| `email` | firmy.cz | ARES email nemá |
| `phone` | firmy.cz | ARES telefon nemá |
| `website` | firmy.cz | ARES web nemá |
| `velikost_firmy` | firmy.cz | ARES počet zaměstnanců nemá |
| `datova_schranka` | ARES > firmy.cz | ARES je primární |
| `description` | firmy.cz | ARES popis nemá |

Logika merge:

1. Vezmi všechny zdroje seřazené podle `Priority()`.
2. Pro každé pole iteruj přes zdroje v pořadí. První zdroj, který má **non-empty hodnotu**, vyhrává.
3. Pokud zdroj autoritativní pro pole (per matrix výše) vrátí non-empty hodnotu, **pohlcuje konflikt** — zaloguje se, ale použije se autoritativní hodnota.
4. Pokud autoritativní zdroj vrátí empty, fallback na další zdroj v pořadí Priority.

### 3.3 Audit — `enrichment_history` tabulka

Nová tabulka (migrace 009 v `features/acquisition/contacts/migrations/`):

| Sloupec | Typ | Význam |
|---|---|---|
| `id` | bigserial | PK |
| `created_at` | timestamptz | čas enrichmentu |
| `contact_id` | bigint | FK do `contacts` |
| `ico` | text | ICO, které se hledalo |
| `sources_attempted` | text[] | např. `['ares', 'firmy_cz']` |
| `sources_success` | text[] | např. `['ares', 'firmy_cz']` (oba uspěly) nebo `['firmy_cz']` (jen fallback) |
| `merge_conflicts_json` | jsonb | pole konfliktů per pole (viz reálný příklad výše) |
| `enrichment_source_used` | text | dominant source: `ares_only`, `firmy_cz_only`, `merged`, `firmy_cz_fallback` |
| `duration_ms` | int | total enrichment time |

Tabulka je read-mostly pro audit. Jeden row per contact enrichment run. UI dashboard tab „Audit“ ji může zobrazit.

### 3.4 Fallback chain

Pipeline `Enrich(contact)`:

1. Spočítej kandidátní zdroje: filtr podle `Health() > 0.3` (zdroj s extrémně nízkou success rate se přeskočí), seřadit podle `Priority()`.
2. Iteruj zdroji v paralelní fan-out (max 2 paralelní volání — ARES + firmy.cz současně, justice.cz až jako fallback). Důvod paralelizmu: ARES má rate-limit 1 req/s, firmy.cz má vlastní rate-limit. Spustit oba paralelně šetří wall-clock time bez extra zátěže.
3. Sber výsledky. Pokud oba uspěly → merge per-field priority.
4. Pokud jen jeden uspěl → použij ten, nastav `enrichment_source_used='ares_only'` nebo `firmy_cz_only`.
5. Pokud žádný neuspěl a `Health(justice_cz) > 0` → spusť justice.cz lookup (sequenční fallback, justice je pomalý). Pokud justice.cz uspěje → použij. Pokud ne → contact `enrichment_status='not_found'`, INSERT history row s `sources_attempted=['ares','firmy_cz','justice_cz']`, `sources_success=[]`.
6. INSERT `enrichment_history` row vždy (i při full failure — pro audit „pokusili jsme se o tuto firmu třikrát“).

### 3.5 Block-aware integrace s KT-A8

KT-A8 umí detekovat, že ARES nebo firmy.cz je dočasně blokovaný. KT-A9 to využívá:

- `ARESSource.Health()` čte z KT-A7 health monitoru. Pokud ARES je v cooldownu (KT-A7), `Health()` vrátí 0.
- Pipeline `Enrich` při paralelní fan-out filtruje zdroje s `Health() == 0` před spuštěním. Šetří se zbytečné fetche.
- Pokud oba primární zdroje (ARES + firmy.cz) jsou dolů, pipeline okamžitě skočí na justice.cz fallback (i když má nízkou prioritu, je to lepší než nic).
- KT-A8 escalate event (oba zdroje blokované) emituje Sentry breadcrumb s tagem `enrichment_degraded=true`. Operátor vidí, že enrichment teď běží jen na fallback.

### 3.6 firmy.cz Source — SQL adapter

`FirmyCZSource.Lookup(ico)` SQL:

```sql
SELECT name, email, telephone, website, street_address, address_locality, postal_code,
       ico, pravni_forma, velikost_firmy, datova_schranka, category_path
FROM firmy_cz_businesses
WHERE ico = $1
  AND scraped_at > NOW() - INTERVAL '90 days'
ORDER BY scraped_at DESC
LIMIT 1;
```

Pokud row neexistuje, `Lookup` vrátí `nil, nil` (not found). Pipeline tím získává info „firmy.cz nás neumí pomoct s tímto ICO“ a fallbackuje. **Důležité:** `FirmyCZSource` v této verzi **neaktivuje scrape**, jen čte z předem nascrapovaných dat. Aktivní lookup (scrape on-demand) je samostatný budoucí sprint nebo součást KT-A10.

Tím se vyhneme problému „ICO 12345678 nikdy nebylo scrape-nuté → enrichment selže navždy“. Řešení: KT-A10 (refresh cron tuning) zajistí, že firmy.cz scraper kontinuálně doplňuje DB. Postupem času se cache zaplňuje a `Lookup` má vyšší hit rate.

## 4. Acceptance kritéria

- [ ] **Interface `EnrichmentSource` s 1+3 (stub) implementacemi** — `ARESSource`, `FirmyCZSource`, `JusticeCZSource` (stub). Interface respektuje konvenci „accept interfaces, return structs“ z Go pravidel.
- [ ] **Per-field merge resolver s definovanou matricí priority** — jednotková matrice `fieldAuthoritySource` v `merge.go`, table-driven test pro každé pole (15+ test cases pokrývajících empty/conflict/agreement varianty).
- [ ] **`enrichment_history` migrace nasazená** — tabulka existuje v dev + prod, INSERT se provádí pro každý enrichment run.
- [ ] **Pipeline volá zdroje paralelně (ARES + firmy.cz)** — `Enrich` spustí 2 goroutines + `sync.WaitGroup`, max wall-clock = max(ares_time, firmy_cz_time), ne sum.
- [ ] **Justice.cz fallback se volá jen když primární zdroje selžou** — sequenční po-paralelní fanout, integration test pokrývá „ARES 404 + firmy.cz 404 → justice.cz volán“.
- [ ] **Health filter — zdroje s Health<0.3 se přeskočí** — když KT-A7 reportuje ARES Health=0.1, pipeline ho neoslovuje, jde rovnou na firmy.cz.
- [ ] **`merge_conflicts_json` ukládá detailní audit** — pole konfliktů s `field`, `ares_value`, `firmy_cz_value`, `resolved_to` per konflikt.
- [ ] **`enrichment_source_used` má vocabulary `ares_only|firmy_cz_only|merged|firmy_cz_fallback|justice_cz_fallback|none`** — closed vocabulary, validace na INSERT.
- [ ] **`FirmyCZSource.Lookup` čte z `firmy_cz_businesses` se 90-day staleness window** — starší rows se ignorují (90 dní je arbitrary, viz otázku 3).
- [ ] **Sentry breadcrumb na degraded enrichment** — když pipeline použije justice.cz fallback nebo když oba primární zdroje jsou v cooldownu, emit breadcrumb `enrichment_degraded` s contact_id + ico.
- [ ] **Žádná regrese existujících enrichment testů** — `go test ./features/acquisition/contacts/enrichment/...` prochází, sqlmock testy aktualizované o nové SQL.

## 5. Změněné soubory

`features/acquisition/contacts/enrichment/source.go` — nový soubor, `EnrichmentSource` interface + sdílené typy `CompanyData`, `MergeConflict`, `EnrichmentHistoryRow`. ~60 řádek.

`features/acquisition/contacts/enrichment/source_ares.go` — nový adapter, `ARESSource` struct wrapuje `ares.Client`. Implementuje 4 metody interface. Mapuje `ares.SubjectData` na `CompanyData`. ~80 řádek.

`features/acquisition/contacts/enrichment/source_firmy_cz.go` — nový SQL adapter, `FirmyCZSource` čte z `firmy_cz_businesses`. Connection pool z `*sql.DB`. ~100 řádek.

`features/acquisition/contacts/enrichment/source_justice_cz.go` — stub, `JusticeCZSource.Lookup` vrací `nil, nil`. Implementace deferred. ~30 řádek (interface + stub + TODO comment).

`features/acquisition/contacts/enrichment/merge.go` — nový soubor, `mergeCompanyData([]CompanyData, []EnrichmentSource) (EnrichedCompany, []MergeConflict)`. Matrice `fieldAuthoritySource` jako konstanta. ~120 řádek.

`features/acquisition/contacts/enrichment/merge_test.go` — table-driven, 15+ test cases. Pokrývá: empty source, single source success, both success no conflict, both success with conflict, autoritativní source overrides non-authoritative, fallback to lower-priority source on empty.

`features/acquisition/contacts/enrichment/pipeline.go` — `Pipeline.Enrich` se přepisuje. Stará logika „call ares.Client directly“ se nahrazuje voláním `runSources(contact)` který volá multi-source paralelně + fallback. ~50 řádek změn.

`features/acquisition/contacts/enrichment/pipeline_multi_source_test.go` — nový integration test, sqlmock + ARES mock + firmy.cz table fixture. Pokrývá happy path, ARES-only, firmy.cz-only, both-fail+justice-fallback, oba blocked + justice success.

`features/acquisition/contacts/enrichment/history.go` — nový soubor, `Insert(ctx, db, row EnrichmentHistoryRow) error`, `Last100(ctx, db, contactID int64) ([]EnrichmentHistoryRow, error)`. ~50 řádek.

`features/acquisition/contacts/migrations/009_enrichment_history.sql` — migrace, vytvoří tabulku `enrichment_history` + index `(contact_id, created_at DESC)`.

`features/platform/outreach-dashboard/server.js` — nový endpoint `GET /api/contacts/:id/enrichment-history`, vrátí JSON pole pro audit UI.

## 6. Otázky pro orchestrátora

1. **firmy.cz Source: SQL read vs aktivní scrape on-demand?** Návrh je SQL-only (čte z pre-scraped tabulky). Aktivní scrape on-demand by znamenal: pipeline spustí TS scraper přes IPC nebo HTTP RPC, počká na výsledek. Latence by byla 2–5 sekund per kontakt. Při 1000 kontaktech denně by to znamenalo 30+ minut wall-clock. SQL-only je rychlé (sub-ms), ale zlobí cache miss („ICO nikdy nebylo scrape-nuté“). Návrh SQL-only se spoléhá na to, že KT-A10 cron drží cache fresh. Souhlasíš?

2. **Staleness window pro firmy.cz cache.** Návrh je 90 dní — data starší než 3 měsíce se ignorují. Alternativy: 30 dní (čerstvější, ale větší cache miss rate), 365 dní (víc hits, ale data můžou být zastaralá). 90 dní je kompromis. Záleží na rychlosti změn v firmy.cz datech (typicky se contacts mění málo, ale firma může zaniknout / přemístit). Stačí 90 dní?

3. **Justice.cz stub — kdy ho dotahat?** Návrh je odložit na samostatný sprint po KT-A10. Důvod: justice.cz parsing vyžaduje cheerio + anti-bot + Cloudflare bypass (možná). Stačí ti stub teď a plný impl jako KT-A11+? Nebo je třeba justice.cz živý už v KT-A9, abychom měli reálný 3-source fallback?

4. **Per-field priorita — chce uživatel jiný resolver pro některé pole?** Matrice v sekci 3.2 je můj draft. Příklad: `name` — ARES vrací oficiální obchodní jméno (`AGRO HEALTH a.s.`), firmy.cz může mít user-friendly variantu (`Agro Health`). Pro kampaň by mohlo být lepší firmy.cz jméno (čitelnější v emailu). Návrh nastavuje ARES > firmy.cz, ale pokud preferuješ čitelnost, otočíme to. Nechej rozhodnutí na operátorovi (settings JSON), nebo pevně v kódu?

5. **Konflikt rozšíření — mailbox-style review queue?** Když resolver má conflict (ARES říká `s.r.o.`, firmy.cz říká `společnost s ručením omezeným`), návrh ukládá do `merge_conflicts_json` a auto-resolveuje. Alternativa: každý conflict zapsat do queue „needs human review“, kde operátor v UI rozhodne. To je víc UX a víc práce, ale dává lepší kontrolu. Pro KT-A9 doporučuju auto-resolve + audit, manual review jako budoucí feature. Souhlasíš?
