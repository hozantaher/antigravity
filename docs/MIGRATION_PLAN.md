# Antigravity Migration Plan (10x Deep Inventory)

Tento dokument mapuje budoucí strukturu repozitáře po kompletním přesunu aplikací **Auction24**, **Hozan Taher** a **Frontier** (tzv. metoda Lift & Shift).

Kódová základna se roztřídí do 5 byznysových os (Story Axis). Každý bod v seznamu představuje fyzický uzel ve `spine/` a má svůj `vektor.json`.

## 1. 🌪️ DEMAND (Poptávka)
Moduly přivádějící uživatele a stroje.
- `spine/demand/acquisition/scrapers` (Hozan Taher - Go)
- `spine/demand/acquisition/firmy-cz` (Hozan Taher - Go)
- `spine/demand/outreach/scheduler` (Hozan Taher - Go)
- `spine/demand/inbound/inbox-orchestrator` (Hozan Taher - Go)
- [x] `spine/demand/search` (Frontier - Boti)
- `spine/demand/user/favorites` (Auction24 - Nuxt/Vue)
- `spine/demand/user/saved-search` (Auction24 - Nuxt/Vue)
- `spine/demand/marketing/newsletter` (Auction24)

## 2. 📦 SUPPLY (Inventář a Nabídka)
Moduly udržující data o trhu a vozidlech.
- `spine/supply/market/bidding` (Auction24 - Bidding engine, WebSockety)
- `spine/supply/market/auction-items` (Auction24 - CRUD aukcí)
- `spine/supply/asset/vehicle-vin` (Auction24 - Dekodér VIN)
- `spine/supply/asset/media-upload` (Auction24 - Zpracování médií)

## 3. 💰 SALE (Transakce a Peníze)
Zde se Poptávka potkává s Nabídkou a vzniká zisk.
- `spine/sale/checkout/deposit-billing` (Auction24 - Kauce)
- `spine/sale/checkout/invoicing` (Auction24 - Fakturace PDF)
- `spine/sale/settlement/sale-settlement` (Auction24 - Vypořádání)
- `spine/sale/support/disputes-complaints` (Auction24 - Spory)

## 4. ⚙️ ENGINE (Autonomní mozek)
Logika, která roztáčí Flywheel efekt, aby ekosystém žil autonomně.
- `spine/engine/recommendation/affinity` (Auction24 - Doporučování AI)
- `spine/engine/intelligence/llm-runner` (Hozan Taher - Ollama integrace)
- `spine/engine/automation/worker` (Hozan Taher - Zpracování PDF)
- `spine/engine/frontier/core-loop` (Frontier - `discover → learn → drive`)

## 5. 🏗️ PLATFORM (Základová deska)
Infrastruktura sdílená všemi osami.
- `spine/platform/security/privacy-gateway` (Hozan Taher - E-mailová bezpečnostní brána)
- `spine/platform/security/auth-account` (Auction24 - SSO Identity provider)
- `spine/platform/compliance/dsr` (Hozan Taher - GDPR a výmazy)
- [x] `spine/platform/audit` (Frontier - Auditní stopa)
- [x] `spine/platform/compliance` (Frontier - Compliance checks)
- `spine/platform/compliance/suppression` (Hozan Taher - Blacklisty)
- `spine/platform/ui/dashboard-core` (Hozan Taher - React UI)
- `spine/platform/ui/dashboard-bff` (Hozan Taher - BFF backend)
- `spine/platform/ui/design-system` (Auction24 - Nuxt/Vue base komponenty)
- `spine/platform/api/mcp` (Hozan Taher - Nativní MCP AI Server pro LLM agenty)

---
*Vygenerováno nástrojem Antigravity Vector-Tree Engine během hloubkového auditu projektů.*
