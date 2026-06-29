# Antigravity: The Frontiers Architecture

Tento dokument definuje globální topologii repozitáře Antigravity. Architektura je postavena na principu "Dokonalé symfonie hemisfér" a je rozdělena na tři vrstvy: Engine (Mozek), Spine (Páteř) a Frontiers (Hranice).

## 1. SRC/ (Kognitivní Mozek)
Složka `src/engine/` představuje mozek celého systému. Zde běží procesy na pozadí a autonomní orchestrace obou hemisfér.
- **`learn/` (Pravá hemisféra):** Abstrakce portálů a LLM analyzátory (čtení světa).
- **`drive/` (Levá hemisféra):** Exekutiva.
  - **`shadow-broker/`:** Tvorba "stínových draftů" a konverze bez CAC.
  - **`arbitrage-miner/`:** Detekce podceněných aktiv a B2B flotil na trhu.

## 2. SPINE/ (Sdílená Byznysová Páteř)
Zde sídlí 100 % byznysové logiky. Žádný kód v této složce není specifický pro jeden portál. Všechny aplikace čerpají odtud.
- **`acquisition/`**: Těžba a lov datasetů (scrapers, classify-icp).
- **`outreach/`**: Ofenzivní komunikace (anti-trace, campaign-scheduler).
- **`inbound/`**: Defenzivní zpracování (imap-poll, reply-classify).
- **`supply/`**: Nabídka a inventář (auction-items, vehicle-vin, bidding).
- **`demand/`**: Poptávka a kupci (search, saved-search, recommendation).
- **`sale/`**: Uzavření obchodu (sale-settlement, invoicing, deposit-billing).
- **`compliance/`**: Ochrana a právo (privacy-gateway, audit-log).
- **`platform/`**: Infrastruktura, UI a Identity (design-system, auth-account).

## 3. FRONTIERS/ (Hranice / Dříve: Portals)
Frontiers jsou "tenké" vrstvy pro styk se světem. Aplikace už nejsou izolovány jako "produkty" s vlastní logikou. Jsou to jen brány pro uživatele nebo stroje.
- **`marketplace-web/` (Dříve: auction24)**: Fyzické B2C/B2B tržiště. Nuxt.js fronted. Natahuje `spine/supply` a `spine/demand`.
- **`operator-console/` (Dříve: hozan-taher/outreach-dashboard)**: Velení pro tvůj tým a agenty (Vue/React). Natahuje `spine/acquisition` a `spine/outreach`.
- **`privacy-gateway/`**: Golang Daemon. Ochrana anonymity nabízejících (Proxy).
- **`mail-relay/`**: Golang Daemon. Obaluje logiku ze `spine/outreach/relay`.

**PRAVIDLO:** Do složky `frontiers/` se NIKDY nepíše byznysová logika. Vše se vkládá do `spine/` a ve `frontiers/` se pouze konzumuje (přes symlink nebo build mechanismus).
