# Antigravity Vector-Tree Architecture Map

Tento soubor byl automaticky vygenerován pro poskytnutí maximálního kontextu AI agentům.

## 🗺️ Topologie Uzlů (Mermaid Graf)

```mermaid
graph TD
  supply["supply (supply)"]
  style supply stroke:#00cc66,stroke-width:1px
  demand["demand (demand)"]
  style demand stroke:#ff9900,stroke-width:2px
  sale["sale (sale)"]
  style sale stroke:#ff9900,stroke-width:2px
  engine["engine (engine)"]
  style engine stroke:#ff9900,stroke-width:2px
  platform["platform (platform)"]
  style platform stroke:#00cc66,stroke-width:1px
  outreach-dashboard["outreach-dashboard (platform)"]
  style outreach-dashboard stroke:#00cc66,stroke-width:1px
  demand-search["demand-search (spine)"]
  style demand-search stroke:#ff9900,stroke-width:2px
  auth["auth (platform)"]
  style auth stroke:#00cc66,stroke-width:1px
  account["account (spine)"]
  style account stroke:#ff9900,stroke-width:2px
  engine-learn["engine-learn (engine)"]
  style engine-learn stroke:#3399ff,stroke-width:3px,fill:#cce5ff,color:#333
  engine-drive["engine-drive (engine)"]
  style engine-drive stroke:#3399ff,stroke-width:3px,fill:#cce5ff,color:#333
```

## 🗂️ Seznam Uzlů

### `supply`
- **Cesta:** `spine/supply`
- **Osa příběhu (Story Axis):** supply
- **Stav:** met

### `demand`
- **Cesta:** `spine/demand`
- **Osa příběhu (Story Axis):** demand
- **Stav:** pending

### `sale`
- **Cesta:** `spine/sale`
- **Osa příběhu (Story Axis):** sale
- **Stav:** pending

### `engine`
- **Cesta:** `spine/engine`
- **Osa příběhu (Story Axis):** engine
- **Stav:** pending

### `platform`
- **Cesta:** `spine/platform/platform`
- **Osa příběhu (Story Axis):** platform
- **Stav:** met

### `outreach-dashboard`
- **Cesta:** `spine/platform/outreach-dashboard`
- **Osa příběhu (Story Axis):** platform
- **Stav:** met
- **Původ (Origin):** hozan-taher/features/platform

### `demand-search`
- **Cesta:** `spine/demand/search`
- **Osa příběhu (Story Axis):** spine
- **Stav:** pending

### `auth`
- **Cesta:** `spine/platform/auth`
- **Osa příběhu (Story Axis):** platform
- **Stav:** met

### `account`
- **Cesta:** `spine/platform/account`
- **Osa příběhu (Story Axis):** spine
- **Stav:** pending

### `engine-learn`
- **Cesta:** `spine/engine/learn`
- **Osa příběhu (Story Axis):** engine
- **Stav:** pending
- **Původ (Origin):** frontier
- **Tagy:** action-graph, selectors, replay-model

### `engine-drive`
- **Cesta:** `spine/engine/drive`
- **Osa příběhu (Story Axis):** engine
- **Stav:** met
- **Původ (Origin):** frontier
- **Tagy:** session, read, write, rate-policy

