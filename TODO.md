# Projektové TODO

## DevOps / MLOps Automatizace
- [ ] **Přesun AI a Audit automatizací mimo lokální stroj (Zamezení závislosti na zapnutém PC)**
  - Z migrovat Jules Nightwatch (`npm run ag:jules`) do Github Actions (noční spouštění ve 02:00) nebo na VPS server.
  - Z migrovat Cybernetic Audit (`npm run ag:audit --heal && npm run ag:map`) do Github Actions (po každém pushi do masteru / každou hodinu) nebo do PM2/cronu na VPS.
  - Zajistit, aby reporty z těchto procesů byly stále notifikovány v příslušných kanálech.


## Implementace: Symfonie Hemisfér (+100M Scale)
- [ ] **Fáze 1: Vybudování Očí (Deep Scraping)**
  - Implementovat `spine/demand/acquisition/deep-inventory/scraper.ts` pro stahování reálných dat z portálů (Playwright / Cheerio).
  - Nahradit testovací mocky v `arbitrage-miner` reálným příjmem dat ze scraperu.
- [ ] **Fáze 2: Mozková Kůra (LLM Scoring)**
  - V uzlu `relay` napojit `logic.ts` na skutečné LLM API (OpenAI/Anthropic).
  - Propojit `arbitrage-miner` s `relay` pro výpočet sémantického skóre inzerátu (`arbitrage_score`).
- [ ] **Fáze 3: Skutečná Exekuce a Magické Linky (Shadow Brokerage)**
  - V `shadow-broker` nahradit timeout plnohodnotným vytvořením databázového stínového inzerátu (Auction24).
  - Přes `privacy-gateway` vygenerovat JWT Magický Link a nastavit odesílání na kontakty prodejce.
- [ ] **Fáze 4: Perzistence Fronty (BullMQ / Redis)**
  - Zcela odstranit `EventEmitter` z uzlu `symphony-queue`.
  - Nasadit BullMQ s Dead Letter Queue, transakčním Acknowledgmentem a řízením backpressure.
