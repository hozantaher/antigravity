# Antigravity Phase Plan (Lift & Shift Migration)

Tento plán jasně definuje postup migrace legacy kódu (z karantény `products/`) do nového Vector-Tree Enginu (`spine/`). 
Postupuje se striktně od závislostí nejnižší úrovně (Bezpečnost, Účty) až po byznysové vrcholy (Prodej, Aukce).

---

## 🏗️ FÁZE 1: PLATFORM CORE & SECURITY (Nezbytné základy)
*Bez dokončení této fáze nelze stavět byznys logiku – všechny ostatní domény závisí na identitě a bezpečnosti.*

- [x] **`spine/platform/audit`** *(Frontier)* – Auditní stopa (Append-only).
- [x] **`spine/platform/compliance`** *(Frontier)* – Compliance checks.
- [x] **`spine/platform/security/auth-account`** *(Auction24)* – SSO, Login, Sessions (Proof of Concept hotov).
- [x] **`spine/platform/security/api-tokens`** *(Auction24)* – API klíče a přístupy (Proof of Concept hotov).
- [x] **`spine/platform/security/privacy-gateway`** *(Hozan Taher)* – Go SMTP relay, E2E šifrování.
- [x] **`spine/platform/compliance/dsr`** *(Hozan Taher)* – GDPR výmazy.
- [x] **`spine/platform/compliance/suppression`** *(Hozan Taher)* – Blacklisty a odhlášení z emailů.
- [x] **`spine/platform/ui/design-system`** *(Auction24)* – Base komponenty a CSS/SCSS tokeny pro budoucí dashboardy.

---

## 🧠 FÁZE 2: ENGINE & DEMAND (Data, AI a Akvizice)
*Stavíme mozek platformy a napojujeme zdroje dat z vnějšku. Uživatelé (z Fáze 1) dostávají první data k interakci.*

- [x] **`spine/demand/search`** *(Frontier)* – Boti a vyhledávací vrstva.
- [x] **`spine/engine/intelligence/relay`** *(Hozan Taher)* – LLM/Ollama Runner & Jádro pro odesílání emailů s rotací IP.
- [x] **`spine/engine/automation/worker`** *(Hozan Taher)* – Zpracování PDF a asynchronní tásky.
- [x] **`spine/demand/acquisition/firmy-cz`** *(Hozan Taher)* – Akvizice subjektů (Go Scraper).
- [x] **`spine/demand/inbound/inbox-orchestrator`** *(Hozan Taher)* – Zpracování webhooků a příchozí komunikace.
- [x] **`spine/demand/user/saved-search`** *(Auction24)* – Sledování poptávky pro uživatele.
- [x] **`spine/demand/user/favorites`** *(Auction24)* – Oblíbené položky uživatelů.

---

## 📦 FÁZE 3: SUPPLY & WORKSPACE (Inventář a Dashboard)
*Inventarizace nasbíraných dat. Zde vytváříme konkrétní produkty a jejich administraci.*

- [x] **`spine/supply/market/auction-items`** *(Auction24)* – CRUD vozidel a předmětů v aukci.
- [x] **`spine/supply/asset/vehicle-vin`** *(Auction24)* – VIN dekodér a metadatové služby.
- [x] **`spine/supply/asset/media-upload`** *(Auction24)* – Zpracování obrázků, Pano-360 a multimédií.
- [x] **`spine/platform/ui/dashboard-core`** *(Hozan Taher)* – Vykreslení hlavního React UI pro administraci.
- [x] **`spine/platform/ui/dashboard-bff`** *(Hozan Taher)* – Backend-For-Frontend můstek pro klientské rozhraní.

---

## 💰 FÁZE 4: SALE & MONETIZATION (Prodej a Transakce)
*Konečná fáze, kde se Nabídka (Fáze 3) setkává s Poptávkou (Fáze 2) za asistence Bezpečnosti (Fáze 1).*

- [x] **`spine/supply/market/bidding`** *(Auction24)* – Real-time Bidding engine (WebSockety).
- [x] **`spine/sale/checkout/deposit-billing`** *(Auction24)* – Skládání kaucí uživateli přes platební bránu (Fio match).
- [x] **`spine/sale/settlement/sale-settlement`** *(Auction24)* – Vypořádání financí a vlastnictví po skončení aukce.
- [x] **`spine/sale/checkout/invoicing`** *(Auction24)* – Generátor PDF faktur a Fakturoid Sync.
- [x] **`spine/sale/support/disputes-complaints`** *(Auction24)* – Řešení stížností a sporů.

---
*Pravidla pro vývojáře: Každý modul se přesouvá striktně metodou Lift & Shift s využitím `node dist/index.js create <ID>` pro prevenci architektonického driftu.*
