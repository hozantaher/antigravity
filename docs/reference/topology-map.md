# Antigravity Vector-Tree Architecture Map

Tento soubor byl automaticky vygenerován pro poskytnutí maximálního kontextu AI agentům.

## 🗺️ Topologie Uzlů (Mermaid Graf)

```mermaid
graph TD
  supply["supply (spine/supply)"]
  style supply stroke:#00cc66,stroke-width:1px
  sale["sale (spine/sale)"]
  style sale stroke:#00cc66,stroke-width:1px
  platform["platform (spine/platform)"]
  style platform stroke:#ff9900,stroke-width:2px
  outreach["outreach (outreach)"]
  style outreach stroke:#00cc66,stroke-width:1px
  inbound["inbound (inbound)"]
  style inbound stroke:#00cc66,stroke-width:1px
  engine["engine (engine)"]
  style engine stroke:#ff9900,stroke-width:2px
  demand["demand (spine/demand)"]
  style demand stroke:#00cc66,stroke-width:1px
  compliance["compliance (compliance)"]
  style compliance stroke:#00cc66,stroke-width:1px
  acquisition["acquisition (acquisition)"]
  style acquisition stroke:#00cc66,stroke-width:1px
  scraper-mobile-de["scraper-mobile-de (frontiers)"]
  style scraper-mobile-de stroke:#ff9900,stroke-width:2px
  scraper-mascus["scraper-mascus (frontiers)"]
  style scraper-mascus stroke:#ff9900,stroke-width:2px
  scraper-judikaty["scraper-judikaty (frontiers)"]
  style scraper-judikaty stroke:#ff9900,stroke-width:2px
  scraper-firmy["scraper-firmy (frontiers)"]
  style scraper-firmy stroke:#ff9900,stroke-width:2px
  scraper-esbirka["scraper-esbirka (frontiers)"]
  style scraper-esbirka stroke:#ff9900,stroke-width:2px
  scraper-autoline["scraper-autoline (frontiers)"]
  style scraper-autoline stroke:#ff9900,stroke-width:2px
  marketplace-web["marketplace-web (apps)"]
  style marketplace-web stroke:#ff9900,stroke-width:2px
  operator-console["operator-console (apps)"]
  style operator-console stroke:#ff9900,stroke-width:2px
  specs-before-bid["specs-before-bid (spine/supply/vehicle-vin/specs-before-bid)"]
  style specs-before-bid stroke:#00cc66,stroke-width:1px
  soft-close["soft-close (spine/supply/bidding/soft-close)"]
  style soft-close stroke:#00cc66,stroke-width:1px
  vehicle-vin["vehicle-vin (spine/supply/vehicle-vin)"]
  style vehicle-vin stroke:#00cc66,stroke-width:1px
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
  sale-settlement["sale-settlement (spine/sale/sale-settlement)"]
  style sale-settlement stroke:#00cc66,stroke-width:1px
  reconcile["reconcile (spine/sale/deposit-billing/reconcile)"]
  style reconcile stroke:#00cc66,stroke-width:1px
  resolution["resolution (spine/sale/disputes-complaints/resolution)"]
  style resolution stroke:#00cc66,stroke-width:1px
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
  disputes-complaints["disputes-complaints (spine/sale/disputes-complaints)"]
  style disputes-complaints stroke:#00cc66,stroke-width:1px
  deposit-billing["deposit-billing (spine/sale/deposit-billing)"]
  style deposit-billing stroke:#00cc66,stroke-width:1px
  completion["completion (spine/sale/sale-settlement/completion)"]
  style completion stroke:#00cc66,stroke-width:1px
  charge-once["charge-once (spine/sale/sale-settlement/charge-once)"]
  style charge-once stroke:#00cc66,stroke-width:1px
  case-open["case-open (spine/sale/disputes-complaints/case-open)"]
  style case-open stroke:#00cc66,stroke-width:1px
  billing-capture["billing-capture (spine/sale/sale-settlement/billing-capture)"]
  style billing-capture stroke:#00cc66,stroke-width:1px
  amount-due["amount-due (spine/sale/sale-settlement/amount-due)"]
  style amount-due stroke:#00cc66,stroke-width:1px
  pano-360["pano-360 (spine/supply/media-upload/pano-360)"]
  style pano-360 stroke:#00cc66,stroke-width:1px
  worker-pdf["worker-pdf (spine/platform/worker-pdf)"]
  style worker-pdf stroke:#00cc66,stroke-width:1px
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
  reference-data["reference-data (spine/platform/reference-data)"]
  style reference-data stroke:#00cc66,stroke-width:1px
  registration["registration (spine/platform/auth-account/registration)"]
  style registration stroke:#00cc66,stroke-width:1px
  protections["protections (spine/platform/protections)"]
  style protections stroke:#00cc66,stroke-width:1px
  read-state["read-state (spine/platform/notifications/read-state)"]
  style read-state stroke:#00cc66,stroke-width:1px
  password-reset["password-reset (spine/platform/auth-account/password-reset)"]
  style password-reset stroke:#00cc66,stroke-width:1px
  notifications["notifications (spine/platform/notifications)"]
  style notifications stroke:#00cc66,stroke-width:1px
  mcp["mcp (spine/platform/mcp)"]
  style mcp stroke:#00cc66,stroke-width:1px
  lcp["lcp (spine/platform/core/lcp)"]
  style lcp stroke:#00cc66,stroke-width:1px
  list-latency["list-latency (spine/platform/admin/list-latency)"]
  style list-latency stroke:#00cc66,stroke-width:1px
  key-events["key-events (spine/platform/notifications/key-events)"]
  style key-events stroke:#00cc66,stroke-width:1px
  key-completeness["key-completeness (spine/platform/i18n/key-completeness)"]
  style key-completeness stroke:#00cc66,stroke-width:1px
  ingest["ingest (spine/platform/consent-tracking/ingest)"]
  style ingest stroke:#00cc66,stroke-width:1px
  guards["guards (spine/platform/auth-account/guards)"]
  style guards stroke:#00cc66,stroke-width:1px
  i18n["i18n (spine/platform/i18n)"]
  style i18n stroke:#00cc66,stroke-width:1px
  design-system["design-system (spine/platform/design-system)"]
  style design-system stroke:#00cc66,stroke-width:1px
  dashboard-bff["dashboard-bff (spine/platform/dashboard-bff)"]
  style dashboard-bff stroke:#00cc66,stroke-width:1px
  country-resolution["country-resolution (spine/platform/reference-data/country-resolution)"]
  style country-resolution stroke:#00cc66,stroke-width:1px
  core["core (spine/platform/core)"]
  style core stroke:#00cc66,stroke-width:1px
  consent-tracking["consent-tracking (spine/platform/consent-tracking)"]
  style consent-tracking stroke:#00cc66,stroke-width:1px
  contract-drift["contract-drift (spine/platform/api-docs/contract-drift)"]
  style contract-drift stroke:#00cc66,stroke-width:1px
  platform-compliance["platform-compliance (spine)"]
  style platform-compliance stroke:#ff9900,stroke-width:2px
  consent-gate["consent-gate (spine/platform/consent-tracking/consent-gate)"]
  style consent-gate stroke:#00cc66,stroke-width:1px
  category-coverage["category-coverage (spine/platform/reference-data/category-coverage)"]
  style category-coverage stroke:#00cc66,stroke-width:1px
  auth-account["auth-account (spine/platform/auth-account)"]
  style auth-account stroke:#00cc66,stroke-width:1px
  brand-parity["brand-parity (spine/platform/design-system/brand-parity)"]
  style brand-parity stroke:#00cc66,stroke-width:1px
  platform-audit["platform-audit (spine)"]
  style platform-audit stroke:#ff9900,stroke-width:2px
  auth["auth (platform)"]
  style auth stroke:#00cc66,stroke-width:1px
  api-docs["api-docs (spine/platform/api-docs)"]
  style api-docs stroke:#00cc66,stroke-width:1px
  api-tokens["api-tokens (spine/platform/api-tokens)"]
  style api-tokens stroke:#00cc66,stroke-width:1px
  account["account (spine)"]
  style account stroke:#ff9900,stroke-width:2px
  admin["admin (spine/platform/admin)"]
  style admin stroke:#00cc66,stroke-width:1px
  a11y["a11y (spine/platform/design-system/a11y)"]
  style a11y stroke:#00cc66,stroke-width:1px
  warmup["warmup (spine/outreach/warmup)"]
  style warmup stroke:#00cc66,stroke-width:1px
  send-window["send-window (spine/outreach/send-window)"]
  style send-window stroke:#00cc66,stroke-width:1px
  send-dedup["send-dedup (spine/outreach/send-dedup)"]
  style send-dedup stroke:#00cc66,stroke-width:1px
  sanitize["sanitize (spine/outreach/anti-trace/sanitize)"]
  style sanitize stroke:#00cc66,stroke-width:1px
  mailbox-reliability["mailbox-reliability (spine/outreach/mailbox-reliability)"]
  style mailbox-reliability stroke:#00cc66,stroke-width:1px
  metadata-min["metadata-min (spine/outreach/anti-trace/metadata-min)"]
  style metadata-min stroke:#00cc66,stroke-width:1px
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
  core-types["core-types (domain)"]
  style core-types stroke:#00cc66,stroke-width:1px
  url-state["url-state (spine/demand/search/url-state)"]
  style url-state stroke:#00cc66,stroke-width:1px
  unsubscribe["unsubscribe (spine/demand/saved-search/unsubscribe)"]
  style unsubscribe stroke:#00cc66,stroke-width:1px
  toggle-roundtrip["toggle-roundtrip (spine/demand/favorites/toggle-roundtrip)"]
  style toggle-roundtrip stroke:#00cc66,stroke-width:1px
  spam-hidden["spam-hidden (spine/demand/messaging/spam-hidden)"]
  style spam-hidden stroke:#00cc66,stroke-width:1px
  send["send (spine/demand/saved-search/send)"]
  style send stroke:#00cc66,stroke-width:1px
  seller-visible["seller-visible (spine/demand/ratings-reviews/seller-visible)"]
  style seller-visible stroke:#00cc66,stroke-width:1px
  search["search (spine/demand/search)"]
  style search stroke:#00cc66,stroke-width:1px
  return-path["return-path (spine/demand/newsletter-email/return-path)"]
  style return-path stroke:#00cc66,stroke-width:1px
  saved-search["saved-search (spine/demand/saved-search)"]
  style saved-search stroke:#00cc66,stroke-width:1px
  relevance["relevance (spine/demand/search/relevance)"]
  style relevance stroke:#00cc66,stroke-width:1px
  ratings-reviews["ratings-reviews (spine/demand/ratings-reviews)"]
  style ratings-reviews stroke:#00cc66,stroke-width:1px
  recommendation["recommendation (spine/demand/recommendation)"]
  style recommendation stroke:#00cc66,stroke-width:1px
  rail-to-bid["rail-to-bid (spine/demand/recommendation/rail-to-bid)"]
  style rail-to-bid stroke:#00cc66,stroke-width:1px
  published-only["published-only (spine/demand/messaging/published-only)"]
  style published-only stroke:#00cc66,stroke-width:1px
  query-roundtrip["query-roundtrip (spine/demand/search/query-roundtrip)"]
  style query-roundtrip stroke:#00cc66,stroke-width:1px
  post-sale["post-sale (spine/demand/ratings-reviews/post-sale)"]
  style post-sale stroke:#00cc66,stroke-width:1px
  pagination["pagination (spine/demand/search/pagination)"]
  style pagination stroke:#00cc66,stroke-width:1px
  owner-scoped["owner-scoped (spine/demand/saved-search/owner-scoped)"]
  style owner-scoped stroke:#00cc66,stroke-width:1px
  ordering["ordering (spine/demand/search/ordering)"]
  style ordering stroke:#00cc66,stroke-width:1px
  non-empty["non-empty (spine/demand/recommendation/non-empty)"]
  style non-empty stroke:#00cc66,stroke-width:1px
  no-duplicate["no-duplicate (spine/demand/saved-search/no-duplicate)"]
  style no-duplicate stroke:#00cc66,stroke-width:1px
  newsletter-email["newsletter-email (spine/demand/newsletter-email)"]
  style newsletter-email stroke:#00cc66,stroke-width:1px
  inquiry-roundtrip["inquiry-roundtrip (spine/demand/contact-offers/inquiry-roundtrip)"]
  style inquiry-roundtrip stroke:#00cc66,stroke-width:1px
  favorites["favorites (spine/demand/favorites)"]
  style favorites stroke:#00cc66,stroke-width:1px
  messaging["messaging (spine/demand/messaging)"]
  style messaging stroke:#00cc66,stroke-width:1px
  facet-filter["facet-filter (spine/demand/search/facet-filter)"]
  style facet-filter stroke:#00cc66,stroke-width:1px
  diacritics["diacritics (spine/demand/search/diacritics)"]
  style diacritics stroke:#00cc66,stroke-width:1px
  create["create (spine/demand/saved-search/create)"]
  style create stroke:#00cc66,stroke-width:1px
  ctr["ctr (spine/demand/recommendation/ctr)"]
  style ctr stroke:#00cc66,stroke-width:1px
  compare-set["compare-set (spine/demand/compare/compare-set)"]
  style compare-set stroke:#00cc66,stroke-width:1px
  compare["compare (spine/demand/compare)"]
  style compare stroke:#00cc66,stroke-width:1px
  contact-offers["contact-offers (spine/demand/contact-offers)"]
  style contact-offers stroke:#00cc66,stroke-width:1px
  auto-publish["auto-publish (spine/demand/messaging/auto-publish)"]
  style auto-publish stroke:#00cc66,stroke-width:1px
  ask["ask (spine/demand/messaging/ask)"]
  style ask stroke:#00cc66,stroke-width:1px
  cadence["cadence (spine/demand/newsletter-email/cadence)"]
  style cadence stroke:#00cc66,stroke-width:1px
  answer["answer (spine/demand/messaging/answer)"]
  style answer stroke:#00cc66,stroke-width:1px
  unsub-token["unsub-token (spine/compliance/unsub-token)"]
  style unsub-token stroke:#00cc66,stroke-width:1px
  suppression["suppression (spine/compliance/compliance/suppression)"]
  style suppression stroke:#00cc66,stroke-width:1px
  dsr["dsr (spine/compliance/compliance/dsr)"]
  style dsr stroke:#00cc66,stroke-width:1px
  gdpr-footer["gdpr-footer (spine/compliance/gdpr-footer)"]
  style gdpr-footer stroke:#00cc66,stroke-width:1px
  audit-log["audit-log (spine/compliance/audit-log)"]
  style audit-log stroke:#00cc66,stroke-width:1px
  firmy-cz["firmy-cz (spine/acquisition/acquisition/firmy-cz)"]
  style firmy-cz stroke:#00cc66,stroke-width:1px
  legacy-scrapers["legacy-scrapers (spine)"]
  style legacy-scrapers stroke:#ff9900,stroke-width:2px
  email-validation["email-validation (spine/acquisition/email-validation)"]
  style email-validation stroke:#00cc66,stroke-width:1px
  classify-icp["classify-icp (spine/acquisition/acquisition/classify-icp)"]
  style classify-icp stroke:#00cc66,stroke-width:1px
  ares-source["ares-source (spine/acquisition/ares-source)"]
  style ares-source stroke:#00cc66,stroke-width:1px
  dashboard-core["dashboard-core (spine)"]
  style dashboard-core stroke:#ff9900,stroke-width:2px
  privacy-gateway["privacy-gateway (spine)"]
  style privacy-gateway stroke:#00cc66,stroke-width:1px
  campaign-scheduler-time-zone-mapper["campaign-scheduler-time-zone-mapper (spine/outreach/campaign-scheduler)"]
  style campaign-scheduler-time-zone-mapper stroke:#00cc66,stroke-width:1px
  campaign-scheduler-send-throttler["campaign-scheduler-send-throttler (spine/outreach/campaign-scheduler)"]
  style campaign-scheduler-send-throttler stroke:#00cc66,stroke-width:1px
  learn-zod-guard["learn-zod-guard (spine/engine/learn/zod-guard)"]
  style learn-zod-guard stroke:#00cc66,stroke-width:1px
  learn-llm-connector["learn-llm-connector (spine/engine/learn/llm-connector)"]
  style learn-llm-connector stroke:#00cc66,stroke-width:1px
  learn-html-cleaner["learn-html-cleaner (spine/engine/learn/html-cleaner)"]
  style learn-html-cleaner stroke:#00cc66,stroke-width:1px
  relay["relay (spine)"]
  style relay stroke:#00cc66,stroke-width:1px
  parser-compiler["parser-compiler (spine/engine/intelligence)"]
  style parser-compiler stroke:#00cc66,stroke-width:1px
  arbitrage-miner["arbitrage-miner (spine)"]
  style arbitrage-miner stroke:#00cc66,stroke-width:1px
  shadow-broker["shadow-broker (spine)"]
  style shadow-broker stroke:#00cc66,stroke-width:1px
  worker["worker (spine)"]
  style worker stroke:#00cc66,stroke-width:1px
  symphony-queue["symphony-queue (spine)"]
  style symphony-queue stroke:#00cc66,stroke-width:1px
  rule-registry["rule-registry (spine/engine/automation)"]
  style rule-registry stroke:#00cc66,stroke-width:1px
  engine-acquisition-mobile-de["engine-acquisition-mobile-de (spine)"]
  style engine-acquisition-mobile-de stroke:#ff9900,stroke-width:2px
  engine-acquisition-mascus["engine-acquisition-mascus (spine)"]
  style engine-acquisition-mascus stroke:#ff9900,stroke-width:2px
  engine-acquisition-judikaty["engine-acquisition-judikaty (spine)"]
  style engine-acquisition-judikaty stroke:#ff9900,stroke-width:2px
  engine-acquisition-firmy["engine-acquisition-firmy (spine)"]
  style engine-acquisition-firmy stroke:#ff9900,stroke-width:2px
  engine-acquisition-esbirka["engine-acquisition-esbirka (spine)"]
  style engine-acquisition-esbirka stroke:#ff9900,stroke-width:2px
  engine-acquisition-autoline["engine-acquisition-autoline (spine)"]
  style engine-acquisition-autoline stroke:#ff9900,stroke-width:2px
  inbox-orchestrator["inbox-orchestrator (spine)"]
  style inbox-orchestrator stroke:#00cc66,stroke-width:1px
  deep-inventory["deep-inventory (spine/demand/acquisition)"]
  style deep-inventory stroke:#00cc66,stroke-width:1px
  relay-rate-limiter["relay-rate-limiter (spine)"]
  style relay-rate-limiter stroke:#00cc66,stroke-width:1px
  relay-provider-router["relay-provider-router (spine)"]
  style relay-provider-router stroke:#00cc66,stroke-width:1px
  cross-border-arbitrage["cross-border-arbitrage (engine)"]
  style cross-border-arbitrage stroke:#00cc66,stroke-width:1px
  inbox-orchestrator-auto-responder["inbox-orchestrator-auto-responder (spine)"]
  style inbox-orchestrator-auto-responder stroke:#00cc66,stroke-width:1px
  inbox-orchestrator-intent-classifier["inbox-orchestrator-intent-classifier (spine)"]
  style inbox-orchestrator-intent-classifier stroke:#00cc66,stroke-width:1px
  sitemap-watcher["sitemap-watcher (demand)"]
  style sitemap-watcher stroke:#00cc66,stroke-width:1px
  stale-reaper["stale-reaper (demand)"]
  style stale-reaper stroke:#00cc66,stroke-width:1px
  b2b-miner["b2b-miner (demand)"]
  style b2b-miner stroke:#00cc66,stroke-width:1px
  network-interceptor["network-interceptor (demand)"]
  style network-interceptor stroke:#00cc66,stroke-width:1px
  legacy-scrapers --> symphony-queue
  arbitrage-miner --> symphony-queue
  arbitrage-miner --> deep-inventory
  arbitrage-miner --> core-types
  shadow-broker --> symphony-queue
  shadow-broker --> marketplace-web
  shadow-broker --> core-types
```

## 🗂️ Seznam Uzlů

### `supply`
- **Cesta:** `spine/supply`
- **Osa příběhu (Story Axis):** spine/supply
- **Stav:** met
- **Duše (LoreLine):** Osa nabídky — aukční ring, inzeráty, VIN data a média; gate se rolluje z dětí.
- **Slib (Promise):** Co prodáváme, stojí za přihození.
- **Anti-Pattern (Zakázáno):** Osa, která sdružuje domény bez společného nabídkového smyslu.

### `sale`
- **Cesta:** `spine/sale`
- **Osa příběhu (Story Axis):** spine/sale
- **Stav:** met
- **Duše (LoreLine):** Osa prodeje — depozit, settlement a provize; gate se rolluje z dětí.
- **Slib (Promise):** Co se vydraží, to se i zaplatí.
- **Anti-Pattern (Zakázáno):** Osa, která sdružuje domény bez společného prodejního smyslu.

### `platform`
- **Cesta:** `spine/platform`
- **Osa příběhu (Story Axis):** spine/platform
- **Stav:** pending
- **Duše (LoreLine):** Paluba a hlídky — operátor vidí stav a stiskne tlačítko dřív, než něco spadne.
- **Slib (Promise):** Vše jde spustit z paluby a výpadek se pozná dřív, než uškodí.
- **Anti-Pattern (Zakázáno):** Platforma jako jeden blok — tichý fallback BFF nebo hluchá sonda se schová v zeleném celku a výpadek se pozná pozdě.

### `outreach`
- **Cesta:** `spine/outreach/outreach`
- **Osa příběhu (Story Axis):** outreach
- **Stav:** met
- **Duše (LoreLine):** Z plánu kampaně do schránky příjemce — pomalu, personalizovaně a beze stopy.
- **Slib (Promise):** Oslovení dorazí relevantní, v bezpečném tempu a bez metadatové stopy.
- **Anti-Pattern (Zakázáno):** Outreach jako jeden blok — dílčí selhání (rozbitý warmup, prosáklá metadata) se schová v zeleném celku a vyplave až jako blacklist.

### `inbound`
- **Cesta:** `spine/inbound/inbound`
- **Osa příběhu (Story Axis):** inbound
- **Stav:** met
- **Duše (LoreLine):** Z IMAP schránky na stav vlákna — reply zařazený, bounce odstavený, nic ztracené.
- **Slib (Promise):** Každá odpověď i odraz se zachytí, zařadí a uklidí do stavu.
- **Anti-Pattern (Zakázáno):** Inbound jako jeden blok — tiše spadlý poller nebo přehlédnutý bounce se schová v zeleném celku a leady mizí.

### `engine`
- **Cesta:** `spine/engine`
- **Osa příběhu (Story Axis):** engine
- **Stav:** pending

### `demand`
- **Cesta:** `spine/demand`
- **Osa příběhu (Story Axis):** spine/demand
- **Stav:** met
- **Duše (LoreLine):** Osa poptávky — discovery, retence a komunikace mezi kupcem a inzerátem; gate se rolluje z dětí.
- **Slib (Promise):** Co trh poptává, to najde.
- **Anti-Pattern (Zakázáno):** Osa, která sdružuje domény bez společného poptávkového smyslu.

### `compliance`
- **Cesta:** `spine/compliance/compliance`
- **Osa příběhu (Story Axis):** compliance
- **Stav:** met
- **Duše (LoreLine):** Legitimní zájem, odvolatelný souhlas, auditní stopa — GDPR jako základ, ne dodatek.
- **Slib (Promise):** Každé oslovení je legitimní, odvolatelné a auditovatelné.
- **Anti-Pattern (Zakázáno):** Compliance jako jeden blok — díra v suppression nebo ztracený audit se schová v zeleném celku a vyplave až jako stížnost u ÚOOÚ.

### `acquisition`
- **Cesta:** `spine/acquisition/acquisition`
- **Osa příběhu (Story Axis):** acquisition
- **Stav:** met
- **Duše (LoreLine):** Z veřejných registrů a marketplaců na ověřené, segmentované kontakty — bez balastu.
- **Slib (Promise):** Seznam firem je čistý, ověřený a zařazený dřív, než ho kampaň osloví.
- **Anti-Pattern (Zakázáno):** Nábor jako jeden neprůhledný import — neověřené adresy a špatné zařazení se schovají v zeleném celku a vyplavou až jako bounce.

### `scraper-mobile-de`
- **Cesta:** `frontiers/scraper-mobile-de`
- **Osa příběhu (Story Axis):** frontiers
- **Stav:** pending

### `scraper-mascus`
- **Cesta:** `frontiers/scraper-mascus-cz`
- **Osa příběhu (Story Axis):** frontiers
- **Stav:** pending

### `scraper-judikaty`
- **Cesta:** `frontiers/scraper-judikaty`
- **Osa příběhu (Story Axis):** frontiers
- **Stav:** pending

### `scraper-firmy`
- **Cesta:** `frontiers/scraper-firmy-cz`
- **Osa příběhu (Story Axis):** frontiers
- **Stav:** pending

### `scraper-esbirka`
- **Cesta:** `frontiers/scraper-esbirka`
- **Osa příběhu (Story Axis):** frontiers
- **Stav:** pending

### `scraper-autoline`
- **Cesta:** `frontiers/scraper-autoline`
- **Osa příběhu (Story Axis):** frontiers
- **Stav:** pending

### `marketplace-web`
- **Cesta:** `apps/marketplace-web`
- **Osa příběhu (Story Axis):** apps
- **Stav:** pending

### `operator-console`
- **Cesta:** `apps/operator-console`
- **Osa příběhu (Story Axis):** apps
- **Stav:** pending
- **Původ (Origin):** hozan-taher/features/platform

### `specs-before-bid`
- **Cesta:** `spine/supply/vehicle-vin/specs-before-bid`
- **Osa příběhu (Story Axis):** spine/supply/vehicle-vin/specs-before-bid
- **Stav:** met
- **Duše (LoreLine):** Papíry napřed — specs čtené dřív, než padne první nabídka.
- **Slib (Promise):** Než přihodíš, vidíš čím přihazuješ.
- **Anti-Pattern (Zakázáno):** Příhoz před přečtením specs — rozhoduje cena, ne ověřená data.

### `soft-close`
- **Cesta:** `spine/supply/bidding/soft-close`
- **Osa příběhu (Story Axis):** spine/supply/bidding/soft-close
- **Stav:** met
- **Duše (LoreLine):** Soft-close, který nedovolí ukrást aukci na poslední chvíli — a je to vidět.
- **Slib (Promise):** Neukradnou ti aukci v poslední vteřině.
- **Anti-Pattern (Zakázáno):** Soft-close skrytý — prodloužení countdownu vypadá jako bug, férovost nikdo nevidí.

### `vehicle-vin`
- **Cesta:** `spine/supply/vehicle-vin`
- **Osa příběhu (Story Axis):** spine/supply/vehicle-vin
- **Stav:** met
- **Duše (LoreLine):** Otevřené papíry — VIN dekód promění inzerát v ověřený technický životopis vozu.
- **Slib (Promise):** Vidíš všechno co při osobní prohlídce — a víc.
- **Anti-Pattern (Zakázáno):** Životopis jako jeden neprůhledný blok — dílčí selhání (torzo specs) se schová v zeleném celku.

### `media-upload`
- **Cesta:** `spine/supply/media-upload`
- **Osa příběhu (Story Axis):** spine/supply/media-upload
- **Stav:** met
- **Duše (LoreLine):** Vůz i stroj ze všech úhlů — galerie a 360° prohlídka dají kupci oči, které by měl při osobní prohlídce.
- **Slib (Promise):** Nic skrytého.
- **Anti-Pattern (Zakázáno):** Oči kupce jako jeden neprůhledný blok — dílčí selhání (placeholder 360°) se schová v zeleném celku.

### `empty-state`
- **Cesta:** `spine/supply/auction-items/empty-state`
- **Osa příběhu (Story Axis):** spine/supply/auction-items/empty-state
- **Stav:** met
- **Duše (LoreLine):** Když listing nic nenajde, promluví — hlas místo bílé plochy.
- **Slib (Promise):** Prázdný výsledek ti něco řekne, nenechá tě v tichu.
- **Anti-Pattern (Zakázáno):** Prázdný listing jako bílá stránka — vypadá rozbitě, mlčky bere důvěru.

### `eligibility`
- **Cesta:** `spine/supply/bidding/eligibility`
- **Osa příběhu (Story Axis):** spine/supply/bidding/eligibility
- **Stav:** met
- **Duše (LoreLine):** Kauce odemyká přihazování — bez ní ticho po pěšině.
- **Slib (Promise):** Nepřihodí ti někdo, kdo nemá kůži ve hře.
- **Anti-Pattern (Zakázáno):** Gate jen v UI — obejde se přímým API requestem.

### `detail-order`
- **Cesta:** `spine/supply/auction-items/detail-order`
- **Osa příběhu (Story Axis):** spine/supply/auction-items/detail-order
- **Stav:** met
- **Duše (LoreLine):** Papers-first — VIN a specs stojí nad foldem, cena čeká pod nimi.
- **Slib (Promise):** Fakta o stroji potkáš dřív než cenu.
- **Anti-Pattern (Zakázáno):** Detail s cenou nahoře a papíry pod foldem — číslo přebije důvěru.

### `decode-cache`
- **Cesta:** `spine/supply/vehicle-vin/decode-cache`
- **Osa příběhu (Story Axis):** spine/supply/vehicle-vin/decode-cache
- **Stav:** met
- **Duše (LoreLine):** Durabilní cache — opakovaný VIN přijde z paměti, ne z účtu.
- **Slib (Promise):** Stejný VIN podruhé nestojí nic.
- **Anti-Pattern (Zakázáno):** Každý opakovaný VIN volá Vincario znovu — platíme za data, která už máme.

### `concurrency`
- **Cesta:** `spine/supply/bidding/concurrency`
- **Osa příběhu (Story Axis):** spine/supply/bidding/concurrency
- **Stav:** met
- **Duše (LoreLine):** I když přihodí dva naráz, ring zůstane férový.
- **Slib (Promise):** Souběžné příhozy nikdy nerozhodí pořadí ani cenu.
- **Anti-Pattern (Zakázáno):** Optimistický zápis bez zámku — dvojí vítěz pod souběhem.

### `completeness`
- **Cesta:** `spine/supply/media-upload/completeness`
- **Osa příběhu (Story Axis):** spine/supply/media-upload/completeness
- **Stav:** met
- **Duše (LoreLine):** Plná galerie — fotek nad minimem, stroj ze všech úhlů.
- **Slib (Promise):** Vidíš stroj na dost fotkách, ne na třech z dálky.
- **Anti-Pattern (Zakázáno):** Inzerát s pár fotkami z dálky — kupec netuší, co kupuje.

### `card-order`
- **Cesta:** `spine/supply/auction-items/card-order`
- **Osa příběhu (Story Axis):** spine/supply/auction-items/card-order
- **Stav:** met
- **Duše (LoreLine):** Karta vypráví — fotka a specs napřed, cena až nakonec.
- **Slib (Promise):** Z karty čteš stroj, ne jen jeho cenu.
- **Anti-Pattern (Zakázáno):** Karta s cenou nad fotkou — listing prodává čísla místo strojů.

### `bidding`
- **Cesta:** `spine/supply/bidding`
- **Osa příběhu (Story Axis):** spine/supply/bidding
- **Stav:** met
- **Duše (LoreLine):** Férová dražba — kůže ve hře plus soft-close, který nedovolí ukrást aukci v poslední vteřině.
- **Slib (Promise):** Nepřeplatíš, neukradnou ti to, souběh nerozhodí pořadí.
- **Anti-Pattern (Zakázáno):** Bidding jako jeden neprůhledný blok — dílčí selhání (skrytý soft-close) se schová v zeleném celku.

### `auction-items`
- **Cesta:** `spine/supply/auction-items`
- **Osa příběhu (Story Axis):** spine/supply/auction-items
- **Stav:** met
- **Duše (LoreLine):** Výkladní skříň — karta i detail vyprávějí příběh každého stroje od fotky po historii, dřív než ukážou cenu.
- **Slib (Promise):** Každý stroj má příběh dřív než cenu.
- **Anti-Pattern (Zakázáno):** Výkladní skříň jako jeden neprůhledný blok — dílčí selhání (cena nad fotkou na kartě) se schová v zeleném celku.

### `sale-settlement`
- **Cesta:** `spine/sale/sale-settlement`
- **Osa příběhu (Story Axis):** spine/sale/sale-settlement
- **Stav:** met
- **Duše (LoreLine):** Vypořádání po dražbě — výherce doplatí přesně koncovou cenu minus kauci, přes Stripe a jen jednou.
- **Slib (Promise):** Vydražená cena se zaplatí přesně a jen jednou.
- **Anti-Pattern (Zakázáno):** Vypořádání jako jeden neprůhledný blok — dvojí stržení skryté za zeleným checkoutem se schová v zeleném celku.

### `reconcile`
- **Cesta:** `spine/sale/deposit-billing/reconcile`
- **Osa příběhu (Story Axis):** spine/sale/deposit-billing/reconcile
- **Stav:** met
- **Duše (LoreLine):** 0 refund-candidate — každá platba spárovaná, účet sedí.
- **Slib (Promise):** Žádná platba neleží bez protějšku.
- **Anti-Pattern (Zakázáno):** Platba bez párového záznamu — skryté refund-riziko.

### `resolution`
- **Cesta:** `spine/sale/disputes-complaints/resolution`
- **Osa příběhu (Story Axis):** spine/sale/disputes-complaints/resolution
- **Stav:** met
- **Duše (LoreLine):** Doložení, rozhodnutí, výsledek — spor s tečkou na konci.
- **Slib (Promise):** Tvůj spor dojde k jasnému rozhodnutí.
- **Anti-Pattern (Zakázáno):** Případ, který zůstane věčně otevřený — spravedlnost, jež nikdy nepřijde.

### `invoicing`
- **Cesta:** `spine/sale/invoicing`
- **Osa příběhu (Story Axis):** spine/sale/invoicing
- **Stav:** met
- **Duše (LoreLine):** Proforma, faktura, storno — daňová stopa, která sedí.
- **Slib (Promise):** Za každou platbu máš dohledatelný doklad.
- **Anti-Pattern (Zakázáno):** Platba bez faktury — peníze bez papíru, noční můra účetní.

### `invoice-list`
- **Cesta:** `spine/sale/invoicing/invoice-list`
- **Osa příběhu (Story Axis):** spine/sale/invoicing/invoice-list
- **Stav:** met
- **Duše (LoreLine):** Kauce i nákup — všechny doklady v jednom seznamu.
- **Slib (Promise):** Své faktury najdeš se stavem i odkazem.
- **Anti-Pattern (Zakázáno):** Faktura existuje, ale uživatel ji nikde nevidí.

### `framing`
- **Cesta:** `spine/sale/deposit-billing/framing`
- **Osa příběhu (Story Axis):** spine/sale/deposit-billing/framing
- **Stav:** met
- **Duše (LoreLine):** Vstupenka, ne poplatek — framing, co vítá vážné dražitele.
- **Slib (Promise):** Kauce zní jako pozvánka, ne jako poplatek.
- **Anti-Pattern (Zakázáno):** Kauce komunikovaná jako zámek, poplatek nebo chyba — bariéra místo pozvánky.

### `fio-match`
- **Cesta:** `spine/sale/deposit-billing/fio-match`
- **Osa příběhu (Story Axis):** spine/sale/deposit-billing/fio-match
- **Stav:** met
- **Duše (LoreLine):** Variabilní symbol páruje — Fio poll dotáhne kauci bez ruky.
- **Slib (Promise):** Převod se spáruje sám, nad cílovou mírou.
- **Anti-Pattern (Zakázáno):** Nespárované převody pod cílem — ruční dohledávání a zpožděná kauce.

### `fakturoid-sync`
- **Cesta:** `spine/sale/invoicing/fakturoid-sync`
- **Osa příběhu (Story Axis):** spine/sale/invoicing/fakturoid-sync
- **Stav:** met
- **Duše (LoreLine):** Vytvoření, párování, storno — Fakturoid a my držíme krok.
- **Slib (Promise):** Stav tvé faktury sedí s účetnictvím.
- **Anti-Pattern (Zakázáno):** Doklad zaplacený u nás, ale neuhrazený ve Fakturoidu — rozjetá účetní realita.

### `disputes-complaints`
- **Cesta:** `spine/sale/disputes-complaints`
- **Osa příběhu (Story Axis):** spine/sale/disputes-complaints
- **Stav:** met
- **Duše (LoreLine):** Spor není slepá ulička — případ, stavy, rozhodnutí, náprava.
- **Slib (Promise):** Když něco nesedí, máš jasnou cestu k nápravě.
- **Anti-Pattern (Zakázáno):** Reklamace přes obecný kontakt bez stavu — stížnost, která se ztratí.

### `deposit-billing`
- **Cesta:** `spine/sale/deposit-billing`
- **Osa příběhu (Story Axis):** spine/sale/deposit-billing
- **Stav:** met
- **Duše (LoreLine):** Pozvánka do dražby — vratná kauce mění diváka ve vážného dražitele; peníze jsou jen mechanika důvěry.
- **Slib (Promise):** Kauce je vstupenka a status, ne poplatek.
- **Anti-Pattern (Zakázáno):** Kauce jako jeden neprůhledný blok — dílčí selhání (peníze bez protějšku) se schová v zeleném celku.

### `completion`
- **Cesta:** `spine/sale/sale-settlement/completion`
- **Osa příběhu (Story Axis):** spine/sale/sale-settlement/completion
- **Stav:** met
- **Duše (LoreLine):** Stripe webhook dotáhne settled_at — peníze a stav v jedné pravdě.
- **Slib (Promise):** Platba doběhne a stav sedí.
- **Anti-Pattern (Zakázáno):** Platba bez spolehlivého settled_at — duplicitní stržení nebo ztracený stav.

### `charge-once`
- **Cesta:** `spine/sale/sale-settlement/charge-once`
- **Osa příběhu (Story Axis):** spine/sale/sale-settlement/charge-once
- **Stav:** met
- **Duše (LoreLine):** CAS na settled_at — zámek, který nedovolí strhnout dvakrát.
- **Slib (Promise):** Strhne se právě jednou, jen výherci.
- **Anti-Pattern (Zakázáno):** Dvojí stržení nebo platba přístupná nevýherci — fatální ztráta důvěry.

### `case-open`
- **Cesta:** `spine/sale/disputes-complaints/case-open`
- **Osa příběhu (Story Axis):** spine/sale/disputes-complaints/case-open
- **Stav:** met
- **Duše (LoreLine):** Případ s číslem a stavem — ne stížnost do prázdna.
- **Slib (Promise):** Reklamaci otevřeš k obchodu a uvidíš, kde je.
- **Anti-Pattern (Zakázáno):** Spor bez vazby na obchod a bez stavu — ztracená stížnost.

### `billing-capture`
- **Cesta:** `spine/sale/sale-settlement/billing-capture`
- **Osa příběhu (Story Axis):** spine/sale/sale-settlement/billing-capture
- **Stav:** met
- **Duše (LoreLine):** Billing adresa zachycená u platby — doklad připravený.
- **Slib (Promise):** Doklad má z čeho vzniknout.
- **Anti-Pattern (Zakázáno):** Platba bez billing adresy — nelze vystavit doklad.

### `amount-due`
- **Cesta:** `spine/sale/sale-settlement/amount-due`
- **Osa příběhu (Story Axis):** spine/sale/sale-settlement/amount-due
- **Stav:** met
- **Duše (LoreLine):** Koncová cena minus kauce — přesně, deterministicky, na haléř.
- **Slib (Promise):** Doplatíš přesně, co dlužíš — na haléř.
- **Anti-Pattern (Zakázáno):** Zaokrouhlení nebo špatný kredit kauce — výherce přeplatí nebo nedoplatí.

### `pano-360`
- **Cesta:** `spine/supply/media-upload/pano-360`
- **Osa příběhu (Story Axis):** spine/supply/media-upload/pano-360
- **Stav:** met
- **Duše (LoreLine):** Otočíš si ho — 360° prohlídka jede tam, kde slibuje, ne placeholder.
- **Slib (Promise):** Když je 360° slíbená, opravdu si stroj otočíš.
- **Anti-Pattern (Zakázáno):** Deklarované 360°, které je jen placeholder — slibuje prohlídku, kterou nedodá.

### `worker-pdf`
- **Cesta:** `spine/platform/worker-pdf`
- **Osa příběhu (Story Axis):** spine/platform/worker-pdf
- **Stav:** met
- **Duše (LoreLine):** Fronta, Claude a LibreOffice — z dokumentů PDF, bez čekání operátora.
- **Slib (Promise):** PDF se vygeneruje asynchronně a operátor není blokován převodem.
- **Anti-Pattern (Zakázáno):** Idempotence jen na sessionId — retry během uploadu nechá dvě úlohy zapsat různá PDF na stejnou cestu a doručí staré.

### `token-lifecycle`
- **Cesta:** `spine/platform/api-tokens/token-lifecycle`
- **Osa příběhu (Story Axis):** spine/platform/api-tokens/token-lifecycle
- **Stav:** met
- **Duše (LoreLine):** Vydání, audit, revoke — přístup s vypínačem.
- **Slib (Promise):** Vydaný token kdykoli dohledáš a odvoláš.
- **Anti-Pattern (Zakázáno):** Token bez revoke — přístup, který přežije i toho, kdo ho vydal.

### `token-hash`
- **Cesta:** `spine/platform/api-tokens/token-hash`
- **Osa příběhu (Story Axis):** spine/platform/api-tokens/token-hash
- **Stav:** met
- **Duše (LoreLine):** Hash a prefix — z DB se původní token zpětně nedá vytáhnout.
- **Slib (Promise):** Tvůj token v databázi nikdo nepřečte.
- **Anti-Pattern (Zakázáno):** Plaintextový token v tabulce — jeden dump a je po bezpečnosti.

### `spec-validity`
- **Cesta:** `spine/platform/api-docs/spec-validity`
- **Osa příběhu (Story Axis):** spine/platform/api-docs/spec-validity
- **Stav:** met
- **Duše (LoreLine):** Validní papíry pro stroje — OpenAPI 3.1, který každý nástroj přečte.
- **Slib (Promise):** Spec se vždy načte.
- **Anti-Pattern (Zakázáno):** Rozbitý spec — partner nenačte dokument a integruje naslepo.

### `sitemap`
- **Cesta:** `spine/platform/core/sitemap`
- **Osa příběhu (Story Axis):** spine/platform/core/sitemap
- **Stav:** met
- **Duše (LoreLine):** Úplná sitemap — žádný aktivní stroj nezůstane skrytý před vyhledávačem.
- **Slib (Promise):** Každý živý inzerát je dohledatelný.
- **Anti-Pattern (Zakázáno):** Inzerát mimo sitemapu — živý stroj, který vyhledávač nikdy nenajde.

### `save-success`
- **Cesta:** `spine/platform/admin/save-success`
- **Osa příběhu (Story Axis):** spine/platform/admin/save-success
- **Stav:** met
- **Duše (LoreLine):** Spolehlivý save — kurátor plní výlohu bez ztracených zápisů.
- **Slib (Promise):** Uložení projde, nebo to dá jasně vědět.
- **Anti-Pattern (Zakázáno):** Tiše selhaný save — kurátor myslí, že uložil, katalog drží stará data.

### `rtl-parity`
- **Cesta:** `spine/platform/i18n/rtl-parity`
- **Osa příběhu (Story Axis):** spine/platform/i18n/rtl-parity
- **Stav:** met
- **Duše (LoreLine):** RTL bez trhlin — zrcadlené rozložení drží od Dubaje po Damašek.
- **Slib (Promise):** Arabsky to drží stejně jako latinkou.
- **Anti-Pattern (Zakázáno):** Rozbitý RTL — arabský layout se rozsype a trh odpadne.

### `reference-data`
- **Cesta:** `spine/platform/reference-data`
- **Osa příběhu (Story Axis):** spine/platform/reference-data
- **Stav:** met
- **Duše (LoreLine):** Společný jazyk inventáře — kategorie, země a měny dělají z techniky napříč Evropou jeden čitelný katalog.
- **Slib (Promise):** Stroj z jakékoli země je čitelný.
- **Anti-Pattern (Zakázáno):** Číselníky jako jeden neprůhledný blok — dílčí selhání (neznámá země) se schová v zeleném celku.

### `registration`
- **Cesta:** `spine/platform/auth-account/registration`
- **Osa příběhu (Story Axis):** spine/platform/auth-account/registration
- **Stav:** met
- **Duše (LoreLine):** Tok bez slepé uličky — kdo začne, ten dojde mezi vážné hráče.
- **Slib (Promise):** Registraci dokončíš bez slepé uličky.
- **Anti-Pattern (Zakázáno):** Tok, který umře uprostřed — vážný zájemce odpadne na kroku bez cesty dál.

### `protections`
- **Cesta:** `spine/platform/protections`
- **Osa příběhu (Story Axis):** spine/platform/protections
- **Stav:** met
- **Duše (LoreLine):** Jedenáct sond a eskalace — výpadek je vidět dřív, než ho nahlásí operátor.
- **Slib (Promise):** Výpadek se objeví na panelu a eskaluje do 5 minut.
- **Anti-Pattern (Zakázáno):** L3 shadow-tx na live outreach_mailboxes deadlockne se souběžnými sendy a umlčí alerty během špičky.

### `read-state`
- **Cesta:** `spine/platform/notifications/read-state`
- **Osa příběhu (Story Axis):** spine/platform/notifications/read-state
- **Stav:** met
- **Duše (LoreLine):** Přečteno zůstane přečtené — žádné fantomové odznaky.
- **Slib (Promise):** Upozornění tě nezahltí ani nezdvojí.
- **Anti-Pattern (Zakázáno):** Stejné upozornění třikrát a odznak, který nikdy nezhasne.

### `password-reset`
- **Cesta:** `spine/platform/auth-account/password-reset`
- **Osa příběhu (Story Axis):** spine/platform/auth-account/password-reset
- **Stav:** met
- **Duše (LoreLine):** Odkaz v poště, nové heslo — návrat bez ztráty účtu.
- **Slib (Promise):** Zapomenuté heslo si vždy obnovíš.
- **Anti-Pattern (Zakázáno):** Zapomenuté heslo = ztracený účet — reset, který chybí nebo tiše selže.

### `notifications`
- **Cesta:** `spine/platform/notifications`
- **Osa příběhu (Story Axis):** spine/platform/notifications
- **Stav:** met
- **Duše (LoreLine):** Přehodili tě? Vyhrál jsi? Uvidíš to dřív, než otevřeš poštu.
- **Slib (Promise):** Důležité se k tobě dostane včas.
- **Anti-Pattern (Zakázáno):** Upozornění jen e-mailem, které dorazí pozdě — výhra, o které se kupec dozví po termínu.

### `mcp`
- **Cesta:** `spine/platform/mcp`
- **Osa příběhu (Story Axis):** spine/platform/mcp
- **Stav:** met
- **Duše (LoreLine):** Dotazovací nástroje nad daty — propojené interním DNS, ne hardcoded adresou.
- **Slib (Promise):** Data jdou dotazovat přes MCP nástroje po stabilní interní síti.
- **Anti-Pattern (Zakázáno):** Hardcoded hostname místo interního DNS — komunikace se rozpadne při přesunu služby a nikdo neví proč.

### `lcp`
- **Cesta:** `spine/platform/core/lcp`
- **Osa příběhu (Story Axis):** spine/platform/core/lcp
- **Stav:** met
- **Duše (LoreLine):** Rychlé jeviště — LCP pod 2.5s, profík vidí stroje hned.
- **Slib (Promise):** Nabídku uvidíš dřív, než ztratíš trpělivost.
- **Anti-Pattern (Zakázáno):** Pomalý first paint — profík odejde dřív, než uvidí nabídku.

### `list-latency`
- **Cesta:** `spine/platform/admin/list-latency`
- **Osa příběhu (Story Axis):** spine/platform/admin/list-latency
- **Stav:** met
- **Duše (LoreLine):** Svižný list — kurátor listuje katalogem bez čekání.
- **Slib (Promise):** Výpis tě nebrzdí ani pod zátěží.
- **Anti-Pattern (Zakázáno):** Pomalý výpis — kurátor čeká a kvalita katalogu klesá.

### `key-events`
- **Cesta:** `spine/platform/notifications/key-events`
- **Osa příběhu (Story Axis):** spine/platform/notifications/key-events
- **Stav:** met
- **Duše (LoreLine):** Tři události, na kterých záleží — doručené hned.
- **Slib (Promise):** O výhře i přehozu se dozvíš včas.
- **Anti-Pattern (Zakázáno):** Výhra oznámená pozdě — kupec přijde o auto kvůli zpoždělé zprávě.

### `key-completeness`
- **Cesta:** `spine/platform/i18n/key-completeness`
- **Osa příběhu (Story Axis):** spine/platform/i18n/key-completeness
- **Stav:** met
- **Duše (LoreLine):** Žádný fallback na češtinu — Kyjev, Berlín i Dubaj čtou ve své řeči.
- **Slib (Promise):** Každý jazyk je kompletní.
- **Anti-Pattern (Zakázáno):** Chybějící klíč v locale — cizí jazyk tiše spadne na český text.

### `ingest`
- **Cesta:** `spine/platform/consent-tracking/ingest`
- **Osa příběhu (Story Axis):** spine/platform/consent-tracking/ingest
- **Stav:** met
- **Duše (LoreLine):** Idempotentní brána — žádné duplicity, žádné měření bez svolení.
- **Slib (Promise):** Tvoje data se počítají jednou a férově.
- **Anti-Pattern (Zakázáno):** Ingest, který bere vše a započítává dvakrát — data, kterým nelze věřit.

### `guards`
- **Cesta:** `spine/platform/auth-account/guards`
- **Osa příběhu (Story Axis):** spine/platform/auth-account/guards
- **Stav:** met
- **Duše (LoreLine):** Anonymní SSR plus client-side guard — divák vidí jen veřejnou výlohu.
- **Slib (Promise):** Žádný anonymní šum se nedostane k chráněným datům.
- **Anti-Pattern (Zakázáno):** Guard jen ve šabloně — SSR prosákne chráněná data nepřihlášenému.

### `i18n`
- **Cesta:** `spine/platform/i18n`
- **Osa příběhu (Story Axis):** spine/platform/i18n
- **Stav:** met
- **Duše (LoreLine):** Most přes hranice — 12 jazyků dělá z tahače v Brně nabídku pro Kyjev, Berlín i Dubaj.
- **Slib (Promise):** Mluvíme tvou řečí.
- **Anti-Pattern (Zakázáno):** i18n jako jeden neprůhledný blok — dílčí selhání (chybějící klíč) se schová v zeleném celku.

### `design-system`
- **Cesta:** `spine/platform/design-system`
- **Osa příběhu (Story Axis):** spine/platform/design-system
- **Stav:** met
- **Duše (LoreLine):** Vizuální hlas Auction24 — Base* primitiva nesou profesionální sebevědomí značky, ne korporátní šeď.
- **Slib (Promise):** Každý dotyk vypadá záměrně.
- **Anti-Pattern (Zakázáno):** Design-system jako jeden neprůhledný blok — dílčí selhání (off-brand komponenta) se schová v zeleném celku.

### `dashboard-bff`
- **Cesta:** `spine/platform/dashboard-bff`
- **Osa příběhu (Story Axis):** spine/platform/dashboard-bff
- **Stav:** met
- **Duše (LoreLine):** BFF jako jediná paluba — čtení z Postgresu, akce přes Go, žádná dvojí cesta.
- **Slib (Promise):** Operátor řídí kampaně z UI a akce projde právě jednou cestou.
- **Anti-Pattern (Zakázáno):** Tichý fallback na přímý Postgres provede run/pause v obou systémech a po zotavení Go zdvojí odeslání všem příjemcům.

### `country-resolution`
- **Cesta:** `spine/platform/reference-data/country-resolution`
- **Osa příběhu (Story Axis):** spine/platform/reference-data/country-resolution
- **Stav:** met
- **Duše (LoreLine):** Každá země rozpoznaná — tahač z Ukrajiny i z Chorvatska má svou vlajku a měnu.
- **Slib (Promise):** Stroj z jakékoli země se rozpozná.
- **Anti-Pattern (Zakázáno):** Neznámá země u zahraničního stroje — nabídka beze jména a měny.

### `core`
- **Cesta:** `spine/platform/core`
- **Osa příběhu (Story Axis):** spine/platform/core
- **Stav:** met
- **Duše (LoreLine):** Neviditelné jeviště — infra, SEO a consent drží svět Auction24 rychlý, dohledatelný a důvěryhodný.
- **Slib (Promise):** Rychlost a nalezitelnost.
- **Anti-Pattern (Zakázáno):** Jeviště jako jeden neprůhledný blok — dílčí selhání (inzerát mimo sitemapu) se schová v zeleném celku.

### `consent-tracking`
- **Cesta:** `spine/platform/consent-tracking`
- **Osa příběhu (Story Axis):** spine/platform/consent-tracking
- **Stav:** met
- **Duše (LoreLine):** Cookie lišta drží bránu — bez souhlasu se neměří, s ním se vrací lepší výběr.
- **Slib (Promise):** Měříme tě jen s tvým souhlasem.
- **Anti-Pattern (Zakázáno):** Tracking, který běží bez souhlasu — měření za zády uživatele.

### `contract-drift`
- **Cesta:** `spine/platform/api-docs/contract-drift`
- **Osa příběhu (Story Axis):** spine/platform/api-docs/contract-drift
- **Stav:** met
- **Duše (LoreLine):** Bez driftu — co je v papírech, to routa skutečně vrací.
- **Slib (Promise):** Spec sedí s tím, co API dělá.
- **Anti-Pattern (Zakázáno):** Spec mimo realitu — dokument slibuje, co routa nedělá.

### `platform-compliance`
- **Cesta:** `spine/platform/compliance`
- **Osa příběhu (Story Axis):** spine
- **Stav:** pending

### `consent-gate`
- **Cesta:** `spine/platform/consent-tracking/consent-gate`
- **Osa příběhu (Story Axis):** spine/platform/consent-tracking/consent-gate
- **Stav:** met
- **Duše (LoreLine):** Souhlas je spínač — dokud nesepne, fronta zůstává prázdná.
- **Slib (Promise):** Než řekneš ano, neměříme nic.
- **Anti-Pattern (Zakázáno):** Klient, který měří ještě před kliknutím na souhlas.

### `category-coverage`
- **Cesta:** `spine/platform/reference-data/category-coverage`
- **Osa příběhu (Story Axis):** spine/platform/reference-data/category-coverage
- **Stav:** met
- **Duše (LoreLine):** Úplné kategorie — od bagru po tahač má každý typ své místo v katalogu.
- **Slib (Promise):** Každý stroj má svou kategorii.
- **Anti-Pattern (Zakázáno):** Mezera v kategoriích — část inventáře se nikam nezařadí a zmizí.

### `auth-account`
- **Cesta:** `spine/platform/auth-account`
- **Osa příběhu (Story Axis):** spine/platform/auth-account
- **Stav:** met
- **Duše (LoreLine):** Vstup do dražby začíná tady — ověřená identita je první krok od diváka k vážnému účastníkovi.
- **Slib (Promise):** Bezpečný účet, žádný anonymní šum.
- **Anti-Pattern (Zakázáno):** Auth jako jeden neprůhledný blok — dílčí selhání (prosáklý guard) se schová v zeleném celku.

### `brand-parity`
- **Cesta:** `spine/platform/design-system/brand-parity`
- **Osa příběhu (Story Axis):** spine/platform/design-system/brand-parity
- **Stav:** met
- **Duše (LoreLine):** Token parita — každý dotyk mluví hlasem Auction24, ne korporátní šedí.
- **Slib (Promise):** Žádná komponenta nevypadá off-brand.
- **Anti-Pattern (Zakázáno):** Komponenta mimo tokeny — svévolná hodnota prozradí default šablonu.

### `platform-audit`
- **Cesta:** `spine/platform/audit`
- **Osa příběhu (Story Axis):** spine
- **Stav:** pending

### `auth`
- **Cesta:** `spine/platform/auth`
- **Osa příběhu (Story Axis):** platform
- **Stav:** met
- **Duše (LoreLine):** Vstup do dražby začíná tady — ověřená identita je první krok od diváka k vážnému účastníkovi.
- **Slib (Promise):** Bezpečný účet, žádný anonymní šum.
- **Anti-Pattern (Zakázáno):** Auth jako jeden neprůhledný blok — dílčí selhání (prosáklý guard) se schová v zeleném celku.

### `api-docs`
- **Cesta:** `spine/platform/api-docs`
- **Osa příběhu (Story Axis):** spine/platform/api-docs
- **Stav:** met
- **Duše (LoreLine):** Otevřené papíry i pro stroje — veřejná OpenAPI dělá z platformy partnera, ne černou skříňku.
- **Slib (Promise):** Integrovatelnost bez hádání.
- **Anti-Pattern (Zakázáno):** Dokumentace jako jeden neprůhledný blok — dílčí selhání (contract drift) se schová v zeleném celku.

### `api-tokens`
- **Cesta:** `spine/platform/api-tokens`
- **Osa příběhu (Story Axis):** spine/platform/api-tokens
- **Stav:** met
- **Duše (LoreLine):** Token se ukáže jednou, žije jako hash a padne na jedno kliknutí.
- **Slib (Promise):** Programový přístup vydáš, uvidíš a kdykoli odvoláš.
- **Anti-Pattern (Zakázáno):** Token v plaintextu nebo bez revoke — přístup, který nejde vzít zpět.

### `account`
- **Cesta:** `spine/platform/account`
- **Osa příběhu (Story Axis):** spine
- **Stav:** pending

### `admin`
- **Cesta:** `spine/platform/admin`
- **Osa příběhu (Story Axis):** spine/platform/admin
- **Stav:** met
- **Duše (LoreLine):** Dílna za scénou — kurátor plní výkladní skříň; kvalita katalogu, kterou kupec cítí, se rodí tady.
- **Slib (Promise):** Rychlá, bezchybná správa nabídky (interní).
- **Anti-Pattern (Zakázáno):** Admin jako jeden neprůhledný blok — dílčí selhání (tichý ztracený save) se schová v zeleném celku.

### `a11y`
- **Cesta:** `spine/platform/design-system/a11y`
- **Osa příběhu (Story Axis):** spine/platform/design-system/a11y
- **Stav:** met
- **Duše (LoreLine):** a11y v základu — klávesnice, kontrast i čtečka fungují na každém dotyku.
- **Slib (Promise):** Každé primitivum je přístupné.
- **Anti-Pattern (Zakázáno):** Primitivum jen pro myš — klávesnice a čtečka narazí na zeď.

### `warmup`
- **Cesta:** `spine/outreach/warmup`
- **Osa příběhu (Story Axis):** spine/outreach/warmup
- **Stav:** met
- **Duše (LoreLine):** 5 → 10 → 25 → 50 → 100 za den — trpělivost vynucená triggerem, ne příslibem.
- **Slib (Promise):** Schránka roste podle fází a cap nelze obejít — reputace se buduje bezpečně.
- **Anti-Pattern (Zakázáno):** Fáze se neposune nebo se cap tiše obejde — schránka pošle Den 1 sto e-mailů a ISP ji zamkne.

### `send-window`
- **Cesta:** `spine/outreach/send-window`
- **Osa příběhu (Story Axis):** spine/outreach/send-window
- **Stav:** met
- **Duše (LoreLine):** Pracovní den, otevřené okno, žádný svátek — kdy oslovit rozhoduje kalendář, ne náhoda.
- **Slib (Promise):** Odesílá se jen v českém pracovním okně — žádné svátky a mrtvé zóny.
- **Anti-Pattern (Zakázáno):** Hardcoded seznam svátků se rozejde s realitou (nový svátek, DST) — odesílá se v blackout dnech bez alertu.

### `send-dedup`
- **Cesta:** `spine/outreach/send-dedup`
- **Osa příběhu (Story Axis):** spine/outreach/send-dedup
- **Stav:** met
- **Duše (LoreLine):** Jeden claim, jedno odeslání — duální cesta bez duplicitního zásahu.
- **Slib (Promise):** Souběžné cesty se nepřekříží — každý krok odejde právě jednou.
- **Anti-Pattern (Zakázáno):** Obě cesty závodí o stejný krok bez koordinace — kontakt dostane e-mail dvakrát a suppression list roste duplicitami.

### `sanitize`
- **Cesta:** `spine/outreach/anti-trace/sanitize`
- **Osa příběhu (Story Axis):** spine/outreach/anti-trace/sanitize
- **Stav:** met
- **Duše (LoreLine):** Vstupní filtr — co prozrazuje, padne, než se to dotkne pipeline.
- **Slib (Promise):** Trackery, skripty a fingerprint hlaviček jsou strženy na vstupu.
- **Anti-Pattern (Zakázáno):** Identifikující hlavička nebo tracking pixel projde sanitací — fingerprint prosákne celým řetězcem.

### `mailbox-reliability`
- **Cesta:** `spine/outreach/mailbox-reliability`
- **Osa příběhu (Story Axis):** spine/outreach/mailbox-reliability
- **Stav:** met
- **Duše (LoreLine):** Tři selhání a klid — jistič, co chrání účet před vlastní schránkou.
- **Slib (Promise):** Selhávající schránka jde do cooldownu místo kaskády auth chyb.
- **Anti-Pattern (Zakázáno):** Schránka retryuje navždy bez throttlingu — auth chyby kaskádují, ISP rate-limitne a sendy z ní mizí.

### `metadata-min`
- **Cesta:** `spine/outreach/anti-trace/metadata-min`
- **Osa příběhu (Story Axis):** spine/outreach/anti-trace/metadata-min
- **Stav:** met
- **Duše (LoreLine):** Padding a bucket — velikost ani čas už nic neprozradí.
- **Slib (Promise):** Velikost a čas jsou rozmazány do tříd — žádný korelační kanál.
- **Anti-Pattern (Zakázáno):** Proměnná velikost obsahu nebo přesný timestamp projde — korelační útok podle metadat uspěje.

### `egress`
- **Cesta:** `spine/outreach/anti-trace/egress`
- **Osa příběhu (Story Axis):** spine/outreach/anti-trace/egress
- **Stav:** met
- **Duše (LoreLine):** Mullvad exit napevno — žádný přímý SMTP, žádný skok přes hranice.
- **Slib (Promise):** Odchod jde jen přes SOCKS5 a každá schránka drží stálý exit.
- **Anti-Pattern (Zakázáno):** Schránka přeskočí Mullvad exit mezi zeměmi do 60 min nebo padne na přímý SMTP — fraud-detekce zkoreluje vzorec.

### `content-render`
- **Cesta:** `spine/outreach/content-render`
- **Osa příběhu (Story Axis):** spine/outreach/content-render
- **Stav:** met
- **Duše (LoreLine):** Z šablony na lidskou zprávu — proměnné dosazené, spintax rozřešený, tón polidštěný.
- **Slib (Promise):** Každý příjemce vidí personalizovaný a variantní text, ne formulář.
- **Anti-Pattern (Zakázáno):** Všichni dostanou identický text bez personalizace, variant a rotace podpisu — očividně automatizované oslovení.

### `content-enc`
- **Cesta:** `spine/outreach/anti-trace/content-enc`
- **Osa příběhu (Story Axis):** spine/outreach/anti-trace/content-enc
- **Stav:** met
- **Duše (LoreLine):** X25519 + AES-GCM — relay přepošle, ale nepřečte.
- **Slib (Promise):** Obsah je zapečetěný — relay vidí jen šifrotext.
- **Anti-Pattern (Zakázáno):** Obsah je čitelný pro relay operátora — transportní anonymita je k ničemu, když je payload otevřený.

### `campaign-scheduler`
- **Cesta:** `spine/outreach/campaign-scheduler`
- **Osa příběhu (Story Axis):** spine/outreach/campaign-scheduler
- **Stav:** met
- **Duše (LoreLine):** Tikot kampaně — eligible kontakt, otevřené okno, posunutý krok, beze zásahu operátora.
- **Slib (Promise):** Kampaň běží automaticky, vybírá správné kontakty a posouvá sekvenci.
- **Anti-Pattern (Zakázáno):** Tick proběhne bez chyby, ale všechny kontakty tiše vygejtuje (0 sendů) — kampaň „běží" a nic neodchází.

### `anti-trace`
- **Cesta:** `spine/outreach/anti-trace`
- **Osa příběhu (Story Axis):** spine/outreach/anti-trace
- **Stav:** met
- **Duše (LoreLine):** Šestnáct kroků mezi obsahem a sítí — sanitace, šifra, jitter, exit přes Mullvad.
- **Slib (Promise):** E-mail odejde sanitovaný, šifrovaný a přes SOCKS5 — bez korelovatelné stopy.
- **Anti-Pattern (Zakázáno):** Metadata prosáknou nešifrovaná nebo přímý SMTP obejde relay — korelace času/velikosti/hlaviček deanonymizuje odesílatele.

### `thread-match`
- **Cesta:** `spine/inbound/thread-match`
- **Osa příběhu (Story Axis):** spine/inbound/thread-match
- **Stav:** met
- **Duše (LoreLine):** In-Reply-To, References, fallback — odpověď vždy najde své vlákno.
- **Slib (Promise):** Každá odpověď je napojená na své vlákno — konverzace v kontextu.
- **Anti-Pattern (Zakázáno):** Parsování hlaviček selže, matchToThread vrátí nil a odpověď osiří bez thread_id — rozbije se konverzační pohled.

### `reply-classify`
- **Cesta:** `spine/inbound/reply-classify`
- **Osa příběhu (Story Axis):** spine/inbound/reply-classify
- **Stav:** met
- **Duše (LoreLine):** Keyword dno, LLM strop — žádná odpověď nezůstane bez zařazení.
- **Slib (Promise):** Každá odpověď je zařazená — skutečné leady oddělené od auto-reply.
- **Anti-Pattern (Zakázáno):** LLM klasifikátor selže, ale fallback se nezavolá — klasifikace zůstane null a operátor vidí prázdný řádek.

### `imap-poll`
- **Cesta:** `spine/inbound/imap-poll`
- **Osa příběhu (Story Axis):** spine/inbound/imap-poll
- **Stav:** met
- **Duše (LoreLine):** Tichý poller, co se sám zotaví — odpověď je vidět dřív, než si jí operátor všimne.
- **Slib (Promise):** Odpovědi dorazí do systému do pár minut, samy.
- **Anti-Pattern (Zakázáno):** Reconnect tiše selže a polling se zastaví — odpovědi nevyplavou až do ručního restartu.

### `bounce-handle`
- **Cesta:** `spine/inbound/bounce-handle`
- **Osa příběhu (Story Axis):** spine/inbound/bounce-handle
- **Stav:** met
- **Duše (LoreLine):** Šestikrokový úklid — odraz zavře vlákno, suppresne kontakt a zatlačí na schránku.
- **Slib (Promise):** Hard bounce kontakt se okamžitě suppresne — žádné další odeslání.
- **Anti-Pattern (Zakázáno):** Hard bounce detekován, ale UPDATE status=bounced neproběhne — stejná adresa se zařadí do další kampaně a odešle znovu.

### `bounce-detect`
- **Cesta:** `spine/inbound/bounce-detect`
- **Osa příběhu (Story Axis):** spine/inbound/bounce-detect
- **Stav:** met
- **Duše (LoreLine):** Brána před klasifikací — MAILER-DAEMON se nikdy nevydává za zájem.
- **Slib (Promise):** Bounce se rozpozná dřív, než ho cokoli splete s leadem.
- **Anti-Pattern (Zakázáno):** DSN dorazí, ale DetectBounce gate se přeskočí — „we tried to deliver" se klasifikuje jako interested a vznikne ghost lead.

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

### `core-types`
- **Cesta:** `spine/domain/core-types`
- **Osa příběhu (Story Axis):** domain
- **Stav:** met
- **Tagy:** types, zod, schema, validation, dto

### `url-state`
- **Cesta:** `spine/demand/search/url-state`
- **Osa příběhu (Story Axis):** spine/demand/search/url-state
- **Stav:** met
- **Duše (LoreLine):** Facety v sync s URL — výběr přežije reload i sdílení.
- **Slib (Promise):** Co vyfiltruješ, to jde poslat odkazem.
- **Anti-Pattern (Zakázáno):** Facety jen v paměti komponenty — reload nebo sdílený odkaz výběr zahodí.

### `unsubscribe`
- **Cesta:** `spine/demand/saved-search/unsubscribe`
- **Osa příběhu (Story Axis):** spine/demand/saved-search/unsubscribe
- **Stav:** met
- **Duše (LoreLine):** HMAC odkaz — odhlášení bez loginu, jedním klikem.
- **Slib (Promise):** Alert vypneš jedním klikem z mailu.
- **Anti-Pattern (Zakázáno):** Odhlášení za loginem — frustrace a spam-stížnost.

### `toggle-roundtrip`
- **Cesta:** `spine/demand/favorites/toggle-roundtrip`
- **Osa příběhu (Story Axis):** spine/demand/favorites/toggle-roundtrip
- **Stav:** met
- **Duše (LoreLine):** Jeden klik, jeden stav — bez záhadných návratů.
- **Slib (Promise):** Co označíš hvězdou, tam zůstane.
- **Anti-Pattern (Zakázáno):** Hvězda, která po reloadu zmizí — stav, jemuž nelze věřit.

### `spam-hidden`
- **Cesta:** `spine/demand/messaging/spam-hidden`
- **Osa příběhu (Story Axis):** spine/demand/messaging/spam-hidden
- **Stav:** met
- **Duše (LoreLine):** Moderace na světle — spam zahozený dřív, než ho někdo uvidí.
- **Slib (Promise):** Spam se ke kupci nedostane.
- **Anti-Pattern (Zakázáno):** Nemoderované vlákno — spam na světle odpudí vážné zájemce.

### `send`
- **Cesta:** `spine/demand/saved-search/send`
- **Osa příběhu (Story Axis):** spine/demand/saved-search/send
- **Stav:** met
- **Duše (LoreLine):** Cron, který hlídá za tebe — nová shoda do schránky.
- **Slib (Promise):** Nová shoda přijde sama do schránky.
- **Anti-Pattern (Zakázáno):** Due hledání, které cron neobešle — tichý alert.

### `seller-visible`
- **Cesta:** `spine/demand/ratings-reviews/seller-visible`
- **Osa příběhu (Story Axis):** spine/demand/ratings-reviews/seller-visible
- **Stav:** met
- **Duše (LoreLine):** Skóre u jména — důvěra na dosah ruky.
- **Slib (Promise):** Reputaci prodejce uvidíš tam, kde přihazuješ.
- **Anti-Pattern (Zakázáno):** Reputace existuje, ale je schovaná mimo dosah rozhodnutí.

### `search`
- **Cesta:** `spine/demand/search`
- **Osa příběhu (Story Axis):** spine/demand/search
- **Stav:** met
- **Duše (LoreLine):** Faceted hledání napříč diakritikou a hranicemi — profík najde přesně ten stroj, který hledá.
- **Slib (Promise):** Co na trhu je, to jde najít — slovem, facetou i sdíleným odkazem.
- **Anti-Pattern (Zakázáno):** Hledání jako jeden neprůhledný blok — dílčí selhání (rozbitý facet-sync) se schová v zeleném celku.

### `return-path`
- **Cesta:** `spine/demand/newsletter-email/return-path`
- **Osa příběhu (Story Axis):** spine/demand/newsletter-email/return-path
- **Stav:** met
- **Duše (LoreLine):** Od mailu k příhozu — celá cesta změřená.
- **Slib (Promise):** Mail měřitelně vede k návratu a příhozu.
- **Anti-Pattern (Zakázáno):** Měření, které končí u otevření a netuší, jestli vznikl návrat či příhoz.

### `saved-search`
- **Cesta:** `spine/demand/saved-search`
- **Osa příběhu (Story Axis):** spine/demand/saved-search
- **Stav:** met
- **Duše (LoreLine):** Uložené hledání s alertem — vážnému kupci přijde nový odpovídající stroj sám do schránky.
- **Slib (Promise):** Novou shodu se dozvíš dřív než ostatní.
- **Anti-Pattern (Zakázáno):** Alert jako jeden neprůhledný blok — dílčí selhání (duplicitní mail) se schová v zeleném celku.

### `relevance`
- **Cesta:** `spine/demand/search/relevance`
- **Osa příběhu (Story Axis):** spine/demand/search/relevance
- **Stav:** met
- **Duše (LoreLine):** Relevantní výsledek na první stránce — ranking, co rozumí, co profík hledá.
- **Slib (Promise):** Co hledáš, je hned navrchu.
- **Anti-Pattern (Zakázáno):** Relevantní inzerát zahrabaný na třetí stránce — neviditelný inventář.

### `ratings-reviews`
- **Cesta:** `spine/demand/ratings-reviews`
- **Osa příběhu (Story Axis):** spine/demand/ratings-reviews
- **Stav:** met
- **Duše (LoreLine):** Reputace, kterou si nelze koupit — jen odsloužit dokončenými obchody.
- **Slib (Promise):** Uvidíš, s kým máš tu čest, ještě než přihodíš.
- **Anti-Pattern (Zakázáno):** Hvězdičky bez vazby na reálný obchod — reputace na prodej.

### `recommendation`
- **Cesta:** `spine/demand/recommendation`
- **Osa příběhu (Story Axis):** spine/demand/recommendation
- **Stav:** met
- **Duše (LoreLine):** Auction24 tě zná — z tisíců strojů podá ten tvůj na detailu, doma i v mailu.
- **Slib (Promise):** Neutopíš se v inzerátech — z tisíců strojů ti podáme ten tvůj.
- **Anti-Pattern (Zakázáno):** Doporučení jako jeden neprůhledný blok — dílčí selhání (prázdný rail) se schová v zeleném celku.

### `rail-to-bid`
- **Cesta:** `spine/demand/recommendation/rail-to-bid`
- **Osa příběhu (Story Axis):** spine/demand/recommendation/rail-to-bid
- **Stav:** met
- **Duše (LoreLine):** Od railu k příhozu — celá cesta změřená, ne jen první klik.
- **Slib (Promise):** Doporučení měřitelně vede k příhozu.
- **Anti-Pattern (Zakázáno):** Měření, které končí u prokliku a netuší, jestli vznikl příhoz.

### `published-only`
- **Cesta:** `spine/demand/messaging/published-only`
- **Osa příběhu (Story Axis):** spine/demand/messaging/published-only
- **Stav:** met
- **Duše (LoreLine):** Jen publikované Q&A na světle — draft zůstává v zákulisí.
- **Slib (Promise):** Veřejně je jen to, co prošlo publikací.
- **Anti-Pattern (Zakázáno):** Nepublikovaný/draft obsah viditelný veřejně — únik nehotového.

### `query-roundtrip`
- **Cesta:** `spine/demand/search/query-roundtrip`
- **Osa příběhu (Story Axis):** spine/demand/search/query-roundtrip
- **Stav:** met
- **Duše (LoreLine):** Stabilní round-trip — co serializuješ, to deserializuješ zpět beze ztráty.
- **Slib (Promise):** Dotaz se vždy vrátí stejný.
- **Anti-Pattern (Zakázáno):** Serializace, která round-trip nedrží — zkomolený dotaz.

### `post-sale`
- **Cesta:** `spine/demand/ratings-reviews/post-sale`
- **Osa příběhu (Story Axis):** spine/demand/ratings-reviews/post-sale
- **Stav:** met
- **Duše (LoreLine):** Žádné recenze naslepo — jen po skutečném prodeji.
- **Slib (Promise):** Hodnocení, za kterým je reálný obchod.
- **Anti-Pattern (Zakázáno):** Hodnocení od kohokoli bez nákupu — reputace, kterou lze zfalšovat.

### `pagination`
- **Cesta:** `spine/demand/search/pagination`
- **Osa příběhu (Story Axis):** spine/demand/search/pagination
- **Stav:** met
- **Duše (LoreLine):** Deterministické pořadí — žádné duplicity ani vynechané stroje mezi stránkami.
- **Slib (Promise):** Strana 2 navazuje na stranu 1.
- **Anti-Pattern (Zakázáno):** Stránkování, co přehází pořadí — duplikuje nebo vynechává výsledky.

### `owner-scoped`
- **Cesta:** `spine/demand/saved-search/owner-scoped`
- **Osa příběhu (Story Axis):** spine/demand/saved-search/owner-scoped
- **Stav:** met
- **Duše (LoreLine):** Owner-scoped HMAC — token platí jen pro svého vlastníka.
- **Slib (Promise):** Nikdo ti přes token nevypne tvůj alert.
- **Anti-Pattern (Zakázáno):** Token, který odhlásí cizí alert — sabotáž alertů.

### `ordering`
- **Cesta:** `spine/demand/search/ordering`
- **Osa příběhu (Story Axis):** spine/demand/search/ordering
- **Stav:** met
- **Duše (LoreLine):** Cena vzestupně, sestupně, nejnovější — pořadí, co si profík zvolí sám.
- **Slib (Promise):** Srovnáš si výsledky podle ceny i data — nebo necháš výchozí pořadí.
- **Anti-Pattern (Zakázáno):** Řazení jen jako dekorace — volba se nepropíše do dotazu ani URL, sdílený odkaz pořadí zahodí; nebo default, co posílá zbytečný ?sort a rozbije sdílené listing pořadí.

### `non-empty`
- **Cesta:** `spine/demand/recommendation/non-empty`
- **Osa příběhu (Story Axis):** spine/demand/recommendation/non-empty
- **Stav:** met
- **Duše (LoreLine):** Fallback řetězec — když relevance mlčí, popularita promluví.
- **Slib (Promise):** Rail vždy ukáže něco tvého.
- **Anti-Pattern (Zakázáno):** Rail, co se na empty schová — kurátorství zmizí beze stopy.

### `no-duplicate`
- **Cesta:** `spine/demand/saved-search/no-duplicate`
- **Osa příběhu (Story Axis):** spine/demand/saved-search/no-duplicate
- **Stav:** met
- **Duše (LoreLine):** Claim-CAS drží 'právě jednou' — i když cron běží dvakrát.
- **Slib (Promise):** Stejná shoda nepřijde dvakrát.
- **Anti-Pattern (Zakázáno):** Duplicitní alerty bez claim-CAS — kupec je začne ignorovat.

### `newsletter-email`
- **Cesta:** `spine/demand/newsletter-email`
- **Osa příběhu (Story Axis):** spine/demand/newsletter-email
- **Stav:** met
- **Duše (LoreLine):** Auction24 se ozve — kurátorský mail přivede vážného kupce zpět ke stroji pro něj.
- **Slib (Promise):** Relevantní, ne spam.
- **Anti-Pattern (Zakázáno):** Newsletter jako jeden neprůhledný blok — dílčí selhání (rozbitá kadence) se schová v zeleném celku.

### `inquiry-roundtrip`
- **Cesta:** `spine/demand/contact-offers/inquiry-roundtrip`
- **Osa příběhu (Story Axis):** spine/demand/contact-offers/inquiry-roundtrip
- **Stav:** met
- **Duše (LoreLine):** Odeslání, záznam, notifikace — řetěz, který nezapadne.
- **Slib (Promise):** Tvoje zpráva se uloží a někdo ji uvidí.
- **Anti-Pattern (Zakázáno):** Odeslání bez záznamu — díra, kterou propadne poptávka i peníze.

### `favorites`
- **Cesta:** `spine/demand/favorites`
- **Osa příběhu (Story Axis):** spine/demand/favorites
- **Stav:** met
- **Duše (LoreLine):** Hvězda na kartě — tvůj soukromý seznam vozů, který tě počká.
- **Slib (Promise):** Auta, co se ti líbí, máš vždy po ruce.
- **Anti-Pattern (Zakázáno):** Oblíbené, která zmizí po odhlášení nebo se neukážou na kartě — slib, který nedrží.

### `messaging`
- **Cesta:** `spine/demand/messaging`
- **Osa příběhu (Story Axis):** spine/demand/messaging
- **Stav:** met
- **Duše (LoreLine):** Veřejné Q&A u inzerátu — kupující se ptá nahlas a odpověď vidí každý další zájemce.
- **Slib (Promise):** Žádná otázka o stroji nezůstane ve tmě.
- **Anti-Pattern (Zakázáno):** Q&A jako jeden neprůhledný blok — dílčí selhání (skrytý spam) se schová v zeleném celku.

### `facet-filter`
- **Cesta:** `spine/demand/search/facet-filter`
- **Osa příběhu (Story Axis):** spine/demand/search/facet-filter
- **Stav:** met
- **Duše (LoreLine):** Typ, kategorie, cena, atributy — facety, co zúží tisíce na ty tvoje.
- **Slib (Promise):** Zúžíš výběr přesně na své parametry.
- **Anti-Pattern (Zakázáno):** Facety, co filtrují špatně nebo nereagují — falešné zúžení.

### `diacritics`
- **Cesta:** `spine/demand/search/diacritics`
- **Osa příběhu (Story Axis):** spine/demand/search/diacritics
- **Stav:** met
- **Duše (LoreLine):** 'škoda' = 'skoda' — diakritika a velikost písmen nerozhodují.
- **Slib (Promise):** Háček neháček, najde to.
- **Anti-Pattern (Zakázáno):** Match, který kvůli háčku zatají inventář, který reálně existuje.

### `create`
- **Cesta:** `spine/demand/saved-search/create`
- **Osa příběhu (Story Axis):** spine/demand/saved-search/create
- **Stav:** met
- **Duše (LoreLine):** Pojmenovaný dotaz — záměr kupce uložený k hlídání.
- **Slib (Promise):** Své hledání si uložíš a vrátíš se k němu.
- **Anti-Pattern (Zakázáno):** Uložení bez limitu/validace — zaplevelený seznam, který nikdo nehlídá.

### `ctr`
- **Cesta:** `spine/demand/recommendation/ctr`
- **Osa příběhu (Story Axis):** spine/demand/recommendation/ctr
- **Stav:** met
- **Duše (LoreLine):** Každý proklik railu se počítá — CTR je signál, ne pocit.
- **Slib (Promise):** Víme, jestli doporučení proklikne.
- **Anti-Pattern (Zakázáno):** Rail bez měření — nikdo neví, jestli vede k čemukoli.

### `compare-set`
- **Cesta:** `spine/demand/compare/compare-set`
- **Osa příběhu (Story Axis):** spine/demand/compare/compare-set
- **Stav:** met
- **Duše (LoreLine):** Smažeš jeden, zbytek stojí — tabulka se nerozsype.
- **Slib (Promise):** Tvoje srovnání vydrží, i když jeden vůz zmizí.
- **Anti-Pattern (Zakázáno):** Porovnání, které spadne celé, když jeden vůz mezitím zmizel.

### `compare`
- **Cesta:** `spine/demand/compare`
- **Osa příběhu (Story Axis):** spine/demand/compare
- **Stav:** met
- **Duše (LoreLine):** Až pět vozů v jedné tabulce — rozdíly na první pohled, nic schovaného.
- **Slib (Promise):** Vozy porovnáš poctivě vedle sebe.
- **Anti-Pattern (Zakázáno):** Porovnání, které tiše vynechá nevýhodný parametr — srovnání, jež klame.

### `contact-offers`
- **Cesta:** `spine/demand/contact-offers`
- **Osa příběhu (Story Axis):** spine/demand/contact-offers
- **Stav:** met
- **Duše (LoreLine):** Kontakt i protinabídka jedním kanálem — ops to vidí, nic se neztratí.
- **Slib (Promise):** Tvůj dotaz i nabídka dorazí a nezapadnou.
- **Anti-Pattern (Zakázáno):** Formulář, který odešle do prázdna — poptávka bez záznamu a bez upozornění.

### `auto-publish`
- **Cesta:** `spine/demand/messaging/auto-publish`
- **Osa příběhu (Story Axis):** spine/demand/messaging/auto-publish
- **Stav:** met
- **Duše (LoreLine):** Auto-publikovaná odpověď — jedna odpověď posvítí všem.
- **Slib (Promise):** Odpověď uvidí každý další zájemce.
- **Anti-Pattern (Zakázáno):** Odpověď viditelná jen tazateli — ostatní tápou.

### `ask`
- **Cesta:** `spine/demand/messaging/ask`
- **Osa příběhu (Story Axis):** spine/demand/messaging/ask
- **Stav:** met
- **Duše (LoreLine):** Dotaz s kůží ve hře — přihlášení a rate-limit drží signál nad šumem.
- **Slib (Promise):** Zeptat se jde, spamovat ne.
- **Anti-Pattern (Zakázáno):** Otázky bez rate-limitu — spam-záplava, co Q&A znehodnotí.

### `cadence`
- **Cesta:** `spine/demand/newsletter-email/cadence`
- **Osa příběhu (Story Axis):** spine/demand/newsletter-email/cadence
- **Stav:** met
- **Duše (LoreLine):** Weekly-per-user, staggered — kadence, co respektuje schránku.
- **Slib (Promise):** Mail chodí v rytmu, ne v záplavě.
- **Anti-Pattern (Zakázáno):** Záplava mailů bez kadence — spam, co kazí důvěru.

### `answer`
- **Cesta:** `spine/demand/messaging/answer`
- **Osa příběhu (Story Axis):** spine/demand/messaging/answer
- **Stav:** met
- **Duše (LoreLine):** Admin/prodávající odpoví — pochybnost dostane odpověď.
- **Slib (Promise):** Na otázku přijde odpověď od znalce.
- **Anti-Pattern (Zakázáno):** Otázka bez možnosti odpovědi — tazatel tápe.

### `unsub-token`
- **Cesta:** `spine/compliance/unsub-token`
- **Osa příběhu (Story Axis):** spine/compliance/unsub-token
- **Stav:** met
- **Duše (LoreLine):** HMAC podpis na odhlášení — pravé projde, podvržené padne v konstantním čase.
- **Slib (Promise):** Odhlášení je kryptograficky ověřené a nezfalšovatelné.
- **Anti-Pattern (Zakázáno):** Timing útok na porovnání nebo chybějící konstantní compare — útočník zfalšuje token a vstříkne suppression záznamy.

### `suppression`
- **Cesta:** `spine/compliance/compliance/suppression`
- **Osa příběhu (Story Axis):** spine/compliance/compliance/suppression
- **Stav:** met
- **Duše (LoreLine):** Jeden zápis, obě tabulky, zavřená vlákna — kdo řekl dost, dost dostane.
- **Slib (Promise):** Jednou suppresnutý kontakt je vyloučený napříč všemi kampaněmi.
- **Anti-Pattern (Zakázáno):** Dotaz použije jen jednu suppression tabulku — kampaň osloví adresu z té druhé a poruší suppression SLA i souhlas.

### `dsr`
- **Cesta:** `spine/compliance/compliance/dsr`
- **Osa příběhu (Story Axis):** spine/compliance/compliance/dsr
- **Stav:** met
- **Duše (LoreLine):** Přístup i výmaz přes osm tabulek najednou — žádný fragment PII nezůstane.
- **Slib (Promise):** Žádost subjektu se vyřídí úplně a atomicky napříč všemi tabulkami.
- **Anti-Pattern (Zakázáno):** Neúplný cascade nechá PII fragment v replies tabulce — výmaz dle čl. 17 je formálně porušen.

### `gdpr-footer`
- **Cesta:** `spine/compliance/gdpr-footer`
- **Osa příběhu (Story Axis):** spine/compliance/gdpr-footer
- **Stav:** met
- **Duše (LoreLine):** Identita správce, právní základ, odhlášení — patička, bez které oslovení nesmí odejít.
- **Slib (Promise):** Každé oslovení nese povinnou patičku s identitou správce a odhlášením.
- **Anti-Pattern (Zakázáno):** Odchozí oslovení postrádá patičku — poruší se informační povinnost a obhajoba legitimního zájmu padá.

### `audit-log`
- **Cesta:** `spine/compliance/audit-log`
- **Osa příběhu (Story Axis):** spine/compliance/audit-log
- **Stav:** met
- **Duše (LoreLine):** Stopa v každé transakci — kdo co změnil je vždy dohledatelné.
- **Slib (Promise):** Každá mutace nechává auditní stopu kdo, co a kdy.
- **Anti-Pattern (Zakázáno):** Best-effort logování ztratí záznam při zátěži DB — chybí stopa kdo co změnil a padá čl. 30 accountability.

### `firmy-cz`
- **Cesta:** `spine/acquisition/acquisition/firmy-cz`
- **Osa příběhu (Story Axis):** spine/acquisition/acquisition/firmy-cz
- **Stav:** met
- **Duše (LoreLine):** Z marketplace listingů na staging prospektů — normalizované, deduplikované, připravené na enrichment.
- **Slib (Promise):** Statisíce firem jsou naimportované, normalizované a bez duplicit.
- **Anti-Pattern (Zakázáno):** Import tiše přeskočí řádky (NULL e-mail, decode chyba) — objem klesá neviditelně, dedup kolize zůstane skrytá.

### `legacy-scrapers`
- **Cesta:** `spine/acquisition/scrapers`
- **Osa příběhu (Story Axis):** spine
- **Stav:** pending
- **Původ (Origin):** legacy
- **Anti-Pattern (Zakázáno):** Zcela odříznuto od SymphonyQueue. Ukládá do lokální SQLite. Nelze škálovat kvůli in-process lokům na databázi.
- **Tagy:** scraper, playwright, sqlite, mobile-de, mascus-cz, autoline, monolith
- **Hrany (Edges):** symphony-queue

### `email-validation`
- **Cesta:** `spine/acquisition/email-validation`
- **Osa příběhu (Story Axis):** spine/acquisition/email-validation
- **Stav:** met
- **Duše (LoreLine):** Pět bran mezi seznamem a odesláním — co je mrtvé, padne dřív, než to spálí reputaci.
- **Slib (Promise):** Žádná pochybná adresa neprojde do kampaně bez zařazení rizika.
- **Anti-Pattern (Zakázáno):** Probe rate-limiter se zasekne při 7+ schránkách, nebo live DNS vypnuté → všechno „risky" a pipeline se ucpe.

### `classify-icp`
- **Cesta:** `spine/acquisition/acquisition/classify-icp`
- **Osa příběhu (Story Axis):** spine/acquisition/acquisition/classify-icp
- **Stav:** met
- **Duše (LoreLine):** Z NACE kódu na ICP profil — kdo je to, jak velký a jestli sedí do cílovky.
- **Slib (Promise):** Každý kontakt nese obor, velikost a ICP faktory pro přesné cílení.
- **Anti-Pattern (Zakázáno):** recalc_all() tiše selže v půlce nebo neznámý NACE → „unmapped" s tichým propadem skóre a staré tagy blokují nové segmenty.

### `ares-source`
- **Cesta:** `spine/acquisition/ares-source`
- **Osa příběhu (Story Axis):** spine/acquisition/ares-source
- **Stav:** met
- **Duše (LoreLine):** Oficiální registr jako zdroj pravdy — IČO, NACE, právní forma, beze stáří.
- **Slib (Promise):** Každá firma má pravdivé IČO, právní formu a NACE z ARES.
- **Anti-Pattern (Zakázáno):** Tichý výpadek ARES fetch — stará company-data >7 dní, ICP-matching se rozjede mimo a nikdo nealertuje.

### `dashboard-core`
- **Cesta:** `spine/platform/ui/dashboard-core`
- **Osa příběhu (Story Axis):** spine
- **Stav:** pending

### `privacy-gateway`
- **Cesta:** `spine/platform/security/privacy-gateway`
- **Osa příběhu (Story Axis):** spine
- **Stav:** met

### `campaign-scheduler-time-zone-mapper`
- **Cesta:** `spine/outreach/campaign-scheduler/time-zone-mapper`
- **Osa příběhu (Story Axis):** spine/outreach/campaign-scheduler
- **Stav:** met
- **Původ (Origin):** Agentic Auto-Split
- **Duše (LoreLine):** Empatický doručovatel — posílá maily, když lidé bdí.
- **Slib (Promise):** Příjemce dostane mail v 9 ráno jeho času, nikdy o půlnoci.
- **Anti-Pattern (Zakázáno):** Nedbá na to, jaký je obsah mailu, řeší pouze časové razítko.

### `campaign-scheduler-send-throttler`
- **Cesta:** `spine/outreach/campaign-scheduler/send-throttler`
- **Osa příběhu (Story Axis):** spine/outreach/campaign-scheduler
- **Stav:** met
- **Původ (Origin):** Agentic Auto-Split
- **Duše (LoreLine):** Rozvážný střelec — rozvolňuje dávku tak, aby nenaštval filtry.
- **Slib (Promise):** Vyhneme se spam filtrům postupným zahříváním odesílací IP.
- **Anti-Pattern (Zakázáno):** Nesnižuje celkový objem rozesílky, pouze ho rozkládá v čase.

### `learn-zod-guard`
- **Cesta:** `spine/engine/learn/zod-guard`
- **Osa příběhu (Story Axis):** spine/engine/learn/zod-guard
- **Stav:** met
- **Původ (Origin):** Autonomně expandováno přes PoC
- **Duše (LoreLine):** Obrněná stráž před LLM halucinacemi — propustí jen to, co sedí do kontraktu.
- **Slib (Promise):** Nikdy neuložíme strukturovaný nesmysl vytvořený halucinací.
- **Anti-Pattern (Zakázáno):** Neopravuje data, pouze je nemilosrdně zahodí, pokud nesedí.

### `learn-llm-connector`
- **Cesta:** `spine/engine/learn/llm-connector`
- **Osa příběhu (Story Axis):** spine/engine/learn/llm-connector
- **Stav:** met
- **Původ (Origin):** Autonomně expandováno přes PoC
- **Duše (LoreLine):** Telepatická linka k velkým jazykovým modelům — izoluje API volání od byznysu.
- **Slib (Promise):** Změna LLM providera (OpenAI, Anthropic) nevyžaduje zásah do doménové logiky.
- **Anti-Pattern (Zakázáno):** Neanalyzuje data, pouze přenáší zprávy.

### `learn-html-cleaner`
- **Cesta:** `spine/engine/learn/html-cleaner`
- **Osa příběhu (Story Axis):** spine/engine/learn/html-cleaner
- **Stav:** met
- **Původ (Origin):** Autonomně expandováno přes PoC
- **Duše (LoreLine):** Chirurgický řez do cizího šumu — odstraní tracking, reklamy a vizuální smog.
- **Slib (Promise):** LLM dostane jen čistou sémantickou strukturu, bez zátěže zbytečných bytů.
- **Anti-Pattern (Zakázáno):** Nikdy nemění obsah textu, pouze odstraňuje nepotřebné tagy.

### `relay`
- **Cesta:** `spine/engine/intelligence/relay`
- **Osa příběhu (Story Axis):** spine
- **Stav:** met

### `parser-compiler`
- **Cesta:** `spine/engine/intelligence/parser-compiler`
- **Osa příběhu (Story Axis):** spine/engine/intelligence
- **Stav:** met
- **Slib (Promise):** Vygenerovat bezpečný AST selektor pro jakoukoliv HTML šablonu inzerce.

### `arbitrage-miner`
- **Cesta:** `spine/engine/intelligence/arbitrage-miner`
- **Osa příběhu (Story Axis):** spine
- **Stav:** met
- **Duše (LoreLine):** Pravá hemisféra: Mozek hledající asymetrické příležitosti v datech.
- **Slib (Promise):** Filtruje masivní objemy inzerátů a identifikuje podhodnocená aktiva pro Shadow Brokera.
- **Anti-Pattern (Zakázáno):** Nesmí kontaktovat uživatele napřímo. Nesmí držet stav (stateless).
- **Hrany (Edges):** symphony-queue, deep-inventory, core-types

### `shadow-broker`
- **Cesta:** `spine/engine/drive/shadow-broker`
- **Osa příběhu (Story Axis):** spine
- **Stav:** met
- **Duše (LoreLine):** Levá hemisféra: Stínový vyjednavač. Uzavírá dealy asynchronně, dřív než uživatel ví, že chce prodat.
- **Slib (Promise):** Konzumuje ArbitrageOpportunities a generuje bezpečné bezheslové Magic Linky (JWT).
- **Anti-Pattern (Zakázáno):** Zákaz používání synchronních REST API a vytváření uživatelských registrací. Vše jde stínově přes SymphonyQueue.
- **Hrany (Edges):** symphony-queue, marketplace-web, core-types

### `worker`
- **Cesta:** `spine/engine/automation/worker`
- **Osa příběhu (Story Axis):** spine
- **Stav:** met

### `symphony-queue`
- **Cesta:** `spine/engine/automation/symphony-queue`
- **Osa příběhu (Story Axis):** spine
- **Stav:** met

### `rule-registry`
- **Cesta:** `spine/engine/automation/rule-registry`
- **Osa příběhu (Story Axis):** spine/engine/automation
- **Stav:** met
- **Slib (Promise):** Poskytnout uložené pravidlo pro parsování konkrétní domény.

### `engine-acquisition-mobile-de`
- **Cesta:** `spine/engine/acquisition/mobile-de`
- **Osa příběhu (Story Axis):** spine
- **Stav:** pending

### `engine-acquisition-mascus`
- **Cesta:** `spine/engine/acquisition/mascus-cz`
- **Osa příběhu (Story Axis):** spine
- **Stav:** pending

### `engine-acquisition-judikaty`
- **Cesta:** `spine/engine/acquisition/judikaty`
- **Osa příběhu (Story Axis):** spine
- **Stav:** pending

### `engine-acquisition-firmy`
- **Cesta:** `spine/engine/acquisition/firmy-cz`
- **Osa příběhu (Story Axis):** spine
- **Stav:** pending

### `engine-acquisition-esbirka`
- **Cesta:** `spine/engine/acquisition/esbirka`
- **Osa příběhu (Story Axis):** spine
- **Stav:** pending

### `engine-acquisition-autoline`
- **Cesta:** `spine/engine/acquisition/autoline`
- **Osa příběhu (Story Axis):** spine
- **Stav:** pending

### `inbox-orchestrator`
- **Cesta:** `spine/demand/inbound/inbox-orchestrator`
- **Osa příběhu (Story Axis):** spine
- **Stav:** met

### `deep-inventory`
- **Cesta:** `spine/demand/acquisition/deep-inventory`
- **Osa příběhu (Story Axis):** spine/demand/acquisition
- **Stav:** met
- **Slib (Promise):** Vyšle boty nasát HTML a poslat relevantní deltu do fronty k dalším zpracování.

### `relay-rate-limiter`
- **Cesta:** `spine/engine/intelligence/relay/rate-limiter`
- **Osa příběhu (Story Axis):** spine
- **Stav:** met
- **Původ (Origin):** Agentic Auto-Split
- **Duše (LoreLine):** Záchranná brzda rozpočtu — chrání peněženku před nekonečnou smyčkou.
- **Slib (Promise):** Žádný agent nám nespálí budget za 10 minut.
- **Anti-Pattern (Zakázáno):** Neanalyzuje obsah promptu, jen počítá tokeny a blokuje zneužití.

### `relay-provider-router`
- **Cesta:** `spine/engine/intelligence/relay/provider-router`
- **Osa příběhu (Story Axis):** spine
- **Stav:** met
- **Původ (Origin):** Agentic Auto-Split
- **Duše (LoreLine):** Inteligentní výhybka — pošle prompt tam, kde to dává smysl.
- **Slib (Promise):** Využijeme vždy nejlepší a nejlevnější model pro danou úlohu.
- **Anti-Pattern (Zakázáno):** Není svázaný s jedním providerem.

### `cross-border-arbitrage`
- **Cesta:** `spine/engine/intelligence/arbitrage-miner/cross-border`
- **Osa příběhu (Story Axis):** engine
- **Stav:** met
- **Duše (LoreLine):** Nezná hranice — čte z cizích trhů, počítá clo a kurz, aby objevil zlatou žílu pro český trh.
- **Slib (Promise):** Vygeneruje stínový draft pouze tehdy, když dovoz a marže dají smysl nad stanovený limit zisku.
- **Anti-Pattern (Zakázáno):** Nevytváří inzeráty bez zakomponování nákladů na dovoz a měnové konverze.

### `inbox-orchestrator-auto-responder`
- **Cesta:** `spine/demand/inbound/inbox-orchestrator/auto-responder`
- **Osa příběhu (Story Axis):** spine
- **Stav:** met
- **Původ (Origin):** Agentic Auto-Split
- **Duše (LoreLine):** Levá mozková hemisféra — exekuuje připravené odpovědi na rutinu.
- **Slib (Promise):** Rutinní dotazy jsou vyřešeny do 5 vteřin bez lidského zásahu.
- **Anti-Pattern (Zakázáno):** Nereaguje na komplexní zprávy, které vyžadují lidský úsudek.

### `inbox-orchestrator-intent-classifier`
- **Cesta:** `spine/demand/inbound/inbox-orchestrator/intent-classifier`
- **Osa příběhu (Story Axis):** spine
- **Stav:** met
- **Původ (Origin):** Agentic Auto-Split
- **Duše (LoreLine):** Pravá mozková hemisféra — čte zprávy s empatií a hledá záměr.
- **Slib (Promise):** Každá zpráva je okamžitě kategorizována, ať už jde o hejt nebo zájem.
- **Anti-Pattern (Zakázáno):** Na zprávu neodpovídá, pouze ji obohatí o štítky záměru.

### `sitemap-watcher`
- **Cesta:** `spine/demand/acquisition/deep-inventory/sitemap-watcher`
- **Osa příběhu (Story Axis):** demand
- **Stav:** met
- **Duše (LoreLine):** Nespí a čte mapy — najde nové cesty k pokladu rychleji, než kdokoli začne klikat.
- **Slib (Promise):** Zjistíme o novém inzerátu do pár vteřin čistě pomocí ETag a sitemap, bez spálení jediné proxy.
- **Anti-Pattern (Zakázáno):** Nikdy nestahuje HTML stránku inzerátu, loví pouze surová URL.

### `stale-reaper`
- **Cesta:** `spine/demand/acquisition/deep-inventory/stale-reaper`
- **Osa příběhu (Story Axis):** demand
- **Stav:** met
- **Duše (LoreLine):** Nenechává nás prodávat duchy — kontroluje tep u rozehraných nabídek.
- **Slib (Promise):** Pokud auto z cizího portálu zmizí, Magic Link v Auction24 u prodejce bude okamžitě zneplatněn.
- **Anti-Pattern (Zakázáno):** Nevytváří inzeráty, pouze je ničí v zájmu ochrany SLA a značky.

### `b2b-miner`
- **Cesta:** `spine/demand/acquisition/deep-inventory/b2b-miner`
- **Osa příběhu (Story Axis):** demand
- **Stav:** met
- **Duše (LoreLine):** Nekliká po jednom — saje ceníky a katalogy ze sdílených disků dealerů naráz.
- **Slib (Promise):** Vyčteme data ze surových PDF a Excelů, abychom z jednoho PDF získali 500 vozů pro Shadow Brokera.
- **Anti-Pattern (Zakázáno):** Neřeší web scraping, loví a čte pouze surové dokumenty.

### `network-interceptor`
- **Cesta:** `spine/demand/acquisition/deep-inventory/network-interceptor`
- **Osa příběhu (Story Axis):** demand
- **Stav:** met
- **Duše (LoreLine):** Naslouchá tepu sítě — krade surová data dřív, než se vůbec stihnou vykreslit.
- **Slib (Promise):** Vyhneme se změnám CSS tříd tím, že se chytíme na skrytá JSON/GraphQL API.
- **Anti-Pattern (Zakázáno):** Neřeší vizuální prvky (DOM), analyzuje pouze datový HTTP provoz.

