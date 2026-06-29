# Antigravity Testing Implementation Plan

Tento plán popisuje fázovaný postup nasazení testovací architektury (The Expanded Shield Map) do Antigravity ekosystému. Postupujeme od nejkritičtějších a nejlevnějších testů po ty nejsložitější.

## 🏁 Fáze 1: Nastavení Infrastruktury (The Sandbox Foundation)
Než napíšeme jediný test, musíme vybudovat ochranné vrstvy (sandboxy), aby žádný agent nebo test nemohl omylem sáhnout na reálné peníze nebo API limity.

1. **Instalace knihoven:** Přidání `msw` (Mock Service Worker) a nástrojů pro nahrávání HTTP kazet (VCR pro TS).
2. **Setup Vitest Prostředí:** Vytvoření souboru `vitest.setup.ts`, který globálně zablokuje veškerý odchozí HTTP provoz, pokud test explicitně nevyžádá VCR kazetu.
3. **Příprava in-memory mocků:** Konfigurace `ioredis-mock` pro simulaci BullMQ (Symphony) v paměti počítače.

## 🏛️ Fáze 2: CORE a BODY (Integrita a Parsování bez sítě)
Zajištění datové integrity a rychlého testování scraperů bez banování IP adres z cílových trhů.

1. **CORE Validátory:** Vytvoření `schemas.test.ts` ve `spine/domain/core-types`. Zde pustíme tzv. *Fuzz testing* (bombardování Zod schémat nesmyslnými daty od umělé inteligence), abychom ověřili odolnost schémat (např. ošetření záporných cen nebo nesmyslných výbav).
2. **BODY HTML Snapshots:** Půjdeme do uzlů `scraper-mobile-de` a `scraper-mascus-cz` (frontiers). Stáhneme aktuální stránky z webu a uložíme je do složek `__fixtures__/`.
3. **Odříznutí scraperů od internetu:** Upravíme testy scraperů tak, aby četly stažené snapshoty místo toho, aby prováděly Axios/Puppeteer dotazy do světa. Testy tak poběží v milisekundách, ne v desítkách sekund.

## 🧠 Fáze 3: BRAIN (Kognitivní Testování a Ochrana API Budgetu)
Tato fáze pokrývá středobod našeho asymetrického enginu – Svatou trojici.

1. **Arbitrage Scoring (Izolovaně):** Vytvoření `dummy-market.json` (fiktivních inzerátů) ve složce `arbitrage-miner/__fixtures__`. Pustíme nad tím algoritmus a pomocí unit testů ověříme, že správně detekoval příležitosti s 20% slevou.
2. **VCR Kazety pro AI:** V uzlu `html-cleaner` vytvoříme test, který poprvé zavolá reálné OpenAI API (parametr `--run-live`). Odpověď nahrajeme do kazety (`clean-dom.json`). Od tohoto momentu poběží LLM testy na CI serveru stoprocentně zadarmo a okamžitě na replice odpovědi.

## 🦾 Fáze 4: HANDS (Testování Exekuce a Zúčtování)
Zde testujeme schopnost aplikace komunikovat ven bez rizika poškození třetích stran.

1. **Mailtrap Sandbox:** Upravíme `campaign-scheduler` tak, aby v testovacím módu všechny odchozí cold-maily posílal do lokálního Mailtrapu/Mailhogu. Následně v testu ověříme (přes Sandbox API), že zprávy obsahují personalizovaný Shadow Draft link, aniž by skutečně opustily localhost.
2. **Stripe Test Clocks:** Do `sale-settlement` implementujeme testování pomocí Stripe Time Travel (Test Clocks). Skript zalistuje vozidlo, nasimuluje kupce, a uměle v testu posune čas o 24 hodin, abychom ověřili automatickou blokaci/uvolnění kauce z testovacích kreditních karet.

## ☠️ Fáze 5: PLATFORM (Chaos Engineering a The Poison Pill)
Poslední stupeň zralosti testování – destrukční útoky na vlastní systém (Red Teaming).

1. **LLM Poison Pill:** Napsání testu `chaos-llm.test.ts`. Tento test záměrně vrátí enginu naformátovaný JSON, ale s úplně rozbitou strukturou. Cílem je ověřit, že Symphony queue to chytí, uzel `worker` nespadne a systém přesměruje vadnou úlohu do fronty pro mrtvé zprávy (Dead-Letter Queue).
2. **Database Drop:** Test `chaos-db.test.ts`, který uprostřed složité finanční transakce simulovaně odstřihne Kysely (Postgres). Ověřujeme bezchybný Rollback a stav databáze po havárii.

---
*Tento dokument byl vytvořen na základě The Expanded Shield Map. Slouží jako roadmapa pro budoucí vývoj agenty.*
