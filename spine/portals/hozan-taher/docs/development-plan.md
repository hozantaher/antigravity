# Development Plan — B2B Outreach Platform

> **Verze:** 1.0  
> **Datum:** 2026-04-20  
> **Autor:** Tomáš Messing + Claude Sonnet 4.6  
> **Repozitář:** hozan-taher  

---

## Obsah

0. [Produkt — definice, vize, kontext](#0-produkt)
1. [Audit stavu](#1-audit-stavu)
2. [Architektura](#2-architektura)
3. [MVP definice](#3-mvp-definice)
4. [Testing strategie](#4-testing-strategie)
5. [Fáze roadmapy](#5-fáze-roadmapy)
6. [Sprint backlog](#6-sprint-backlog)
7. [CI/CD pipeline](#7-cicd-pipeline)
8. [Infra + deployment](#8-infra--deployment)
9. [Observability](#9-observability)
10. [Security](#10-security)
11. [Email deliverability](#11-email-deliverability)
12. [Operational runbooks](#12-operational-runbooks)
13. [Rizika + mitigace](#13-rizika--mitigace)
14. [Cost breakdown](#14-cost-breakdown)
15. [Anti-trace & anonymita](#15-anti-trace--anonymita)
16. [Disaster recovery](#16-disaster-recovery)
17. [Multi-instance deployment](#17-multi-instance-deployment)
18. [Abuse prevention](#18-abuse-prevention)
19. [Offline resilience](#19-offline-resilience)
20. [Compliance framework](#20-compliance-framework)
21. [Škálovatelnost](#21-škálovatelnost)
22. [Template & content strategy](#22-template--content-strategy)
23. [Intelligence & adaptive learning](#23-intelligence--adaptive-learning)

---

## 0. Produkt

### 0.1 Vize

Platforma pro B2B sales outreach na českém trhu, která propojuje veřejné obchodní registry s automatizovaným, reputation-safe, anonymním emailovým oslovením. Operátor definuje koho oslovit, platforma zajistí jak — doručitelně, měřitelně, bez stop neviditelně.

### 0.2 Problém

B2B obchodní firma v ČR dnes:

1. **Ručně hledá firmy** — ARES, firmy.cz, Google, excel
2. **Ručně ověřuje kontakty** — emaily, telefony, osoby
3. **Ručně píše emaily** — kopíruje šablonu, mění jméno, posílá 1 po 1
4. **Nemá přehled** — neví kdo otevřel, odpověděl, ignoroval
5. **Nemá follow-up systém** — zapomene napsat podruhé
6. **Nemá ochranu reputace** — posílá z jedné schránky, dostane se na blacklist

Platí **napříč vertikálami** — technika, IT, materiál, služby, rekrutace.

### 0.3 Řešení — procesní tok

```
Veřejné registry (ARES, firmy.cz)
        ↓
[Enrichment] — email, kategorie, region, ICP skóre
        ↓
[Segmentace] — filtry definované operátorem
        ↓
[Kampaň] — segment + šablona + sequence
        ↓
[Quality gate] — email quality + kapacita + odhad
        ↓
[Sender engine] — rate-limited, warmup, multi-mailbox, proxy, anti-trace
        ↓
[Tracking] — open pixel, click redirect (přes zákaznické domény)
        ↓
[IMAP poll] — příchozí odpovědi
        ↓
[Klasifikace] — positive / negative / OOO / auto-reply
        ↓
[Inbox] — operátor zpracuje, předá lead, nebo odpoví
        ↓
[Suppression] — negativní → blacklist, permanentní
```

### 0.4 Persony

| Persona | Role | Denní použití | Klíčová potřeba |
|---|---|---|---|
| **Operátor** | Primary user | 2–6h | Přehled, jednoduchost, inbox |
| **Obchodník** | Secondary | Příležitostně | Kontext leadu, konverzace |
| **Manažer** | Stakeholder | Týdně | ROI, analytiky, výkon kampaní |

### 0.5 Business model

- **Single-tenant, operator-run** — každý zákazník má vlastní instanci
- **Vlastní SMTP schránky** zákazníka — platforma jen orchestruje
- **Veřejná data** — ARES, firmy.cz (žádný nákup databází)
- **Vertikálně agnostické jádro** — konfigurace per zákazník bez změny kódu

**Revenue model:**
- Self-hosted licence per zákazník
- Managed SaaS: Basic (1 mailbox) → Pro (5 mailboxů) → Enterprise
- Upsell: LLM personalizace, pokročilá analytika, CRM integrace

### 0.6 Vertikální konfigurace

| Co se konfiguruje | Těžká technika | IT služby | Stav. materiál |
|---|---|---|---|
| Cílové NACE kódy | 28.xx, 29.xx | 62.xx, 63.xx | 23.xx, 46.73 |
| ICP faktory | vlastní stroje, export | počet zaměstnanců | stavební projekty |
| Šablony | odkup strojů | IT outsourcing | velkoobchod |
| Segmenty | Stavební firmy Praha | Software firmy 50+ | Developerské firmy |

### 0.7 Platforma vs. konfigurace

```
┌─────────────────────────────────────────────────────┐
│                PLATFORMA (jádro — shared kód)        │
│  Sender engine   │  Inbox / Reply          │        │
│  Mailbox mgmt    │  Analytics              │        │
│  Campaign mgmt   │  Healing / Monitoring   │        │
│  Segmentace      │  Enrichment pipeline    │        │
│  Template engine │  Suppression            │        │
│  Quality gate    │  Tracking               │        │
│  IMAP polling    │  Anti-trace relay       │        │
│  ARES client     │  firmy.cz client        │        │
└─────────────────────────────────────────────────────┘
                        ↕ konfigurace
┌─────────────────────────────────────────────────────┐
│           VERTIKÁLNÍ KONFIGURACE (per zákazník)     │
│  configs/                                           │
│  ├── templates/        → šablony emailů             │
│  ├── icp_weights.json  → váhy ICP faktorů           │
│  ├── categories.json   → NACE → vertikála           │
│  └── signatures/       → podpisy odesílatelů        │
└─────────────────────────────────────────────────────┘
```

### 0.8 Feature mapa

| Feature | MVP-0 | MVP-1 | MVP-2 | MVP-3 | MVP-4 | MVP-5 | Post |
|---|---|---|---|---|---|---|---|
| Enrichment ARES/firmy.cz | ✅ | | | | | | |
| Email verifikace | ✅ | | | | | | |
| Segmentace (CRUD, preview) | ✅ | | | | | | |
| Template engine (spin, vars) | ✅ | | | | | | |
| Sender engine (multi-MB, warmup) | ✅ | | | | | | |
| Circuit breaker + healing | ✅ | | | | | | |
| Anti-trace relay + proxy | ✅ | | | | | | |
| Header sanitization | ✅ | | | | | | |
| Open/click tracking | ✅ | | | | | | |
| Bounce detection + suppression | ✅ | | | | | | |
| IMAP poll + reply fetch | ✅ | | | | | | |
| Reply klasifikace | ✅ | | | | | | |
| Mailbox CRUD + health | ✅ | | | | | | |
| Dashboard + healing log | ✅ | | | | | | |
| DNS audit panel | ✅ | | | | | | |
| Campaign wizard + quality gate | | ✅ | | | | | |
| Campaign KPIs + send tabulka | | ✅ | | | | | |
| Preflight checks | | ✅ | | | | | |
| Inbox (seznam odpovědí, filtry) | | | ✅ | | | | |
| Thread view read-only | | | ✅ | | | | |
| Příchozí přílohy (view + download) | | | ✅ | | | | |
| Nav badge (unhandled count) | | | ✅ | | | | |
| Reply z platformy (SMTP) | | | | ✅ | | | |
| Threading headers (In-Reply-To) | | | | ✅ | | | |
| Přílohy v reply (max 10 MB) | | | | ✅ | | | |
| Kampaňové přílohy — blokováno | | | | ✅ | | | |
| Lead store + webhook | | | | | ✅ | | |
| "Převést na lead" tlačítko | | | | | ✅ | | |
| Contact card sidebar | | | | | ✅ | | |
| Forward email | | | | | ✅ | | |
| Search (fulltext) | | | | | ✅ | | |
| Analytics (overview + timeline) | | | | | ✅ | | |
| LLM opener | | | | | | ✅ | |
| AI reply draft | | | | | | ✅ | |
| Smart scheduling | | | | | | ✅ | |
| SendCalendar UI | | | | | | ✅ | |
| Template ranking + A/B testing | | | | | | ✅ | |
| Advanced analytics (funnel) | | | | | | ✅ | |
| Export CSV | | | | | | ✅ | |
| Snooze / Scheduled send | | | | | | ✅ | |
| Security hardening + CI/CD | | | | | | ✅ | |
| Compose (nový email mimo reply) | | | | | | | ✅ |
| Multi-tenant | | | | | | | ✅ |
| Mobile responsive | | | | | | | ✅ |

### 0.9 Success metriky

| Metrika | Target MVP | Target Prod |
|---|---|---|
| Emailů za den (per instance) | 100+ | 500+ |
| Open rate | >20% | >25% |
| Reply rate | >3% | >5% |
| Positive reply rate | >1.5% | >3% |
| Bounce rate | <5% | <3% |
| Spam score (mail-tester.com) | 9+/10 | 10/10 |
| Uptime | >99% | >99.5% |
| API p95 response | <500ms | <200ms |

### 0.10 Produktové principy

1. **Neviditelnost je non-negotiable** — každý email nerozeznatelný od ručního. Detekce platformy = critical bug.
2. **Deliverability first** — raději poslat méně a doručit, než víc a skončit ve spamu.
3. **Human in the loop** — platforma automatizuje, finální rozhodnutí dělá člověk.
4. **Transparentnost** — operátor vždy vidí PROČ se něco stalo.
5. **Reputace je nevratná** — platforma je konzervativní. Lepší přeskočit lead než spálit doménu.
6. **Suppression je jednosměrná** — "ne" = NIKDY znovu. Žádný override.
7. **Jednoduchost > flexibilita** — 3 kroky místo 10, rozumné defaults.
8. **Vertikálně agnostické jádro** — žádný hardcoded business logic per obor.
9. **Czech-first** — UI, šablony, kategorizace v češtině. i18n post-MVP.
10. **Data patří zákazníkovi** — single-tenant, export kdykoliv.

---

## 1. Audit stavu

### 1.1 Go packages (modules/outreach/internal/)

| Package | Účel | Stav | Testy | Poznámka |
|---|---|---|---|---|
| sender/ | SMTP engine, rate limiter, warmup, circuit breaker | ✅ hotovo | ✅ 186+ | Context-aware sleep fix aplikován |
| campaign/ | Runner, batch, scheduling | ✅ hotovo | ✅ | |
| content/ | Template engine, spin, vars | ✅ hotovo | ✅ 9 heavy + unit | |
| thread/ | Inbound reply, klasifikace | ✅ hotovo | ✅ | |
| bounce/ | Bounce detection, klasifikace | ✅ hotovo | ✅ | |
| imap/ | IMAP pool, poll, mark seen | ✅ hotovo | ✅ | |
| mailbox/ | Selector, adaptive release | ✅ hotovo | ✅ | |
| validation/ | Email, MX, spamtrap | ✅ hotovo | ✅ | |
| segment/ | Filter, query builder, rebuild | ✅ hotovo | ✅ | |
| enrich/ | Pipeline, score, promote, suppress | ✅ hotovo | ✅ | |
| intelligence/ | Health report, 6h loop | ✅ hotovo | ✅ | |
| config/ | Env loading, validation | ✅ hotovo | ✅ | |
| token/ | Unsubscribe token | ✅ hotovo | ✅ | |
| honeypot/ | Pattern, role-based, TLD | ✅ hotovo | ✅ | |
| exclusion/ | Rules engine | ✅ hotovo | ✅ | |
| humanize/ | Delays, headers, UA rotation | ✅ hotovo | ✅ | |
| warmup/ | Schedule, ramp | ✅ hotovo | ✅ | |
| audit/ | DNS/DMARC probes | ✅ hotovo | ✅ 173 | |
| health/ | Staleness, data quality | ✅ hotovo | ✅ | |
| protections/ | Probe matrix, alerts, coverage | ✅ hotovo | ✅ | |
| watchdog/ | Circuit breaker monitoring | ✅ hotovo | ✅ | |
| classify/ | ICP scoring, LLM batch | ✅ hotovo | ✅ | |
| category/ | NACE mapping, path classification | ✅ hotovo | ✅ | |
| ares/ | ARES client, XML import | ✅ hotovo | ✅ | |
| prospect/ | firmy.cz client, pagination | ✅ hotovo | ✅ | |
| company/ | Metadata, snapshot, sync | ✅ hotovo | ✅ | |
| contact/ | Status transitions, store | ✅ hotovo | ✅ | |
| db/ | Migrations, pool | ✅ hotovo | ✅ | |
| mailsim/ | Mail simulation (tests) | ✅ hotovo | ✅ | |
| calendar/ | Business hours, sending window | ✅ hotovo | ✅ | |
| alert/ | Alert store, acknowledgement | ✅ hotovo | ✅ | |
| llm/ | LLM client | 🔨 WIP | — | D2 task |
| web/ | HTTP handlers, routing | ✅ hotovo | contract testy | |
| seed/ | Prodlike seed data | ✅ hotovo | — | |

**Go celkem:** ~3 327 testů passing, `go build ./...` clean.

### 1.2 React pages (features/platform/outreach-dashboard/src/)

| Page | Stav | Testy | BFF endpoint(y) |
|---|---|---|---|
| Dashboard | ✅ | ✅ | /api/daemons, /api/health/* |
| Campaigns | ✅ | ✅ 16 | /api/campaigns |
| CampaignDetail | ✅ | ✅ 15 | /api/campaigns/:id, /api/campaigns/:id/sends |
| CampaignNew | 🔨 WIP | — | /api/campaigns, /api/templates, /api/segments |
| Segments | ✅ | ✅ 13 | /api/segments |
| Templates | ✅ | — | /api/templates |
| Mailboxes | ✅ | 🔴 3 failures | /api/mailboxes |
| Analytics | ✅ | 🔴 5 failures | /api/analytics/* |
| Inbox | 📝 TODO | — | /api/replies |
| ThreadDetail | 📝 TODO | — | /api/replies/:id |
| Healing | ✅ | — | /api/healing/* |
| DnsAuditPanel | ✅ | — | /api/audit/* |

### 1.3 BFF routes (server.js)

- **Celkem:** 130+ routes
- **Contract testy:** route inventory snapshot ✅, segments ✅ (14), campaigns preflight ✅ (7)
- **Chybí contract testy:** replies, analytics, mailboxes, templates, healing, protections

### 1.4 Databázové migrace

- Migrace 001–045 v `internal/db/migrations/`
- Migrace 044 (lead store) + 045 (dedup) — kód existuje, prodlike sync test chybí
- Backward-compatible policy: DROP/RENAME v samostatném kroku

### 1.5 Build health

```
go build ./...        ✅ clean
go test ./...         ✅ ~3327 passing (sender/OutsideBusinessHours: 65s long test)
pnpm build            🔨 verify needed
pnpm test             ⚠️  8 failures (Analytics 5, Mailboxes 3) — pre-existing
```

### 1.6 Tech debt katalog

| Závažnost | Lokace | Popis | Effort |
|---|---|---|---|
| 🔴 Blokuje | Analytics.components.test.jsx | 5 failing tests | S |
| 🔴 Blokuje | Mailboxes.components.test.jsx | 3 failing tests | S |
| 🟡 DX | CampaignNew.jsx | Stepper neimplementován | M |
| 🟡 DX | Inbox page | Chybí celá stránka | L |
| 🟡 DX | ThreadDetail page | Chybí | L |
| 🟢 Kosmetika | REFACTOR commity | Vynechat, sloučit s GREEN | — |

---

## 2. Architektura

### 2.1 System context diagram

```
[Operátor]
    │ HTTPS (přes VPN/tunnel)
    ▼
[React SPA] ←→ [Express BFF :3100]
                      │ HTTP (interní)
                      ▼
               [Go Backend :8080]
                /     |      \
               /      |       \
    [PostgreSQL] [SMTP servery] [IMAP servery]
                      |
              [Anti-trace relay]
                      |
              [Proxy pool]
                      |
         [ARES API] [firmy.cz]
```

### 2.2 Container diagram

| Container | Tech | Port | Komunikace |
|---|---|---|---|
| React SPA | Vite + React 19 | 5175 (dev) | → BFF přes HTTP |
| Express BFF | Node.js + Express 5 | 3100 | → Go přes HTTP + X-API-Key |
| Go Backend | Go 1.25 | 8080 | → PostgreSQL, SMTP, IMAP |
| PostgreSQL | pg 16 (Railway) | 5432 | ← Go backend |
| Anti-trace relay | nginx / Go | 8090 | ← email tracking, → Go backend |
| Proxy pool | External SOCKS5 | — | ← Go sender |

### 2.3 Go package dependencies (zjednodušeno)

```
main.go
  └── web/          (HTTP handlers)
        ├── campaign/    (runner, batch)
        │     ├── sender/     (SMTP engine)
        │     │     ├── mailbox/ (selector)
        │     │     ├── content/ (template)
        │     │     └── humanize/ (delays, headers)
        │     └── segment/ (filter, query)
        ├── thread/      (inbound, classify)
        │     └── imap/  (pool, poll)
        ├── enrich/      (pipeline, score)
        │     ├── ares/  (client)
        │     ├── prospect/ (firmy.cz)
        │     └── validation/ (email, MX)
        ├── intelligence/ (health report, 6h loop)
        └── db/          (migrations, pool)
```

### 2.4 Datový model (klíčové tabulky)

```sql
companies       (ico PK, name, region, nace_code, score, email, email_status)
contacts        (id, company_ico FK, email, status, first_name, last_name)
campaigns       (id, name, status, sequence_config JSONB, category_paths, category_match)
mailboxes       (id, email, smtp_*, imap_*, daily_limit, status, warmup_day, proxy_url)
send_events     (id, campaign_id FK, contact_id FK, mailbox_id FK, step, status, sent_at)
replies         (id, send_event_id FK, classification, handled, received_at)
templates       (id, name, subject, body)
segments        (id, name, query JSONB, company_count)
suppression     (email PK, reason, created_at)
audit_log       (id, entity_type, entity_id, action, details JSONB)
healing_events  (id, entity_type, entity_id, action, reason, resolved_at)
leads           (id, company_ico, campaign_id, status, webhook_sent_at)  -- migration 044
dedup_log       (id, contact_email, domain, campaign_id, reason)         -- migration 045
```

### 2.5 State machines

**Campaign:**
```
draft → active (quality gate + Spustit)
active → paused (Pozastavit)
paused → active (Spustit)
active → completed (všechny kontakty zpracovány)
draft → [deleted]
```

**Mailbox:**
```
active → paused (manuálně nebo auto: 3 consecutive bounces)
paused → active (manuálně nebo auto recovery)
active → cooldown (bounce rate > threshold)
cooldown → active (po cooldown period)
any → blacklisted (spam complaint, severe reputation damage)
```

**Contact:**
```
new → active (po enrichmentu)
active → replied (positive reply)
active → blacklisted (negative reply, opt-out)
active → bounced (hard bounce)
active → suppressed (suppression list)
```

### 2.6 Event flow — lifecycle emailu

```
1.  Campaign.Run() → dequeue kontakt
2.  Exclusion check → skip: blacklisted / bounced / honeypot / suppressed
3.  Template.Render() → spin resolve + var substitute + unique Message-ID
4.  Mailbox.Select() → weighted by remaining daily capacity
5.  RateLimiter.Allow() → per-domain hourly cap + global daily cap
6.  Humanize → gaussian delay + header randomize + UA rotate
7.  ProxyPool.Pick() → SOCKS5 proxy pro tento send
8.  SMTP Send (přes proxy) → nebo AntiTrace relay
9.  Record send_event (status: sent)
10. Tracking: open pixel → /o/:token → send_event status: opened
11. Tracking: click redirect → /c/:token → send_event status: clicked
12. IMAP Poll → new reply detected
13. Thread.Classify() → positive / negative / OOO / auto_reply
14. If negative → Contact.Blacklist() + Suppression.Add()
15. Reply stored → visible in Inbox
16. Operator handles → marks handled, předá lead, nebo odpoví
```

### 2.7 Error handling matrix

| Error | Typ | Akce | Operátor vidí |
|---|---|---|---|
| SMTP 421 | Transient | Retry 3×, pak requeue | — (auto) |
| SMTP 550 | Permanent | Hard bounce → blacklist | Healing log |
| SMTP 535 auth | Permanent | Pause mailbox | Mailbox status: error |
| IMAP conn lost | Transient | Reconnect backoff | Warning banner |
| DB error | Fatal | 500 + circuit breaker | Error toast + banner |
| Template var | Logic | Skip send, log | Send status: error |
| BFF → Go timeout | Transient | 504 | Error toast |
| Relay down | Degraded | Fallback: direct tracking | Healing event |
| Circuit breaker open | Expected | Pause, retry after 1min | Healing log |
| Bounce rate > 15% | Critical | STOP vše, alert | Critical banner |

---

## 3. MVP definice — inkrementální milestony

### 3.0 Filosofie: jedno vlákno per kontakt

Platforma není full email klient. Klíčový koncept je **jedno dlouhé vlákno per kontakt** — operátor vidí celou historii konverzace s danou firmou na jednom místě:

```
Vlákno: jan.novak@firma.cz
─────────────────────────────────────────────────────
[Kampaň: Excavator Q1]  Step 1 odesláno 15.4 10:23
[Kampaň: Excavator Q1]  Step 2 odesláno 19.4 09:15
→ Příchozí odpověď       "Máte nabídku na Volvo EC300?" 19.4 14:32
← Ruční odpověď          "Dobrý den, posílám katalog…" 19.4 15:01
→ Příchozí odpověď       "Kdy byste mohli přijet?" 20.4 09:44
─────────────────────────────────────────────────────
[Stav: Positive reply] [Lead ✓] [Kampaň pozastavena]
```

Operátor vede konverzaci z platformy. Přílohy (příchozí i odchozí v reply) jsou součástí vlákna. Kampaňové emaily jsou jen začátek — zbytek je ruční dialog.

### 3.1 MVP-0: "Vidím co se děje" (~2 dny)

**Cíl:** Čistý baseline. Vše co existuje funguje bezchybně.

| Task | Stav |
|---|---|
| Fix Analytics.components.test.jsx (5 failures) | 🔨 WIP |
| Fix Mailboxes.components.test.jsx (3 failures) | 🔨 WIP |
| `pnpm build` clean | 📝 TODO |
| `go test ./...` clean (~3327 passing) | ✅ |
| Baseline coverage report (Go + React) | 📝 TODO |
| Smoke test script (health endpoints) | 📝 TODO |

**Exit criteria:** Zero failing tests. Clean build. Operátor může otevřít dashboard, vidí stav, konfiguruje mailboxy/šablony/segmenty.

---

### 3.2 MVP-1: "Posílám" (~3 dny)

**Cíl:** Operátor spustí první kampaň z UI a vidí progress.

| Feature | Detail | Stav |
|---|---|---|
| CampaignNew wizard | Stepper: název → šablona → segment → preview → vytvořit | 🔨 WIP |
| Quality gate modal | Email quality + kapacita + odhad dní, potvrzení | 📝 TODO |
| Campaign run/pause z UI | Tlačítka v CampaignDetail, BFF → Go | ✅ hotovo |
| Preflight checks | DNS audit, mailbox health gate před spuštěním | 📝 TODO |
| CampaignDetail KPIs | Odesláno/otevřeno/odpovězeno/bounced/ve frontě | ✅ hotovo |
| CampaignDetail send tabulka | Seznam odeslaných s timestampy, status | ✅ hotovo |
| E2E: campaign-lifecycle.spec.ts | Vytvořit → spustit → pozastavit → obnovit | 📝 TODO |

**US-01: Spustit kampaň**
```
GIVEN operátor je na /campaigns
WHEN klikne "Nová kampaň" → wizard (šablona + segment) → "Vytvořit"
THEN draft kampaň
WHEN klikne "Spustit" → quality gate modal (validní emaily, kapacita, odhad)
WHEN potvrdí → kampaň active, sender začne odesílat
THEN vidí v CampaignDetail KPIs jak rostou
```

**Exit criteria:** E2E campaign-lifecycle.spec.ts green. Reálný email doručen test schránce.

---

### 3.3 MVP-2: "Čtu odpovědi" (~3 dny)

**Cíl:** Příjemce odpoví → operátor to vidí, včetně příloh.

| Feature | Detail | Stav |
|---|---|---|
| Inbox.jsx stránka | Seznam: odesílatel, předmět, klasifikace, čas, handled | 📝 TODO |
| Filter bar | Nezpracované / Positive / Negative / OOO / Vše | 📝 TODO |
| Nav badge | Unhandled count v sidebar navigaci | 📝 TODO |
| ThreadView v1 (read-only) | Vlákno: kampaňové emaily + replies chronologicky | 📝 TODO |
| Příchozí přílohy | Zobrazit název/velikost/typ, stáhnout, inline preview obrázků | 📝 TODO |
| Contact context panel | Sidebar: firma, kampaň, klasifikace | 📝 TODO |
| Mark as handled | PATCH /api/replies/:id | 📝 TODO |
| BFF contract tests: replies | ~10 testů | 📝 TODO |
| E2E: inbox-flow.spec.ts | Otevřít inbox → filter → vlákno → handled | 📝 TODO |

**US-02: Přečíst odpověď s přílohou**
```
GIVEN příjemce odpoví a pošle PDF katalog
WHEN operátor otevře /inbox
THEN vidí vlákno: kampaňový email + odpověď + příloha (název, velikost)
AND může stáhnout PDF
AND může označit jako handled
```

**Exit criteria:** E2E inbox-flow.spec.ts green. Badge ukazuje správný count. Příloha stažitelná.

---

### 3.4 MVP-3: "Odpovídám" (~3 dny)

**Cíl:** Operátor odpovídá přímo z platformy. Může přiložit soubor. Vlákno pokračuje.

| Feature | Detail | Stav |
|---|---|---|
| Reply compose v thread view | Textarea + "Odeslat" v ThreadView | 📝 TODO |
| Go: POST /api/threads/:id/reply | SMTP send ze stejné schránky jako kampaň | 📝 TODO |
| Reply headers | In-Reply-To, References, Message-ID — threading v Gmail/Outlook | 📝 TODO |
| Anti-trace na manuální reply | Stejné header sanitization jako kampaňové emaily | 📝 TODO |
| Přílohy v reply | Operátor přiloží soubor (PDF, obrázek, max 10 MB, max 3 přílohy) | 📝 TODO |
| Sent email ve vláknu | Odeslaná odpověď se zobrazí ve vláknu okamžitě | 📝 TODO |
| Auto-mark handled | Po odeslání reply → vlákno automaticky handled | 📝 TODO |
| BFF contract test | POST /api/threads/:id/reply | 📝 TODO |
| E2E: reply-flow.spec.ts | Vlákno → napsat → přiložit → odeslat → vidět ve vláknu | 📝 TODO |

**US-03: Odpovědět s přílohou**
```
GIVEN operátor má otevřené vlákno s příchozí odpovědí
WHEN klikne "Odpovědět"
THEN textarea + možnost přiložit soubor
WHEN napíše text, přiloží PDF, odešle
THEN email odejde ze STEJNÉ schránky jako kampaňový email
AND In-Reply-To header správně nastaven (threading v klientu příjemce)
AND příloha je v emailu
AND reply se zobrazí ve vláknu
AND vlákno → handled
```

**Přílohy v kampani — explicitní blokace:**
- Template engine odmítne šablonu s přílohou při uložení i renderování
- Důvod: přílohy v cold emailu = spam signál, snižují deliverability

**Exit criteria:** E2E reply-flow.spec.ts green. Příjemce vidí odpověď ve správném vláknu v Gmailu/Outlooku. Příloha doručena.

---

### 3.5 MVP-4: "Leady + analytiky" (~4 dny)

**Cíl:** Data z konverzací se mění v business hodnotu. Operátor vidí výkon.

| Feature | Detail | Stav |
|---|---|---|
| Lead store | DB: leads tabulka, status (new/contacted/qualified/won/lost) | 📝 TODO |
| "Převést na lead" | V thread view → vytvoří lead, označí vlákno "Lead ✓" | 📝 TODO |
| Lead webhook | POST na konfigurovanou URL při změně statusu | 📝 TODO |
| Leads stránka | Seznam leadů, status, firma, kampaň, poslední aktivita | 📝 TODO |
| Contact card v thread view | Sidebar: IČO, NACE, ICP skóre, historie kampaní | 📝 TODO |
| Forward email | Přeposlat vlákno kolegovi mimo platformu | 📝 TODO |
| Search | Fulltext přes vlákna, kontakty, firmy | 📝 TODO |
| Analytics page | Overview KPI + timeline chart 30d + campaign performance tabulka | 📝 TODO |
| BFF contract tests | Analytics, templates, healing (~22 testů) | 📝 TODO |
| E2E: lead-flow.spec.ts | Reply → lead → webhook | 📝 TODO |

**US-04: Lead conversion**
```
GIVEN vlákno s positive reply
WHEN operátor klikne "Převést na lead"
THEN lead záznam: firma, kontakt, kampaň, status "new"
AND webhook odeslán (pokud nakonfigurován)
AND vlákno označeno "Lead ✓"
AND lead viditelný na /leads stránce
```

**Exit criteria:** Lead → webhook flow green. Analytics ukazuje reálná data. Search vrací relevantní výsledky.

---

### 3.6 MVP-5: "Inteligence" (~6 dní)

**Cíl:** Platforma se učí. Operátor dělá méně manuální práce.

| Feature | Detail | Stav |
|---|---|---|
| LLM opener | AI generuje personalizovanou první větu per kontakt | 📝 TODO |
| AI reply draft | Navrhne odpověď (kontext vlákna + firma), operátor schválí/upraví | 📝 TODO |
| Smart scheduling | Optimální sending window per doména/region z historických dat | 📝 TODO |
| SendCalendar UI | Vizuální pohled na plánovací okno kampaně | 📝 TODO |
| Template ranking | Automatický ranking šablon dle reply rate | 📝 TODO |
| A/B testing | Split test subject lines / body variants, statistický vítěz | 📝 TODO |
| Advanced analytics | Funnel (segment→send→open→reply→lead), cohort analýza | 📝 TODO |
| Churn prediction | Auto-stop kontakty bez engagement po N emailech | 📝 TODO |
| Export CSV | Kontakty, leady, analytiky | 📝 TODO |
| Snooze | Odložit vlákno na datum, vrátí se do inbox | 📝 TODO |
| Scheduled send | Manuální reply s plánovaným časem odeslání | 📝 TODO |

**US-05: AI reply draft**
```
GIVEN příchozí email ve vlákně
WHEN operátor klikne "Odpovědět"
THEN platforma navrhne draft (AI, kontext vlákna + firma z DB)
AND operátor může upravit / schválit / zahodit
AND draft se neodešle bez explicitního schválení operátora
```

---

### 3.7 Srovnání milestones

| Schopnost | MVP-0 | MVP-1 | MVP-2 | MVP-3 | MVP-4 | MVP-5 |
|---|---|---|---|---|---|---|
| Dashboard + konfigurace | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ |
| Kampaně (CRUD, run, pause) | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ |
| Sender engine | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ |
| Campaign wizard + quality gate | — | ✅ | ✅ | ✅ | ✅ | ✅ |
| Inbox (čtení odpovědí) | — | — | ✅ | ✅ | ✅ | ✅ |
| Thread view (read-only) | — | — | ✅ | ✅ | ✅ | ✅ |
| Příchozí přílohy (view + download) | — | — | ✅ | ✅ | ✅ | ✅ |
| Reply z platformy | — | — | — | ✅ | ✅ | ✅ |
| Přílohy v reply | — | — | — | ✅ | ✅ | ✅ |
| Lead store + webhook | — | — | — | — | ✅ | ✅ |
| Contact card | — | — | — | — | ✅ | ✅ |
| Analytics (overview + timeline) | — | — | — | — | ✅ | ✅ |
| Search | — | — | — | — | ✅ | ✅ |
| Forward email | — | — | — | — | ✅ | ✅ |
| LLM opener | — | — | — | — | — | ✅ |
| AI reply draft | — | — | — | — | — | ✅ |
| A/B testing | — | — | — | — | — | ✅ |
| Smart scheduling | — | — | — | — | — | ✅ |
| Export CSV | — | — | — | — | — | ✅ |
| Snooze / Scheduled send | — | — | — | — | — | ✅ |

**Kdy je operátor produktivní:** od MVP-3 (odpovídá z platformy) — ~den 8.

### 3.8 Definition of Done (platí pro každý milestone)

- [ ] Kód buildí (`go build`, `pnpm build`)
- [ ] Unit testy napsány a procházejí
- [ ] Contract test pro každý nový BFF endpoint
- [ ] E2E test pro user-facing flow daného milestonu
- [ ] Error states: loading, empty, error
- [ ] Czech UI strings
- [ ] Zero platform identifiers v odeslaném emailu
- [ ] No console.log, no hardcoded values

### 3.9 Out of scope (post MVP-5)

- Compose (nový email komukoliv mimo reply) — post-MVP-5 pokud bude potřeba
- Oficiální schránka (typ "official", full IMAP sync) — post-MVP-5
- Unified inbox (kampaňové + ruční korespondence) — post-MVP-5
- Multi-tenant
- Mobile responsive
- i18n (jiné jazyky než čeština)
- CRM nativní integrace (jen webhook)
- Real-time WebSocket updates

---

## 4. Testing strategie

### 4.1 Testing pyramid

```
        /    E2E    \        5–10%  | 25+ scénářů (Playwright)
       /   Contract  \      10–15% | route inventory + shapes
      / Integration   \    15–20% | DB + SMTP + IMAP
     /      Unit       \   60–70% | functions + components
```

**Coverage targets:**

| Layer | Target | Tool |
|---|---|---|
| Go business logic | ≥85% | `go test -cover` |
| Go handlers | ≥70% | `go test -cover` |
| Go utilities | ≥90% | `go test -cover` |
| React components | ≥80% | vitest --coverage |
| BFF (server.js) | ≥75% | vitest --coverage |
| E2E critical paths | 100% US-01–US-10 | Playwright |

### 4.2 Unit testy — Go

| Package | Pattern | Key scenarios |
|---|---|---|
| sender/ | fake SMTP server, context cancel | Send success/fail, rate limit, circuit breaker, warmup |
| campaign/ | mock sender + sqlmock | Runner batch, scheduling, pause/resume, skip logic |
| content/ | file-based templates | Render, spin, vars, conditionals, subjects |
| thread/ | mock IMAP | Classify, blacklist on negative, dedup |
| bounce/ | unit | Hard/soft, counter, registry routing |
| validation/ | mock DNS | Email format, MX, spamtrap, state machine |
| mailbox/ | unit | Selector weighting, adaptive release, backpressure |
| segment/ | sqlmock | Filter build, query, rebuild, preview |

### 4.3 Unit testy — React

| Page | Done | Target |
|---|---|---|
| CampaignDetail | ✅ 15 | — |
| Campaigns | ✅ 16 | — |
| Segments | ✅ 13 | — |
| Inbox | 📝 | 12 |
| ThreadDetail | 📝 | 8 |
| Analytics | ⚠️ 5 fail | 10 (fix first) |
| Mailboxes | ⚠️ 3 fail | 8 (fix first) |
| Templates | — | 10 |
| Dashboard | — | 8 |
| Healing | — | 6 |
| DnsAuditPanel | — | 5 |

### 4.4 Contract testy

| Suite | Status | Tests |
|---|---|---|
| Route inventory snapshot | ✅ | 29 |
| BFF campaigns preflight | ✅ | 7 |
| BFF segments | ✅ | 14 |
| BFF replies | 📝 TODO | ~10 |
| BFF analytics | 📝 TODO | ~8 |
| BFF mailboxes | 📝 TODO | ~10 |
| BFF templates | 📝 TODO | ~8 |
| BFF healing | 📝 TODO | ~6 |
| BFF protections | 📝 TODO | ~8 |

### 4.5 E2E scénáře (Playwright)

**Tier 1 — MVP critical (must have):**
```
campaign-lifecycle.spec.ts
  ✓ Vytvořit kampaň → wizard → save
  ✓ Quality gate zobrazí email counts + capacity
  ✓ Spustit kampaň přes gate
  ✓ Pozastavit běžící kampaň
  ✓ Obnovit pozastavenou kampaň
  ✓ Campaign detail: KPIs + sends tabulka

inbox-flow.spec.ts
  ✓ Inbox zobrazí unhandled replies
  ✓ Filter dle klasifikace
  ✓ Označit reply jako handled
  ✓ Badge count se aktualizuje

segment-management.spec.ts
  ✓ Vytvořit segment s filtrem
  ✓ Preview count
  ✓ Rebuild segment
  ✓ Smazat segment

template-management.spec.ts
  ✓ Vytvořit šablonu s proměnnými
  ✓ Upravit šablonu
  ✓ Smazat šablonu
```

**Tier 2 — Operátorský comfort:**
```
mailbox-management.spec.ts     (6 scénářů)
analytics-dashboard.spec.ts    (4 scénáře)
healing-monitoring.spec.ts     (3 scénáře)
thread-detail.spec.ts          (4 scénáře)
```

**Tier 3 — Edge cases:**
```
error-states.spec.ts           (6 scénářů: 404, empty, network error, degraded)
navigation.spec.ts             (3 scénáře)
auth-guards.spec.ts            (2 scénáře)
```

**Tier 4 — Post-MVP:**
```
cross-browser.spec.ts          (Chrome, Firefox, Safari)
responsive.spec.ts             (320, 768, 1024, 1440)
performance.spec.ts            (Lighthouse, bundle size)
```

### 4.6 Anti-trace testy

```
anti-trace-audit.spec.ts
  ✓ Odeslat email → raw source → zero platform identifiers
  ✓ X-Mailer header chybí nebo je generický
  ✓ Message-ID formát odpovídá standardnímu klientu
  ✓ Tracking pixel URL → žádná vazba na platformu
  ✓ Click redirect → žádný platform odkaz v chain
  ✓ 10 emailů → žádný konzistentní header pattern
  ✓ Received headers → max 2 hopy
  ✓ Spam score (mail-tester.com pattern) ≥ 9/10
```

### 4.7 Quality gates

| Gate | Trigger | Podmínky | Blokuje |
|---|---|---|---|
| Pre-commit | `git commit` | `go vet`, `go test -short`, lint | Commit |
| PR merge | Pull request | Unit + contract suite, build | Merge |
| Staging deploy | Merge to main | PR gate + E2E Tier 1 | Prod deploy |
| Production deploy | Manuální | Staging green + smoke tests | Release |
| Release | Po deploy | Smoke + anti-trace audit | Announcement |

---

## 5. Fáze roadmapy

### Fáze 0 = MVP-0 — Stabilizace (~2 dny)

**Cíl:** Čistý baseline. Vše co existuje musí fungovat bezchybně.

| Task | Effort | Parallel |
|---|---|---|
| Fix Analytics.components.test.jsx (5 failures) | M | Track A |
| Fix Mailboxes.components.test.jsx (3 failures) | S | Track A |
| `pnpm build` verify + fix | S | Track A |
| Baseline coverage report (Go + React) | S | Track B |
| Smoke test script (health endpoints + basic UI) | S | Track B |

**Quality gate:** Zero failing tests. Clean build. Smoke green.

---

### Fáze 1 = MVP-1 — "Posílám" (~3 dny)

**Cíl:** Operátor spustí kampaň z UI, vidí jak emaily odcházejí.

**Parallel tracks:**

Track A — Campaign wizard:
| Task | Effort |
|---|---|
| CampaignNew.jsx stepper (název → šablona → segment → preview) | L |
| CampaignNew.test.jsx + BFF contract tests | M |
| Quality gate modal (email quality + kapacita + odhad) | M |

Track B — Preflight + detail:
| Task | Effort |
|---|---|
| preflight.go go-live checks (DNS, mailbox health, segment quality) | M |
| CampaignDetail preflight UI gate | M |
| preflight_test.go + BFF contract test | M |

Track C — E2E (po Track A+B):
| Task | Effort |
|---|---|
| campaign-lifecycle.spec.ts (6 scénářů) | M |
| segment-management.spec.ts (4 scénáře) | S |
| template-management.spec.ts (4 scénáře) | S |

**Quality gate:** E2E campaign-lifecycle green. Reálný email doručen test schránce.

---

### Fáze 2 = MVP-2 — "Čtu odpovědi" (~3 dny)

**Cíl:** Inbox s vlákny + příchozí přílohy.

**Parallel tracks:**

Track A — Inbox + threading:
| Task | Effort |
|---|---|
| Inbox.jsx + Zustand store (fetch, filtry, polling) | L |
| Nav badge (unhandled count) | S |
| ThreadView v1 — read-only, chronologické vlákno | L |
| Contact context panel (sidebar: firma, kampaň, klasifikace) | M |
| Mark as handled (PATCH /api/replies/:id) | S |

Track B — Přílohy:
| Task | Effort |
|---|---|
| Go: IMAP parsování MIME příloh při fetch reply | M |
| DB: attachments tabulka (migration 046) | S |
| BFF: GET /api/replies/:id/attachments | S |
| React: inline preview obrázků, download ostatních | M |

Track C — Testy:
| Task | Effort |
|---|---|
| Inbox.test.jsx (12 testů) | M |
| BFF contract tests: replies (~10) | M |
| E2E: inbox-flow.spec.ts (4 scénáře) | M |

**Quality gate:** E2E inbox-flow green. Badge ukazuje správný count. Příloha stažitelná.

---

### Fáze 3 = MVP-3 — "Odpovídám" (~3 dny)

**Cíl:** Operátor odpoví přímo z platformy, může přiložit soubor.

**Parallel tracks:**

Track A — Reply engine (Go):
| Task | Effort |
|---|---|
| POST /api/threads/:id/reply — SMTP send, správné headers | M |
| In-Reply-To + References threading | M |
| Anti-trace na manuální reply (stejné sanitization jako kampaň) | S |
| MIME multipart pro přílohy v reply | M |
| threads_test.go (unit testy) | M |

Track B — Reply UI (React):
| Task | Effort |
|---|---|
| Reply compose v ThreadView (textarea + attach) | M |
| File picker pro přílohy (max 10 MB, max 3 soubory) | S |
| Sent email zobrazení ve vláknu | S |
| Auto-mark handled po odeslání | S |
| ThreadDetail.test.jsx (8 testů) | M |

Track C — Testy:
| Task | Effort |
|---|---|
| BFF contract test: POST /api/threads/:id/reply | S |
| E2E: reply-flow.spec.ts (4 scénáře) | M |
| E2E: thread-detail.spec.ts (4 scénáře) | S |

**Quality gate:** E2E reply-flow green. Příjemce vidí odpověď ve správném vláknu v Gmailu. Příloha doručena.

---

### Fáze 4 = MVP-4 — "Leady + analytiky" (~4 dny)

**Cíl:** Konverzace → leady. Viditelný ROI.

**Parallel tracks:**

Track A — Lead store:
| Task | Effort |
|---|---|
| lead/store.go + migration 044 | M |
| Lead webhook (POST na konfigurovanou URL) | M |
| Leads stránka (seznam, status, firma, kampaň) | L |
| lead/store_test.go | M |

Track B — Thread enhancements:
| Task | Effort |
|---|---|
| "Převést na lead" tlačítko v ThreadView | S |
| Contact card sidebar (IČO, NACE, ICP, kampaň history) | L |
| Forward email (přeposlat vlákno kolegovi) | M |

Track C — Analytics + Search:
| Task | Effort |
|---|---|
| Analytics page (overview KPI + timeline + campaign table) | M |
| Search — fulltext přes vlákna + kontakty | L |
| BFF contract tests: analytics, templates, healing (~22) | L |
| E2E: lead-flow.spec.ts (3 scénáře) | M |
| E2E: analytics-dashboard.spec.ts (4 scénáře) | S |

**Quality gate:** Lead → webhook flow green. Analytics ukazuje reálná data.

---

### Fáze 5 = MVP-5 — "Inteligence" (~6 dní)

**Cíl:** Platforma se učí. Operátor dělá méně rutiny.

**Parallel tracks:**

Track A — LLM:
| Task | Effort |
|---|---|
| anthropic_content.go — LLM opener | L |
| AI reply draft (kontext vlákna + firma) | L |
| anthropic_content_test.go | M |

Track B — Optimalizace:
| Task | Effort |
|---|---|
| Smart scheduling (sending window per doména/region) | M |
| SendCalendar UI + dryrun calendar | L |
| Template ranking (reply rate) | M |
| A/B testing (split, statistický vítěz) | L |

Track C — Produktivita:
| Task | Effort |
|---|---|
| Advanced analytics (funnel, cohort) | L |
| Churn prediction (auto-stop bez engagement) | M |
| Export CSV (kontakty, leady, analytiky) | M |
| Snooze (odložit vlákno na datum) | M |
| Scheduled send (plánovaný čas odeslání) | M |

**Quality gate:** LLM opener integrovaný v Campaign wizard. AI draft v ThreadView. A/B test reportuje vítěze.

---

### Fáze 6 — Production hardening + deploy (~5 dní)

**Cíl:** Produkční kvalita, monitoring, deploy.

| Task | Effort |
|---|---|
| Security audit — všechny endpointy | L |
| `go test -race ./...` clean | M |
| Go coverage ≥85% + React coverage ≥80% | L |
| Migration prodlike sync test | M |
| CI/CD pipeline (GitHub Actions + Railway) | L |
| Railway production config + env vars | M |
| DNS + SSL setup (custom domény) | S |
| Anti-trace audit checklist | M |
| DB backup automation + verify | M |
| Monitoring + alerting (health endpoints) | M |
| Smoke test suite | S |
| Final manual QA | M |

**Quality gate:** Deploy succeeds. Smoke green. Monitoring fires test alert. Rollback tested. Anti-trace audit pass.

---

## 6. Sprint backlog

### 6.1 Aktuální prioritizovaný task list

**MVP-0 — IHNED:**
- [ ] Fix Analytics.components.test.jsx (5 failures) — fetch polyfill
- [ ] Fix Mailboxes.components.test.jsx (3 failures) — DOM assertions
- [ ] `pnpm build` verify + fix
- [ ] Baseline coverage report

**MVP-1 — Posílám (parallel):**

Track A — Campaign wizard:
- [ ] CampaignNew.jsx stepper (4 kroky)
- [ ] CampaignNew.test.jsx + BFF contract
- [ ] Quality gate modal

Track B — Preflight:
- [ ] preflight.go go-live checks
- [ ] CampaignDetail preflight UI gate
- [ ] preflight_test.go

Track C — E2E (po A+B):
- [ ] campaign-lifecycle.spec.ts
- [ ] segment-management.spec.ts
- [ ] template-management.spec.ts

**MVP-2 — Čtu odpovědi (parallel):**

Track A:
- [ ] Inbox.jsx + Zustand store
- [ ] ThreadView v1 (read-only)
- [ ] Contact context panel
- [ ] Mark as handled

Track B:
- [ ] Go: IMAP MIME parsing + attachments
- [ ] DB: migration 046 (attachments)
- [ ] React: attachment view + download

Track C:
- [ ] Inbox.test.jsx (12 testů)
- [ ] BFF contract: replies (~10)
- [ ] E2E: inbox-flow.spec.ts

**MVP-3 — Odpovídám (parallel):**

Track A:
- [ ] POST /api/threads/:id/reply (Go)
- [ ] Threading headers (In-Reply-To)
- [ ] MIME multipart s přílohami
- [ ] threads_test.go

Track B:
- [ ] Reply compose UI
- [ ] File picker (max 10 MB)
- [ ] ThreadDetail.test.jsx

Track C:
- [ ] BFF contract: POST /threads/:id/reply
- [ ] E2E: reply-flow.spec.ts
- [ ] E2E: thread-detail.spec.ts

**MVP-4 — Leady + analytiky (parallel):**

Track A:
- [ ] lead/store.go + migration 044
- [ ] Lead webhook
- [ ] Leads stránka

Track B:
- [ ] "Převést na lead" tlačítko
- [ ] Contact card sidebar
- [ ] Forward email

Track C:
- [ ] Analytics page
- [ ] Search (fulltext)
- [ ] BFF contract: analytics, templates, healing
- [ ] E2E: lead-flow.spec.ts

**MVP-5 — Inteligence:** viz Fáze 5 detaily výše.

**Fáze 6 — Hardening:** security, -race, CI/CD, deploy.

### 6.2 Effort scale

| Size | Hodiny |
|---|---|
| S | 1–2h |
| M | 2–4h |
| L | 4–8h |
| XL | 8–16h |

### 6.3 Critical path

```
MVP-0 → MVP-1 → MVP-2 → MVP-3 → MVP-4 → MVP-5 → Hardening → Deploy
```

Operátor **produktivní** od MVP-3 (den ~8). Full platform od MVP-5 (den ~21).

---

## 7. CI/CD pipeline

### 7.1 Pre-commit hooks

```json
{
  "pre-commit": [
    "go vet ./modules/outreach/...",
    "go test -short ./modules/outreach/...",
    "cd features/platform/outreach-dashboard && pnpm lint",
    "cd features/platform/outreach-dashboard && pnpm build --if-present"
  ],
  "pre-push": [
    "go test -race -short ./modules/outreach/..."
  ]
}
```

### 7.2 GitHub Actions

```yaml
# .github/workflows/ci.yml
jobs:
  go:
    steps:
      - go test -race -cover ./modules/outreach/...
      - gosec ./modules/outreach/...
      - go build ./...

  react:
    steps:
      - pnpm install
      - pnpm test --run
      - pnpm build

  e2e:
    needs: [go, react]
    steps:
      - Start: Go backend + BFF + React
      - npx playwright test --project=chromium
      - Upload: playwright-report/

  anti-trace-audit:
    needs: [e2e]
    steps:
      - Run anti-trace audit checklist
      - Verify zero platform identifiers
```

### 7.3 Deploy pipeline

```
push to main
  → CI passes (go + react + e2e Tier 1)
  → Auto-deploy to staging (Railway)
  → Smoke tests on staging
  → Manual approval
  → Deploy to production
  → Smoke tests on production
  → ✅ Release || 🔴 Auto-rollback
```

### 7.4 Rollback

- Railway: instant rollback (UI + CLI: `railway rollback`)
- DB: backward-compatible migrations only
- Target: rollback complete < 5 minut
- Rollback trigger: smoke test failure nebo manuální

---

## 8. Infra + deployment

### 8.1 Railway topology

```
┌─────────────────────────────────────────┐
│         Railway Project                 │
│                                         │
│  ┌──────────────┐  ┌──────────────┐    │
│  │ Go Backend   │  │ Express BFF  │    │
│  │ :8080        │←─│ :3100        │    │
│  │ Internal DNS │  │ Public URL   │    │
│  └──────┬───────┘  └──────────────┘    │
│         │                               │
│  ┌──────┴───────┐  ┌──────────────┐    │
│  │ PostgreSQL   │  │ Anti-trace   │    │
│  │ Railway      │  │ Relay :8090  │    │
│  │ Managed      │  │              │    │
│  └──────────────┘  └──────────────┘    │
└─────────────────────────────────────────┘
         │
   (zákaznické CNAME domény → relay)
```

### 8.2 Environment variables

| Service | Variable | Required |
|---|---|---|
| Go | DATABASE_URL | ✅ |
| Go | OUTREACH_API_KEY | ✅ |
| Go | DB_SSL_MODE | disable/require |
| Go | ANTI_TRACE_URL | ❌ (opt) |
| Go | MAILBOX_N_SMTP_HOST | ✅ per mailbox |
| BFF | GO_SERVER_URL | ✅ |
| BFF | OUTREACH_API_KEY | ✅ |
| BFF | PORT | default 3100 |
| BFF | CORS_ORIGIN | default localhost:5175 |

### 8.3 DNS setup

```
dashboard.zakaznik.cz    → CNAME → bff.railway.app
img.zakaznik.cz          → CNAME → relay.railway.app  (tracking pixel)
info.zakaznik.cz         → CNAME → relay.railway.app  (click redirect)
```

- SSL: Railway auto-SSL (Let's Encrypt) na custom domains
- TTL: 300s (rychlý failover)

### 8.4 DB backup

- Railway: automatické denní snapshots
- Point-in-time recovery: 7 dní
- Suppression list: samostatný export denně (viz sekce 16)
- Restore test: měsíčně (viz runbook 12.5)

---

## 9. Observability

### 9.1 Health endpoints

```
GET /api/health/system    → { db: ok, overall: ok }
GET /api/health/guards    → { staleness: ok, configDrift: ok }
GET /api/health/watchdog  → { circuitBreakers: [...], mailboxHealth: [...] }
GET /api/anti-trace/health → { ok: true, ms: 2 }
```

### 9.2 Business metriky (logované každou hodinu)

```
emails_sent_total         counter
emails_bounced_total      counter (by: hard/soft)
emails_replied_total      counter (by: classification)
emails_opened_total       counter
queue_depth               gauge
active_mailboxes          gauge
bounce_rate_7d            gauge
open_rate_7d              gauge
reply_rate_7d             gauge
```

### 9.3 Alerting rules

| Podmínka | Severity | Akce |
|---|---|---|
| Health endpoint !ok | 🔴 Critical | Page operátora |
| Bounce rate > 10%/hodina | 🟡 Warning | Auto-pause mailbox |
| Celková bounce rate > 15% | 🔴 Critical | STOP vše |
| Žádné emaily 2h v sending window | 🟡 Warning | Check sender + queue |
| Queue depth > 1000 | 🟡 Warning | Check rate limits |
| Relay down > 5 min | 🟡 Warning | Fallback active |
| DB pool exhausted | 🔴 Critical | Scale nebo investigate |

### 9.4 Structured logging

```json
{
  "time": "2026-04-20T10:30:00Z",
  "level": "INFO",
  "msg": "email sent",
  "campaign_id": 1,
  "mailbox": "m***@domain.cz",
  "domain": "cilova-firma.cz",
  "step": 0,
  "send_event_id": 12345
}
```

Pravidla:
- Žádný plain-text email v logu — vždy maskovaný (`m***@domain.cz`)
- Žádný template body v logu
- JSON format, queryable v Railway Logs

---

## 10. Security

### 10.1 Authentication

- API: `X-API-Key` header na všech Go endpointech
- BFF: přidává key automaticky, nikdy není exposed klientovi
- Key rotation: manuální procedura (viz runbook 12.6)
- Dashboard: přístupný pouze přes VPN/SSH tunnel nebo IP whitelist

### 10.2 Input validation

- Všechny user inputs validovány na BFF (request body schema)
- Parametrizované SQL queries everywhere — žádná string concatenation
- Template variables sanitizovány před rendering

### 10.3 Rate limiting

- BFF: 100 req/min per IP pro public endpoints
- BFF: 1000 req/min pro autentizované operace
- Go: interní rate limiting na sender (per domain, per mailbox)

### 10.4 Security headers (BFF)

```
Content-Security-Policy: default-src 'self'; script-src 'self'
Strict-Transport-Security: max-age=31536000; includeSubDomains
X-Content-Type-Options: nosniff
X-Frame-Options: DENY
Referrer-Policy: no-referrer
Permissions-Policy: camera=(), microphone=(), geolocation=()
```

### 10.5 Secret management

- Nikdy v kódu — vždy env vars
- Validace při startu (`os.Getenv` + fatal pokud chybí)
- Rotation procedure: viz runbook 12.6

### 10.6 SMTP security per mailbox domain

- SPF: `v=spf1 include:mailbox-provider.cz ~all`
- DKIM: klíč generovaný per doména, uložen v DNS
- DMARC: `v=DMARC1; p=quarantine; rua=mailto:dmarc@domain.cz`
- Alignment: From = envelope-from = DKIM domain (strict)

### 10.7 Dependency audit

```bash
# Go
go mod tidy && govulncheck ./...

# Node.js
pnpm audit --audit-level=high
```

Spouštět: před každým releasem + měsíčně.

---

## 11. Email deliverability

### 11.1 Warmup schedule

| Den | Emailů/den |
|---|---|
| 1–3 | 5 |
| 4–7 | 10–15 |
| 8–14 | 20–30 |
| 15–21 | 40–60 |
| 22–30 | 80–100 |
| 30+ | daily_limit (max 120) |

### 11.2 Sending patterns (human mimicry)

- **Business hours only:** Po–Pá, 8:00–17:00, timezone mailboxu
- **Gaussian delay:** mean 90s, stddev 45s, min 30s, max 300s
- **Daily variation:** ±15% od target volume
- **Domain throttle:** max 3 emaily/doménu/hodinu
- **Initial delay:** 5–30 min po spuštění kampaně
- **Micro-breaks:** občasná 5–15 min pauza (simulace oběda)
- **Ramp-up:** pomalý start ráno, peak 10:00–14:00, útlum k 17:00

### 11.3 Bounce management

| Typ | Akce |
|---|---|
| Hard bounce (5xx) | Kontakt → blacklisted, Suppression.Add() |
| Soft bounce (4xx) | Increment counter, retry later |
| Consecutive bounces (3) | Mailbox → paused, healing event |
| Bounce rate > 10% | Mailbox → cooldown |
| Bounce rate > 15% global | STOP všechno, critical alert |

### 11.4 Content quality

Před odesláním šablony (template score check):
- ❌ Spam slova: "zdarma", "sleva", "výhra", "klikněte ZDE"
- ❌ Příliš mnoho odkazů (>2)
- ❌ Žádná personalizace (žádné proměnné)
- ❌ Příliš krátké (<50 slov) nebo příliš dlouhé (>500 slov)
- ✅ Minimálně 3 spin body → unikátnost
- ✅ Plain text jako primární, HTML minimální

---

## 12. Operational runbooks

### 12.1 Deployment procedure

```bash
1. Verify CI green na main branch
2. `railway deploy` nebo push to main (auto-deploy)
3. Monitor logs 5 minut: `railway logs`
4. Run smoke tests: `./scripts/smoke-test.sh $PROD_URL $API_KEY`
5. Check health: GET /api/health/system
6. Verify Inbox + Analytics v UI
7. ✅ Hotovo || 🔴 Rollback procedure
```

### 12.2 Rollback procedure

```bash
1. `railway rollback` (vrátí na předchozí deployment)
2. Verify health endpoints
3. Notify operátora
4. Investigate root cause
5. Fix + redeploy
```

### 12.3 Mailbox paused alert

```
1. Otevři Healing log → najdi event
2. Přečti reason (SMTP failure / bounce spike / manual)
3. SMTP failure → zkontroluj credentials, SPF/DKIM, IP blacklist
4. Bounce spike → zkontroluj poslední kampaň, kvalitu emailů
5. Fix issue
6. Mailboxes → Resume
7. Verify: test email odeslán úspěšně
```

### 12.4 High bounce rate

```
1. Identifikuj mailbox/kampaň s problémem
2. Pause kampaň ihned
3. Zkontroluj: cílový segment (spam traps?), šablona (content quality)
4. Zkontroluj: IP blacklist (mxtoolbox.com)
5. Čekej 24h cooldown
6. Nastav nižší denní limit
7. Znovu spusť s menším segmentem (test batch 20 emailů)
8. Monitor 2 hodiny
9. Pokud OK → plný segment
```

### 12.5 DB backup verification

```bash
# Měsíčně:
1. Stáhni nejnovější backup z Railway
2. Obnov na test instanci: `psql $TEST_DB < backup.sql`
3. Verify: `SELECT count(*) FROM companies;`
4. Verify: `SELECT count(*) FROM suppression;`
5. Verify: migrations applied: `SELECT * FROM schema_migrations ORDER BY version DESC LIMIT 5;`
6. Zaznamenej datum verifikace
```

### 12.6 Secret rotation

```bash
1. Vygeneruj nový OUTREACH_API_KEY: `openssl rand -hex 32`
2. Nastav v Railway: Go service + BFF service současně (atomic update)
3. Verify: oba services healthcheck OK
4. Smaž starý key z Railway secrets
5. Zaznamenej datum rotace
```

### 12.7 New mailbox onboarding

```
1. Získej SMTP credentials (host, port, user, password)
2. Získej IMAP credentials (host, port, user, password)
3. Přidej v Mailboxes → "Nový mailbox"
4. Platform ověří SMTP + IMAP konektivitu
5. DNS audit → zkontroluj SPF/DKIM/DMARC
6. Nastav daily_limit = 5 (warmup start)
7. Přiřaď proxy ze working pool
8. Čekej 30 dní na warmup
9. Postupně zvyšuj daily_limit
```

### 12.8 Campaign launch checklist

```
Pre-launch:
□ Segment má preview count > 0
□ Šablona prošla template quality score
□ DNS audit pro sending domény → SPF/DKIM/DMARC OK
□ Minimálně 1 aktivní mailbox v warming nebo full capacity
□ Quality gate: validní emaily > 80% segmentu
□ Bounce rate všech mailboxů < 5%

Post-launch (první 2 hodiny):
□ Sender odesílá (check campaign KPIs)
□ Bounce rate < 5%
□ Žádné circuit breaker eventy
□ První odpovědi v Inboxu (pokud OK open rate)
```

---

## 13. Rizika + mitigace

| Riziko | Pravděpodobnost | Dopad | Mitigace |
|---|---|---|---|
| SMTP deliverability degradace | Střední | Vysoký | Warmup, proxy rotation, monitoring, content quality |
| IP/doména blacklisting | Nízká | Kritický | Proactive monitoring (mxtoolbox), quick rotation |
| DB data loss | Nízká | Kritický | Daily backup + PITR + suppression export |
| Relay single point of failure | Střední | Střední | Fallback na direct tracking, zdravotní check |
| Suppression list ztráta | Velmi nízká | Kritický | Separátní backup každý den, immutable storage |
| Timeline slippage | Střední | Střední | Pravidelné priority review, scope cut pokud nutné |
| Operator error (spuštění špatné kampaně) | Střední | Střední | Quality gate, confirmation dialogs, undo kde možné |
| Secret exposure | Nízká | Kritický | Env vars only, rotation procedure, git history audit |
| N+1 DB queries při scale | Střední | Střední | Query profiling, indexy, connection pooling |
| Go race condition | Nízká | Střední | `go test -race` v CI, careful locking v sender |

---

## 14. Cost breakdown

### 14.1 Development cost (tokeny)

| Fáze | Input tokens | Output tokens | Sonnet ($3/$15) | Opus ($30/$150) |
|---|---|---|---|---|
| Fáze 0 | 200k | 30k | $1.05 | $10.50 |
| Fáze 1 | 800k | 120k | $4.20 | $42 |
| Fáze 2 | 600k | 100k | $3.30 | $33 |
| Fáze 3 | 700k | 120k | $3.90 | $39 |
| Fáze 4 | 300k | 50k | $1.65 | $16.50 |
| **Celkem** | **2.6M** | **420k** | **~$14** | **~$141** |

**Doporučení:** Sonnet pro implementaci, Opus pouze pro architektonická rozhodnutí.

### 14.2 Infrastructure cost

| Komponent | Railway tier | Cena/měsíc |
|---|---|---|
| Go Backend | Hobby/Pro | $5–20 |
| PostgreSQL | Hobby managed | $5–20 |
| Express BFF | Hobby | $5 |
| Anti-trace relay | Hobby | $5 |
| Static hosting (React) | Hobby | $0–5 |
| **Celkem** | | **~$20–50/měsíc** |

### 14.3 Timeline

| Milestone | Elapsed | Kumulativně | Co přibývá |
|---|---|---|---|
| MVP-0 Stabilizace | ~2 dny | 2 dny | Zero broken tests, clean build |
| MVP-1 Posílám | ~3 dny | 5 dní | Kampaň z UI, quality gate, KPIs |
| MVP-2 Čtu odpovědi | ~3 dny | 8 dní | Inbox, thread read-only, přílohy |
| MVP-3 Odpovídám | ~3 dny | 11 dní | Reply z platformy, přílohy v reply |
| MVP-4 Leady + analytiky | ~4 dny | 15 dní | Leady, contact card, analytics |
| MVP-5 Inteligence | ~6 dní | 21 dní | LLM, A/B, smart scheduling |
| Fáze 6 Hardening + deploy | ~5 dní | 26 dní | CI/CD, monitoring, produkce |
| **Do produkce (MVP-3)** | | **~11 dní** | **Operátor produktivní** |
| **Do full platform** | | **~26 dní** | **Kompletní funkce** |

---

## 15. Anti-trace & anonymita

> **Invariant:** Každý email nerozeznatelný od ručně napsaného v Thunderbirdu. Detekce platformy = critical bug.

### 15.1 Vrstvy anonymity

```
Vrstva 0: INFRASTRUKTURA    — IP adresy, hosting, domény
Vrstva 1: SMTP OBÁLKA       — HELO, envelope-from, TLS fingerprint
Vrstva 2: EMAIL HLAVIČKY    — Message-ID, X-Mailer, Received chain
Vrstva 3: OBSAH EMAILU      — tracking pixel, click links, HTML structure
Vrstva 4: CHOVÁNÍ           — timing, frekvence, vzorce odesílání
Vrstva 5: ODPOVĚDNÍ KANÁL   — IMAP poll pattern
Vrstva 6: WEB TRACKING      — pixel endpoint, redirect endpoint
Vrstva 7: OPERÁTORSKÝ PŘÍSTUP — dashboard dostupnost
```

### 15.2 Infrastruktura

| Opatření | Stav |
|---|---|
| SMTP přes SOCKS5/HTTP proxy | ✅ impl. |
| Proxy rotation per mailbox/send | ✅ impl. |
| Proxy health probing | ✅ impl. |
| Geo-matching (CZ mailbox → CZ proxy) | 🔨 konfig |
| Tracking doména ≠ sending doména ≠ platform doména | 📝 plán |
| Dashboard pouze přes VPN/tunnel | 📝 plán |
| Whois privacy na tracking doménách | 📝 plán |

### 15.3 Email hlavičky — co stripovat

| Hlavička | Akce |
|---|---|
| `X-Mailer` | Stripovat nebo nastavit na "Thunderbird 115.0" |
| `X-Originating-IP` | Stripovat |
| `X-Priority` | Nepoužívat |
| `List-Unsubscribe` | Nepoužívat (B2B, ne newsletter) |
| `Return-Path` | Mailbox adresa zákazníka |
| Jakýkoliv `X-Platform-*` | NIKDY nepřidávat |
| `Message-ID` | `<random@mailbox-domain>` formát |
| `User-Agent` | Rotovat z poolu reálných UA |

**Header order randomization:** Pořadí From/To/Subject/Date/Message-ID náhodné per email, odpovídá profilu UA.

### 15.4 Tracking — architektura

**Pixel (nesprávně):**
```
<img src="https://track.platforma.cz/o/abc123">
```

**Pixel (správně):**
```html
<img src="https://img.zakaznik.cz/logo-podpis.png?v=k8x9m2"
     width="1" height="1" alt="logo">
```
- Doména zákazníka (CNAME → relay)
- Vypadá jako logo v podpisu
- Token v query param (vypadá jako cache buster)

**Click redirect (správně):**
```
https://info.zakaznik.cz/nabidka-2024?ref=k8x9m2
```
- Doména zákazníka
- Path vypadá jako content
- Cílová URL nikde viditelná

**Relay flow:**
```
Request → zákaznická doména → CNAME → relay
        → relay zaznamená event (interní síť → Go backend)
        → relay vrátí: reálné PNG / 302 redirect na cíl
        → Response headers: standardní nginx/CF headers
```

### 15.5 Behavioral fingerprinting — mitigace

| Pattern | Mitigace |
|---|---|
| Rovnoměrné intervaly | Gaussian delay (mean 90s, stddev 45s) |
| Odesílání v noci | Business hours only |
| Burst na začátku dne | Ramp-up + peak 10:00–14:00 |
| Přesně stejný objem | ±15% denní variace |
| Hned po startu kampaně | Initial delay 5–30 min |
| Žádné pauzy | Micro-breaks 5–15 min |
| Identický timing napříč mailboxy | Nezávislé timery per mailbox |

### 15.6 Anti-trace audit checklist (před každým releasem)

```
□ Odeslat test email → stáhnout raw source → zero platform identifiers
□ Porovnat headers s Thunderbird → nerozeznatelné
□ Tracking pixel URL → resolve → žádný odkaz na platformu
□ Click link → resolve chain → žádný odkaz na platformu
□ nslookup všechny domény v emailu → žádná vazba na platformu
□ Whois tracking domén → privacy protection
□ 10 emailů stejné kampani → žádný header pattern
□ mail-tester.com score ≥ 9/10
□ Received headers → max 2 hopy, žádný interní hostname
□ Message-ID → standard klient formát
```

### 15.7 Fingerprint resistance matrix

| Detektor | Naše mitigace |
|---|---|
| SpamAssassin | Žádné bulk headers, spin syntax, plain text |
| Gmail anti-spam | Warmup, human timing, engagement |
| Barracuda | Proxy rotation, unique content per email |
| Proofpoint | Header randomization, custom tracking domény |
| DMARC checkers | Strict alignment: From = envelope-from = DKIM |
| Manual investigation | Zero platform artifacts v raw source |
| Honeypot operators | Pre-send honeypot detection, known trap domény vyloučeny |

---

## 16. Disaster recovery

### 16.1 Backup strategie

| Data | Backup | Frekvence | Retention |
|---|---|---|---|
| PostgreSQL (full) | Railway automated | Denně | 7 dní PITR |
| Suppression list | Export CSV (separátní) | Denně | Navždy |
| Campaign state | DB backup | Denně | 7 dní |
| Templates | DB backup | Denně | 7 dní |
| Konfigurace (env vars) | Dokumentovány | Při změně | Navždy |

**Suppression list je kritický** — jeho ztráta = opětovné oslovení opt-out kontaktů = devastace reputace. Ukládáme separátně, šifrovaně, mimo Railway.

### 16.2 Recovery objectives

| Scénář | RTO (Recovery Time) | RPO (Data Loss) |
|---|---|---|
| Go backend crash | <2 min (Railway auto-restart) | 0 |
| DB connection lost | <5 min | 0 |
| Railway outage | <30 min (failover nebo redeploy) | <1 den |
| Accidental data delete | <1 hodina (PITR restore) | <24 hodin |
| Suppression list corruption | <15 min (CSV restore) | 0 |

### 16.3 Anti-duplicate protection

- Před každým send: check suppression list (DB lookup)
- Send event dedup: `(campaign_id, contact_id, step)` unique constraint
- Queue persistence: při restartu se queue obnoví z DB, ne z paměti
- Idempotent send: re-delivery protection přes Message-ID tracking

### 16.4 Šifrování

- DB at rest: Railway managed encryption
- Backups: šifrovat před přenosem mimo Railway
- Suppression CSV: GPG encrypted, klíč u operátora

---

## 17. Multi-instance deployment

### 17.1 Onboarding nového zákazníka

```bash
# 1. Kopíruj Railway projekt template
railway link $TEMPLATE_PROJECT
railway copy --name "zakaznik-nazev"

# 2. Nastav environment variables
railway variables set DATABASE_URL=$NEW_DB_URL
railway variables set OUTREACH_API_KEY=$(openssl rand -hex 32)

# 3. Nastav vertikální konfiguraci
cp -r configs/heavy-machinery configs/new-customer
# Uprav: templates/, icp_weights.json, categories.json

# 4. Apply migrace
go run cmd/outreach/main.go --migrate-only

# 5. Seed default data
go run cmd/outreach/main.go --seed-only

# 6. Verify
curl -H "X-API-Key: $KEY" https://api.zakaznik.cz/api/health/system
```

### 17.2 Instance isolation

- Každý zákazník: vlastní Railway projekt, vlastní DB, vlastní API key
- Žádné sdílené tabulky, žádné cross-instance volání
- Každá instance na vlastní subdoméně zákazníka

### 17.3 Upgrade strategie

```bash
# Pro každou instanci:
1. Test upgrade na staging instanci
2. Backup produkční DB
3. Deploy nové verze
4. Run migrations
5. Smoke test
6. Rollback pokud fail
```

---

## 18. Abuse prevention

### 18.1 Hard limity (nepřekročitelné konfigurací)

```go
const (
    MaxDailyEmailsPerInstance = 5000   // celková instance
    MaxDailyEmailsPerMailbox  = 200    // per mailbox (override warmup)
    MaxConcurrentCampaigns    = 10     // současně aktivních
    MaxSegmentSize            = 10000  // kontaktů per segment
    MaxTemplateBodyLength     = 5000   // znaků
    MaxMailboxes              = 50     // per instance
)
```

### 18.2 Suppression immutability

- UI: žádné tlačítko "odblacklistovat"
- API: `DELETE /api/suppression/:email` pouze s admin tokenem (jiný od operátorského)
- Audit log: každé odstranění ze suppression loggováno s důvodem

### 18.3 Content guardrails

Automatická kontrola šablony před uložením:
- ❌ Phishing patterns: "verify account", "click to confirm", "login to"
- ❌ Fake urgency: "expires in 24h", "act now", "limited time"
- ❌ Attachment indicators (B2B outreach — žádné přílohy)
- ❌ Domain blacklist: gmail.com, seznam.cz, policie.cz, soudy.cz

### 18.4 Sending velocity cap

```
Global circuit breaker: pokud celková bounce rate > 15% → STOP VŠE
Domain circuit breaker: pokud bounce rate na doméně > 20% → pause ta doména
Mailbox circuit breaker: 3 consecutive SMTP failures → pause mailbox
```

### 18.5 Audit trail (nemazatelný)

```sql
-- audit_log: INSERT only, žádný UPDATE/DELETE
INSERT INTO audit_log (entity_type, entity_id, action, details, created_at)
VALUES ('campaign', $1, 'launched', $2, NOW());
```

Logujeme: každé spuštění kampaně, každou pauzu, každé přidání/odebrání ze suppression, každý manuální override.

---

## 19. Offline resilience

### 19.1 Failure modes

| Komponent padne | Chování | Operátor vidí |
|---|---|---|
| PostgreSQL | Sender pausne, BFF vrací cached data kde možné | Degraded banner |
| Go backend | BFF vrací 503, React zobrazí stale data | "Backend nedostupný" banner |
| Anti-trace relay | Tracking vrátí fallback PNG, links redirect přímo | Healing event (warning) |
| IMAP server | Poll pausne, retry s exponential backoff | "Odpovědi se nestahují" |
| SMTP server | Daný mailbox pausne, ostatní jedou dál | Mailbox status: error |
| Proxy pool | Fallback na direct SMTP (bez proxy) | Log event |
| Celý Railway | App nedostupná, data safe v DB | — |

### 19.2 No-duplicate guarantee

Za žádných okolností nesmí být stejný email odeslán dvakrát:
- Pre-send check: `send_events` (campaign_id, contact_id, step) unique constraint
- Sender: před odesláním zkontroluje DB zda send_event neexistuje
- Queue: po restartu obnoví stav z DB, přeskočí již odesláno

### 19.3 Graceful shutdown

```go
// Go backend
sigChan := make(chan os.Signal, 1)
signal.Notify(sigChan, syscall.SIGTERM, syscall.SIGINT)
<-sigChan
// 1. Stop accepting new queue items
// 2. Wait for in-flight sends to complete (max 30s)
// 3. Flush metrics
// 4. Close DB connections
// 5. Exit
```

---

## 20. Compliance framework

### 20.1 Filozofie

Platforma je nasazena mimo EU/EEA — GDPR/ePrivacy se neaplikuje. Compliance modul je volitelný, zapnutelný per instance pokud jurisdikce vyžaduje.

### 20.2 Vždy aktivní (best practice, ne GDPR)

- **Opt-out honored** — negative reply = permanentní suppression. Nevratné.
- **Suppression list** — de facto "do not contact" list
- **No B2C data** — pouze firmy z veřejných registrů, žádní jednotlivci mimo business roli
- **Unsubscribe link** — v každém emailu (zlepšuje deliverability, snižuje spam complaints)
- **Audit trail** — nemazatelný log všech akcí

### 20.3 Volitelné moduly (per jurisdikce)

| Modul | Zapíná se | Popis |
|---|---|---|
| `GDPR_MODE=true` | EU/EEA deployment | DSR endpoints, legal basis fields, consent tracking |
| `DATA_RETENTION_DAYS=90` | Dle lokálního zákona | Auto-delete starých send_events |
| `MANDATORY_UNSUBSCRIBE=true` | Default on | Unsubscribe link povinný v každém emailu |

### 20.4 Data retention

| Data | Default retention | Konfigurovatelné |
|---|---|---|
| send_events | Navždy (archiv) | Ano |
| replies | Navždy | Ano |
| suppression | Navždy (nikdy mazat) | ❌ |
| audit_log | 2 roky | Ano (min 1 rok) |
| companies | Navždy | Ano |

---

## 21. Škálovatelnost

### 21.1 Scale tiers

| Tier | Zákazníci | Mailboxy | Emaily/den | DB rows | Infra |
|---|---|---|---|---|---|
| **Pilot** | 1 | 3–5 | 300–500 | <1M | Railway Starter |
| **Growth** | 2–5 | 15–25 | 2–5K | 1–10M | Railway Pro |
| **Scale** | 10–20 | 50–100 | 10–20K | 10–50M | Dedicated |
| **Enterprise** | 20+ | 100+ | 50K+ | 50M+ | Custom infra |

### 21.2 Bottlenecks a řešení

| Bottleneck | Symptom | Řešení |
|---|---|---|
| DB connections | Slow queries, timeouts | Connection pool tuning, read replicas |
| Sender goroutines | Queue not draining | Scale Go instances, increase workers |
| IMAP connections | Replies late | IMAP IDLE místo poll |
| Memory (in-memory queue) | OOM | Persist queue do DB místo paměti |
| Template rendering | CPU spike | Cache rendered templates |
| Analytics queries | Slow dashboard | Materialized views, pre-aggregation |

### 21.3 DB optimization

- Indexy na: `send_events(campaign_id, status)`, `replies(handled, campaign_id)`, `companies(email_status, score)`, `suppression(email)`
- Partitioning: `send_events` by `sent_at` (monthly partitions při >10M rows)
- Archivace: `send_events` starší 1 rok → archive tabulka
- Connection pool: max 20 connections per Go instance (pgbouncer optional)

### 21.4 Worker architecture (budoucí)

```
Pilot:   1 Go instance → sender + all workers in-process
Growth:  1 Go instance + dedicated sender worker
Scale:   Go instance + N sender workers (horizontal scale)
```

---

## 22. Template & content strategy

### 22.1 Template quality score

Automatická kontrola před uložením šablony:

| Check | Pass | Warn | Fail |
|---|---|---|---|
| Spam slova | 0 | 1–2 | 3+ |
| Počet odkazů | 0–2 | 3–4 | 5+ |
| Délka těla | 100–400 slov | 50–100 nebo 400–600 | <50 nebo >600 |
| Personalizace | 3+ proměnné | 1–2 | 0 |
| Spin body | 5+ | 3–4 | <3 |
| Subject lines | 3+ | 2 | 1 |
| Phishing patterns | 0 | — | 1+ → block |

### 22.2 Template library per vertikála

Každá vertikála dodává:
- `initial.tmpl` — první oslovení
- `followup1.tmpl` — první follow-up (po 3–5 dnech)
- `final.tmpl` — poslední pokus (po 7–10 dnech)

Pravidla pro dobrou šablonu:
- Kratší = lepší (B2B, ne newsletter)
- Konkrétní hodnota pro příjemce v prvním odstavci
- Jediná jasná výzva k akci
- Žádné přílohy, žádné formuláře
- Podpis s jménem + telefonem (vypadá lidsky)

### 22.3 Preview s reálnými daty

Před uložením šablony: operátor může zadat testovací firmu a vidí jak email vypadá s reálnými proměnnými (firma, jméno, region, podpis).

### 22.4 Template versioning

- Každá úprava šablony vytvoří novou verzi
- Běžící kampaně pokračují se starší verzí (snapshot při spuštění)
- Operátor může explicitně upgradovat běžící kampaň na novou verzi

---

## 23. Intelligence & adaptive learning

### 23.1 Best time to send

Data z `send_events`:
- Per cílová doména: kdy jsou nejvyšší open rates (hodina, den v týdnu)
- Per region: Praha firmy vs. moravské firmy — různé vzorce?
- Výstup: doporučená sending window per segment (zobrazeno v Campaign wizard)

### 23.2 Template performance ranking

Automaticky po každé kampani:
- Reply rate per šablona + subject line kombinace
- Open rate per subject line
- Výstup: ranking šablon v template pickeru (nejlepší nahoře)

### 23.3 ICP model refinement

- Které ICP faktory korelují s positive reply → zvýšit váhu
- Které faktory jsou irrelevantní → snížit váhu
- Výstup: automatický reweight `icp_weights.json` (s potvrzením operátora)

### 23.4 Domain reputation scoring

Per cílová doména (ne mailbox doména):
- Bounce rate, open rate, reply rate
- Domény s bounce rate > 20% → flagovat jako "risky domain"
- Výstup: segment quality report ukazuje risky domény v segmentu

### 23.5 Churn prediction

Kontakty bez otevření po 3 emailech → automaticky stop (neplýtvat kapacitou).
Zobrazeno jako: "X kontaktů vyřazeno pro nízký engagement" v campaign detail.

### 23.6 Optimal sequence length

Analýza: na kterém emailu (step 1/2/3) přichází nejvíce odpovědí per vertikála.
Výstup: doporučení délky sequence při vytváření kampaně.

---

## 24. Thread model & přílohy — architektura

### 24.1 Thread model

Jedno vlákno = jeden kontakt v jedné kampani. Thread grupuje všechny interakce (auto-sends, replies, manual replies) pro daný `(campaign_id, contact_id)` pár, seřazené chronologicky.

```
thread_key = (campaign_id, contact_id)

Thread: jan.novak@firma.cz × Excavator Q1
  [auto]   Step 1 odesláno  15.4 10:23  send_event_id=1001
  [auto]   Step 2 odesláno  19.4 09:15  send_event_id=1002
  [in]     Reply přijata    19.4 14:32  reply_id=55   "Máte nabídku na Volvo EC300?"
  [out]    Manual reply     19.4 15:01  send_event_id=1003  typ=manual_reply
  [in]     Reply přijata    20.4 09:44  reply_id=56   "Kdy byste mohli přijet?"
```

### 24.2 DB rozšíření

**Migration 046 — attachments:**
```sql
CREATE TABLE attachments (
    id            BIGSERIAL PRIMARY KEY,
    message_type  TEXT NOT NULL CHECK (message_type IN ('reply', 'manual_reply')),
    message_id    BIGINT NOT NULL,
    filename      TEXT NOT NULL,
    content_type  TEXT NOT NULL,
    size_bytes    INT NOT NULL,
    data          BYTEA NOT NULL,
    created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX idx_attachments_message ON attachments (message_type, message_id);
```

Limity (hard-coded):
- Max 10 MB per příloha
- Max 3 přílohy per zpráva
- Kampaňové emaily: přílohy blokované v template engine (validace při uložení i renderování)

**send_events — nový typ:**
```sql
ALTER TABLE send_events
  ADD COLUMN message_type TEXT NOT NULL DEFAULT 'campaign'
  CHECK (message_type IN ('campaign', 'manual_reply'));
```

`manual_reply` = zpráva odeslaná operátorem ručně (reply na příchozí). Participuje v threading (In-Reply-To), ale nepodléhá rate limitům, warmup, ani anti-trace delay.

### 24.3 IMAP MIME parsing

Při fetch reply z IMAP:
1. Parsovat MIME strukturu (Go: `mime/multipart`, `net/mail`)
2. Text/plain nebo text/html část → `replies.body`
3. Ostatní části (content-disposition: attachment) → uložit do `attachments`
4. Inline obrázky (content-disposition: inline, content-id) → uložit jako attachment s flagím `inline=true`

```go
type ParsedReply struct {
    Body        string
    HTMLBody    string
    Attachments []ParsedAttachment
}

type ParsedAttachment struct {
    Filename    string
    ContentType string
    Inline      bool
    Data        []byte
}
```

### 24.4 Reply flow — Go endpoint

`POST /api/threads/:id/reply` přijme:
```json
{
  "body": "Dobrý den, posílám katalog...",
  "attachments": [
    { "filename": "katalog.pdf", "content_type": "application/pdf", "data": "<base64>" }
  ]
}
```

Go handler:
1. Načte thread (campaign_id + contact_id + mailbox_id z posledního send_event)
2. Načte původní reply (pro In-Reply-To + References headers)
3. Sestaví MIME multipart email (text + přílohy)
4. Aplikuje anti-trace sanitization (stejné jako kampaňové emaily)
5. Odešle přes SMTP ze stejné schránky
6. Uloží send_event s `message_type=manual_reply`
7. Uloží přílohy do `attachments`

**Threading headers:**
```
In-Reply-To: <original-message-id@domain>
References: <first-message-id@domain> <previous-message-id@domain>
Message-ID: <new-random@mailbox-domain>
```

### 24.5 Kampaňové přílohy — blokace

Template engine odmítne šablonu pokud body nebo subject obsahují MIME attachment indikátory. Validace v:
- `POST /api/templates` (uložení)
- `content.Render()` (renderování před odesláním)
- Campaign wizard UI (upozornění při editaci)

Error: `"Přílohy v kampaních nejsou povoleny — snižují deliverability. Místo přílohy použijte odkaz."`

### 24.6 React — ThreadView komponenta

```
ThreadView
  ├── ThreadHeader (firma, kampaň, stav, akce: lead, blacklist)
  ├── MessageList (chronologický scroll)
  │   ├── MessageBubble [auto-send] (šedá, vlevo)
  │   ├── MessageBubble [reply-in] (zelená, vlevo + přílohy)
  │   └── MessageBubble [manual-out] (modrá, vpravo + přílohy)
  └── ReplyCompose
      ├── Textarea
      ├── FileDropzone (max 3 soubory, max 10 MB each)
      └── SendButton
```

Přílohy v MessageBubble:
- Obrázky (image/*): inline preview, klik = fullscreen
- PDF, ostatní: ikona + název + velikost + download tlačítko

---

## Appendix A — Technologický stack

| Vrstva | Technologie |
|---|---|
| Backend | Go 1.25 |
| Frontend | React 19, Vite 6, React Router 7, Zustand 5 |
| BFF | Express 5 (Node.js) |
| Databáze | PostgreSQL 16 |
| Hosting | Railway |
| Testy (Go) | `go test`, `testify`, `sqlmock`, `httptest` |
| Testy (React) | Vitest, Testing Library, MSW |
| E2E | Playwright |
| CI/CD | GitHub Actions |
| Monitoring | Railway Logs + custom health endpoints |
| Anti-trace relay | Go nebo nginx |

## Appendix B — Repozitář struktura

```
hozan-taher/
├── apps/
│   └── outreach-dashboard/    # React SPA + Express BFF
│       ├── src/               # React app
│       ├── test/              # unit + contract + e2e
│       └── server.js          # Express BFF
├── modules/
│   └── outreach/              # Go backend
│       ├── cmd/outreach/      # Entry point
│       ├── internal/          # 37 packages
│       │   ├── sender/
│       │   ├── campaign/
│       │   ├── content/
│       │   └── ...
│       ├── configs/
│       │   └── templates/     # Email šablony per vertikála
│       └── internal/db/migrations/
├── docs/
│   └── development-plan.md   # Tento dokument
└── CLAUDE.md
```

---

*Dokument generován: 2026-04-20. Aktualizovat při každé větší architektonické změně.*
