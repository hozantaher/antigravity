# Projektové TODO

## DevOps / MLOps Automatizace
- [x] **Přesun AI a Audit automatizací mimo lokální stroj (Zamezení závislosti na zapnutém PC)**
  - Z migrovat Jules Nightwatch (`npm run ag:jules`) do Railway Cron Jobu (noční spouštění).
  - Backend připraven přes `Dockerfile` a `docker-compose.yml`.


## Implementace: Symfonie Hemisfér (+100M Scale)
- [x] **Fáze 1: Vybudování Očí (Deep Scraping)**
  - Implementovat `spine/demand/acquisition/deep-inventory/scraper.ts` pro stahování reálných dat z portálů (Playwright / Cheerio).
  - Nahradit testovací mocky v `arbitrage-miner` reálným příjmem dat ze scraperu.
- [x] **Fáze 2: Mozková Kůra (LLM Scoring)**
  - V uzlu `relay` napojit `logic.ts` na skutečné LLM API (OpenAI/Anthropic).
  - Propojit `arbitrage-miner` s `relay` pro výpočet sémantického skóre inzerátu (`arbitrage_score`).
- [x] **Fáze 3: Skutečná Exekuce a Magické Linky (Shadow Brokerage)**
  - V `shadow-broker` nahradit timeout plnohodnotným vytvořením databázového stínového inzerátu (Auction24).
  - Přes `privacy-gateway` vygenerovat JWT Magický Link a nastavit odesílání na kontakty prodejce.
- [x] **Fáze 4: Perzistence Fronty (BullMQ / Redis)**
  - Zcela odstranit `EventEmitter` z uzlu `symphony-queue`.
  - Nasadit BullMQ s Dead Letter Queue, transakčním Acknowledgmentem a řízením backpressure.
