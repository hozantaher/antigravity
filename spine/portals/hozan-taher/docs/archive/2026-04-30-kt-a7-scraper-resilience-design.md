# Sprint KT-A7 — Když přestane fungovat jeden zdroj proxy serverů, automaticky se přepneme na jiný

> **Status:** Design draft 2026-04-30. Kód v tomto sprintu nevzniká, jen plán. Implementace navazuje sprintem KT-A8+.

---

## 1. Aktuální stav

Naše dva primární scrapery — **ARES** (oficiální veřejný registr ekonomických subjektů) a **firmy.cz** (komerční katalog firem) — sbírají kontakty pro výkupní kampaň. Dnes každý funguje úplně jinak a každý má svůj vlastní slabý článek.

ARES scraper je napsaný v Go a žije v adresáři `features/acquisition/contacts/ares`. Posílá HTTP požadavky přímo na `ares.gov.cz` přes vestavěný `net/http` klient. Má vlastní **token bucket rate limiter** (1 požadavek za sekundu jako defaultní hodnota) a třístupňové retry s exponenciálním backoffem na chyby typu 429 (Too Many Requests) a 5xx (server error). Klient je relativně hezky stavěný — má funkční volby (`WithBaseURL`, `WithRate`, `WithHTTPClient`, `WithRetryBackoff`), takže je možné mu zvenku podstrčit jiný HTTP klient. Ale dnes se nikde nepodstrkuje. ARES jede z plain IP adresy nasazení (Railway), bez proxy, bez rotace. Když ARES začne 429-kovat nebo když naše IP skončí v jejich rate-limit blacklistu, scraper se zasekne na backoff smyčkách a kampaň přestane získávat nová ICO.

firmy.cz scraper je naopak v TypeScriptu a žije v `features/acquisition/scrapers/scrapers/firmy-cz`. Používá globální `fetch()` z Node.js, posílá si User-Agent řetězec `BOT_UA` (SeznamBot napodobenina, aby dostal SSR HTML). Má `createRateLimiter` z `features/acquisition/scrapers/lib/utils.ts` a retry helper. Při statusu 429 zavolá `rateLimiter.onRateLimited(retryAfter)`, což zvedne delay. Při statusu 410/404 označí URL jako "gone". Žádnou proxy podporu nemá vůbec — fetchá z primárního IP nasazení. Pokud Cloudflare před firmy.cz nasadí challenge nebo pokud Seznam (vlastník firmy.cz) zaban-listne naše IP, scraper sletí na 403 a celá fronta čekajících URL se zablokuje.

Vedle toho máme v `features/outreach/relay/internal/transport/proxy_pool.go` vyspělou vrstvu pro **rotaci SOCKS5 proxy**, která se ale dnes používá jen pro odchozí SMTP delivery z relay binárky, ne pro scrapery. Tahle vrstva už dnes řeší tři public free-proxy zdroje (proxifly, geonode, proxyscrape), paralelní fetch s deduplikací podle host:port, validaci TLS handshakem proti seznam.cz:465, country enrichment přes ip-api.com, persistenci pool snapshotu na disk pro rychlý cold-start a metric `consecutiveZeroRefreshes`, který signalizuje "tři refreshe po sobě prázdné — operátor musí zasáhnout". Existuje i samostatný registr `proxy_source_health.go` s tabulkou per-zdroj (počet po sobě jdoucích neúspěšných nebo prázdných fetch volání, čas posledního pokusu, poslední chybová zpráva). Tenhle registr ale dnes pool **nepoužívá pro výběr** — pouze loguje varování při překročení threshold a vystavuje snapshot do JSON pro `/v1/proxy-pool` endpoint. Je to monitoring, ne řízení.

Souběžně máme nasazenou alternativu **Mullvad WireGuard přes wireproxy** (memory `project_mullvad_wireproxy_egress.md`). To je placená cesta — relay container bootstrappuje userspace WireGuard klient, který expozuje SOCKS5 na localhost:1080, a relay je do něj nasměrovaný přes `TRANSPORT_MODE=tor` + `SOCKS_PROXY_ADDR=127.0.0.1:1080`. Pro SMTP delivery to funguje, pro scrapery ale taková infrastruktura zatím není sjednocená. ARES klient nemá nakonfigurovanou cestu, jak Mullvad SOCKS použít, a firmy.cz scraper v TypeScriptu o tom zatím vůbec neví.

**Single-points-of-failure dnes vypadají takto:**

1. **ARES IP-block** — pokud ARES blacklistne primární Railway IP, scraper se zacyklí na exponenciálním backoffu, ale nikdy se neodjistí.
2. **firmy.cz Cloudflare challenge** — pokud Cloudflare před firmy.cz spustí JavaScriptovou challenge nebo IP-block, dostáváme 403 a žádnou cestu obchvatu.
3. **Free pool má jediný fallback řetěz** — proxifly → geonode → proxyscrape, ale pokud všechny tři současně vrátí prázdno (což se reálně stalo, viz memory `project_seznam_proxy_geo_mismatch.md`), pool se vyprázdní a nikdo ho automaticky nenahradí žádnou jinou strategií.
4. **Mullvad jako single point of failure pro SMTP** — pokud Mullvad CZ exit zaroste do běžného Seznam fingerprint blacklistu, jediná egress cesta padne a relay buď spadne na free pool (kterému Seznam nedůvěřuje), nebo úplně zhasne.
5. **Zdraví per-zdroj se neměří v ovládací smyčce** — `proxy_source_health` registr existuje, ale jen pro logování. `pick()` ve `proxy_pool.go` na něj nekouká, takže pokud zdroj padá, neudělá se nic víc než varování.

## 2. Proč tento sprint

Když se podíváme na věci, které mohou v nejbližších týdnech odpálit kampaň, dostaneme tři reálné scénáře:

**Scénář první — Seznam ban.** Memory `project_seznam_proxy_geo_mismatch.md` zaznamenala 2026-04-28 reálnou situaci, kdy Seznam SMTP server odmítl zprávu z `mazher.a@email.cz` přes rumunské proxy IP (envelope `env_2d876994`). To samé se může stát firmy.cz, který je rovněž v rukou Seznamu. Pokud Seznam přiřadí naši primární IP k anti-spam reputaci kampaně, firmy.cz scraper začne dostávat 429/403 a my nemáme automatický záskok.

**Scénář druhý — ARES rate-limit.** Veřejný ARES API neavizuje konkrétní limity, ale empiricky 1 req/s drží. Pokud zvedneme paralelizaci kvůli backfillu (KT-A nebo budoucí sprint), nebo pokud několik instancí scraperu poběží současně po deploy-konfliktu, ARES nás může na pár hodin uzavřít. Dnes by to znamenalo, že ARES klient se zacyklí na retry a retry, while requeue worker pokračuje a otevírá další saturate na blacklistnutou IP.

**Scénář třetí — Cloudflare challenge na firmy.cz.** Cloudflare často nasazuje JavaScriptovou validaci na user-agent BOT*. Náš scraper se vydává za SeznamBot — když Cloudflare detekuje "SeznamBot ze ne-Seznam IP rozsahu", odpoví 403 challenge stránkou. Bez proxy přepínače jsme tady na hluché koleji.

**Reálný příklad scénáře, který bude tento sprint řešit:**

> Je úterý ráno, kampaň běží druhý týden, ARES začne ve 10:14 vracet 429 na všechny dotazy. ARES klient retryuje s backoffem 2s, 4s, 6s a pak označí ICO jako failed. Worker však dál táhne další ICO z fronty a saturuje API ještě víc. Po pěti minutách máme 200 failed ICO, žádný fresh data, kampaň stagnuje.
>
> Po sprintu KT-A7: ARES klient si v rámci dotazu vybere jeden ze zdrojů egress proxy (Mullvad jako primární, free pool jako záskok). Když začne zdroj "primary-railway-ip" vracet 429 nad threshold (≥30 % failed za posledních 10 dotazů), tento zdroj se na 5 minut vyřadí z výběru. Worker se přepne na free SOCKS5 pool. Po 5 minutách se primární IP otestuje jedním probe dotazem. Kampaň běží dál bez zásahu operátora.

Cíl tohoto sprintu tedy **není** přidávat nové proxy poskytovatele (to může být budoucí sprint), ale **aktivovat existující** zdraví-monitoring pro každý zdroj egress (Mullvad, free pool jako celek, případně přímý výstup) a navázat ho na rozhodovací smyčku, která zdroj se špatným success rate dočasně vyřadí a po cooldownu znovu otestuje.

## 3. Návrh

Návrh stojí na čtyřech vrstvách. Každá vrstva má jasný kontrakt vůči té další, takže je možné je implementovat postupně a otestovat samostatně.

### 3.1 Definice zdroje

Zavedeme abstraktní pojem **proxy zdroj** (source). Zdroj je pojmenovaná egress cesta, kterou scraper může použít. Konkrétní zdroje pro tento sprint budou:

- `direct` — bez proxy, primární IP nasazení. Pro ARES často nejrychlejší cesta, ale nejvíc rate-limit-citlivá.
- `mullvad-wireproxy` — odkaz na lokální SOCKS5 na 127.0.0.1:1080 (poskytuje wireproxy kontejner z `project_mullvad_wireproxy_egress.md`). Stabilní CZ exit, plať předem, žádný rate-limit z naší strany, ale single endpoint.
- `free-pool` — celá rotující množina volných SOCKS5 proxy (proxifly + geonode + proxyscrape), spravovaná `RotatingProxyTransport` v `proxy_pool.go`. Vysoká variabilita, není garantovaný uptime, ale nemá rate-limit ani fingerprint.

Každý zdroj má svůj **health stav**: počet úspěšných pokusů, počet neúspěšných pokusů, čas posledního použití, čas konce cooldown období (pokud je zdroj zrovna vyřazený). Stav se aktualizuje pokaždé, když scraper přes daný zdroj odešle dotaz.

### 3.2 Health monitoring per zdroj

Rozšíříme stávající `sourceHealth` strukturu v `features/outreach/relay/internal/transport/proxy_source_health.go` tak, aby kromě dnešního "počítadla po sobě jdoucích nul" vedla i **klouzavé okno posledních N pokusů** (N=10 pro tento sprint). Každý záznam je dvojice "kdy" + "úspěch nebo selhání". Z tohoto okna se počítá **success rate** jako počet úspěchů děleno N, jakmile je okno plné. Pod prahem 30 % a při minimálně 10 zaznamenaných pokusech se zdroj automaticky vyřadí.

Co se počítá jako úspěch a co jako selhání, definujeme úzce — úspěch je HTTP 2xx response (pro ARES) nebo úspěšný TLS handshake + 2xx HTML (pro firmy.cz). Selhání je 429, 403, 5xx, nebo network timeout. 404 a 410 se nezapočítávají vůbec — jsou to očekávané "tato firma neexistuje" odpovědi a nevypovídají nic o zdraví zdroje.

### 3.3 Auto-skip pod threshold a cooldown

Když success rate klesne pod 30 % a okno je plné, zdroj se přepne do stavu "v karanténě" — `cooldownUntil = time.Now() + 5 minut`. Po tuto dobu ho výběrová logika přeskočí a zkusí jiný zdroj v pořadí preference. Po uplynutí cooldownu se zdroj automaticky vrátí do hry, ale jeho okno se vynuluje, aby předchozí špatná historie nesmazávala čistý start.

Pokud se zdroj po cooldownu opět dostane pod threshold, cooldown se exponenciálně prodlouží (5 min → 15 min → 45 min → max 4 hodiny). Tím se zabrání tomu, abychom v nestabilní situaci znovu a znovu pumpovali požadavky do zdroje, který je trvale rozbitý. Celý exponenciální stack se vyresetuje, jakmile zdroj projde plné okno (10 pokusů) bez vyřazení.

### 3.4 Multi-source fallback strategie

Scraper si při každém požadavku zavolá funkci `selectSource()`, která vrátí jméno zdroje, který má použít. Logika je:

1. Vezmi všechny zdroje seřazené podle preferovaného pořadí (default: `direct`, `mullvad-wireproxy`, `free-pool` pro ARES; pro firmy.cz `mullvad-wireproxy`, `free-pool`, `direct`).
2. Vyfiltruj ty, co jsou v cooldownu.
3. Vrať první zbývající.
4. Pokud nezbude nic, vrať `direct` jako poslední záchranu (lepší zkusit než zaspat) a zaloguj `slog.Error` "all sources in cooldown".

Pořadí preference je konfigurovatelné přes env proměnnou `SCRAPER_SOURCE_ORDER_ARES` a `SCRAPER_SOURCE_ORDER_FIRMY` (čárkou oddělené jména zdrojů). Default je výše uvedený. Operátor může pořadí měnit bez deploy.

Pro TypeScriptovou stranu (firmy.cz) bude potřeba postavit tenkou paralelní vrstvu — TS nemá přístup ke Go health registru přímo. Buď přes HTTP endpoint (`GET /v1/scraper-source/select?for=firmy`) na relay binárce (jednodušší, ale přidává síťový hop) nebo replikací health logiky v TS s vlastním IPC. Pro tento sprint navrhuji **HTTP endpoint** — relay už expozuje `/v1/proxy-pool` a přidat další admin endpoint je triviální. Latency je sub-ms na localhost.

### 3.5 Dashboard a viditelnost

Snapshot stavu (které zdroje jsou healthy, které v cooldownu, success rate v posledním okně) se přidá do existujícího `Snapshot()` v `proxy_pool.go` a zveřejní přes `/v1/proxy-pool`. Tím se dnešní dashboard rozšíří o sekci "Scraper sources", kde operátor uvidí graf success rate a aktuální stav per zdroj. Žádné nové dashboard komponenty se nepíšou — stačí JSON pole navíc, frontend si je vykreslí.

## 4. Acceptance kritéria

- [ ] **Zdroj má vlastní okno posledních 10 pokusů** — každý fetch zaznamená `success | failure` do registry, takže můžeme spočítat success rate per zdroj v reálném čase.
- [ ] **Success rate pod 30 % při plném okně vyřadí zdroj** — pokud zdroj absolvuje 10 pokusů a 7+ z nich selhalo, automaticky se přepne do cooldownu a další request přes něj nepošleme.
- [ ] **Cooldown je 5 minut a exponenciálně se prodlužuje při opakovaných výpadcích** — první vyřazení trvá 5 min, druhé v řadě 15 min, třetí 45 min, čtvrté a další 4 hodiny (cap).
- [ ] **Scraper si vybírá zdroj podle preference + cooldown** — ARES klient i firmy.cz scraper volají `selectSource()` před každým fetchem, dostávají healthy zdroj a podle něj routeují HTTP požadavek.
- [ ] **Cooldown se resetuje po čistém okně 10 pokusů** — pokud se zdroj po návratu z cooldownu chytí (úspěšně absolvuje 10 pokusů bez nového vyřazení), exponenciální countdown se vrátí na začátek (5 min).
- [ ] **404/410 odpovědi se nezapočítávají do health počítadla** — jsou to legitimní "firma neexistuje" odpovědi a nesmí kazit success rate.
- [ ] **Stav zdrojů je viditelný v `/v1/proxy-pool` JSON** — endpoint vrací pole `scraper_sources` se jménem, success rate v posledním okně, počtem zbývajících sekund cooldownu a aktuálním exponenciálním stupněm.
- [ ] **Pořadí preference je env-konfigurovatelné** — `SCRAPER_SOURCE_ORDER_ARES` a `SCRAPER_SOURCE_ORDER_FIRMY` nastavují prioritu zdrojů bez nutnosti deploy.
- [ ] **Když všechny zdroje jsou v cooldownu, scraper použije `direct` a zaloguje critical** — defenzivní fallback, aby kampaň nikdy nepadla na nulový throughput, ale operátor dostane jasný signál ("all sources cooldown").
- [ ] **Existující `RotatingProxyTransport` rotace zůstává nedotčená pro SMTP delivery** — sprint nesmí změnit chování `pick()` pro relay/cmd path, jen rozšířit registr a přidat scraper-side `selectSource()`.

## 5. Změněné soubory

`features/outreach/relay/internal/transport/proxy_source_health.go` — rozšíří se `sourceHealth` o klouzavé okno (kruhový buffer 10 záznamů success/failure), pole `cooldownUntil`, `cooldownTier` (exponenciální stupeň). Doplní se metoda `RecordOutcome(name string, success bool)` pro fetch-level logging a `SelectHealthySource(preference []string) string` pro výběrovou logiku.

`features/outreach/relay/internal/transport/proxy_source_health_test.go` — nový testovací soubor (table-driven) pokrývající: prázdný registr vrátí první preferenci; plné okno pod thresholdem vyřadí zdroj; cooldown vyprší → zdroj se vrátí; opakovaný výpadek prodlouží cooldown exponenciálně; 404/410 se nezapočítává; všechny zdroje v cooldownu vrátí first-preference + log.

`features/outreach/relay/web/server.go` — přidá se nový endpoint `GET /v1/scraper-source/select?for=<name>` který zavolá `SelectHealthySource` z transportu a vrátí JSON `{"source": "mullvad-wireproxy"}`. Existující `/v1/proxy-pool` se rozšíří o `scraper_sources` pole v PoolSnapshot.

`features/outreach/relay/internal/transport/proxy_pool.go` — `PoolSnapshot` struktura dostane nové pole `ScraperSources []ScraperSourceState`. `Snapshot()` ho naplní z health registru. Ostatní logika `RotatingProxyTransport` zůstává.

`features/acquisition/contacts/ares/client.go` — `doFetch` před vlastním HTTP voláním zavolá `selectScraperSource("ares")` (nový tenký helper, který hit-uje localhost:port/v1/scraper-source/select). Podle vrácené hodnoty se postaví HTTP klient: `direct` použije `c.client`, `mullvad-wireproxy` použije klient s SOCKS5 dialer na 127.0.0.1:1080, `free-pool` použije klient s SOCKS5 dialer co rotuje přes `RotatingProxyTransport`. Po fetch zavolá `recordScraperSourceOutcome(name, success)`. Klient výběr zdroje nezpůsobí circular import — helper bude v novém balíčku `features/acquisition/contacts/internal/proxysource`.

`features/acquisition/contacts/internal/proxysource/client.go` — nový soubor, tenký HTTP klient pro `/v1/scraper-source/select` a `/v1/scraper-source/outcome` endpointy na relay. Sub-millisecond cache (in-memory, 200 ms TTL) aby ARES s 1 req/s nezahltil relay zbytečným hopem.

`features/acquisition/scrapers/lib/proxy-source.ts` — nový TS modul, paralela `proxysource/client.go`. Exportuje `selectSource(scraper: 'firmy')` a `recordOutcome(name: string, success: boolean)`. Komunikuje s relay přes `fetch()` na `RELAY_BASE_URL` env (default `http://localhost:8080`).

`features/acquisition/scrapers/scrapers/firmy-cz/scraper.ts` — `fetchDetailPage` se obalí: před fetchem zavolá `selectSource('firmy')`, podle vrácené hodnoty se buď použije přímý `fetch()` (pro `direct`), nebo `fetch` s SOCKS5 agent (`socks-proxy-agent` přes pre-existing dependency, nebo nová minimal lib bez nového package — viz otázka v sekci 6) pro `mullvad-wireproxy` a `free-pool`. Po fetch zavolá `recordOutcome`.

`features/acquisition/scrapers/scrapers/firmy-cz/scraper.test.ts` — přidají se tři test cases: outcome se zaloguje při 200, při 429, při timeoutu. Vyžaduje mockování `proxy-source.ts` modulu.

## 6. Otázky pro orchestrátora

1. **Threshold success rate — 30 % nebo jiný?** GH issue #301 říká 30 %, ale v memory `project_proxy_sources.md` je zmíněna empirická live-rate 5–10 % free pool. Pokud bude scraper na free pool 90 % failed, threshold 30 % se nikdy neuplatní pozitivně (zdroj bude trvale v cooldownu). Chceš threshold per-zdroj (free-pool tolerantní 15 %, mullvad přísný 50 %) nebo jednotných 30 %?

2. **Délka cooldown a exponenciální cap.** Návrh je 5 → 15 → 45 → 240 min. Druhá varianta byla 5 → 10 → 20 → 60 (více pokusů, méně času na zotavení). Operátor preferuje rychlejší retry nebo bezpečnější dlouhý čekání?

3. **Window size — 10 pokusů nebo časový bucket?** GH issue říká "po 10 pokusech". Alternativa je "v posledních 5 minutách". 10-pokusů je jednodušší pro test a předvídatelnější, ale při nízkém ARES throughputu (1 req/s) se může okno zaplnit za 10 sekund a špatný moment ovlivní rozhodnutí ne velmi dlouho.

4. **Přidat reálný `paid` proxy zdroj (např. iproyal/oxylabs CZ residential) v rámci tohoto sprintu, nebo nechat jen direct + mullvad + free-pool?** Memory `project_seznam_proxy_geo_mismatch.md` navrhuje paid CZ residential jako jediné dlouhodobě spolehlivé řešení, ale to je nákupní rozhodnutí a operátorská konfigurace, ne čistě technický sprint. Doporučuji **NE** v tomto sprintu, jen rozhraní, které další zdroj umožní přidat změnou env.

5. **TypeScript SOCKS5 klient — přidat nový npm package nebo ručně napsat minimální SOCKS5 helper?** firmy.cz scraper běží v Node.js a `fetch()` nemá nativní podporu pro SOCKS5. Buď přidáme `socks-proxy-agent` (audited, ~5 kB, závislost na `@types/node`) nebo napíšeme ručně SOCKS5 handshake (cca 80 řádek). První varianta je rychlá, druhá držela by stack v souladu s pravidlem "zero external imports" z relay CLAUDE.md (které ale platí pro Go binárku, ne pro Node scrapery — TypeScript stack už dnes závisí na `cheerio`, `pg`, `ioredis` atd.).
