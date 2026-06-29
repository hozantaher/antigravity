# Antigravity Vector-Tree Architecture Map

Tento soubor byl automaticky vygenerován pro poskytnutí maximálního kontextu AI agentům.

## 🗺️ Topologie Uzlů (Mermaid Graf)

```mermaid
graph TD
  supply["supply (supply)"]
  style supply stroke:#00cc66,stroke-width:1px
  sale["sale (sale)"]
  style sale stroke:#00cc66,stroke-width:1px
  engine["engine (engine)"]
  style engine stroke:#ff9900,stroke-width:2px
  demand["demand (demand)"]
  style demand stroke:#00cc66,stroke-width:1px
  demo-invoicing["demo-invoicing (sale)"]
  style demo-invoicing stroke:#ff9900,stroke-width:2px
  auth["auth (platform)"]
  style auth stroke:#00cc66,stroke-width:1px
  account["account (spine)"]
  style account stroke:#ff9900,stroke-width:2px
  outreach-dashboard["outreach-dashboard (platform)"]
  style outreach-dashboard stroke:#ff9900,stroke-width:2px
  engine-learn["engine-learn (engine)"]
  style engine-learn stroke:#3399ff,stroke-width:3px,fill:#cce5ff,color:#333
  engine-drive["engine-drive (engine)"]
  style engine-drive stroke:#3399ff,stroke-width:3px,fill:#cce5ff,color:#333
  demand-search["demand-search (spine)"]
  style demand-search stroke:#ff9900,stroke-width:2px
  demand-discover["demand-discover (demand)"]
  style demand-discover stroke:#3399ff,stroke-width:3px,fill:#cce5ff,color:#333
  registration["registration (platform)"]
  style registration stroke:#00cc66,stroke-width:1px
  password-reset["password-reset (platform)"]
  style password-reset stroke:#00cc66,stroke-width:1px
  guards["guards (platform)"]
  style guards stroke:#00cc66,stroke-width:1px
  engine-learn-action-graph["engine-learn-action-graph (engine)"]
  style engine-learn-action-graph stroke:#ff9900,stroke-width:2px
  engine-drive-write["engine-drive-write (engine)"]
  style engine-drive-write stroke:#ff9900,stroke-width:2px
  engine-drive-read["engine-drive-read (engine)"]
  style engine-drive-read stroke:#ff9900,stroke-width:2px
  demand-discover-crawl["demand-discover-crawl (demand)"]
  style demand-discover-crawl stroke:#ff9900,stroke-width:2px
  demand-discover-scrapers["demand-discover-scrapers (demand)"]
  style demand-discover-scrapers stroke:#00cc66,stroke-width:1px
  outreach["outreach (legacy)"]
  style outreach stroke:#00cc66,stroke-width:1px
  platform["platform (platform)"]
  style platform stroke:#00cc66,stroke-width:1px
  compliance["compliance (legacy)"]
  style compliance stroke:#00cc66,stroke-width:1px
  acquisition["acquisition (legacy)"]
  style acquisition stroke:#00cc66,stroke-width:1px
  inbound["inbound (legacy)"]
  style inbound stroke:#00cc66,stroke-width:1px
  warmup["warmup (legacy)"]
  style warmup stroke:#00cc66,stroke-width:1px
  send-window["send-window (legacy)"]
  style send-window stroke:#00cc66,stroke-width:1px
  send-dedup["send-dedup (legacy)"]
  style send-dedup stroke:#00cc66,stroke-width:1px
  campaign-scheduler["campaign-scheduler (legacy)"]
  style campaign-scheduler stroke:#00cc66,stroke-width:1px
  content-render["content-render (legacy)"]
  style content-render stroke:#00cc66,stroke-width:1px
  anti-trace["anti-trace (legacy)"]
  style anti-trace stroke:#00cc66,stroke-width:1px
  mailbox-reliability["mailbox-reliability (legacy)"]
  style mailbox-reliability stroke:#00cc66,stroke-width:1px
  worker-pdf["worker-pdf (platform)"]
  style worker-pdf stroke:#00cc66,stroke-width:1px
  protections["protections (platform)"]
  style protections stroke:#00cc66,stroke-width:1px
  mcp["mcp (platform)"]
  style mcp stroke:#00cc66,stroke-width:1px
  dashboard-bff["dashboard-bff (platform)"]
  style dashboard-bff stroke:#00cc66,stroke-width:1px
  unsub-token["unsub-token (legacy)"]
  style unsub-token stroke:#00cc66,stroke-width:1px
  suppression["suppression (legacy)"]
  style suppression stroke:#00cc66,stroke-width:1px
  gdpr-footer["gdpr-footer (legacy)"]
  style gdpr-footer stroke:#00cc66,stroke-width:1px
  dsr["dsr (legacy)"]
  style dsr stroke:#00cc66,stroke-width:1px
  audit-log["audit-log (legacy)"]
  style audit-log stroke:#00cc66,stroke-width:1px
  email-validation["email-validation (legacy)"]
  style email-validation stroke:#00cc66,stroke-width:1px
  firmy-cz["firmy-cz (legacy)"]
  style firmy-cz stroke:#00cc66,stroke-width:1px
  classify-icp["classify-icp (legacy)"]
  style classify-icp stroke:#00cc66,stroke-width:1px
  reply-classify["reply-classify (legacy)"]
  style reply-classify stroke:#00cc66,stroke-width:1px
  ares-source["ares-source (legacy)"]
  style ares-source stroke:#00cc66,stroke-width:1px
  imap-poll["imap-poll (legacy)"]
  style imap-poll stroke:#00cc66,stroke-width:1px
  bounce-handle["bounce-handle (legacy)"]
  style bounce-handle stroke:#00cc66,stroke-width:1px
  thread-match["thread-match (legacy)"]
  style thread-match stroke:#00cc66,stroke-width:1px
  bounce-detect["bounce-detect (legacy)"]
  style bounce-detect stroke:#00cc66,stroke-width:1px
  vehicle-vin["vehicle-vin (supply)"]
  style vehicle-vin stroke:#00cc66,stroke-width:1px
  media-upload["media-upload (supply)"]
  style media-upload stroke:#00cc66,stroke-width:1px
  auction-items["auction-items (supply)"]
  style auction-items stroke:#00cc66,stroke-width:1px
  bidding["bidding (supply)"]
  style bidding stroke:#00cc66,stroke-width:1px
  deposit-billing["deposit-billing (sale)"]
  style deposit-billing stroke:#00cc66,stroke-width:1px
  disputes-complaints["disputes-complaints (sale)"]
  style disputes-complaints stroke:#00cc66,stroke-width:1px
  sale-settlement["sale-settlement (sale)"]
  style sale-settlement stroke:#00cc66,stroke-width:1px
  invoicing["invoicing (sale)"]
  style invoicing stroke:#00cc66,stroke-width:1px
  notifications["notifications (platform)"]
  style notifications stroke:#00cc66,stroke-width:1px
  reference-data["reference-data (platform)"]
  style reference-data stroke:#00cc66,stroke-width:1px
  core["core (platform)"]
  style core stroke:#00cc66,stroke-width:1px
  consent-tracking["consent-tracking (platform)"]
  style consent-tracking stroke:#00cc66,stroke-width:1px
  design-system["design-system (platform)"]
  style design-system stroke:#00cc66,stroke-width:1px
  i18n["i18n (platform)"]
  style i18n stroke:#00cc66,stroke-width:1px
  api-docs["api-docs (platform)"]
  style api-docs stroke:#00cc66,stroke-width:1px
  api-tokens["api-tokens (platform)"]
  style api-tokens stroke:#00cc66,stroke-width:1px
  admin["admin (platform)"]
  style admin stroke:#00cc66,stroke-width:1px
  saved-search["saved-search (demand)"]
  style saved-search stroke:#00cc66,stroke-width:1px
  search["search (demand)"]
  style search stroke:#00cc66,stroke-width:1px
  ratings-reviews["ratings-reviews (demand)"]
  style ratings-reviews stroke:#00cc66,stroke-width:1px
  newsletter-email["newsletter-email (demand)"]
  style newsletter-email stroke:#00cc66,stroke-width:1px
  recommendation["recommendation (demand)"]
  style recommendation stroke:#00cc66,stroke-width:1px
  contact-offers["contact-offers (demand)"]
  style contact-offers stroke:#00cc66,stroke-width:1px
  favorites["favorites (demand)"]
  style favorites stroke:#00cc66,stroke-width:1px
  messaging["messaging (demand)"]
  style messaging stroke:#00cc66,stroke-width:1px
  compare["compare (demand)"]
  style compare stroke:#00cc66,stroke-width:1px
  sanitize["sanitize (legacy)"]
  style sanitize stroke:#00cc66,stroke-width:1px
  metadata-min["metadata-min (legacy)"]
  style metadata-min stroke:#00cc66,stroke-width:1px
  egress["egress (legacy)"]
  style egress stroke:#00cc66,stroke-width:1px
  content-enc["content-enc (legacy)"]
  style content-enc stroke:#00cc66,stroke-width:1px
  specs-before-bid["specs-before-bid (supply)"]
  style specs-before-bid stroke:#00cc66,stroke-width:1px
  decode-cache["decode-cache (supply)"]
  style decode-cache stroke:#00cc66,stroke-width:1px
  completeness["completeness (supply)"]
  style completeness stroke:#00cc66,stroke-width:1px
  pano-360["pano-360 (supply)"]
  style pano-360 stroke:#00cc66,stroke-width:1px
  empty-state["empty-state (supply)"]
  style empty-state stroke:#00cc66,stroke-width:1px
  detail-order["detail-order (supply)"]
  style detail-order stroke:#00cc66,stroke-width:1px
  card-order["card-order (supply)"]
  style card-order stroke:#00cc66,stroke-width:1px
  soft-close["soft-close (supply)"]
  style soft-close stroke:#00cc66,stroke-width:1px
  eligibility["eligibility (supply)"]
  style eligibility stroke:#00cc66,stroke-width:1px
  reconcile["reconcile (sale)"]
  style reconcile stroke:#00cc66,stroke-width:1px
  fio-match["fio-match (sale)"]
  style fio-match stroke:#00cc66,stroke-width:1px
  framing["framing (sale)"]
  style framing stroke:#00cc66,stroke-width:1px
  resolution["resolution (sale)"]
  style resolution stroke:#00cc66,stroke-width:1px
  concurrency["concurrency (supply)"]
  style concurrency stroke:#00cc66,stroke-width:1px
  case-open["case-open (sale)"]
  style case-open stroke:#00cc66,stroke-width:1px
  charge-once["charge-once (sale)"]
  style charge-once stroke:#00cc66,stroke-width:1px
  amount-due["amount-due (sale)"]
  style amount-due stroke:#00cc66,stroke-width:1px
  billing-capture["billing-capture (sale)"]
  style billing-capture stroke:#00cc66,stroke-width:1px
  completion["completion (sale)"]
  style completion stroke:#00cc66,stroke-width:1px
  fakturoid-sync["fakturoid-sync (sale)"]
  style fakturoid-sync stroke:#00cc66,stroke-width:1px
  invoice-list["invoice-list (sale)"]
  style invoice-list stroke:#00cc66,stroke-width:1px
  key-events["key-events (platform)"]
  style key-events stroke:#00cc66,stroke-width:1px
  country-resolution["country-resolution (platform)"]
  style country-resolution stroke:#00cc66,stroke-width:1px
  category-coverage["category-coverage (platform)"]
  style category-coverage stroke:#00cc66,stroke-width:1px
  sitemap["sitemap (platform)"]
  style sitemap stroke:#00cc66,stroke-width:1px
  read-state["read-state (platform)"]
  style read-state stroke:#00cc66,stroke-width:1px
  lcp["lcp (platform)"]
  style lcp stroke:#00cc66,stroke-width:1px
  consent-gate["consent-gate (platform)"]
  style consent-gate stroke:#00cc66,stroke-width:1px
  ingest["ingest (platform)"]
  style ingest stroke:#00cc66,stroke-width:1px
  brand-parity["brand-parity (platform)"]
  style brand-parity stroke:#00cc66,stroke-width:1px
  a11y["a11y (platform)"]
  style a11y stroke:#00cc66,stroke-width:1px
  rtl-parity["rtl-parity (platform)"]
  style rtl-parity stroke:#00cc66,stroke-width:1px
  key-completeness["key-completeness (platform)"]
  style key-completeness stroke:#00cc66,stroke-width:1px
  spec-validity["spec-validity (platform)"]
  style spec-validity stroke:#00cc66,stroke-width:1px
  token-lifecycle["token-lifecycle (platform)"]
  style token-lifecycle stroke:#00cc66,stroke-width:1px
  token-hash["token-hash (platform)"]
  style token-hash stroke:#00cc66,stroke-width:1px
  contract-drift["contract-drift (platform)"]
  style contract-drift stroke:#00cc66,stroke-width:1px
  save-success["save-success (platform)"]
  style save-success stroke:#00cc66,stroke-width:1px
  list-latency["list-latency (platform)"]
  style list-latency stroke:#00cc66,stroke-width:1px
  send["send (demand)"]
  style send stroke:#00cc66,stroke-width:1px
  owner-scoped["owner-scoped (demand)"]
  style owner-scoped stroke:#00cc66,stroke-width:1px
  unsubscribe["unsubscribe (demand)"]
  style unsubscribe stroke:#00cc66,stroke-width:1px
  create["create (demand)"]
  style create stroke:#00cc66,stroke-width:1px
  no-duplicate["no-duplicate (demand)"]
  style no-duplicate stroke:#00cc66,stroke-width:1px
  relevance["relevance (demand)"]
  style relevance stroke:#00cc66,stroke-width:1px
  query-roundtrip["query-roundtrip (demand)"]
  style query-roundtrip stroke:#00cc66,stroke-width:1px
  url-state["url-state (demand)"]
  style url-state stroke:#00cc66,stroke-width:1px
  pagination["pagination (demand)"]
  style pagination stroke:#00cc66,stroke-width:1px
  ordering["ordering (demand)"]
  style ordering stroke:#00cc66,stroke-width:1px
  diacritics["diacritics (demand)"]
  style diacritics stroke:#00cc66,stroke-width:1px
  seller-visible["seller-visible (demand)"]
  style seller-visible stroke:#00cc66,stroke-width:1px
  post-sale["post-sale (demand)"]
  style post-sale stroke:#00cc66,stroke-width:1px
  return-path["return-path (demand)"]
  style return-path stroke:#00cc66,stroke-width:1px
  cadence["cadence (demand)"]
  style cadence stroke:#00cc66,stroke-width:1px
  facet-filter["facet-filter (demand)"]
  style facet-filter stroke:#00cc66,stroke-width:1px
  rail-to-bid["rail-to-bid (demand)"]
  style rail-to-bid stroke:#00cc66,stroke-width:1px
  non-empty["non-empty (demand)"]
  style non-empty stroke:#00cc66,stroke-width:1px
  ctr["ctr (demand)"]
  style ctr stroke:#00cc66,stroke-width:1px
  toggle-roundtrip["toggle-roundtrip (demand)"]
  style toggle-roundtrip stroke:#00cc66,stroke-width:1px
  inquiry-roundtrip["inquiry-roundtrip (demand)"]
  style inquiry-roundtrip stroke:#00cc66,stroke-width:1px
  spam-hidden["spam-hidden (demand)"]
  style spam-hidden stroke:#00cc66,stroke-width:1px
  auto-publish["auto-publish (demand)"]
  style auto-publish stroke:#00cc66,stroke-width:1px
  ask["ask (demand)"]
  style ask stroke:#00cc66,stroke-width:1px
  published-only["published-only (demand)"]
  style published-only stroke:#00cc66,stroke-width:1px
  answer["answer (demand)"]
  style answer stroke:#00cc66,stroke-width:1px
  compare-set["compare-set (demand)"]
  style compare-set stroke:#00cc66,stroke-width:1px
```

## 🗂️ Seznam Uzlů

### `supply`
- **Cesta:** `products/auction24/features/supply`
- **Osa příběhu (Story Axis):** supply
- **Stav:** met

### `sale`
- **Cesta:** `products/auction24/features/sale`
- **Osa příběhu (Story Axis):** sale
- **Stav:** met

### `engine`
- **Cesta:** `spine/engine`
- **Osa příběhu (Story Axis):** engine
- **Stav:** pending

### `demand`
- **Cesta:** `products/auction24/features/demand`
- **Osa příběhu (Story Axis):** demand
- **Stav:** met

### `demo-invoicing`
- **Cesta:** `spine/sale/demo-invoicing`
- **Osa příběhu (Story Axis):** sale
- **Stav:** pending

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
- **Stav:** pending
- **Původ (Origin):** hozan-taher/features/platform

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

### `demand-search`
- **Cesta:** `spine/demand/search`
- **Osa příběhu (Story Axis):** spine
- **Stav:** pending

### `demand-discover`
- **Cesta:** `spine/demand/discover`
- **Osa příběhu (Story Axis):** demand
- **Stav:** pending
- **Původ (Origin):** frontier
- **Tagy:** crawl, fingerprint, bot, discovery

### `registration`
- **Cesta:** `spine/platform/auth/registration`
- **Osa příběhu (Story Axis):** platform
- **Stav:** met

### `password-reset`
- **Cesta:** `spine/platform/auth/password-reset`
- **Osa příběhu (Story Axis):** platform
- **Stav:** met

### `guards`
- **Cesta:** `spine/platform/auth/guards`
- **Osa příběhu (Story Axis):** platform
- **Stav:** met

### `engine-learn-action-graph`
- **Cesta:** `spine/engine/learn/action-graph`
- **Osa příběhu (Story Axis):** engine
- **Stav:** pending

### `engine-drive-write`
- **Cesta:** `spine/engine/drive/write`
- **Osa příběhu (Story Axis):** engine
- **Stav:** pending

### `engine-drive-read`
- **Cesta:** `spine/engine/drive/read`
- **Osa příběhu (Story Axis):** engine
- **Stav:** pending

### `demand-discover-crawl`
- **Cesta:** `spine/demand/discover/crawl`
- **Osa příběhu (Story Axis):** demand
- **Stav:** pending

### `demand-discover-scrapers`
- **Cesta:** `spine/demand/discover/scrapers`
- **Osa příběhu (Story Axis):** demand
- **Stav:** met

### `outreach`
- **Cesta:** `products/hozan-taher/features/outreach`
- **Osa příběhu (Story Axis):** legacy
- **Stav:** met

### `platform`
- **Cesta:** `products/auction24/features/platform`
- **Osa příběhu (Story Axis):** platform
- **Stav:** met

### `compliance`
- **Cesta:** `products/hozan-taher/features/compliance`
- **Osa příběhu (Story Axis):** legacy
- **Stav:** met

### `acquisition`
- **Cesta:** `products/hozan-taher/features/acquisition`
- **Osa příběhu (Story Axis):** legacy
- **Stav:** met

### `inbound`
- **Cesta:** `products/hozan-taher/features/inbound`
- **Osa příběhu (Story Axis):** legacy
- **Stav:** met

### `warmup`
- **Cesta:** `products/hozan-taher/features/outreach/warmup`
- **Osa příběhu (Story Axis):** legacy
- **Stav:** met

### `send-window`
- **Cesta:** `products/hozan-taher/features/outreach/send-window`
- **Osa příběhu (Story Axis):** legacy
- **Stav:** met

### `send-dedup`
- **Cesta:** `products/hozan-taher/features/outreach/send-dedup`
- **Osa příběhu (Story Axis):** legacy
- **Stav:** met

### `campaign-scheduler`
- **Cesta:** `products/hozan-taher/features/outreach/campaign-scheduler`
- **Osa příběhu (Story Axis):** legacy
- **Stav:** met

### `content-render`
- **Cesta:** `products/hozan-taher/features/outreach/content-render`
- **Osa příběhu (Story Axis):** legacy
- **Stav:** met

### `anti-trace`
- **Cesta:** `products/hozan-taher/features/outreach/anti-trace`
- **Osa příběhu (Story Axis):** legacy
- **Stav:** met

### `mailbox-reliability`
- **Cesta:** `products/hozan-taher/features/outreach/mailbox-reliability`
- **Osa příběhu (Story Axis):** legacy
- **Stav:** met

### `worker-pdf`
- **Cesta:** `products/hozan-taher/features/platform/worker-pdf`
- **Osa příběhu (Story Axis):** platform
- **Stav:** met

### `protections`
- **Cesta:** `products/hozan-taher/features/platform/protections`
- **Osa příběhu (Story Axis):** platform
- **Stav:** met

### `mcp`
- **Cesta:** `products/hozan-taher/features/platform/mcp`
- **Osa příběhu (Story Axis):** platform
- **Stav:** met

### `dashboard-bff`
- **Cesta:** `products/hozan-taher/features/platform/dashboard-bff`
- **Osa příběhu (Story Axis):** platform
- **Stav:** met

### `unsub-token`
- **Cesta:** `products/hozan-taher/features/compliance/unsub-token`
- **Osa příběhu (Story Axis):** legacy
- **Stav:** met

### `suppression`
- **Cesta:** `products/hozan-taher/features/compliance/suppression`
- **Osa příběhu (Story Axis):** legacy
- **Stav:** met

### `gdpr-footer`
- **Cesta:** `products/hozan-taher/features/compliance/gdpr-footer`
- **Osa příběhu (Story Axis):** legacy
- **Stav:** met

### `dsr`
- **Cesta:** `products/hozan-taher/features/compliance/dsr`
- **Osa příběhu (Story Axis):** legacy
- **Stav:** met

### `audit-log`
- **Cesta:** `products/hozan-taher/features/compliance/audit-log`
- **Osa příběhu (Story Axis):** legacy
- **Stav:** met

### `email-validation`
- **Cesta:** `products/hozan-taher/features/acquisition/email-validation`
- **Osa příběhu (Story Axis):** legacy
- **Stav:** met

### `firmy-cz`
- **Cesta:** `products/hozan-taher/features/acquisition/firmy-cz`
- **Osa příběhu (Story Axis):** legacy
- **Stav:** met

### `classify-icp`
- **Cesta:** `products/hozan-taher/features/acquisition/classify-icp`
- **Osa příběhu (Story Axis):** legacy
- **Stav:** met

### `reply-classify`
- **Cesta:** `products/hozan-taher/features/inbound/reply-classify`
- **Osa příběhu (Story Axis):** legacy
- **Stav:** met

### `ares-source`
- **Cesta:** `products/hozan-taher/features/acquisition/ares-source`
- **Osa příběhu (Story Axis):** legacy
- **Stav:** met

### `imap-poll`
- **Cesta:** `products/hozan-taher/features/inbound/imap-poll`
- **Osa příběhu (Story Axis):** legacy
- **Stav:** met

### `bounce-handle`
- **Cesta:** `products/hozan-taher/features/inbound/bounce-handle`
- **Osa příběhu (Story Axis):** legacy
- **Stav:** met

### `thread-match`
- **Cesta:** `products/hozan-taher/features/inbound/thread-match`
- **Osa příběhu (Story Axis):** legacy
- **Stav:** met

### `bounce-detect`
- **Cesta:** `products/hozan-taher/features/inbound/bounce-detect`
- **Osa příběhu (Story Axis):** legacy
- **Stav:** met

### `vehicle-vin`
- **Cesta:** `products/auction24/features/supply/vehicle-vin`
- **Osa příběhu (Story Axis):** supply
- **Stav:** met

### `media-upload`
- **Cesta:** `products/auction24/features/supply/media-upload`
- **Osa příběhu (Story Axis):** supply
- **Stav:** met

### `auction-items`
- **Cesta:** `products/auction24/features/supply/auction-items`
- **Osa příběhu (Story Axis):** supply
- **Stav:** met

### `bidding`
- **Cesta:** `products/auction24/features/supply/bidding`
- **Osa příběhu (Story Axis):** supply
- **Stav:** met

### `deposit-billing`
- **Cesta:** `products/auction24/features/sale/deposit-billing`
- **Osa příběhu (Story Axis):** sale
- **Stav:** met

### `disputes-complaints`
- **Cesta:** `products/auction24/features/sale/disputes-complaints`
- **Osa příběhu (Story Axis):** sale
- **Stav:** met

### `sale-settlement`
- **Cesta:** `products/auction24/features/sale/sale-settlement`
- **Osa příběhu (Story Axis):** sale
- **Stav:** met

### `invoicing`
- **Cesta:** `products/auction24/features/sale/invoicing`
- **Osa příběhu (Story Axis):** sale
- **Stav:** met

### `notifications`
- **Cesta:** `products/auction24/features/platform/notifications`
- **Osa příběhu (Story Axis):** platform
- **Stav:** met

### `reference-data`
- **Cesta:** `products/auction24/features/platform/reference-data`
- **Osa příběhu (Story Axis):** platform
- **Stav:** met

### `core`
- **Cesta:** `products/auction24/features/platform/core`
- **Osa příběhu (Story Axis):** platform
- **Stav:** met

### `consent-tracking`
- **Cesta:** `products/auction24/features/platform/consent-tracking`
- **Osa příběhu (Story Axis):** platform
- **Stav:** met

### `design-system`
- **Cesta:** `products/auction24/features/platform/design-system`
- **Osa příběhu (Story Axis):** platform
- **Stav:** met

### `i18n`
- **Cesta:** `products/auction24/features/platform/i18n`
- **Osa příběhu (Story Axis):** platform
- **Stav:** met

### `api-docs`
- **Cesta:** `products/auction24/features/platform/api-docs`
- **Osa příběhu (Story Axis):** platform
- **Stav:** met

### `api-tokens`
- **Cesta:** `products/auction24/features/platform/api-tokens`
- **Osa příběhu (Story Axis):** platform
- **Stav:** met

### `admin`
- **Cesta:** `products/auction24/features/platform/admin`
- **Osa příběhu (Story Axis):** platform
- **Stav:** met

### `saved-search`
- **Cesta:** `products/auction24/features/demand/saved-search`
- **Osa příběhu (Story Axis):** demand
- **Stav:** met

### `search`
- **Cesta:** `products/auction24/features/demand/search`
- **Osa příběhu (Story Axis):** demand
- **Stav:** met

### `ratings-reviews`
- **Cesta:** `products/auction24/features/demand/ratings-reviews`
- **Osa příběhu (Story Axis):** demand
- **Stav:** met

### `newsletter-email`
- **Cesta:** `products/auction24/features/demand/newsletter-email`
- **Osa příběhu (Story Axis):** demand
- **Stav:** met

### `recommendation`
- **Cesta:** `products/auction24/features/demand/recommendation`
- **Osa příběhu (Story Axis):** demand
- **Stav:** met

### `contact-offers`
- **Cesta:** `products/auction24/features/demand/contact-offers`
- **Osa příběhu (Story Axis):** demand
- **Stav:** met

### `favorites`
- **Cesta:** `products/auction24/features/demand/favorites`
- **Osa příběhu (Story Axis):** demand
- **Stav:** met

### `messaging`
- **Cesta:** `products/auction24/features/demand/messaging`
- **Osa příběhu (Story Axis):** demand
- **Stav:** met

### `compare`
- **Cesta:** `products/auction24/features/demand/compare`
- **Osa příběhu (Story Axis):** demand
- **Stav:** met

### `sanitize`
- **Cesta:** `products/hozan-taher/features/outreach/anti-trace/sanitize`
- **Osa příběhu (Story Axis):** legacy
- **Stav:** met

### `metadata-min`
- **Cesta:** `products/hozan-taher/features/outreach/anti-trace/metadata-min`
- **Osa příběhu (Story Axis):** legacy
- **Stav:** met

### `egress`
- **Cesta:** `products/hozan-taher/features/outreach/anti-trace/egress`
- **Osa příběhu (Story Axis):** legacy
- **Stav:** met

### `content-enc`
- **Cesta:** `products/hozan-taher/features/outreach/anti-trace/content-enc`
- **Osa příběhu (Story Axis):** legacy
- **Stav:** met

### `specs-before-bid`
- **Cesta:** `products/auction24/features/supply/vehicle-vin/specs-before-bid`
- **Osa příběhu (Story Axis):** supply
- **Stav:** met

### `decode-cache`
- **Cesta:** `products/auction24/features/supply/vehicle-vin/decode-cache`
- **Osa příběhu (Story Axis):** supply
- **Stav:** met

### `completeness`
- **Cesta:** `products/auction24/features/supply/media-upload/completeness`
- **Osa příběhu (Story Axis):** supply
- **Stav:** met

### `pano-360`
- **Cesta:** `products/auction24/features/supply/media-upload/pano-360`
- **Osa příběhu (Story Axis):** supply
- **Stav:** met

### `empty-state`
- **Cesta:** `products/auction24/features/supply/auction-items/empty-state`
- **Osa příběhu (Story Axis):** supply
- **Stav:** met

### `detail-order`
- **Cesta:** `products/auction24/features/supply/auction-items/detail-order`
- **Osa příběhu (Story Axis):** supply
- **Stav:** met

### `card-order`
- **Cesta:** `products/auction24/features/supply/auction-items/card-order`
- **Osa příběhu (Story Axis):** supply
- **Stav:** met

### `soft-close`
- **Cesta:** `products/auction24/features/supply/bidding/soft-close`
- **Osa příběhu (Story Axis):** supply
- **Stav:** met

### `eligibility`
- **Cesta:** `products/auction24/features/supply/bidding/eligibility`
- **Osa příběhu (Story Axis):** supply
- **Stav:** met

### `reconcile`
- **Cesta:** `products/auction24/features/sale/deposit-billing/reconcile`
- **Osa příběhu (Story Axis):** sale
- **Stav:** met

### `fio-match`
- **Cesta:** `products/auction24/features/sale/deposit-billing/fio-match`
- **Osa příběhu (Story Axis):** sale
- **Stav:** met

### `framing`
- **Cesta:** `products/auction24/features/sale/deposit-billing/framing`
- **Osa příběhu (Story Axis):** sale
- **Stav:** met

### `resolution`
- **Cesta:** `products/auction24/features/sale/disputes-complaints/resolution`
- **Osa příběhu (Story Axis):** sale
- **Stav:** met

### `concurrency`
- **Cesta:** `products/auction24/features/supply/bidding/concurrency`
- **Osa příběhu (Story Axis):** supply
- **Stav:** met

### `case-open`
- **Cesta:** `products/auction24/features/sale/disputes-complaints/case-open`
- **Osa příběhu (Story Axis):** sale
- **Stav:** met

### `charge-once`
- **Cesta:** `products/auction24/features/sale/sale-settlement/charge-once`
- **Osa příběhu (Story Axis):** sale
- **Stav:** met

### `amount-due`
- **Cesta:** `products/auction24/features/sale/sale-settlement/amount-due`
- **Osa příběhu (Story Axis):** sale
- **Stav:** met

### `billing-capture`
- **Cesta:** `products/auction24/features/sale/sale-settlement/billing-capture`
- **Osa příběhu (Story Axis):** sale
- **Stav:** met

### `completion`
- **Cesta:** `products/auction24/features/sale/sale-settlement/completion`
- **Osa příběhu (Story Axis):** sale
- **Stav:** met

### `fakturoid-sync`
- **Cesta:** `products/auction24/features/sale/invoicing/fakturoid-sync`
- **Osa příběhu (Story Axis):** sale
- **Stav:** met

### `invoice-list`
- **Cesta:** `products/auction24/features/sale/invoicing/invoice-list`
- **Osa příběhu (Story Axis):** sale
- **Stav:** met

### `key-events`
- **Cesta:** `products/auction24/features/platform/notifications/key-events`
- **Osa příběhu (Story Axis):** platform
- **Stav:** met

### `country-resolution`
- **Cesta:** `products/auction24/features/platform/reference-data/country-resolution`
- **Osa příběhu (Story Axis):** platform
- **Stav:** met

### `category-coverage`
- **Cesta:** `products/auction24/features/platform/reference-data/category-coverage`
- **Osa příběhu (Story Axis):** platform
- **Stav:** met

### `sitemap`
- **Cesta:** `products/auction24/features/platform/core/sitemap`
- **Osa příběhu (Story Axis):** platform
- **Stav:** met

### `read-state`
- **Cesta:** `products/auction24/features/platform/notifications/read-state`
- **Osa příběhu (Story Axis):** platform
- **Stav:** met

### `lcp`
- **Cesta:** `products/auction24/features/platform/core/lcp`
- **Osa příběhu (Story Axis):** platform
- **Stav:** met

### `consent-gate`
- **Cesta:** `products/auction24/features/platform/consent-tracking/consent-gate`
- **Osa příběhu (Story Axis):** platform
- **Stav:** met

### `ingest`
- **Cesta:** `products/auction24/features/platform/consent-tracking/ingest`
- **Osa příběhu (Story Axis):** platform
- **Stav:** met

### `brand-parity`
- **Cesta:** `products/auction24/features/platform/design-system/brand-parity`
- **Osa příběhu (Story Axis):** platform
- **Stav:** met

### `a11y`
- **Cesta:** `products/auction24/features/platform/design-system/a11y`
- **Osa příběhu (Story Axis):** platform
- **Stav:** met

### `rtl-parity`
- **Cesta:** `products/auction24/features/platform/i18n/rtl-parity`
- **Osa příběhu (Story Axis):** platform
- **Stav:** met

### `key-completeness`
- **Cesta:** `products/auction24/features/platform/i18n/key-completeness`
- **Osa příběhu (Story Axis):** platform
- **Stav:** met

### `spec-validity`
- **Cesta:** `products/auction24/features/platform/api-docs/spec-validity`
- **Osa příběhu (Story Axis):** platform
- **Stav:** met

### `token-lifecycle`
- **Cesta:** `products/auction24/features/platform/api-tokens/token-lifecycle`
- **Osa příběhu (Story Axis):** platform
- **Stav:** met

### `token-hash`
- **Cesta:** `products/auction24/features/platform/api-tokens/token-hash`
- **Osa příběhu (Story Axis):** platform
- **Stav:** met

### `contract-drift`
- **Cesta:** `products/auction24/features/platform/api-docs/contract-drift`
- **Osa příběhu (Story Axis):** platform
- **Stav:** met

### `save-success`
- **Cesta:** `products/auction24/features/platform/admin/save-success`
- **Osa příběhu (Story Axis):** platform
- **Stav:** met

### `list-latency`
- **Cesta:** `products/auction24/features/platform/admin/list-latency`
- **Osa příběhu (Story Axis):** platform
- **Stav:** met

### `send`
- **Cesta:** `products/auction24/features/demand/saved-search/send`
- **Osa příběhu (Story Axis):** demand
- **Stav:** met

### `owner-scoped`
- **Cesta:** `products/auction24/features/demand/saved-search/owner-scoped`
- **Osa příběhu (Story Axis):** demand
- **Stav:** met

### `unsubscribe`
- **Cesta:** `products/auction24/features/demand/saved-search/unsubscribe`
- **Osa příběhu (Story Axis):** demand
- **Stav:** met

### `create`
- **Cesta:** `products/auction24/features/demand/saved-search/create`
- **Osa příběhu (Story Axis):** demand
- **Stav:** met

### `no-duplicate`
- **Cesta:** `products/auction24/features/demand/saved-search/no-duplicate`
- **Osa příběhu (Story Axis):** demand
- **Stav:** met

### `relevance`
- **Cesta:** `products/auction24/features/demand/search/relevance`
- **Osa příběhu (Story Axis):** demand
- **Stav:** met

### `query-roundtrip`
- **Cesta:** `products/auction24/features/demand/search/query-roundtrip`
- **Osa příběhu (Story Axis):** demand
- **Stav:** met

### `url-state`
- **Cesta:** `products/auction24/features/demand/search/url-state`
- **Osa příběhu (Story Axis):** demand
- **Stav:** met

### `pagination`
- **Cesta:** `products/auction24/features/demand/search/pagination`
- **Osa příběhu (Story Axis):** demand
- **Stav:** met

### `ordering`
- **Cesta:** `products/auction24/features/demand/search/ordering`
- **Osa příběhu (Story Axis):** demand
- **Stav:** met

### `diacritics`
- **Cesta:** `products/auction24/features/demand/search/diacritics`
- **Osa příběhu (Story Axis):** demand
- **Stav:** met

### `seller-visible`
- **Cesta:** `products/auction24/features/demand/ratings-reviews/seller-visible`
- **Osa příběhu (Story Axis):** demand
- **Stav:** met

### `post-sale`
- **Cesta:** `products/auction24/features/demand/ratings-reviews/post-sale`
- **Osa příběhu (Story Axis):** demand
- **Stav:** met

### `return-path`
- **Cesta:** `products/auction24/features/demand/newsletter-email/return-path`
- **Osa příběhu (Story Axis):** demand
- **Stav:** met

### `cadence`
- **Cesta:** `products/auction24/features/demand/newsletter-email/cadence`
- **Osa příběhu (Story Axis):** demand
- **Stav:** met

### `facet-filter`
- **Cesta:** `products/auction24/features/demand/search/facet-filter`
- **Osa příběhu (Story Axis):** demand
- **Stav:** met

### `rail-to-bid`
- **Cesta:** `products/auction24/features/demand/recommendation/rail-to-bid`
- **Osa příběhu (Story Axis):** demand
- **Stav:** met

### `non-empty`
- **Cesta:** `products/auction24/features/demand/recommendation/non-empty`
- **Osa příběhu (Story Axis):** demand
- **Stav:** met

### `ctr`
- **Cesta:** `products/auction24/features/demand/recommendation/ctr`
- **Osa příběhu (Story Axis):** demand
- **Stav:** met

### `toggle-roundtrip`
- **Cesta:** `products/auction24/features/demand/favorites/toggle-roundtrip`
- **Osa příběhu (Story Axis):** demand
- **Stav:** met

### `inquiry-roundtrip`
- **Cesta:** `products/auction24/features/demand/contact-offers/inquiry-roundtrip`
- **Osa příběhu (Story Axis):** demand
- **Stav:** met

### `spam-hidden`
- **Cesta:** `products/auction24/features/demand/messaging/spam-hidden`
- **Osa příběhu (Story Axis):** demand
- **Stav:** met

### `auto-publish`
- **Cesta:** `products/auction24/features/demand/messaging/auto-publish`
- **Osa příběhu (Story Axis):** demand
- **Stav:** met

### `ask`
- **Cesta:** `products/auction24/features/demand/messaging/ask`
- **Osa příběhu (Story Axis):** demand
- **Stav:** met

### `published-only`
- **Cesta:** `products/auction24/features/demand/messaging/published-only`
- **Osa příběhu (Story Axis):** demand
- **Stav:** met

### `answer`
- **Cesta:** `products/auction24/features/demand/messaging/answer`
- **Osa příběhu (Story Axis):** demand
- **Stav:** met

### `compare-set`
- **Cesta:** `products/auction24/features/demand/compare/compare-set`
- **Osa příběhu (Story Axis):** demand
- **Stav:** met

