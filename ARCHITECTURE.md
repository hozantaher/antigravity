# Antigravity Vector-Tree Architecture Map

Tento soubor byl automaticky vygenerován pro poskytnutí maximálního kontextu AI agentům.

## 🗺️ Topologie Uzlů (Mermaid Graf)

```mermaid
graph TD
  supply["supply (supply)"]
  style supply stroke:#ff9900,stroke-width:2px
  sale["sale (sale)"]
  style sale stroke:#ff9900,stroke-width:2px
  platform["platform (platform)"]
  style platform stroke:#ff9900,stroke-width:2px
  demand["demand (demand)"]
  style demand stroke:#ff9900,stroke-width:2px
  engine["engine (engine)"]
  style engine stroke:#ff9900,stroke-width:2px
  demo-invoicing["demo-invoicing (sale)"]
  style demo-invoicing stroke:#ff9900,stroke-width:2px
  platform-heal["platform-heal (platform)"]
  style platform-heal stroke:#3399ff,stroke-width:3px,fill:#cce5ff,color:#333
  demand-discover["demand-discover (demand)"]
  style demand-discover stroke:#3399ff,stroke-width:3px,fill:#cce5ff,color:#333
  platform-core["platform-core (platform)"]
  style platform-core stroke:#3399ff,stroke-width:3px,fill:#cce5ff,color:#333
  engine-learn["engine-learn (engine)"]
  style engine-learn stroke:#3399ff,stroke-width:3px,fill:#cce5ff,color:#333
  engine-drive["engine-drive (engine)"]
  style engine-drive stroke:#3399ff,stroke-width:3px,fill:#cce5ff,color:#333
  undefined["undefined (unknown)"]
  style undefined stroke:#00cc66,stroke-width:1px
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

### `platform`
- **Cesta:** `spine/platform`
- **Osa příběhu (Story Axis):** platform
- **Stav:** pending

### `demand`
- **Cesta:** `spine/demand`
- **Osa příběhu (Story Axis):** demand
- **Stav:** pending

### `engine`
- **Cesta:** `spine/engine`
- **Osa příběhu (Story Axis):** engine
- **Stav:** pending

### `demo-invoicing`
- **Cesta:** `spine/sale/demo-invoicing`
- **Osa příběhu (Story Axis):** sale
- **Stav:** pending

### `platform-heal`
- **Cesta:** `spine/platform/heal`
- **Osa příběhu (Story Axis):** platform
- **Stav:** pending
- **Původ (Origin):** frontier
- **Tagy:** drift-detect, re-map, trust

### `demand-discover`
- **Cesta:** `spine/demand/discover`
- **Osa příběhu (Story Axis):** demand
- **Stav:** pending
- **Původ (Origin):** frontier
- **Tagy:** crawl, fingerprint, bot, discovery

### `platform-core`
- **Cesta:** `spine/platform/core`
- **Osa příběhu (Story Axis):** platform
- **Stav:** pending
- **Původ (Origin):** frontier
- **Tagy:** compliance, audit, credential-vault, proxy-egress

### `engine-learn`
- **Cesta:** `spine/engine/learn`
- **Osa příběhu (Story Axis):** engine
- **Stav:** pending
- **Původ (Origin):** frontier
- **Tagy:** action-graph, selectors, replay-model

### `engine-drive`
- **Cesta:** `spine/engine/drive`
- **Osa příběhu (Story Axis):** engine
- **Stav:** pending
- **Původ (Origin):** frontier
- **Tagy:** session, read, write, rate-policy

### `undefined`
- **Cesta:** `spine/engine/drive/read`
- **Osa příběhu (Story Axis):** N/A
- **Stav:** met

