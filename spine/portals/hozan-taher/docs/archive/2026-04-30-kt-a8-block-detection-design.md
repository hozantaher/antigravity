# Sprint KT-A8 — Když nás zdroj zaban-listne, sami si toho všimneme a přepneme

> **Status:** Design draft 2026-04-30. Kód v tomto sprintu nevzniká, jen plán. Předchůdce: KT-A7 (proxy rotation), navazuje sprint KT-A9.

---

## 1. Aktuální stav

Naše dva primární scrapery — **ARES** (`features/acquisition/contacts/ares/client.go`) a **firmy.cz** (`features/acquisition/scrapers/scrapers/firmy-cz/scraper.ts`) — dnes reagují na blokaci stejným způsobem: tiše. ARES klient v `doFetch` rozlišuje jen tři skupiny stavů. Pokud HTTP odpověď je `404`, vrátí speciální `notFoundError` a kampaň pokračuje. Pokud je `429` nebo `5xx`, vrátí chybu typu „ares status %d“ a `FetchSubject` ji uvnitř smyčky tří retry pokusů zkusí znovu s lineárním backoffem (2s × pokus). Po vyčerpání všech tří pokusů se vrátí finální chyba a sync worker označí ICO jako selhané. **Žádný poplach se nikam nepošle, žádná stopa do `healing_log`, žádný signál, že systém má reálný problém.**

firmy.cz scraper se chová podobně. V `runDetailPhase` vidíme `if (status === 429) { rateLimiter.onRateLimited(retryAfter); throw 'Rate limited'; }`. Co znamená 403, kód explicitně neřeší — spadne to do větve `if (status !== 200) throw 'Unexpected status'`, retry helper ho zopakuje, a po vyčerpání pokusů to skončí v `markFailed`. Stejně tak Cloudflare challenge (která reálně přichází jako HTTP 200 s body obsahujícím `<title>Just a moment...</title>` nebo header `cf-mitigated: challenge`) se dnes do scraperu propíše jako úspěšný fetch — parser pak v cheerio kódu nenajde žádná data, protože tam jsou jen JS bootstrap skripty. **Cloudflare challenge je tedy invisible — vypadá jako HTTP 200 prázdný profil.**

V `features/acquisition/scrapers/src/queue/scrape-worker.ts` máme generický queue worker, který orchestruje běh scraperů přes BullMQ. Job má `attempts` a `backoff`, takže BullMQ retryuje na svém vlastním kruhu, nezávisle na in-process retry. Když job opakovaně selže, BullMQ ho posune do `failed` queue, ale operátor o tom dnes ví jen pokud se podívá na BullMQ Bull Board. Žádný alert, žádný Sentry breadcrumb, žádná auto-recovery akce.

KT-A7 plánuje vrstvu **proxy rotation** s health monitoringem per egress zdroj. Scraper přes funkci `selectSource()` dostane jméno cesty (direct / mullvad-wireproxy / free-pool). Co tahle vrstva ale **neumí**, je rozhodnout, **že současný fetch byl blokovaný**. Vrátí jen `success | failure` na úrovni transportu (HTTP odpověď přišla, nebo nepřišla). Pokud nás Cloudflare obslouží 200 OK challenge stránkou, KT-A7 health monitoring to zaregistruje jako úspěch a zdroj zůstane „healthy“, i když reálně nedostáváme data. **KT-A8 je o sémantické vrstvě nad transportem — jak rozeznat, že odpověď je sice technicky validní, ale obsahově to je blok.**

## 2. Proč tento sprint

Reálné scénáře, které KT-A8 řeší a KT-A7 sám neřeší:

**Scénář první — Cloudflare challenge bez signálu.** Cloudflare před firmy.cz nasadí JavaScriptovou validaci. Scraper dostane HTTP 200 + 4 kB HTML s `<title>Just a moment...</title>` + meta refresh. cheerio parser pokusí extrahovat JSON-LD — žádný tam není. `parseDetailPage` vrátí prázdný `BusinessData{ url: ... }` bez `name`, `email`, `ico`. SQL INSERT proběhne (URL se označí jako `scraped`), ale databáze se naplňuje prázdnými řádky. Po deseti minutách máme tisíc URL „úspěšně“ scrapnutých, a žádný kontakt. Operátor si toho všimne až další ráno při kontrole, a to je už proxy rate-limit reset za sebou.

**Scénář druhý — ARES vrací HTML místo JSON.** ARES API občas (při přetížení nebo údržbě) vrátí HTML stránku „Služba není dostupná“ s HTTP statusem 200 a `Content-Type: text/html` místo očekávaného `application/json`. JSON decoder spadne na první znak, vrátí `decode response: unexpected character`. Klient to dnes zaobalí do `ares fetch %s after %d retries`, sync worker to označí jako trvalé selhání ICO. **Reálný problém je dočasný server-side incident, ale my si o tom nezaznamenáme nic.**

**Scénář třetí — Tiché rate-limit posun.** firmy.cz zvedne nepublikovaný rate-limit threshold z 60 req/min na 30. Náš scraper běží na 50 req/min (dnešní default). Začne dostávat 429 každý druhý request. KT-A7 health monitor to chytne, source půjde do cooldownu — ale **pokud jediným zdrojem je `direct`, KT-A7 ho po 5 minutách vrátí, on opět 429-kuje, jde znovu do cooldownu, a takhle to oscilující až do skon kampaně.** KT-A8 doplní detekci „source X dostává 429 v 80 % posledních fetchů — vyhodit alert a zastavit run, ne jenom cooldown“.

**Reálný příklad scénáře, který KT-A8 řeší:**

> Středa 14:42, Cloudflare před firmy.cz aktivuje challenge mode (sezónní vlna botů). Scraper běží přes mullvad-wireproxy, fetch vrací HTTP 200 + challenge HTML. KT-A7 počítá tento fetch jako success, source zůstává healthy. cheerio parsuje prázdný HTML, `BusinessData{ url, ico: null, name: null }` jde do DB.
>
> Po sprintu KT-A8: po fetch zavolá scraper `detectBlock(response, html)`. Detektor zjistí `cf-ray` header + body obsahuje `Just a moment` → vrátí `BlockType.Cloudflare`. Scraper neuloží prázdný record, místo toho zaloguje `healing_log` row (`block_type=cloudflare, source=mullvad-wireproxy, url=https://...`), markne URL jako `pending` (ne `scraped`), informuje KT-A7 health monitor o cílené failure, a request requeue-ne na alternativní source `free-pool`. Pokud i `free-pool` blokovaný, escalate alert: Sentry breadcrumb + slog.Error s `op=firmy_cz.detect_block/all_sources_blocked`. Operátor dostane jasný signál, že je třeba zasáhnout, ne až ráno když vidí prázdné výsledky.

Cíl sprintu je tedy **vrstvit dva typy detekce**: stavový kód transportu (HTTP status, network error — to už dnes řešíme alespoň částečně) a sémantická detekce (HTTP 200 který přesto signalizuje blok). Plus auto-recovery: když primární zdroj blokovaný, zkusit alternativní v rámci jednoho retry kola, ne až po vyčerpání tří pokusů na primárním.

## 3. Návrh

### 3.1 Klasifikace bloků — čtyři typy

Zavádíme typ `BlockType` se čtyřmi hodnotami a explicitním `null` (žádný blok detekován):

- `rate_limit` — HTTP 429, nebo 503 + `Retry-After` header. Cesta zotavení: respektovat `Retry-After`, případně requeue na alt source pokud je dostupný.
- `captcha` — body obsahuje `g-recaptcha`, `h-captcha`, `cf-turnstile`, nebo HTTP status 200 + `<form action*="captcha">`. Cesta zotavení: alt source ihned (captcha vyřešit nelze).
- `cloudflare` — `cf-ray` header + body obsahuje `Just a moment`, `Checking your browser`, nebo HTTP status 403 + `Server: cloudflare`. Cesta zotavení: alt source ihned + delší cooldown na primární (15 min, ne 5).
- `forbidden` — HTTP 403 bez Cloudflare signatury, nebo 401. Indikuje IP-block nebo banned User-Agent. Cesta zotavení: alt source + `consecutive_failures++` na zdroj.

Funkce `detectBlock` má signaturu (Go i TS):

```
DetectBlock(status int, headers http.Header, bodyPrefix []byte) BlockType
detectBlock(response: Response, html?: string): BlockType | null
```

Detektor čte **jen prvních 4 kB body** (`bodyPrefix`), aby neblokoval na velkých response bodech. Cloudflare challenge je v prvních 2 kB, captcha widgety taky. Pokud detekce vyžaduje delší body (například Cloudflare rate limit page bez `cf-ray`), vrátí `null` — false negativ je preferován před false pozitivem (false pozitiv by zbytečně blokoval validní data).

### 3.2 Audit trail — `healing_log` tabulka

Nová tabulka `healing_log` (migrace v `features/acquisition/contacts/migrations/`) s sloupci:

| Sloupec | Typ | Význam |
|---|---|---|
| `id` | bigserial | PK |
| `created_at` | timestamptz | čas záznamu |
| `scraper` | text | `ares` nebo `firmy_cz` |
| `block_type` | text | `rate_limit | captcha | cloudflare | forbidden` |
| `source` | text | jméno egress zdroje (z KT-A7) |
| `url` | text | URL nebo ICO, kterého se to týkalo |
| `http_status` | int | původní HTTP status |
| `body_signature` | text | krátký hash + první 200 znaků body (pro audit) |
| `recovery_action` | text | `alt_source | escalate | give_up` |
| `recovery_source` | text | jméno alt zdroje, pokud byl použit |

Každá detekce bloku zapíše row. Tabulka neloguje úspěšné fetche — ta cesta jde přes KT-A7 health metriky. `healing_log` je čistě audit pro „co se nestandardního stalo“.

### 3.3 Auto-recovery — dvouvrstvý retry

Scraper kód okolo fetche se rozšiřuje o **block-aware retry layer** nad existujícím transport retry. Logika:

1. Volej `selectSource()` (KT-A7) → dostaneš jméno zdroje.
2. Proveď fetch přes vybraný zdroj.
3. Pokud HTTP error (network, timeout) → KT-A7 records failure, retry s exponenciálním backoffem na **stejný zdroj** (max 2 pokusy).
4. Pokud HTTP success → zavolat `detectBlock(status, headers, body)`.
5. Pokud `block_type != null`:
   - INSERT do `healing_log`.
   - KT-A7 records failure pro tento zdroj.
   - Vyber **jiný** zdroj přes `selectSource(exclude=[currentSource])` (rozšíření KT-A7 API o `exclude` parametr).
   - Pokud alt zdroj existuje → retry na něm (max 1 pokus, není to nekonečná smyčka).
   - Pokud alt zdroj není → INSERT row `recovery_action=escalate` + `slog.Error` + Sentry breadcrumb + return failure (URL zůstane `pending` v queue, BullMQ ji vezme později).
6. Pokud `block_type == null` → fetch je success, parsuj data, KT-A7 records success.

Klíčová změna: **detekce bloku se nepočítá jako úspěch transportu, i když HTTP status byl 200**. Alt-source retry je v rámci stejného „uživatelského“ requestu, takže operátor vidí jeden URL → jeden výsledek (success na alt source nebo definitivní block escalation).

### 3.4 Ochrana proti smyčce — circuit breaker

Pokud v posledních 50 fetchích bylo ≥30 zaznamenaných bloků (60 % block rate), scraper vstoupí do **circuit-breaker mode** na 30 minut: nový job se nezačne, BullMQ queue se pauzne (`bullQueue.pause()`), zaloguje se `slog.Error` + Sentry alert. Operátor musí buď ručně resume, nebo počkat na 30-minutový auto-resume. Tím zabráníme situaci, kdy oba zdroje (mullvad + free-pool) jsou rovnoměrně blokované a scraper jen pumpuje requesty zbytečně.

Práh 30/50 je konfigurovatelný přes `BLOCK_RATE_BREAKER_WINDOW=50` a `BLOCK_RATE_BREAKER_THRESHOLD=30`.

### 3.5 Pozorovatelnost

Tři místa, kde KT-A8 vystavuje stav:

1. **`healing_log` tabulka** — audit, dostupný přes BFF endpoint `GET /api/scraper/healing` (read-only, last 100 rows).
2. **Sentry breadcrumbs** — každý detected block emit-uje breadcrumb level=warning, eskalace `recovery_action=escalate` jde jako `level=error` Sentry capture.
3. **Slog op konvence** — `op=firmy_cz.detect_block`, `op=ares.detect_block`, `op=scraper.circuit_breaker_open`, `op=scraper.circuit_breaker_close`. Audit test `slog_op_audit_test.go` pokrývá nové ops.

## 4. Acceptance kritéria

- [ ] **`detectBlock` v Go a TS rozezná čtyři typy bloků** — funkce má unit testy s 5+ fixtures per typ (real captures z Cloudflare/recaptcha/firmy.cz 429), false-pozitiv rate na 100 validních HTML <1 %.
- [ ] **`healing_log` migrace nasazená v dev + prod** — tabulka existuje, INSERT má index na `(scraper, created_at DESC)` pro rychlou last-100 dotaz.
- [ ] **Block-aware retry vrstva v ARES klientu** — `features/acquisition/contacts/ares/client.go` `FetchSubject` po HTTP success volá detektor, na detected block requeue přes alt source z KT-A7.
- [ ] **Block-aware retry vrstva v firmy.cz scraperu** — `features/acquisition/scrapers/scrapers/firmy-cz/scraper.ts` `runDetailPhase` worker volá detektor, na block stejnou logikou.
- [ ] **Circuit-breaker pauzne BullMQ na 30/50 práh** — překročení block-rate během 50 posledních fetchů zapauzuje queue na 30 min, slog.Error + Sentry capture.
- [ ] **Sentry breadcrumb + Sentry error capture na escalate** — každý block je breadcrumb, escalate (žádný alt source) je full Sentry event s tagem `scraper:<name>`, `block_type:<type>`.
- [ ] **`slog_op_audit_test.go` pokrývá nové ops** — `firmy_cz.detect_block`, `ares.detect_block`, `scraper.circuit_breaker_open`, `scraper.circuit_breaker_close`.
- [ ] **BFF endpoint `GET /api/scraper/healing` vrací last 100 rows** — chráněno X-API-Key, JSON pole, pro UI healing tab.
- [ ] **Cloudflare challenge na primární zdroj → automaticky retry na alt** — integration test: mocked fetch vrátí Cloudflare HTML, alt source vrátí valid JSON-LD, finální výsledek je validní `BusinessData`, `healing_log` má 1 row.
- [ ] **Žádná regrese existujících scraper testů** — `pnpm test` v `features/acquisition/scrapers/` + `go test ./features/acquisition/contacts/ares/...` prochází bez nových failures.

## 5. Změněné soubory

`features/acquisition/contacts/migrations/008_healing_log.sql` — nová migrace, vytvoří `healing_log` tabulku + index. Předpoklad: KT-A7 nepřidává migraci, takže 008 je free.

`features/acquisition/contacts/healing/log.go` — nový balíček, exportuje `Insert(ctx, db, row HealingLogRow) error` a `Last100(ctx, db, scraper string) ([]HealingLogRow, error)`. Tenký writer, 80 řádek max.

`features/acquisition/contacts/ares/blockdetect.go` — nový soubor v ARES balíčku, exportuje `DetectBlock(status int, headers http.Header, bodyPrefix []byte) BlockType`. Tabulkové constanty pro signatury Cloudflare/captcha/forbidden.

`features/acquisition/contacts/ares/blockdetect_test.go` — table-driven test, 25+ fixtures (5 per typ + 5 negative), pokrývá hraniční případy (200 OK valid JSON, 200 OK Cloudflare challenge, 429 + Retry-After, 503 bez Retry-After, 403 + Server: cloudflare, 403 plain).

`features/acquisition/contacts/ares/client.go` — `doFetch` po `http.Do` zavolá `DetectBlock`. `FetchSubject` při detected block zavolá `proxysource.SelectAlternative()` (rozšíření helperu z KT-A7 o `exclude` slice) a retry na alt. Při escalate INSERT do `healing_log` + `slog.Error(op="ares.detect_block")`.

`features/acquisition/scrapers/src/util/block-detector.ts` — nový soubor, paralela Go detektoru. `detectBlock(response: Response, html: string): BlockType | null`. Stejné signatury, exportuje TS enum `BlockType`.

`features/acquisition/scrapers/src/util/block-detector.test.ts` — vitest spec, stejné fixtures jako Go (kopíruje stejné HTML samples).

`features/acquisition/scrapers/scrapers/firmy-cz/scraper.ts` — `runDetailPhase` po `fetchDetailPage` zavolá `detectBlock`. Při bloku INSERT do `healing_log` (přes `features/acquisition/scrapers/src/util/healing-log.ts` helper, pg poolu z `db.ts`), zavolá `proxySource.selectAlternative()`, retry. Worker funkce dostane circuit-breaker counter.

`features/acquisition/scrapers/src/util/healing-log.ts` — nový TS helper, INSERT do `healing_log` přes pg pool. Paralela Go `healing.Insert`.

`features/acquisition/scrapers/src/util/circuit-breaker.ts` — nový soubor, sliding window 50 fetchů + threshold 30. Exportuje `recordFetch(blocked: boolean)` + `shouldOpen(): boolean`. Stav per scraper instance (in-memory, BullMQ worker process scope).

`features/platform/outreach-dashboard/server.js` — nový endpoint `GET /api/scraper/healing` proxy na `features/acquisition/contacts/web` (nebo přímo SQL přes BFF pool, dle ADR existing patterns). Vrátí last 100 řádků s `?scraper=ares|firmy_cz` filterem.

`features/outreach/relay/internal/transport/proxy_source_health.go` — rozšíří se KT-A7 API o `SelectAlternative(exclude []string) (string, error)`. Implementace: `SelectHealthySource` s vyfiltrovaným `exclude` setem, error když nezbude žádný zdroj.

## 6. Otázky pro orchestrátora

1. **Body inspection — kolik kB číst pro detekci?** Návrh je 4 kB. Cloudflare challenge stránka má ~12 kB, ale signatury (`<title>Just a moment...</title>`, `cf-mitigated`, `g-recaptcha`) jsou obvykle v prvních 2 kB. Větší okno znamená vyšší latency a paměťový tlak při paralelních requestech. Stačí 4 kB, nebo chceš 8 kB pro safety margin?

2. **Circuit-breaker auto-resume vs manual-resume?** Návrh je 30 min auto-resume. Alternativa: jen manual resume přes BFF endpoint `POST /api/scraper/resume`. Auto-resume riskuje, že kampaň bude oscilovat mezi „blocked → cooldown → blocked“. Manual nutí operátora reagovat (což může být v noci pozdě). Můj favorit: 30 min auto pro první otevření, pak druhé otevření v rámci 4 hodin = manual-only. Souhlasíš?

3. **`healing_log` retention — 30 dní nebo natrvalo?** Tabulka může růst ~1000 rows/den při aktivní kampani s občasnými incidenty. 30 dní = ~30k rows, OK. Natrvalo = za rok 365k rows, stále OK. Pokud nasloucháš stranou audit/compliance, natrvalo. Pokud disk concern, 30 dní s `DELETE WHERE created_at < NOW() - INTERVAL '30 days'` cron.

4. **Block detection prioritizace mezi headery a body?** Návrh: header-first (`cf-ray`, `Retry-After`, `Server: cloudflare`), body-second (`Just a moment`, `g-recaptcha`). Důvod: header parsing je deterministický a rychlý, body parsing je náchylný na false-pozitiv (legitimní stránka může obsahovat slovo „captcha“ v textu). Souhlasíš s prioritou, nebo chceš čistě header-only pro KT-A8 a body detekci nechat na KT-A9?

5. **Integrace s KT-B test sprintem?** KT-A8 generuje `Needs-Tests: scraper block_detector chaos` trailer pro Chat B. Chaos test by měl: spustit scraper proti kontrolovanému HTTP serveru, který náhodně mixuje 200 OK valid + 200 OK Cloudflare + 429 + 403, a verifikovat že (a) detekce je přesná, (b) circuit breaker vstupuje při >=60 % block rate, (c) alt source switch loguje audit. To je v scope KT-B15, nebo jiný KT-B sprint?
