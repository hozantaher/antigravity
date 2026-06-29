# Antigravity Vector-Tree Architecture Map

Tento soubor byl automaticky vygenerován pro poskytnutí maximálního kontextu AI agentům.

## 🗺️ Topologie Uzlů (Mermaid Graf)

```mermaid
graph TD
  sale["sale (sale)"]
  style sale stroke:#ff9900,stroke-width:2px
  supply["supply (supply)"]
  style supply stroke:#ff9900,stroke-width:2px
  demand["demand (demand)"]
  style demand stroke:#ff9900,stroke-width:2px
  engine["engine (engine)"]
  style engine stroke:#ff9900,stroke-width:2px
  sale-settlement["sale-settlement (sale)"]
  style sale-settlement stroke:#ff9900,stroke-width:2px
  resolution["resolution (sale)"]
  style resolution stroke:#00cc66,stroke-width:1px
  invoicing["invoicing (sale)"]
  style invoicing stroke:#ff9900,stroke-width:2px
  reconcile["reconcile (sale)"]
  style reconcile stroke:#00cc66,stroke-width:1px
  invoice-list["invoice-list (sale)"]
  style invoice-list stroke:#00cc66,stroke-width:1px
  fakturoid-sync["fakturoid-sync (sale)"]
  style fakturoid-sync stroke:#00cc66,stroke-width:1px
  disputes-complaints["disputes-complaints (sale)"]
  style disputes-complaints stroke:#ff9900,stroke-width:2px
  framing["framing (sale)"]
  style framing stroke:#00cc66,stroke-width:1px
  deposit-billing["deposit-billing (sale)"]
  style deposit-billing stroke:#ff9900,stroke-width:2px
  charge-once["charge-once (sale)"]
  style charge-once stroke:#00cc66,stroke-width:1px
  completion["completion (sale)"]
  style completion stroke:#00cc66,stroke-width:1px
  case-open["case-open (sale)"]
  style case-open stroke:#00cc66,stroke-width:1px
  amount-due["amount-due (sale)"]
  style amount-due stroke:#00cc66,stroke-width:1px
  outreach["outreach (outreach)"]
  style outreach stroke:#00cc66,stroke-width:1px
  vehicle-vin["vehicle-vin (supply)"]
  style vehicle-vin stroke:#ff9900,stroke-width:2px
  specs-before-bid["specs-before-bid (supply)"]
  style specs-before-bid stroke:#00cc66,stroke-width:1px
  soft-close["soft-close (supply)"]
  style soft-close stroke:#00cc66,stroke-width:1px
  pano-360["pano-360 (supply)"]
  style pano-360 stroke:#00cc66,stroke-width:1px
  billing-capture["billing-capture (sale)"]
  style billing-capture stroke:#00cc66,stroke-width:1px
  media-upload["media-upload (supply)"]
  style media-upload stroke:#ff9900,stroke-width:2px
  eligibility["eligibility (supply)"]
  style eligibility stroke:#00cc66,stroke-width:1px
  detail-order["detail-order (supply)"]
  style detail-order stroke:#00cc66,stroke-width:1px
  empty-state["empty-state (supply)"]
  style empty-state stroke:#00cc66,stroke-width:1px
  fio-match["fio-match (sale)"]
  style fio-match stroke:#00cc66,stroke-width:1px
  decode-cache["decode-cache (supply)"]
  style decode-cache stroke:#00cc66,stroke-width:1px
  concurrency["concurrency (supply)"]
  style concurrency stroke:#00cc66,stroke-width:1px
  completeness["completeness (supply)"]
  style completeness stroke:#00cc66,stroke-width:1px
  card-order["card-order (supply)"]
  style card-order stroke:#00cc66,stroke-width:1px
  bidding["bidding (supply)"]
  style bidding stroke:#ff9900,stroke-width:2px
  auction-items["auction-items (supply)"]
  style auction-items stroke:#ff9900,stroke-width:2px
  worker-pdf["worker-pdf (platform)"]
  style worker-pdf stroke:#00cc66,stroke-width:1px
  token-lifecycle["token-lifecycle (platform)"]
  style token-lifecycle stroke:#00cc66,stroke-width:1px
  token-hash["token-hash (platform)"]
  style token-hash stroke:#00cc66,stroke-width:1px
  reference-data["reference-data (platform)"]
  style reference-data stroke:#00cc66,stroke-width:1px
  protections["protections (platform)"]
  style protections stroke:#00cc66,stroke-width:1px
  platform["platform (platform)"]
  style platform stroke:#00cc66,stroke-width:1px
  outreach-dashboard["outreach-dashboard (platform)"]
  style outreach-dashboard stroke:#00cc66,stroke-width:1px
  notifications["notifications (platform)"]
  style notifications stroke:#00cc66,stroke-width:1px
  i18n["i18n (platform)"]
  style i18n stroke:#00cc66,stroke-width:1px
  design-system["design-system (platform)"]
  style design-system stroke:#00cc66,stroke-width:1px
  dashboard-bff["dashboard-bff (platform)"]
  style dashboard-bff stroke:#ff9900,stroke-width:2px
  mcp["mcp (platform)"]
  style mcp stroke:#00cc66,stroke-width:1px
  core["core (platform)"]
  style core stroke:#00cc66,stroke-width:1px
  consent-tracking["consent-tracking (platform)"]
  style consent-tracking stroke:#00cc66,stroke-width:1px
  brand-parity["brand-parity (platform)"]
  style brand-parity stroke:#00cc66,stroke-width:1px
  auth-account["auth-account (platform)"]
  style auth-account stroke:#00cc66,stroke-width:1px
  auth["auth (platform)"]
  style auth stroke:#00cc66,stroke-width:1px
  api-tokens["api-tokens (platform)"]
  style api-tokens stroke:#00cc66,stroke-width:1px
  api-docs["api-docs (platform)"]
  style api-docs stroke:#00cc66,stroke-width:1px
  admin["admin (platform)"]
  style admin stroke:#00cc66,stroke-width:1px
  account["account (spine)"]
  style account stroke:#ff9900,stroke-width:2px
  a11y["a11y (platform)"]
  style a11y stroke:#00cc66,stroke-width:1px
  inbound["inbound (inbound)"]
  style inbound stroke:#00cc66,stroke-width:1px
  unsubscribe["unsubscribe (demand)"]
  style unsubscribe stroke:#00cc66,stroke-width:1px
  url-state["url-state (demand)"]
  style url-state stroke:#00cc66,stroke-width:1px
  toggle-roundtrip["toggle-roundtrip (demand)"]
  style toggle-roundtrip stroke:#00cc66,stroke-width:1px
  send["send (demand)"]
  style send stroke:#00cc66,stroke-width:1px
  demand-search["demand-search (spine)"]
  style demand-search stroke:#ff9900,stroke-width:2px
  relevance["relevance (demand)"]
  style relevance stroke:#00cc66,stroke-width:1px
  saved-search["saved-search (demand)"]
  style saved-search stroke:#00cc66,stroke-width:1px
  recommendation["recommendation (demand)"]
  style recommendation stroke:#00cc66,stroke-width:1px
  ratings-reviews["ratings-reviews (demand)"]
  style ratings-reviews stroke:#00cc66,stroke-width:1px
  query-roundtrip["query-roundtrip (demand)"]
  style query-roundtrip stroke:#00cc66,stroke-width:1px
  pagination["pagination (demand)"]
  style pagination stroke:#00cc66,stroke-width:1px
  owner-scoped["owner-scoped (demand)"]
  style owner-scoped stroke:#00cc66,stroke-width:1px
  ordering["ordering (demand)"]
  style ordering stroke:#00cc66,stroke-width:1px
  no-duplicate["no-duplicate (demand)"]
  style no-duplicate stroke:#00cc66,stroke-width:1px
  newsletter-email["newsletter-email (demand)"]
  style newsletter-email stroke:#00cc66,stroke-width:1px
  messaging["messaging (demand)"]
  style messaging stroke:#00cc66,stroke-width:1px
  favorites["favorites (demand)"]
  style favorites stroke:#00cc66,stroke-width:1px
  facet-filter["facet-filter (demand)"]
  style facet-filter stroke:#00cc66,stroke-width:1px
  diacritics["diacritics (demand)"]
  style diacritics stroke:#00cc66,stroke-width:1px
  create["create (demand)"]
  style create stroke:#00cc66,stroke-width:1px
  contact-offers["contact-offers (demand)"]
  style contact-offers stroke:#00cc66,stroke-width:1px
  compare["compare (demand)"]
  style compare stroke:#00cc66,stroke-width:1px
  core-types["core-types (domain)"]
  style core-types stroke:#00cc66,stroke-width:1px
  engine-learn["engine-learn (engine)"]
  style engine-learn stroke:#3399ff,stroke-width:3px,fill:#cce5ff,color:#333
  engine-drive["engine-drive (engine)"]
  style engine-drive stroke:#3399ff,stroke-width:3px,fill:#cce5ff,color:#333
  dsr["dsr (compliance)"]
  style dsr stroke:#00cc66,stroke-width:1px
  suppression["suppression (compliance)"]
  style suppression stroke:#00cc66,stroke-width:1px
  compliance["compliance (compliance)"]
  style compliance stroke:#00cc66,stroke-width:1px
  firmy-cz["firmy-cz (acquisition)"]
  style firmy-cz stroke:#00cc66,stroke-width:1px
  acquisition["acquisition (acquisition)"]
  style acquisition stroke:#00cc66,stroke-width:1px
  undefined["undefined (unknown)"]
  style undefined stroke:#00cc66,stroke-width:1px
  privacy-gateway["privacy-gateway (spine)"]
  style privacy-gateway stroke:#00cc66,stroke-width:1px
  dashboard-core["dashboard-core (spine)"]
  style dashboard-core stroke:#ff9900,stroke-width:2px
  inbox-orchestrator["inbox-orchestrator (spine)"]
  style inbox-orchestrator stroke:#00cc66,stroke-width:1px
  deep-inventory["deep-inventory (spine)"]
  style deep-inventory stroke:#00cc66,stroke-width:1px
  arbitrage-miner["arbitrage-miner (spine)"]
  style arbitrage-miner stroke:#00cc66,stroke-width:1px
  worker["worker (spine)"]
  style worker stroke:#00cc66,stroke-width:1px
  shadow-broker["shadow-broker (spine)"]
  style shadow-broker stroke:#00cc66,stroke-width:1px
  relay["relay (spine)"]
  style relay stroke:#00cc66,stroke-width:1px
  symphony-queue["symphony-queue (spine)"]
  style symphony-queue stroke:#00cc66,stroke-width:1px
  search["search (demand)"]
  style search stroke:#00cc66,stroke-width:1px
```

## 🗂️ Seznam Uzlů

### `sale`
- **Cesta:** `spine/sale`
- **Osa příběhu (Story Axis):** sale
- **Stav:** pending

### `supply`
- **Cesta:** `spine/supply`
- **Osa příběhu (Story Axis):** supply
- **Stav:** pending

### `demand`
- **Cesta:** `spine/demand`
- **Osa příběhu (Story Axis):** demand
- **Stav:** pending

### `engine`
- **Cesta:** `spine/engine`
- **Osa příběhu (Story Axis):** engine
- **Stav:** pending

### `sale-settlement`
- **Cesta:** `spine/sale/sale-settlement`
- **Osa příběhu (Story Axis):** sale
- **Stav:** pending

### `resolution`
- **Cesta:** `spine/sale/resolution`
- **Osa příběhu (Story Axis):** sale
- **Stav:** met

### `invoicing`
- **Cesta:** `spine/sale/invoicing`
- **Osa příběhu (Story Axis):** sale
- **Stav:** pending

### `reconcile`
- **Cesta:** `spine/sale/reconcile`
- **Osa příběhu (Story Axis):** sale
- **Stav:** met

### `invoice-list`
- **Cesta:** `spine/sale/invoice-list`
- **Osa příběhu (Story Axis):** sale
- **Stav:** met

### `fakturoid-sync`
- **Cesta:** `spine/sale/fakturoid-sync`
- **Osa příběhu (Story Axis):** sale
- **Stav:** met

### `disputes-complaints`
- **Cesta:** `spine/sale/disputes-complaints`
- **Osa příběhu (Story Axis):** sale
- **Stav:** pending

### `framing`
- **Cesta:** `spine/sale/framing`
- **Osa příběhu (Story Axis):** sale
- **Stav:** met

### `deposit-billing`
- **Cesta:** `spine/sale/deposit-billing`
- **Osa příběhu (Story Axis):** sale
- **Stav:** pending

### `charge-once`
- **Cesta:** `spine/sale/charge-once`
- **Osa příběhu (Story Axis):** sale
- **Stav:** met

### `completion`
- **Cesta:** `spine/sale/completion`
- **Osa příběhu (Story Axis):** sale
- **Stav:** met

### `case-open`
- **Cesta:** `spine/sale/case-open`
- **Osa příběhu (Story Axis):** sale
- **Stav:** met

### `amount-due`
- **Cesta:** `spine/sale/amount-due`
- **Osa příběhu (Story Axis):** sale
- **Stav:** met

### `outreach`
- **Cesta:** `spine/outreach/outreach`
- **Osa příběhu (Story Axis):** outreach
- **Stav:** met

### `vehicle-vin`
- **Cesta:** `spine/supply/vehicle-vin`
- **Osa příběhu (Story Axis):** supply
- **Stav:** pending

### `specs-before-bid`
- **Cesta:** `spine/supply/specs-before-bid`
- **Osa příběhu (Story Axis):** supply
- **Stav:** met

### `soft-close`
- **Cesta:** `spine/supply/soft-close`
- **Osa příběhu (Story Axis):** supply
- **Stav:** met

### `pano-360`
- **Cesta:** `spine/supply/pano-360`
- **Osa příběhu (Story Axis):** supply
- **Stav:** met

### `billing-capture`
- **Cesta:** `spine/sale/billing-capture`
- **Osa příběhu (Story Axis):** sale
- **Stav:** met

### `media-upload`
- **Cesta:** `spine/supply/media-upload`
- **Osa příběhu (Story Axis):** supply
- **Stav:** pending

### `eligibility`
- **Cesta:** `spine/supply/eligibility`
- **Osa příběhu (Story Axis):** supply
- **Stav:** met

### `detail-order`
- **Cesta:** `spine/supply/detail-order`
- **Osa příběhu (Story Axis):** supply
- **Stav:** met

### `empty-state`
- **Cesta:** `spine/supply/empty-state`
- **Osa příběhu (Story Axis):** supply
- **Stav:** met

### `fio-match`
- **Cesta:** `spine/sale/fio-match`
- **Osa příběhu (Story Axis):** sale
- **Stav:** met

### `decode-cache`
- **Cesta:** `spine/supply/decode-cache`
- **Osa příběhu (Story Axis):** supply
- **Stav:** met

### `concurrency`
- **Cesta:** `spine/supply/concurrency`
- **Osa příběhu (Story Axis):** supply
- **Stav:** met

### `completeness`
- **Cesta:** `spine/supply/completeness`
- **Osa příběhu (Story Axis):** supply
- **Stav:** met

### `card-order`
- **Cesta:** `spine/supply/card-order`
- **Osa příběhu (Story Axis):** supply
- **Stav:** met

### `bidding`
- **Cesta:** `spine/supply/bidding`
- **Osa příběhu (Story Axis):** supply
- **Stav:** pending

### `auction-items`
- **Cesta:** `spine/supply/auction-items`
- **Osa příběhu (Story Axis):** supply
- **Stav:** pending

### `worker-pdf`
- **Cesta:** `spine/platform/worker-pdf`
- **Osa příběhu (Story Axis):** platform
- **Stav:** met

### `token-lifecycle`
- **Cesta:** `spine/platform/token-lifecycle`
- **Osa příběhu (Story Axis):** platform
- **Stav:** met

### `token-hash`
- **Cesta:** `spine/platform/token-hash`
- **Osa příběhu (Story Axis):** platform
- **Stav:** met

### `reference-data`
- **Cesta:** `spine/platform/reference-data`
- **Osa příběhu (Story Axis):** platform
- **Stav:** met

### `protections`
- **Cesta:** `spine/platform/protections`
- **Osa příběhu (Story Axis):** platform
- **Stav:** met

### `platform`
- **Cesta:** `spine/platform/platform`
- **Osa příběhu (Story Axis):** platform
- **Stav:** met

### `outreach-dashboard`
- **Cesta:** `spine/platform/outreach-dashboard`
- **Osa příběhu (Story Axis):** platform
- **Stav:** met
- **Původ (Origin):** hozan-taher/features/platform

### `notifications`
- **Cesta:** `spine/platform/notifications`
- **Osa příběhu (Story Axis):** platform
- **Stav:** met

### `i18n`
- **Cesta:** `spine/platform/i18n`
- **Osa příběhu (Story Axis):** platform
- **Stav:** met

### `design-system`
- **Cesta:** `spine/platform/design-system`
- **Osa příběhu (Story Axis):** platform
- **Stav:** met

### `dashboard-bff`
- **Cesta:** `spine/platform/dashboard-bff`
- **Osa příběhu (Story Axis):** platform
- **Stav:** pending

### `mcp`
- **Cesta:** `spine/platform/mcp`
- **Osa příběhu (Story Axis):** platform
- **Stav:** met

### `core`
- **Cesta:** `spine/platform/core`
- **Osa příběhu (Story Axis):** platform
- **Stav:** met

### `consent-tracking`
- **Cesta:** `spine/platform/consent-tracking`
- **Osa příběhu (Story Axis):** platform
- **Stav:** met

### `brand-parity`
- **Cesta:** `spine/platform/brand-parity`
- **Osa příběhu (Story Axis):** platform
- **Stav:** met

### `auth-account`
- **Cesta:** `spine/platform/auth-account`
- **Osa příběhu (Story Axis):** platform
- **Stav:** met

### `auth`
- **Cesta:** `spine/platform/auth`
- **Osa příběhu (Story Axis):** platform
- **Stav:** met

### `api-tokens`
- **Cesta:** `spine/platform/api-tokens`
- **Osa příběhu (Story Axis):** platform
- **Stav:** met

### `api-docs`
- **Cesta:** `spine/platform/api-docs`
- **Osa příběhu (Story Axis):** platform
- **Stav:** met

### `admin`
- **Cesta:** `spine/platform/admin`
- **Osa příběhu (Story Axis):** platform
- **Stav:** met

### `account`
- **Cesta:** `spine/platform/account`
- **Osa příběhu (Story Axis):** spine
- **Stav:** pending

### `a11y`
- **Cesta:** `spine/platform/a11y`
- **Osa příběhu (Story Axis):** platform
- **Stav:** met

### `inbound`
- **Cesta:** `spine/inbound/inbound`
- **Osa příběhu (Story Axis):** inbound
- **Stav:** met

### `unsubscribe`
- **Cesta:** `spine/demand/unsubscribe`
- **Osa příběhu (Story Axis):** demand
- **Stav:** met

### `url-state`
- **Cesta:** `spine/demand/url-state`
- **Osa příběhu (Story Axis):** demand
- **Stav:** met

### `toggle-roundtrip`
- **Cesta:** `spine/demand/toggle-roundtrip`
- **Osa příběhu (Story Axis):** demand
- **Stav:** met

### `send`
- **Cesta:** `spine/demand/send`
- **Osa příběhu (Story Axis):** demand
- **Stav:** met

### `demand-search`
- **Cesta:** `spine/demand/search`
- **Osa příběhu (Story Axis):** spine
- **Stav:** pending

### `relevance`
- **Cesta:** `spine/demand/relevance`
- **Osa příběhu (Story Axis):** demand
- **Stav:** met

### `saved-search`
- **Cesta:** `spine/demand/saved-search`
- **Osa příběhu (Story Axis):** demand
- **Stav:** met

### `recommendation`
- **Cesta:** `spine/demand/recommendation`
- **Osa příběhu (Story Axis):** demand
- **Stav:** met

### `ratings-reviews`
- **Cesta:** `spine/demand/ratings-reviews`
- **Osa příběhu (Story Axis):** demand
- **Stav:** met

### `query-roundtrip`
- **Cesta:** `spine/demand/query-roundtrip`
- **Osa příběhu (Story Axis):** demand
- **Stav:** met

### `pagination`
- **Cesta:** `spine/demand/pagination`
- **Osa příběhu (Story Axis):** demand
- **Stav:** met

### `owner-scoped`
- **Cesta:** `spine/demand/owner-scoped`
- **Osa příběhu (Story Axis):** demand
- **Stav:** met

### `ordering`
- **Cesta:** `spine/demand/ordering`
- **Osa příběhu (Story Axis):** demand
- **Stav:** met

### `no-duplicate`
- **Cesta:** `spine/demand/no-duplicate`
- **Osa příběhu (Story Axis):** demand
- **Stav:** met

### `newsletter-email`
- **Cesta:** `spine/demand/newsletter-email`
- **Osa příběhu (Story Axis):** demand
- **Stav:** met

### `messaging`
- **Cesta:** `spine/demand/messaging`
- **Osa příběhu (Story Axis):** demand
- **Stav:** met

### `favorites`
- **Cesta:** `spine/demand/favorites`
- **Osa příběhu (Story Axis):** demand
- **Stav:** met

### `facet-filter`
- **Cesta:** `spine/demand/facet-filter`
- **Osa příběhu (Story Axis):** demand
- **Stav:** met

### `diacritics`
- **Cesta:** `spine/demand/diacritics`
- **Osa příběhu (Story Axis):** demand
- **Stav:** met

### `create`
- **Cesta:** `spine/demand/create`
- **Osa příběhu (Story Axis):** demand
- **Stav:** met

### `contact-offers`
- **Cesta:** `spine/demand/contact-offers`
- **Osa příběhu (Story Axis):** demand
- **Stav:** met

### `compare`
- **Cesta:** `spine/demand/compare`
- **Osa příběhu (Story Axis):** demand
- **Stav:** met

### `core-types`
- **Cesta:** `spine/domain/core-types`
- **Osa příběhu (Story Axis):** domain
- **Stav:** met
- **Tagy:** types, zod, schema, validation, dto

### `engine-learn`
- **Cesta:** `spine/engine/learn`
- **Osa příběhu (Story Axis):** engine
- **Stav:** met
- **Původ (Origin):** frontier
- **Tagy:** action-graph, selectors, replay-model

### `engine-drive`
- **Cesta:** `spine/engine/drive`
- **Osa příběhu (Story Axis):** engine
- **Stav:** met
- **Původ (Origin):** frontier
- **Tagy:** session, read, write, rate-policy

### `dsr`
- **Cesta:** `spine/compliance/dsr`
- **Osa příběhu (Story Axis):** compliance
- **Stav:** met

### `suppression`
- **Cesta:** `spine/compliance/suppression`
- **Osa příběhu (Story Axis):** compliance
- **Stav:** met

### `compliance`
- **Cesta:** `spine/compliance/compliance`
- **Osa příběhu (Story Axis):** compliance
- **Stav:** met

### `firmy-cz`
- **Cesta:** `spine/acquisition/firmy-cz`
- **Osa příběhu (Story Axis):** acquisition
- **Stav:** met

### `acquisition`
- **Cesta:** `spine/acquisition/acquisition`
- **Osa příběhu (Story Axis):** acquisition
- **Stav:** met

### `undefined`
- **Cesta:** `products/auction24/features/supply/media-upload/completeness`
- **Osa příběhu (Story Axis):** N/A
- **Stav:** met

### `privacy-gateway`
- **Cesta:** `spine/platform/security/privacy-gateway`
- **Osa příběhu (Story Axis):** spine
- **Stav:** met

### `dashboard-core`
- **Cesta:** `spine/platform/ui/dashboard-core`
- **Osa příběhu (Story Axis):** spine
- **Stav:** pending

### `inbox-orchestrator`
- **Cesta:** `spine/demand/inbound/inbox-orchestrator`
- **Osa příběhu (Story Axis):** spine
- **Stav:** met

### `deep-inventory`
- **Cesta:** `spine/demand/acquisition/deep-inventory`
- **Osa příběhu (Story Axis):** spine
- **Stav:** met
- **Tagy:** crawler, queue, delta-engine, automation

### `arbitrage-miner`
- **Cesta:** `spine/engine/intelligence/arbitrage-miner`
- **Osa příběhu (Story Axis):** spine
- **Stav:** met

### `worker`
- **Cesta:** `spine/engine/automation/worker`
- **Osa příběhu (Story Axis):** spine
- **Stav:** met

### `shadow-broker`
- **Cesta:** `spine/engine/drive/shadow-broker`
- **Osa příběhu (Story Axis):** spine
- **Stav:** met

### `relay`
- **Cesta:** `spine/engine/intelligence/relay`
- **Osa příběhu (Story Axis):** spine
- **Stav:** met

### `symphony-queue`
- **Cesta:** `spine/engine/automation/symphony-queue`
- **Osa příběhu (Story Axis):** spine
- **Stav:** met

### `search`
- **Cesta:** `products/auction24/features/demand/search`
- **Osa příběhu (Story Axis):** demand
- **Stav:** met

