# Antigravity Vector-Tree Architecture Map

Tento soubor byl automaticky vygenerován pro poskytnutí maximálního kontextu AI agentům.

## 🗺️ Topologie Uzlů (Mermaid Graf)

```mermaid
graph TD
  supply["supply (supply)"]
  style supply stroke:#ff9900,stroke-width:2px
  sale["sale (sale)"]
  style sale stroke:#ff9900,stroke-width:2px
  engine["engine (engine)"]
  style engine stroke:#ff9900,stroke-width:2px
  demand["demand (demand)"]
  style demand stroke:#ff9900,stroke-width:2px
  platform["platform (platform)"]
  style platform stroke:#00cc66,stroke-width:1px
  auth["auth (platform)"]
  style auth stroke:#00cc66,stroke-width:1px
  account["account (spine)"]
  style account stroke:#ff9900,stroke-width:2px
  outreach-dashboard["outreach-dashboard (platform)"]
  style outreach-dashboard stroke:#00cc66,stroke-width:1px
  engine-drive["engine-drive (engine)"]
  style engine-drive stroke:#3399ff,stroke-width:3px,fill:#cce5ff,color:#333
  engine-learn["engine-learn (engine)"]
  style engine-learn stroke:#3399ff,stroke-width:3px,fill:#cce5ff,color:#333
  demand-search["demand-search (spine)"]
  style demand-search stroke:#ff9900,stroke-width:2px
  auction-items["auction-items (spine)"]
  style auction-items stroke:#ff9900,stroke-width:2px
  bidding["bidding (spine)"]
  style bidding stroke:#ff9900,stroke-width:2px
  media-upload["media-upload (spine)"]
  style media-upload stroke:#ff9900,stroke-width:2px
  sale-settlement["sale-settlement (spine)"]
  style sale-settlement stroke:#ff9900,stroke-width:2px
  disputes-complaints["disputes-complaints (spine)"]
  style disputes-complaints stroke:#ff9900,stroke-width:2px
  vehicle-vin["vehicle-vin (spine)"]
  style vehicle-vin stroke:#ff9900,stroke-width:2px
  invoicing["invoicing (spine)"]
  style invoicing stroke:#ff9900,stroke-width:2px
  design-system["design-system (spine)"]
  style design-system stroke:#00cc66,stroke-width:1px
  deposit-billing["deposit-billing (spine)"]
  style deposit-billing stroke:#ff9900,stroke-width:2px
  dashboard-bff["dashboard-bff (spine)"]
  style dashboard-bff stroke:#ff9900,stroke-width:2px
  privacy-gateway["privacy-gateway (spine)"]
  style privacy-gateway stroke:#00cc66,stroke-width:1px
  api-tokens["api-tokens (spine)"]
  style api-tokens stroke:#00cc66,stroke-width:1px
  dashboard-core["dashboard-core (spine)"]
  style dashboard-core stroke:#ff9900,stroke-width:2px
  suppression["suppression (spine)"]
  style suppression stroke:#00cc66,stroke-width:1px
  dsr["dsr (spine)"]
  style dsr stroke:#00cc66,stroke-width:1px
  shadow-broker["shadow-broker (spine)"]
  style shadow-broker stroke:#ff9900,stroke-width:2px
  worker["worker (spine)"]
  style worker stroke:#00cc66,stroke-width:1px
  relay["relay (spine)"]
  style relay stroke:#00cc66,stroke-width:1px
  saved-search["saved-search (spine)"]
  style saved-search stroke:#00cc66,stroke-width:1px
  arbitrage-miner["arbitrage-miner (spine)"]
  style arbitrage-miner stroke:#ff9900,stroke-width:2px
  favorites["favorites (spine)"]
  style favorites stroke:#00cc66,stroke-width:1px
  inbox-orchestrator["inbox-orchestrator (spine)"]
  style inbox-orchestrator stroke:#00cc66,stroke-width:1px
  firmy-cz["firmy-cz (spine)"]
  style firmy-cz stroke:#00cc66,stroke-width:1px
  deep-inventory["deep-inventory (spine)"]
  style deep-inventory stroke:#ff9900,stroke-width:2px
```

## 🗂️ Seznam Uzlů

### `supply`
- **Cesta:** `spine/supply`
- **Osa příběhu (Story Axis):** supply
- **Stav:** pending

### `sale`
- **Cesta:** `spine/sale`
- **Osa příběhu (Story Axis):** sale
- **Stav:** pending

### `engine`
- **Cesta:** `spine/engine`
- **Osa příběhu (Story Axis):** engine
- **Stav:** pending

### `demand`
- **Cesta:** `spine/demand`
- **Osa příběhu (Story Axis):** demand
- **Stav:** pending

### `platform`
- **Cesta:** `spine/platform/platform`
- **Osa příběhu (Story Axis):** platform
- **Stav:** met

### `auth`
- **Cesta:** `spine/platform/auth`
- **Osa příběhu (Story Axis):** platform
- **Stav:** met

### `account`
- **Cesta:** `spine/platform/account`
- **Osa příběhu (Story Axis):** spine
- **Stav:** pending

### `outreach-dashboard`
- **Cesta:** `spine/platform/outreach-dashboard`
- **Osa příběhu (Story Axis):** platform
- **Stav:** met
- **Původ (Origin):** hozan-taher/features/platform

### `engine-drive`
- **Cesta:** `spine/engine/drive`
- **Osa příběhu (Story Axis):** engine
- **Stav:** pending
- **Původ (Origin):** frontier
- **Tagy:** session, read, write, rate-policy

### `engine-learn`
- **Cesta:** `spine/engine/learn`
- **Osa příběhu (Story Axis):** engine
- **Stav:** pending
- **Původ (Origin):** frontier
- **Tagy:** action-graph, selectors, replay-model

### `demand-search`
- **Cesta:** `spine/demand/search`
- **Osa příběhu (Story Axis):** spine
- **Stav:** pending

### `auction-items`
- **Cesta:** `spine/supply/market/auction-items`
- **Osa příběhu (Story Axis):** spine
- **Stav:** pending

### `bidding`
- **Cesta:** `spine/supply/market/bidding`
- **Osa příběhu (Story Axis):** spine
- **Stav:** pending

### `media-upload`
- **Cesta:** `spine/supply/asset/media-upload`
- **Osa příběhu (Story Axis):** spine
- **Stav:** pending

### `sale-settlement`
- **Cesta:** `spine/sale/settlement/sale-settlement`
- **Osa příběhu (Story Axis):** spine
- **Stav:** pending

### `disputes-complaints`
- **Cesta:** `spine/sale/support/disputes-complaints`
- **Osa příběhu (Story Axis):** spine
- **Stav:** pending

### `vehicle-vin`
- **Cesta:** `spine/supply/asset/vehicle-vin`
- **Osa příběhu (Story Axis):** spine
- **Stav:** pending

### `invoicing`
- **Cesta:** `spine/sale/checkout/invoicing`
- **Osa příběhu (Story Axis):** spine
- **Stav:** pending

### `design-system`
- **Cesta:** `spine/platform/ui/design-system`
- **Osa příběhu (Story Axis):** spine
- **Stav:** met

### `deposit-billing`
- **Cesta:** `spine/sale/checkout/deposit-billing`
- **Osa příběhu (Story Axis):** spine
- **Stav:** pending

### `dashboard-bff`
- **Cesta:** `spine/platform/ui/dashboard-bff`
- **Osa příběhu (Story Axis):** spine
- **Stav:** pending

### `privacy-gateway`
- **Cesta:** `spine/platform/security/privacy-gateway`
- **Osa příběhu (Story Axis):** spine
- **Stav:** met

### `api-tokens`
- **Cesta:** `spine/platform/security/api-tokens`
- **Osa příběhu (Story Axis):** spine
- **Stav:** met

### `dashboard-core`
- **Cesta:** `spine/platform/ui/dashboard-core`
- **Osa příběhu (Story Axis):** spine
- **Stav:** pending

### `suppression`
- **Cesta:** `spine/platform/compliance/suppression`
- **Osa příběhu (Story Axis):** spine
- **Stav:** met

### `dsr`
- **Cesta:** `spine/platform/compliance/dsr`
- **Osa příběhu (Story Axis):** spine
- **Stav:** met

### `shadow-broker`
- **Cesta:** `spine/engine/drive/shadow-broker`
- **Osa příběhu (Story Axis):** spine
- **Stav:** pending

### `worker`
- **Cesta:** `spine/engine/automation/worker`
- **Osa příběhu (Story Axis):** spine
- **Stav:** met

### `relay`
- **Cesta:** `spine/engine/intelligence/relay`
- **Osa příběhu (Story Axis):** spine
- **Stav:** met

### `saved-search`
- **Cesta:** `spine/demand/user/saved-search`
- **Osa příběhu (Story Axis):** spine
- **Stav:** met

### `arbitrage-miner`
- **Cesta:** `spine/engine/intelligence/arbitrage-miner`
- **Osa příběhu (Story Axis):** spine
- **Stav:** pending

### `favorites`
- **Cesta:** `spine/demand/user/favorites`
- **Osa příběhu (Story Axis):** spine
- **Stav:** met

### `inbox-orchestrator`
- **Cesta:** `spine/demand/inbound/inbox-orchestrator`
- **Osa příběhu (Story Axis):** spine
- **Stav:** met

### `firmy-cz`
- **Cesta:** `spine/demand/acquisition/firmy-cz`
- **Osa příběhu (Story Axis):** spine
- **Stav:** met

### `deep-inventory`
- **Cesta:** `spine/demand/acquisition/deep-inventory`
- **Osa příběhu (Story Axis):** spine
- **Stav:** pending

