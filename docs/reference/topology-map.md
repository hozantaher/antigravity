# Antigravity Vector-Tree Architecture Map

Tento soubor byl automaticky vygenerován pro poskytnutí maximálního kontextu AI agentům.

## 🗺️ Topologie Uzlů (Mermaid Graf)

```mermaid
graph TD
  sale["sale (spine/sale)"]
  style sale stroke:#00cc66,stroke-width:1px
  supply["supply (spine/supply)"]
  style supply stroke:#00cc66,stroke-width:1px
  inbound["inbound (inbound)"]
  style inbound stroke:#00cc66,stroke-width:1px
  engine["engine (engine)"]
  style engine stroke:#ff9900,stroke-width:2px
  outreach["outreach (outreach)"]
  style outreach stroke:#00cc66,stroke-width:1px
  platform["platform (platform)"]
  style platform stroke:#00cc66,stroke-width:1px
  acquisition["acquisition (acquisition)"]
  style acquisition stroke:#00cc66,stroke-width:1px
  compliance["compliance (compliance)"]
  style compliance stroke:#00cc66,stroke-width:1px
  demand["demand (spine/demand)"]
  style demand stroke:#00cc66,stroke-width:1px
  operator-console["operator-console (apps)"]
  style operator-console stroke:#ff9900,stroke-width:2px
  marketplace-web["marketplace-web (apps)"]
  style marketplace-web stroke:#ff9900,stroke-width:2px
  reconcile["reconcile (spine/sale/deposit-billing/reconcile)"]
  style reconcile stroke:#00cc66,stroke-width:1px
  resolution["resolution (spine/sale/disputes-complaints/resolution)"]
  style resolution stroke:#00cc66,stroke-width:1px
  sale-settlement["sale-settlement (spine/sale/sale-settlement)"]
  style sale-settlement stroke:#00cc66,stroke-width:1px
  invoicing["invoicing (spine/sale/invoicing)"]
  style invoicing stroke:#00cc66,stroke-width:1px
  invoice-list["invoice-list (spine/sale/invoicing/invoice-list)"]
  style invoice-list stroke:#00cc66,stroke-width:1px
  framing["framing (spine/sale/deposit-billing/framing)"]
  style framing stroke:#00cc66,stroke-width:1px
  fio-match["fio-match (spine/sale/deposit-billing/fio-match)"]
  style fio-match stroke:#00cc66,stroke-width:1px
  fakturoid-sync["fakturoid-sync (spine/sale/invoicing/fakturoid-sync)"]
  style fakturoid-sync stroke:#00cc66,stroke-width:1px
  completion["completion (spine/sale/sale-settlement/completion)"]
  style completion stroke:#00cc66,stroke-width:1px
  disputes-complaints["disputes-complaints (spine/sale/disputes-complaints)"]
  style disputes-complaints stroke:#00cc66,stroke-width:1px
  deposit-billing["deposit-billing (spine/sale/deposit-billing)"]
  style deposit-billing stroke:#00cc66,stroke-width:1px
  charge-once["charge-once (spine/sale/sale-settlement/charge-once)"]
  style charge-once stroke:#00cc66,stroke-width:1px
  case-open["case-open (spine/sale/disputes-complaints/case-open)"]
  style case-open stroke:#00cc66,stroke-width:1px
  amount-due["amount-due (spine/sale/sale-settlement/amount-due)"]
  style amount-due stroke:#00cc66,stroke-width:1px
  billing-capture["billing-capture (spine/sale/sale-settlement/billing-capture)"]
  style billing-capture stroke:#00cc66,stroke-width:1px
  vehicle-vin["vehicle-vin (spine/supply/vehicle-vin)"]
  style vehicle-vin stroke:#00cc66,stroke-width:1px
  specs-before-bid["specs-before-bid (spine/supply/vehicle-vin/specs-before-bid)"]
  style specs-before-bid stroke:#00cc66,stroke-width:1px
  soft-close["soft-close (spine/supply/bidding/soft-close)"]
  style soft-close stroke:#00cc66,stroke-width:1px
  pano-360["pano-360 (spine/supply/media-upload/pano-360)"]
  style pano-360 stroke:#00cc66,stroke-width:1px
  media-upload["media-upload (spine/supply/media-upload)"]
  style media-upload stroke:#00cc66,stroke-width:1px
  empty-state["empty-state (spine/supply/auction-items/empty-state)"]
  style empty-state stroke:#00cc66,stroke-width:1px
  eligibility["eligibility (spine/supply/bidding/eligibility)"]
  style eligibility stroke:#00cc66,stroke-width:1px
  detail-order["detail-order (spine/supply/auction-items/detail-order)"]
  style detail-order stroke:#00cc66,stroke-width:1px
  decode-cache["decode-cache (spine/supply/vehicle-vin/decode-cache)"]
  style decode-cache stroke:#00cc66,stroke-width:1px
  concurrency["concurrency (spine/supply/bidding/concurrency)"]
  style concurrency stroke:#00cc66,stroke-width:1px
  completeness["completeness (spine/supply/media-upload/completeness)"]
  style completeness stroke:#00cc66,stroke-width:1px
  card-order["card-order (spine/supply/auction-items/card-order)"]
  style card-order stroke:#00cc66,stroke-width:1px
  bidding["bidding (spine/supply/bidding)"]
  style bidding stroke:#00cc66,stroke-width:1px
  auction-items["auction-items (spine/supply/auction-items)"]
  style auction-items stroke:#00cc66,stroke-width:1px
  thread-match["thread-match (spine/inbound/thread-match)"]
  style thread-match stroke:#00cc66,stroke-width:1px
  reply-classify["reply-classify (spine/inbound/reply-classify)"]
  style reply-classify stroke:#00cc66,stroke-width:1px
  imap-poll["imap-poll (spine/inbound/imap-poll)"]
  style imap-poll stroke:#00cc66,stroke-width:1px
  bounce-handle["bounce-handle (spine/inbound/bounce-handle)"]
  style bounce-handle stroke:#00cc66,stroke-width:1px
  bounce-detect["bounce-detect (spine/inbound/bounce-detect)"]
  style bounce-detect stroke:#00cc66,stroke-width:1px
  engine-learn["engine-learn (engine)"]
  style engine-learn stroke:#3399ff,stroke-width:3px,fill:#cce5ff,color:#333
  engine-drive["engine-drive (engine)"]
  style engine-drive stroke:#3399ff,stroke-width:3px,fill:#cce5ff,color:#333
  warmup["warmup (spine/outreach/warmup)"]
  style warmup stroke:#00cc66,stroke-width:1px
  send-window["send-window (spine/outreach/send-window)"]
  style send-window stroke:#00cc66,stroke-width:1px
  send-dedup["send-dedup (spine/outreach/send-dedup)"]
  style send-dedup stroke:#00cc66,stroke-width:1px
  sanitize["sanitize (spine/outreach/anti-trace/sanitize)"]
  style sanitize stroke:#00cc66,stroke-width:1px
  metadata-min["metadata-min (spine/outreach/anti-trace/metadata-min)"]
  style metadata-min stroke:#00cc66,stroke-width:1px
  mailbox-reliability["mailbox-reliability (spine/outreach/mailbox-reliability)"]
  style mailbox-reliability stroke:#00cc66,stroke-width:1px
  egress["egress (spine/outreach/anti-trace/egress)"]
  style egress stroke:#00cc66,stroke-width:1px
  content-render["content-render (spine/outreach/content-render)"]
  style content-render stroke:#00cc66,stroke-width:1px
  content-enc["content-enc (spine/outreach/anti-trace/content-enc)"]
  style content-enc stroke:#00cc66,stroke-width:1px
  campaign-scheduler["campaign-scheduler (spine/outreach/campaign-scheduler)"]
  style campaign-scheduler stroke:#00cc66,stroke-width:1px
  anti-trace["anti-trace (spine/outreach/anti-trace)"]
  style anti-trace stroke:#00cc66,stroke-width:1px
  core-types["core-types (domain)"]
  style core-types stroke:#00cc66,stroke-width:1px
  token-lifecycle["token-lifecycle (spine/platform/api-tokens/token-lifecycle)"]
  style token-lifecycle stroke:#00cc66,stroke-width:1px
  token-hash["token-hash (spine/platform/api-tokens/token-hash)"]
  style token-hash stroke:#00cc66,stroke-width:1px
  spec-validity["spec-validity (spine/platform/api-docs/spec-validity)"]
  style spec-validity stroke:#00cc66,stroke-width:1px
  sitemap["sitemap (spine/platform/core/sitemap)"]
  style sitemap stroke:#00cc66,stroke-width:1px
  save-success["save-success (spine/platform/admin/save-success)"]
  style save-success stroke:#00cc66,stroke-width:1px
  rtl-parity["rtl-parity (spine/platform/i18n/rtl-parity)"]
  style rtl-parity stroke:#00cc66,stroke-width:1px
  registration["registration (spine/platform/auth-account/registration)"]
  style registration stroke:#00cc66,stroke-width:1px
  reference-data["reference-data (spine/platform/reference-data)"]
  style reference-data stroke:#00cc66,stroke-width:1px
  read-state["read-state (spine/platform/notifications/read-state)"]
  style read-state stroke:#00cc66,stroke-width:1px
  protections["protections (spine/platform/protections)"]
  style protections stroke:#00cc66,stroke-width:1px
  worker-pdf["worker-pdf (spine/platform/worker-pdf)"]
  style worker-pdf stroke:#00cc66,stroke-width:1px
  password-reset["password-reset (spine/platform/auth-account/password-reset)"]
  style password-reset stroke:#00cc66,stroke-width:1px
  notifications["notifications (spine/platform/notifications)"]
  style notifications stroke:#00cc66,stroke-width:1px
  mcp["mcp (spine/platform/mcp)"]
  style mcp stroke:#00cc66,stroke-width:1px
  list-latency["list-latency (spine/platform/admin/list-latency)"]
  style list-latency stroke:#00cc66,stroke-width:1px
  lcp["lcp (spine/platform/core/lcp)"]
  style lcp stroke:#00cc66,stroke-width:1px
  key-completeness["key-completeness (spine/platform/i18n/key-completeness)"]
  style key-completeness stroke:#00cc66,stroke-width:1px
  key-events["key-events (spine/platform/notifications/key-events)"]
  style key-events stroke:#00cc66,stroke-width:1px
  i18n["i18n (spine/platform/i18n)"]
  style i18n stroke:#00cc66,stroke-width:1px
  guards["guards (spine/platform/auth-account/guards)"]
  style guards stroke:#00cc66,stroke-width:1px
  ingest["ingest (spine/platform/consent-tracking/ingest)"]
  style ingest stroke:#00cc66,stroke-width:1px
  country-resolution["country-resolution (spine/platform/reference-data/country-resolution)"]
  style country-resolution stroke:#00cc66,stroke-width:1px
  design-system["design-system (spine/platform/design-system)"]
  style design-system stroke:#00cc66,stroke-width:1px
  dashboard-bff["dashboard-bff (spine/platform/dashboard-bff)"]
  style dashboard-bff stroke:#00cc66,stroke-width:1px
  core["core (spine/platform/core)"]
  style core stroke:#00cc66,stroke-width:1px
  contract-drift["contract-drift (spine/platform/api-docs/contract-drift)"]
  style contract-drift stroke:#00cc66,stroke-width:1px
  consent-gate["consent-gate (spine/platform/consent-tracking/consent-gate)"]
  style consent-gate stroke:#00cc66,stroke-width:1px
  consent-tracking["consent-tracking (spine/platform/consent-tracking)"]
  style consent-tracking stroke:#00cc66,stroke-width:1px
  auth["auth (platform)"]
  style auth stroke:#00cc66,stroke-width:1px
  brand-parity["brand-parity (spine/platform/design-system/brand-parity)"]
  style brand-parity stroke:#00cc66,stroke-width:1px
  category-coverage["category-coverage (spine/platform/reference-data/category-coverage)"]
  style category-coverage stroke:#00cc66,stroke-width:1px
  auth-account["auth-account (spine/platform/auth-account)"]
  style auth-account stroke:#00cc66,stroke-width:1px
  api-tokens["api-tokens (spine/platform/api-tokens)"]
  style api-tokens stroke:#00cc66,stroke-width:1px
  a11y["a11y (spine/platform/design-system/a11y)"]
  style a11y stroke:#00cc66,stroke-width:1px
  account["account (spine)"]
  style account stroke:#ff9900,stroke-width:2px
  api-docs["api-docs (spine/platform/api-docs)"]
  style api-docs stroke:#00cc66,stroke-width:1px
  admin["admin (spine/platform/admin)"]
  style admin stroke:#00cc66,stroke-width:1px
  firmy-cz["firmy-cz (spine/acquisition/acquisition/firmy-cz)"]
  style firmy-cz stroke:#00cc66,stroke-width:1px
  scrapers["scrapers (spine/acquisition/scrapers)"]
  style scrapers stroke:#00cc66,stroke-width:1px
  ares-source["ares-source (spine/acquisition/ares-source)"]
  style ares-source stroke:#00cc66,stroke-width:1px
  classify-icp["classify-icp (spine/acquisition/acquisition/classify-icp)"]
  style classify-icp stroke:#00cc66,stroke-width:1px
  email-validation["email-validation (spine/acquisition/email-validation)"]
  style email-validation stroke:#00cc66,stroke-width:1px
  unsub-token["unsub-token (spine/compliance/unsub-token)"]
  style unsub-token stroke:#00cc66,stroke-width:1px
  gdpr-footer["gdpr-footer (spine/compliance/gdpr-footer)"]
  style gdpr-footer stroke:#00cc66,stroke-width:1px
  suppression["suppression (spine/compliance/compliance/suppression)"]
  style suppression stroke:#00cc66,stroke-width:1px
  dsr["dsr (spine/compliance/compliance/dsr)"]
  style dsr stroke:#00cc66,stroke-width:1px
  unsubscribe["unsubscribe (spine/demand/saved-search/unsubscribe)"]
  style unsubscribe stroke:#00cc66,stroke-width:1px
  audit-log["audit-log (spine/compliance/audit-log)"]
  style audit-log stroke:#00cc66,stroke-width:1px
  url-state["url-state (spine/demand/search/url-state)"]
  style url-state stroke:#00cc66,stroke-width:1px
  toggle-roundtrip["toggle-roundtrip (spine/demand/favorites/toggle-roundtrip)"]
  style toggle-roundtrip stroke:#00cc66,stroke-width:1px
  spam-hidden["spam-hidden (spine/demand/messaging/spam-hidden)"]
  style spam-hidden stroke:#00cc66,stroke-width:1px
  seller-visible["seller-visible (spine/demand/ratings-reviews/seller-visible)"]
  style seller-visible stroke:#00cc66,stroke-width:1px
  send["send (spine/demand/saved-search/send)"]
  style send stroke:#00cc66,stroke-width:1px
  search["search (spine/demand/search)"]
  style search stroke:#00cc66,stroke-width:1px
  return-path["return-path (spine/demand/newsletter-email/return-path)"]
  style return-path stroke:#00cc66,stroke-width:1px
  relevance["relevance (spine/demand/search/relevance)"]
  style relevance stroke:#00cc66,stroke-width:1px
  recommendation["recommendation (spine/demand/recommendation)"]
  style recommendation stroke:#00cc66,stroke-width:1px
  saved-search["saved-search (spine/demand/saved-search)"]
  style saved-search stroke:#00cc66,stroke-width:1px
  ratings-reviews["ratings-reviews (spine/demand/ratings-reviews)"]
  style ratings-reviews stroke:#00cc66,stroke-width:1px
  query-roundtrip["query-roundtrip (spine/demand/search/query-roundtrip)"]
  style query-roundtrip stroke:#00cc66,stroke-width:1px
  rail-to-bid["rail-to-bid (spine/demand/recommendation/rail-to-bid)"]
  style rail-to-bid stroke:#00cc66,stroke-width:1px
  published-only["published-only (spine/demand/messaging/published-only)"]
  style published-only stroke:#00cc66,stroke-width:1px
  pagination["pagination (spine/demand/search/pagination)"]
  style pagination stroke:#00cc66,stroke-width:1px
  post-sale["post-sale (spine/demand/ratings-reviews/post-sale)"]
  style post-sale stroke:#00cc66,stroke-width:1px
  owner-scoped["owner-scoped (spine/demand/saved-search/owner-scoped)"]
  style owner-scoped stroke:#00cc66,stroke-width:1px
  non-empty["non-empty (spine/demand/recommendation/non-empty)"]
  style non-empty stroke:#00cc66,stroke-width:1px
  ordering["ordering (spine/demand/search/ordering)"]
  style ordering stroke:#00cc66,stroke-width:1px
  no-duplicate["no-duplicate (spine/demand/saved-search/no-duplicate)"]
  style no-duplicate stroke:#00cc66,stroke-width:1px
  messaging["messaging (spine/demand/messaging)"]
  style messaging stroke:#00cc66,stroke-width:1px
  newsletter-email["newsletter-email (spine/demand/newsletter-email)"]
  style newsletter-email stroke:#00cc66,stroke-width:1px
  inquiry-roundtrip["inquiry-roundtrip (spine/demand/contact-offers/inquiry-roundtrip)"]
  style inquiry-roundtrip stroke:#00cc66,stroke-width:1px
  favorites["favorites (spine/demand/favorites)"]
  style favorites stroke:#00cc66,stroke-width:1px
  facet-filter["facet-filter (spine/demand/search/facet-filter)"]
  style facet-filter stroke:#00cc66,stroke-width:1px
  create["create (spine/demand/saved-search/create)"]
  style create stroke:#00cc66,stroke-width:1px
  ctr["ctr (spine/demand/recommendation/ctr)"]
  style ctr stroke:#00cc66,stroke-width:1px
  diacritics["diacritics (spine/demand/search/diacritics)"]
  style diacritics stroke:#00cc66,stroke-width:1px
  contact-offers["contact-offers (spine/demand/contact-offers)"]
  style contact-offers stroke:#00cc66,stroke-width:1px
  compare-set["compare-set (spine/demand/compare/compare-set)"]
  style compare-set stroke:#00cc66,stroke-width:1px
  auto-publish["auto-publish (spine/demand/messaging/auto-publish)"]
  style auto-publish stroke:#00cc66,stroke-width:1px
  cadence["cadence (spine/demand/newsletter-email/cadence)"]
  style cadence stroke:#00cc66,stroke-width:1px
  ask["ask (spine/demand/messaging/ask)"]
  style ask stroke:#00cc66,stroke-width:1px
  compare["compare (spine/demand/compare)"]
  style compare stroke:#00cc66,stroke-width:1px
  answer["answer (spine/demand/messaging/answer)"]
  style answer stroke:#00cc66,stroke-width:1px
  relay["relay (spine)"]
  style relay stroke:#00cc66,stroke-width:1px
  arbitrage-miner["arbitrage-miner (spine)"]
  style arbitrage-miner stroke:#00cc66,stroke-width:1px
  shadow-broker["shadow-broker (spine)"]
  style shadow-broker stroke:#00cc66,stroke-width:1px
  worker["worker (spine)"]
  style worker stroke:#00cc66,stroke-width:1px
  symphony-queue["symphony-queue (spine)"]
  style symphony-queue stroke:#00cc66,stroke-width:1px
  privacy-gateway["privacy-gateway (spine)"]
  style privacy-gateway stroke:#00cc66,stroke-width:1px
  dashboard-core["dashboard-core (spine)"]
  style dashboard-core stroke:#ff9900,stroke-width:2px
  inbox-orchestrator["inbox-orchestrator (spine)"]
  style inbox-orchestrator stroke:#00cc66,stroke-width:1px
  deep-inventory["deep-inventory (spine)"]
  style deep-inventory stroke:#00cc66,stroke-width:1px
```

## 🗂️ Seznam Uzlů

### `sale`
- **Cesta:** `spine/sale`
- **Osa příběhu (Story Axis):** spine/sale
- **Stav:** met

### `supply`
- **Cesta:** `spine/supply`
- **Osa příběhu (Story Axis):** spine/supply
- **Stav:** met

### `inbound`
- **Cesta:** `spine/inbound/inbound`
- **Osa příběhu (Story Axis):** inbound
- **Stav:** met

### `engine`
- **Cesta:** `spine/engine`
- **Osa příběhu (Story Axis):** engine
- **Stav:** pending

### `outreach`
- **Cesta:** `spine/outreach/outreach`
- **Osa příběhu (Story Axis):** outreach
- **Stav:** met

### `platform`
- **Cesta:** `spine/platform/platform`
- **Osa příběhu (Story Axis):** platform
- **Stav:** met

### `acquisition`
- **Cesta:** `spine/acquisition/acquisition`
- **Osa příběhu (Story Axis):** acquisition
- **Stav:** met

### `compliance`
- **Cesta:** `spine/compliance/compliance`
- **Osa příběhu (Story Axis):** compliance
- **Stav:** met

### `demand`
- **Cesta:** `spine/demand`
- **Osa příběhu (Story Axis):** spine/demand
- **Stav:** met

### `operator-console`
- **Cesta:** `apps/operator-console`
- **Osa příběhu (Story Axis):** apps
- **Stav:** pending
- **Původ (Origin):** hozan-taher/features/platform

### `marketplace-web`
- **Cesta:** `apps/marketplace-web`
- **Osa příběhu (Story Axis):** apps
- **Stav:** pending

### `reconcile`
- **Cesta:** `spine/sale/deposit-billing/reconcile`
- **Osa příběhu (Story Axis):** spine/sale/deposit-billing/reconcile
- **Stav:** met

### `resolution`
- **Cesta:** `spine/sale/disputes-complaints/resolution`
- **Osa příběhu (Story Axis):** spine/sale/disputes-complaints/resolution
- **Stav:** met

### `sale-settlement`
- **Cesta:** `spine/sale/sale-settlement`
- **Osa příběhu (Story Axis):** spine/sale/sale-settlement
- **Stav:** met

### `invoicing`
- **Cesta:** `spine/sale/invoicing`
- **Osa příběhu (Story Axis):** spine/sale/invoicing
- **Stav:** met

### `invoice-list`
- **Cesta:** `spine/sale/invoicing/invoice-list`
- **Osa příběhu (Story Axis):** spine/sale/invoicing/invoice-list
- **Stav:** met

### `framing`
- **Cesta:** `spine/sale/deposit-billing/framing`
- **Osa příběhu (Story Axis):** spine/sale/deposit-billing/framing
- **Stav:** met

### `fio-match`
- **Cesta:** `spine/sale/deposit-billing/fio-match`
- **Osa příběhu (Story Axis):** spine/sale/deposit-billing/fio-match
- **Stav:** met

### `fakturoid-sync`
- **Cesta:** `spine/sale/invoicing/fakturoid-sync`
- **Osa příběhu (Story Axis):** spine/sale/invoicing/fakturoid-sync
- **Stav:** met

### `completion`
- **Cesta:** `spine/sale/sale-settlement/completion`
- **Osa příběhu (Story Axis):** spine/sale/sale-settlement/completion
- **Stav:** met

### `disputes-complaints`
- **Cesta:** `spine/sale/disputes-complaints`
- **Osa příběhu (Story Axis):** spine/sale/disputes-complaints
- **Stav:** met

### `deposit-billing`
- **Cesta:** `spine/sale/deposit-billing`
- **Osa příběhu (Story Axis):** spine/sale/deposit-billing
- **Stav:** met

### `charge-once`
- **Cesta:** `spine/sale/sale-settlement/charge-once`
- **Osa příběhu (Story Axis):** spine/sale/sale-settlement/charge-once
- **Stav:** met

### `case-open`
- **Cesta:** `spine/sale/disputes-complaints/case-open`
- **Osa příběhu (Story Axis):** spine/sale/disputes-complaints/case-open
- **Stav:** met

### `amount-due`
- **Cesta:** `spine/sale/sale-settlement/amount-due`
- **Osa příběhu (Story Axis):** spine/sale/sale-settlement/amount-due
- **Stav:** met

### `billing-capture`
- **Cesta:** `spine/sale/sale-settlement/billing-capture`
- **Osa příběhu (Story Axis):** spine/sale/sale-settlement/billing-capture
- **Stav:** met

### `vehicle-vin`
- **Cesta:** `spine/supply/vehicle-vin`
- **Osa příběhu (Story Axis):** spine/supply/vehicle-vin
- **Stav:** met

### `specs-before-bid`
- **Cesta:** `spine/supply/vehicle-vin/specs-before-bid`
- **Osa příběhu (Story Axis):** spine/supply/vehicle-vin/specs-before-bid
- **Stav:** met

### `soft-close`
- **Cesta:** `spine/supply/bidding/soft-close`
- **Osa příběhu (Story Axis):** spine/supply/bidding/soft-close
- **Stav:** met

### `pano-360`
- **Cesta:** `spine/supply/media-upload/pano-360`
- **Osa příběhu (Story Axis):** spine/supply/media-upload/pano-360
- **Stav:** met

### `media-upload`
- **Cesta:** `spine/supply/media-upload`
- **Osa příběhu (Story Axis):** spine/supply/media-upload
- **Stav:** met

### `empty-state`
- **Cesta:** `spine/supply/auction-items/empty-state`
- **Osa příběhu (Story Axis):** spine/supply/auction-items/empty-state
- **Stav:** met

### `eligibility`
- **Cesta:** `spine/supply/bidding/eligibility`
- **Osa příběhu (Story Axis):** spine/supply/bidding/eligibility
- **Stav:** met

### `detail-order`
- **Cesta:** `spine/supply/auction-items/detail-order`
- **Osa příběhu (Story Axis):** spine/supply/auction-items/detail-order
- **Stav:** met

### `decode-cache`
- **Cesta:** `spine/supply/vehicle-vin/decode-cache`
- **Osa příběhu (Story Axis):** spine/supply/vehicle-vin/decode-cache
- **Stav:** met

### `concurrency`
- **Cesta:** `spine/supply/bidding/concurrency`
- **Osa příběhu (Story Axis):** spine/supply/bidding/concurrency
- **Stav:** met

### `completeness`
- **Cesta:** `spine/supply/media-upload/completeness`
- **Osa příběhu (Story Axis):** spine/supply/media-upload/completeness
- **Stav:** met

### `card-order`
- **Cesta:** `spine/supply/auction-items/card-order`
- **Osa příběhu (Story Axis):** spine/supply/auction-items/card-order
- **Stav:** met

### `bidding`
- **Cesta:** `spine/supply/bidding`
- **Osa příběhu (Story Axis):** spine/supply/bidding
- **Stav:** met

### `auction-items`
- **Cesta:** `spine/supply/auction-items`
- **Osa příběhu (Story Axis):** spine/supply/auction-items
- **Stav:** met

### `thread-match`
- **Cesta:** `spine/inbound/thread-match`
- **Osa příběhu (Story Axis):** spine/inbound/thread-match
- **Stav:** met

### `reply-classify`
- **Cesta:** `spine/inbound/reply-classify`
- **Osa příběhu (Story Axis):** spine/inbound/reply-classify
- **Stav:** met

### `imap-poll`
- **Cesta:** `spine/inbound/imap-poll`
- **Osa příběhu (Story Axis):** spine/inbound/imap-poll
- **Stav:** met

### `bounce-handle`
- **Cesta:** `spine/inbound/bounce-handle`
- **Osa příběhu (Story Axis):** spine/inbound/bounce-handle
- **Stav:** met

### `bounce-detect`
- **Cesta:** `spine/inbound/bounce-detect`
- **Osa příběhu (Story Axis):** spine/inbound/bounce-detect
- **Stav:** met

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

### `warmup`
- **Cesta:** `spine/outreach/warmup`
- **Osa příběhu (Story Axis):** spine/outreach/warmup
- **Stav:** met

### `send-window`
- **Cesta:** `spine/outreach/send-window`
- **Osa příběhu (Story Axis):** spine/outreach/send-window
- **Stav:** met

### `send-dedup`
- **Cesta:** `spine/outreach/send-dedup`
- **Osa příběhu (Story Axis):** spine/outreach/send-dedup
- **Stav:** met

### `sanitize`
- **Cesta:** `spine/outreach/anti-trace/sanitize`
- **Osa příběhu (Story Axis):** spine/outreach/anti-trace/sanitize
- **Stav:** met

### `metadata-min`
- **Cesta:** `spine/outreach/anti-trace/metadata-min`
- **Osa příběhu (Story Axis):** spine/outreach/anti-trace/metadata-min
- **Stav:** met

### `mailbox-reliability`
- **Cesta:** `spine/outreach/mailbox-reliability`
- **Osa příběhu (Story Axis):** spine/outreach/mailbox-reliability
- **Stav:** met

### `egress`
- **Cesta:** `spine/outreach/anti-trace/egress`
- **Osa příběhu (Story Axis):** spine/outreach/anti-trace/egress
- **Stav:** met

### `content-render`
- **Cesta:** `spine/outreach/content-render`
- **Osa příběhu (Story Axis):** spine/outreach/content-render
- **Stav:** met

### `content-enc`
- **Cesta:** `spine/outreach/anti-trace/content-enc`
- **Osa příběhu (Story Axis):** spine/outreach/anti-trace/content-enc
- **Stav:** met

### `campaign-scheduler`
- **Cesta:** `spine/outreach/campaign-scheduler`
- **Osa příběhu (Story Axis):** spine/outreach/campaign-scheduler
- **Stav:** met

### `anti-trace`
- **Cesta:** `spine/outreach/anti-trace`
- **Osa příběhu (Story Axis):** spine/outreach/anti-trace
- **Stav:** met

### `core-types`
- **Cesta:** `spine/domain/core-types`
- **Osa příběhu (Story Axis):** domain
- **Stav:** met
- **Tagy:** types, zod, schema, validation, dto

### `token-lifecycle`
- **Cesta:** `spine/platform/api-tokens/token-lifecycle`
- **Osa příběhu (Story Axis):** spine/platform/api-tokens/token-lifecycle
- **Stav:** met

### `token-hash`
- **Cesta:** `spine/platform/api-tokens/token-hash`
- **Osa příběhu (Story Axis):** spine/platform/api-tokens/token-hash
- **Stav:** met

### `spec-validity`
- **Cesta:** `spine/platform/api-docs/spec-validity`
- **Osa příběhu (Story Axis):** spine/platform/api-docs/spec-validity
- **Stav:** met

### `sitemap`
- **Cesta:** `spine/platform/core/sitemap`
- **Osa příběhu (Story Axis):** spine/platform/core/sitemap
- **Stav:** met

### `save-success`
- **Cesta:** `spine/platform/admin/save-success`
- **Osa příběhu (Story Axis):** spine/platform/admin/save-success
- **Stav:** met

### `rtl-parity`
- **Cesta:** `spine/platform/i18n/rtl-parity`
- **Osa příběhu (Story Axis):** spine/platform/i18n/rtl-parity
- **Stav:** met

### `registration`
- **Cesta:** `spine/platform/auth-account/registration`
- **Osa příběhu (Story Axis):** spine/platform/auth-account/registration
- **Stav:** met

### `reference-data`
- **Cesta:** `spine/platform/reference-data`
- **Osa příběhu (Story Axis):** spine/platform/reference-data
- **Stav:** met

### `read-state`
- **Cesta:** `spine/platform/notifications/read-state`
- **Osa příběhu (Story Axis):** spine/platform/notifications/read-state
- **Stav:** met

### `protections`
- **Cesta:** `spine/platform/protections`
- **Osa příběhu (Story Axis):** spine/platform/protections
- **Stav:** met

### `worker-pdf`
- **Cesta:** `spine/platform/worker-pdf`
- **Osa příběhu (Story Axis):** spine/platform/worker-pdf
- **Stav:** met

### `password-reset`
- **Cesta:** `spine/platform/auth-account/password-reset`
- **Osa příběhu (Story Axis):** spine/platform/auth-account/password-reset
- **Stav:** met

### `notifications`
- **Cesta:** `spine/platform/notifications`
- **Osa příběhu (Story Axis):** spine/platform/notifications
- **Stav:** met

### `mcp`
- **Cesta:** `spine/platform/mcp`
- **Osa příběhu (Story Axis):** spine/platform/mcp
- **Stav:** met

### `list-latency`
- **Cesta:** `spine/platform/admin/list-latency`
- **Osa příběhu (Story Axis):** spine/platform/admin/list-latency
- **Stav:** met

### `lcp`
- **Cesta:** `spine/platform/core/lcp`
- **Osa příběhu (Story Axis):** spine/platform/core/lcp
- **Stav:** met

### `key-completeness`
- **Cesta:** `spine/platform/i18n/key-completeness`
- **Osa příběhu (Story Axis):** spine/platform/i18n/key-completeness
- **Stav:** met

### `key-events`
- **Cesta:** `spine/platform/notifications/key-events`
- **Osa příběhu (Story Axis):** spine/platform/notifications/key-events
- **Stav:** met

### `i18n`
- **Cesta:** `spine/platform/i18n`
- **Osa příběhu (Story Axis):** spine/platform/i18n
- **Stav:** met

### `guards`
- **Cesta:** `spine/platform/auth-account/guards`
- **Osa příběhu (Story Axis):** spine/platform/auth-account/guards
- **Stav:** met

### `ingest`
- **Cesta:** `spine/platform/consent-tracking/ingest`
- **Osa příběhu (Story Axis):** spine/platform/consent-tracking/ingest
- **Stav:** met

### `country-resolution`
- **Cesta:** `spine/platform/reference-data/country-resolution`
- **Osa příběhu (Story Axis):** spine/platform/reference-data/country-resolution
- **Stav:** met

### `design-system`
- **Cesta:** `spine/platform/design-system`
- **Osa příběhu (Story Axis):** spine/platform/design-system
- **Stav:** met

### `dashboard-bff`
- **Cesta:** `spine/platform/dashboard-bff`
- **Osa příběhu (Story Axis):** spine/platform/dashboard-bff
- **Stav:** met

### `core`
- **Cesta:** `spine/platform/core`
- **Osa příběhu (Story Axis):** spine/platform/core
- **Stav:** met

### `contract-drift`
- **Cesta:** `spine/platform/api-docs/contract-drift`
- **Osa příběhu (Story Axis):** spine/platform/api-docs/contract-drift
- **Stav:** met

### `consent-gate`
- **Cesta:** `spine/platform/consent-tracking/consent-gate`
- **Osa příběhu (Story Axis):** spine/platform/consent-tracking/consent-gate
- **Stav:** met

### `consent-tracking`
- **Cesta:** `spine/platform/consent-tracking`
- **Osa příběhu (Story Axis):** spine/platform/consent-tracking
- **Stav:** met

### `auth`
- **Cesta:** `spine/platform/auth`
- **Osa příběhu (Story Axis):** platform
- **Stav:** met

### `brand-parity`
- **Cesta:** `spine/platform/design-system/brand-parity`
- **Osa příběhu (Story Axis):** spine/platform/design-system/brand-parity
- **Stav:** met

### `category-coverage`
- **Cesta:** `spine/platform/reference-data/category-coverage`
- **Osa příběhu (Story Axis):** spine/platform/reference-data/category-coverage
- **Stav:** met

### `auth-account`
- **Cesta:** `spine/platform/auth-account`
- **Osa příběhu (Story Axis):** spine/platform/auth-account
- **Stav:** met

### `api-tokens`
- **Cesta:** `spine/platform/api-tokens`
- **Osa příběhu (Story Axis):** spine/platform/api-tokens
- **Stav:** met

### `a11y`
- **Cesta:** `spine/platform/design-system/a11y`
- **Osa příběhu (Story Axis):** spine/platform/design-system/a11y
- **Stav:** met

### `account`
- **Cesta:** `spine/platform/account`
- **Osa příběhu (Story Axis):** spine
- **Stav:** pending

### `api-docs`
- **Cesta:** `spine/platform/api-docs`
- **Osa příběhu (Story Axis):** spine/platform/api-docs
- **Stav:** met

### `admin`
- **Cesta:** `spine/platform/admin`
- **Osa příběhu (Story Axis):** spine/platform/admin
- **Stav:** met

### `firmy-cz`
- **Cesta:** `spine/acquisition/acquisition/firmy-cz`
- **Osa příběhu (Story Axis):** spine/acquisition/acquisition/firmy-cz
- **Stav:** met

### `scrapers`
- **Cesta:** `spine/acquisition/scrapers`
- **Osa příběhu (Story Axis):** spine/acquisition/scrapers
- **Stav:** met

### `ares-source`
- **Cesta:** `spine/acquisition/ares-source`
- **Osa příběhu (Story Axis):** spine/acquisition/ares-source
- **Stav:** met

### `classify-icp`
- **Cesta:** `spine/acquisition/acquisition/classify-icp`
- **Osa příběhu (Story Axis):** spine/acquisition/acquisition/classify-icp
- **Stav:** met

### `email-validation`
- **Cesta:** `spine/acquisition/email-validation`
- **Osa příběhu (Story Axis):** spine/acquisition/email-validation
- **Stav:** met

### `unsub-token`
- **Cesta:** `spine/compliance/unsub-token`
- **Osa příběhu (Story Axis):** spine/compliance/unsub-token
- **Stav:** met

### `gdpr-footer`
- **Cesta:** `spine/compliance/gdpr-footer`
- **Osa příběhu (Story Axis):** spine/compliance/gdpr-footer
- **Stav:** met

### `suppression`
- **Cesta:** `spine/compliance/compliance/suppression`
- **Osa příběhu (Story Axis):** spine/compliance/compliance/suppression
- **Stav:** met

### `dsr`
- **Cesta:** `spine/compliance/compliance/dsr`
- **Osa příběhu (Story Axis):** spine/compliance/compliance/dsr
- **Stav:** met

### `unsubscribe`
- **Cesta:** `spine/demand/saved-search/unsubscribe`
- **Osa příběhu (Story Axis):** spine/demand/saved-search/unsubscribe
- **Stav:** met

### `audit-log`
- **Cesta:** `spine/compliance/audit-log`
- **Osa příběhu (Story Axis):** spine/compliance/audit-log
- **Stav:** met

### `url-state`
- **Cesta:** `spine/demand/search/url-state`
- **Osa příběhu (Story Axis):** spine/demand/search/url-state
- **Stav:** met

### `toggle-roundtrip`
- **Cesta:** `spine/demand/favorites/toggle-roundtrip`
- **Osa příběhu (Story Axis):** spine/demand/favorites/toggle-roundtrip
- **Stav:** met

### `spam-hidden`
- **Cesta:** `spine/demand/messaging/spam-hidden`
- **Osa příběhu (Story Axis):** spine/demand/messaging/spam-hidden
- **Stav:** met

### `seller-visible`
- **Cesta:** `spine/demand/ratings-reviews/seller-visible`
- **Osa příběhu (Story Axis):** spine/demand/ratings-reviews/seller-visible
- **Stav:** met

### `send`
- **Cesta:** `spine/demand/saved-search/send`
- **Osa příběhu (Story Axis):** spine/demand/saved-search/send
- **Stav:** met

### `search`
- **Cesta:** `spine/demand/search`
- **Osa příběhu (Story Axis):** spine/demand/search
- **Stav:** met

### `return-path`
- **Cesta:** `spine/demand/newsletter-email/return-path`
- **Osa příběhu (Story Axis):** spine/demand/newsletter-email/return-path
- **Stav:** met

### `relevance`
- **Cesta:** `spine/demand/search/relevance`
- **Osa příběhu (Story Axis):** spine/demand/search/relevance
- **Stav:** met

### `recommendation`
- **Cesta:** `spine/demand/recommendation`
- **Osa příběhu (Story Axis):** spine/demand/recommendation
- **Stav:** met

### `saved-search`
- **Cesta:** `spine/demand/saved-search`
- **Osa příběhu (Story Axis):** spine/demand/saved-search
- **Stav:** met

### `ratings-reviews`
- **Cesta:** `spine/demand/ratings-reviews`
- **Osa příběhu (Story Axis):** spine/demand/ratings-reviews
- **Stav:** met

### `query-roundtrip`
- **Cesta:** `spine/demand/search/query-roundtrip`
- **Osa příběhu (Story Axis):** spine/demand/search/query-roundtrip
- **Stav:** met

### `rail-to-bid`
- **Cesta:** `spine/demand/recommendation/rail-to-bid`
- **Osa příběhu (Story Axis):** spine/demand/recommendation/rail-to-bid
- **Stav:** met

### `published-only`
- **Cesta:** `spine/demand/messaging/published-only`
- **Osa příběhu (Story Axis):** spine/demand/messaging/published-only
- **Stav:** met

### `pagination`
- **Cesta:** `spine/demand/search/pagination`
- **Osa příběhu (Story Axis):** spine/demand/search/pagination
- **Stav:** met

### `post-sale`
- **Cesta:** `spine/demand/ratings-reviews/post-sale`
- **Osa příběhu (Story Axis):** spine/demand/ratings-reviews/post-sale
- **Stav:** met

### `owner-scoped`
- **Cesta:** `spine/demand/saved-search/owner-scoped`
- **Osa příběhu (Story Axis):** spine/demand/saved-search/owner-scoped
- **Stav:** met

### `non-empty`
- **Cesta:** `spine/demand/recommendation/non-empty`
- **Osa příběhu (Story Axis):** spine/demand/recommendation/non-empty
- **Stav:** met

### `ordering`
- **Cesta:** `spine/demand/search/ordering`
- **Osa příběhu (Story Axis):** spine/demand/search/ordering
- **Stav:** met

### `no-duplicate`
- **Cesta:** `spine/demand/saved-search/no-duplicate`
- **Osa příběhu (Story Axis):** spine/demand/saved-search/no-duplicate
- **Stav:** met

### `messaging`
- **Cesta:** `spine/demand/messaging`
- **Osa příběhu (Story Axis):** spine/demand/messaging
- **Stav:** met

### `newsletter-email`
- **Cesta:** `spine/demand/newsletter-email`
- **Osa příběhu (Story Axis):** spine/demand/newsletter-email
- **Stav:** met

### `inquiry-roundtrip`
- **Cesta:** `spine/demand/contact-offers/inquiry-roundtrip`
- **Osa příběhu (Story Axis):** spine/demand/contact-offers/inquiry-roundtrip
- **Stav:** met

### `favorites`
- **Cesta:** `spine/demand/favorites`
- **Osa příběhu (Story Axis):** spine/demand/favorites
- **Stav:** met

### `facet-filter`
- **Cesta:** `spine/demand/search/facet-filter`
- **Osa příběhu (Story Axis):** spine/demand/search/facet-filter
- **Stav:** met

### `create`
- **Cesta:** `spine/demand/saved-search/create`
- **Osa příběhu (Story Axis):** spine/demand/saved-search/create
- **Stav:** met

### `ctr`
- **Cesta:** `spine/demand/recommendation/ctr`
- **Osa příběhu (Story Axis):** spine/demand/recommendation/ctr
- **Stav:** met

### `diacritics`
- **Cesta:** `spine/demand/search/diacritics`
- **Osa příběhu (Story Axis):** spine/demand/search/diacritics
- **Stav:** met

### `contact-offers`
- **Cesta:** `spine/demand/contact-offers`
- **Osa příběhu (Story Axis):** spine/demand/contact-offers
- **Stav:** met

### `compare-set`
- **Cesta:** `spine/demand/compare/compare-set`
- **Osa příběhu (Story Axis):** spine/demand/compare/compare-set
- **Stav:** met

### `auto-publish`
- **Cesta:** `spine/demand/messaging/auto-publish`
- **Osa příběhu (Story Axis):** spine/demand/messaging/auto-publish
- **Stav:** met

### `cadence`
- **Cesta:** `spine/demand/newsletter-email/cadence`
- **Osa příběhu (Story Axis):** spine/demand/newsletter-email/cadence
- **Stav:** met

### `ask`
- **Cesta:** `spine/demand/messaging/ask`
- **Osa příběhu (Story Axis):** spine/demand/messaging/ask
- **Stav:** met

### `compare`
- **Cesta:** `spine/demand/compare`
- **Osa příběhu (Story Axis):** spine/demand/compare
- **Stav:** met

### `answer`
- **Cesta:** `spine/demand/messaging/answer`
- **Osa příběhu (Story Axis):** spine/demand/messaging/answer
- **Stav:** met

### `relay`
- **Cesta:** `spine/engine/intelligence/relay`
- **Osa příběhu (Story Axis):** spine
- **Stav:** met

### `arbitrage-miner`
- **Cesta:** `spine/engine/intelligence/arbitrage-miner`
- **Osa příběhu (Story Axis):** spine
- **Stav:** met

### `shadow-broker`
- **Cesta:** `spine/engine/drive/shadow-broker`
- **Osa příběhu (Story Axis):** spine
- **Stav:** met

### `worker`
- **Cesta:** `spine/engine/automation/worker`
- **Osa příběhu (Story Axis):** spine
- **Stav:** met

### `symphony-queue`
- **Cesta:** `spine/engine/automation/symphony-queue`
- **Osa příběhu (Story Axis):** spine
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

