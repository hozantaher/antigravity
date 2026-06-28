# Domain Map

**Status:** draft (M0)
**Vytvořeno:** 2026-04-22
**Owner:** tomas
**Related initiative:** [`docs/initiatives/2026-04-22-discipline-and-domain-migration.md`](../initiatives/2026-04-22-discipline-and-domain-migration.md)

> Tento dokument mapuje všechny top-level domény monorepa, jejich současnou
> fyzickou lokaci (před migrací) a cílový stav v `services/<doména>/`.
> Každá doména = jedna složka v `services/`, cross-cutting komponenty
> jako pod-services.

## Přehled domén

| Doména | Účel | Owner | Současná fyzická lokace | Public API | Upstream deps | Downstream consumers | Sub-services | Target state |
|---|---|---|---|---|---|---|---|---|
| **mailboxes** ✅ M1 | Správa SMTP/IMAP schránek — registry, výběr, warm-up, backpressure, bounce tracking | tomas | **Go BE moved:** `features/outreach/mailboxes/mailbox/`, `features/outreach/mailboxes/watchdog/`, `features/outreach/mailboxes/bounce/` (M1a/b/c 2026-04-22). **UI scaffolded:** `features/outreach/mailboxes/ui/` re-exports from `features/platform/outreach-dashboard/src/pages/Mailboxes*.jsx` + `Watchdog*.jsx` (M1d.1; M1d.2 physical move deferred). | REST `/api/mailboxes/*`, `/api/watchdog/*` (Go) — spec: `features/outreach/mailboxes/schemas/openapi.yaml` | relay, privacy-gateway, PostgreSQL, outreach/audit | campaigns, inbox, intelligence, dashboard | mailbox (registry), watchdog (backpressure), bounce | `features/outreach/mailboxes/` (active M1 sprint) |
| **campaigns** | Outbound kampaně — sequences, scheduler, runner, preflight gate | tomas | `modules/outreach/internal/campaign/`, `modules/outreach/internal/sender/`, `modules/outreach/internal/sequence/`, `features/platform/outreach-dashboard/src/pages/Campaigns*.jsx`, `features/platform/outreach-dashboard/campaignPreflight.js` | REST `/api/campaigns/*`, `/api/sequences/*` (Go) | mailboxes, contacts, relay | intelligence, dashboard | sequence, scheduler, runner, preflight | `features/outreach/campaigns/` (top-level) |
| **contacts** | Prospekti, leady, segmenty, enrichment, deliverability | tomas | `modules/outreach/internal/contact/`, `modules/outreach/internal/lead/`, `modules/outreach/internal/prospect/`, `modules/outreach/internal/segment/`, `modules/outreach/internal/enrich/`, `modules/outreach/internal/company/`, `modules/outreach/internal/ares/`, `features/platform/outreach-dashboard/src/pages/Contacts.jsx`, `Leads.jsx`, `Companies.jsx`, `Segments.jsx` | REST `/api/contacts/*`, `/api/leads/*`, `/api/segments/*` (Go) | scrapers, PostgreSQL | campaigns, intelligence, dashboard | registry, segments, enrichment, deliverability | `features/acquisition/contacts/` (top-level) |
| **relay** ✅ M2.1 | Anti-trace SMTP relay — transport, proxy pool, SOCKS5, egress obfuscation (cross-cutting) | tomas | `features/outreach/relay/` (renamed from anti-trace-relay 2026-04-22) | REST `/submit`, `/relay/*`, `/pool/*` (Go) | proxifly/geonode/proxyscrape HTTP APIs | mailboxes, campaigns | proxy-pool, transport, boundary | `features/outreach/relay/` (active, M2.2 proxy-pool sub-service extract deferred) |
| **privacy-gateway** | Anonymizační vrstva — identity vault, alias, filestore (cross-cutting) | tomas | `features/compliance/privacy-gateway/` | REST `/api/privacy/*` (Go) | PostgreSQL, filestore | relay, campaigns | alias, identityvault, sanitizer, submission | `features/compliance/privacy-gateway/` (top-level, zůstává) |
| **inbox** | IMAP polling, reply handling, thread management | tomas | `modules/outreach/internal/imap/`, `modules/outreach/internal/thread/`, `features/platform/outreach-dashboard/src/pages/Inbox.jsx`, `Replies.jsx`, `ThreadDetail.jsx`, `features/platform/outreach-dashboard/src/routes/replies.js` | REST `/api/inbox/*`, `/api/threads/*`, `/api/replies/*` (Go) | mailboxes, privacy-gateway | intelligence, dashboard | imap-poller, reply-classifier, thread-resolver | `features/inbound/inbox/` (top-level) |
| **intelligence** | Analytics, reporting, learning loop (běží každých 6h) | tomas | `modules/outreach/internal/intelligence/`, `modules/outreach/internal/metrics/`, `modules/outreach/internal/classify/`, `modules/outreach/internal/llm/`, `modules/outreach/internal/humanize/`, `features/platform/outreach-dashboard/src/pages/Analytics.jsx`, `Scoring.jsx` | REST `/api/intelligence/*`, `/api/analytics/*` (Go) | mailboxes, campaigns, contacts, inbox | dashboard | learning-loop, analytics, scoring, classify | `services/intelligence/` (top-level) |
| **scrapers** | Data ingestion — firmy.cz, justice (ARES), VVZ, mobile.de, autoline, mascus | tomas | `features/acquisition/scrapers/` (TS), `modules/outreach/internal/ares/` (Go) | internal cron + queue (TS) | firmy.cz, justice.cz, ARES HTTP | contacts | firmy-cz, justice, autoline, mascus-cz, mobile-de, esbirka, judikaty | `features/acquisition/scrapers/` (top-level, zůstává) |
| **dashboard** | UI shell — thin app importující UI packages ze services/*/ui/ | tomas | `features/platform/outreach-dashboard/` (React 19, Vite 6, Express BFF) | Express BFF proxyuje na Go API | všechny domény přes `X-API-Key` | human operator | (žádné — thin shell) | `apps/dashboard/` (rename, thin shell) |
| **infra** | CI/CD, observability, shared config, deploy scripts | tomas | `.github/`, `.githooks/`, `infra/docker/`, `scripts/`, `go.work`, `pnpm-workspace.yaml` | (žádné runtime API) | (žádné) | všechny služby | ci-cd, secrets, observability | zůstává top-level: `infra/`, `.github/`, `scripts/` |

## Per-doména detail

### mailboxes

- **Invarianty:**
  - Každá schránka má právě jeden health state (`healthy`, `warming`, `paused`, `bounced`)
  - Backpressure blokuje sender když `open_authfails > threshold`
  - Bounce events jsou idempotentní (duplicate bounce ID se dedupe na DB level)
  - Warm-up rate je monotónní (nikdy neklesne v rámci jednoho okna)
- **Key entities:** `mailbox`, `mailbox_health`, `authfail_event`, `bounce_event`, `warmup_schedule`
- **SLO:** availability 99.5 %, latency p95 `/api/mailboxes/selector/next` < 200 ms

### campaigns

- **Invarianty:**
  - Žádný duplicate send pro stejnou (contact_id, sequence_step_id) dvojici
  - Preflight gate blokuje run dokud všechny validace nepřejdou (DNS, mailbox health, contact dedup)
  - Sequence step order je immutable po první odeslané zprávě
- **Key entities:** `campaign`, `sequence`, `sequence_step`, `campaign_run`, `send_event`, `preflight_check`
- **SLO:** availability 99.5 %, scheduler tick ≤ 60 s, zero duplicate sends

### contacts

- **Invarianty:**
  - Unique constraint na (email, tenant) — žádné duplicity
  - Segment membership je deterministický vůči query snapshot
  - Enrichment data mají TTL a refresh policy (7 dní default)
  - Suppression list zablokuje any send bez ohledu na kampaň
- **Key entities:** `contact`, `company`, `segment`, `segment_membership`, `enrichment_cache`, `suppression`
- **SLO:** availability 99.9 %, segment rebuild < 30 s pro 100k kontaktů

### relay

- **Invarianty:**
  - Každý odchozí SMTP pakový přes SOCKS5 proxy (nikdy přímý konekt z app serveru)
  - Proxy pool má ≥3 živé proxies nebo fail-fast
  - Žádný leak client IP do Received headerů (boundary guarantee)
  - Audit log je append-only, per-request trace ID
- **Key entities:** `proxy`, `proxy_pool_state`, `relay_attempt`, `submission`, `identity_link`
- **SLO:** availability 99.9 %, submission p95 < 5 s, proxy pool refresh < 60 s

### privacy-gateway

- **Invarianty:**
  - Identity vault data nejsou logged v plain-textu
  - Alias ↔ real identity mapping je šifrovaný at-rest
  - Retention policy se aplikuje deterministicky (cron + audit)
  - Submission state machine je monotónní (`pending → relayed → delivered`, žádné reverse přechody)
- **Key entities:** `identity`, `alias`, `submission`, `relay_attempt`, `audit_entry`
- **SLO:** availability 99.9 %, encryption at-rest 100 %, no plaintext PII in logs

### inbox

- **Invarianty:**
  - IMAP polling je idempotentní (message UID dedup)
  - Reply classification má fallback na "unknown" (nikdy nehází exception nahoru)
  - Thread merging je deterministický vůči In-Reply-To + References headers
- **Key entities:** `imap_poll_state`, `message`, `reply`, `thread`, `reply_classification`
- **SLO:** availability 99 %, IMAP poll lag < 5 min, reply classification p95 < 2 s

### intelligence

- **Invarianty:**
  - Learning loop neprepíše prod data bez dry-run kroku
  - Analytics reports jsou reproducible (same input → same output)
  - Scoring model verze je trackovaná per-prediction
- **Key entities:** `analytics_report`, `scoring_prediction`, `learning_run`, `model_version`
- **SLO:** availability 99 %, 6h learning loop dokončí < 30 min, report latency p95 < 3 s

### scrapers

- **Invarianty:**
  - Každý scrape job má timeout (žádný no-timeout HTTP call — viz scrapers audit)
  - Rate limiting respektuje robots.txt + crawl-delay
  - Scraped data jsou validovaná schema-based před insertem
  - Dedup na úrovni (source, source_id) klíče
- **Key entities:** `scrape_job`, `scrape_run`, `scraped_record`, `source_registry`
- **SLO:** availability 95 % (scraping je best-effort), job success rate ≥ 90 %

### dashboard

- **Invarianty:**
  - Pouze proxy na backend API (žádný business logic v BFF vrstvě)
  - Všechny API requesty s `X-API-Key` headerem (Express → Go)
  - Degraded UI banner když backend nedostupný (nevrší se errors)
  - UI packages importovány z `services/*/ui/` (žádný cross-doména import mezi UI package)
- **Key entities:** (žádné — thin shell)
- **SLO:** availability 99.5 %, FCP < 1.5 s, LCP < 2.5 s

### infra

- **Invarianty:**
  - CI musí být green na main před merge (pre-merge hook)
  - Secrets nejsou committed (pre-commit scan, `.env.example` placeholders)
  - Každá Railway service má owner v `docs/playbooks/SERVICES.md`
  - Docker images jsou reproducible (pinned base, vendored deps kde to jde)
- **Key entities:** CI workflows, Railway deploy configs, githooks, shared scripts
- **SLO:** CI success rate ≥ 90 % za 7 dní, deploy success rate ≥ 95 %

## Legenda statusů migrace

Každá doména má v `services/<doména>/service.yaml` pole `status`:

- `planned` — v DOMAIN-MAP, ještě nemigrována
- `in-progress` — aktuálně v migration PR
- `active` — migrace dokončena, doména běží z nové lokace
- `legacy` — stará lokace, čeká na smazání

Aktuální stav všech domén (k 2026-04-22): `planned`.

## Related

- [Initiative: Discipline + Domain Migration](../initiatives/2026-04-22-discipline-and-domain-migration.md)
- [Playbook: Domain Migration](../playbooks/DOMAIN-MIGRATION.md)
- [Template: `_template/service/`](../../_template/service/)
