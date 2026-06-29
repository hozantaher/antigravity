# 📖 Slovník Pojmů (Glossary)

Tento dokument je automaticky generován z `@terminology` tagů v TSDoc komentářích.

### ArbitrageOpportunity
Reprezentuje nalezenou příležitost na trhu (inzerát), kde  odhadovaná hodnota od LLM je výrazně vyšší než nabízená cena.

*Odkazy (Zdroj pravdy):*
- `spine/domain/core-types/schemas.ts`

---

### B2BMiner
Zpracovává hromadné ceníky a flotilové exporty (PDF, Excel) B2B dealerů. Spolupracuje s uzlem `worker-pdf` k extrakci strukturovaných inzerátů a krmí frontu pro Shadow Brokera na +100M Scale způsobem.

*Odkazy (Zdroj pravdy):*
- `spine/demand/acquisition/deep-inventory/b2b-miner/miner.ts`

---

### CrossBorderArbitrage
Engine, který kombinuje scrapovaná data z DE (Mobile.de) a CZ trhu. Aplikuje dynamické přepočty (aktuální kurz CZK/EUR, orientační náklady na dovoz). Když rozdíl ceny (Arbitrage Profit) po zdanění překoná threshold,  pošle příležitost dál pro Shadow Brokera na CZ doménu.

*Odkazy (Zdroj pravdy):*
- `spine/engine/intelligence/arbitrage-miner/cross-border/scanner.ts`

---

### DeltaEngine
Modul, který na úrovni Kognitivní a Fyzické vrstvy zahazuje data, která již byla zpracována, nebo posílá dál inzeráty s dynamicky se měnící cenou (zlevnění). Odlehčuje LLM frontu.

*Odkazy (Zdroj pravdy):*
- `spine/demand/acquisition/deep-inventory/delta-engine.ts`

---

### DynamicSitemapDiscovery
Sleduje sitemap.xml soubory cílových platforem pomocí hlaviček ETag a Last-Modified. Pokud dojde k detekci nového URL inzerátu, okamžitě jej zařadí do fronty k extrakci,  čímž šetří proxy kapacity a minimalizuje vizuální scrapování kategorií.

*Odkazy (Zdroj pravdy):*
- `spine/demand/acquisition/deep-inventory/sitemap-watcher/sitemap-watcher.ts`

---

### Lead
Datový payload, který jde ze scrapingu (Deep Inventory) směrem do Arbitrage Mineru.

*Odkazy (Zdroj pravdy):*
- `spine/domain/core-types/schemas.ts`

---

### ReverseAPIInterceptor
Namísto parsování DOM struktur přes selektory poslouchá `response` eventy na úrovni prohlížeče (Playwright). Pokud detekuje odpověď ze serveru, která obsahuje JSON nebo GraphQL odpovídající inzerátu,  data přímo vyextrahuje a ihned převede na RawListing.

*Odkazy (Zdroj pravdy):*
- `spine/demand/acquisition/deep-inventory/network-interceptor/interceptor.ts`

---

### SelfHealingEngine
Kognitivní mechanismus schopný samostatně číst rozbité zdrojové HTML cizích inzertních portálů, osekat ho od šumu a využít LLM k rekonstrukci či vytěžení dat (a tím automaticky opravit scraper).

*Odkazy (Zdroj pravdy):*
- `spine/engine/learn/self-healing.ts`

---

### ShadowDraft
Rozpracovaný, neviditelný návrh inzerátu vytvořený naší Levou hemisférou. Prodejce ho uvidí až po kliknutí na Magic Link.

*Odkazy (Zdroj pravdy):*
- `spine/domain/core-types/schemas.ts`

---

### StaleOpportunityReaper
Reaper pravidelně prochází aktivní Shadow Drafts, ke kterým jsme vytvořili Magic Linky. Provede rychlý HEAD ping na původní sourceUrl cizího portálu. Pokud vrátí 404 (nebo přesměrování s indikací smazání), okamžitě odesílá event `opportunity_dead`. Tento event chytí levá hemisféra (Auction24) a draft i link zneplatní.

*Odkazy (Zdroj pravdy):*
- `spine/demand/acquisition/deep-inventory/stale-reaper/reaper.ts`

---

### Vehicle
Normalizovaná reprezentace stroje v našem katalogu.

*Odkazy (Zdroj pravdy):*
- `spine/domain/core-types/schemas.ts`

---

