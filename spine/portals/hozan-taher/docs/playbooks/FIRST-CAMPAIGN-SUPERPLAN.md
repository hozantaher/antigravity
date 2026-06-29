# First Campaign — Superplán

> Jediný referenční dokument. Zahrnuje cíl, flow, segment, testovací
> architekturu, 19 TDD sprintů s realistickými počty testů a go-live runbook.

---

## 1. Cíl

Spustit první ostrou B2B outreach kampaň od nuly do leadu:

```
ARES data → segment → verifikace → dedup → kampaň → scheduler
  → humanized mail → tracking → reply loop → lead → obchoďák
```

Měřitelný výsledek: **≥ 3 % reply rate** z 150–200 odeslání na firmy
zemních prací (NACE 43.11 + 43.12). Každý „interested" reply viditelný
v dashboardu do 15 minut od přijetí.

---

## 2. Cílový segment

**CZ-NACE 43.11 + 43.12 — Demolice a zemní práce**

| Filtr | Hodnota |
|---|---|
| category | 43.11, 43.12 |
| email.status | valid (po A2+A5) |
| hasWebsite | true |
| region | CZ |
| lastContactedNever | true |
| cap vlna 1 | 300 firem → ~150–200 odeslatelných |

**Proč:** každá taková firma provozuje rýpadla/nakladače — ne „možná", ale
„jistě". Malé firmy = jeden rozhodovatel. Cyklický nákup techniky 2–5 let.

**Záložní segmenty (vlna 2+):** NACE 08 kamenolomy, 02.40 lesnictví, 38.11 odpady.

---

## 3. Co existuje (po merge wm/new-features)

Kompletní backend:

| Vrstva | Stav |
|---|---|
| Segmenty + NACE kategorie | ✓ `internal/segment/`, `internal/classify/nace_map.go` |
| Kampaň sequence + cadence | ✓ `internal/campaign/runner.go` |
| MX/SMTP verifikace pipeline | ✓ `internal/validation/verifier.go` |
| Mailbox pool + warmup + rotace | ✓ `internal/mailbox/`, `internal/warmup/` |
| SOCKS5/HTTP proxy per mailbox | ✓ migrace 039 |
| Circuit breaker + auth-fail | ✓ migrace 038–040 |
| Tracking pixel + click redirect | ✓ `/o`, `/c` |
| Spintax + persona + humanize | ✓ `internal/content/spin.go`, `internal/humanize/` |
| IMAP poller + reply classifier | ✓ `internal/imap/`, `internal/thread/` |
| Bounce processor + suppression | ✓ `internal/bounce/`, migrace 037 |
| DNS/DMARC L3 probe (S4) | ✓ `internal/protections/probe/probes_l3_dns.go` |
| Per-send protection_trace (S6) | ✓ migrace 042, `internal/sender/trace.go` |
| Alert routing + eskalace (S7) | ✓ migrace 043, `internal/protections/alert/` |
| Observability (S8) | ✓ `internal/protections/probe/metrics_sink.go` |

Chybí: scheduler daemon, UI flows, dedup, šablony, leads tabulka.

---

## 4. Flow krok za krokem

```
1.  Operator otevře /firmy
2.  Nastaví filtr: category=43.11+43.12, email=valid, hasWebsite=true
3.  Klikne „Uložit jako segment" → SaveSegmentModal → POST /api/segments
4.  Dashboard zobrazí dedup preview:
      "12 kontaktů bude přeskočeno (sdílená schránka / doménový flood)"
5.  Operator otevře /segmenty → klikne „Ověřit e-maily"
      → batch SMTP probe přes SOCKS5 → report valid/risky/invalid
      → „Vytvořit čistý subsegment" → nový segment jen s valid
6.  Operator otevře /kampane/nova → 4-stepper:
      (1) segment  (2) sekvence kroků  (3) send window  (4) start
      dry-run preview → confirm
7.  Kampaň status → running
8.  Scheduler daemon tick 60s → RunCampaign() per running kampaň
      → Postgres advisory lock → jeden winner
      → DedupGate → EmailStatusGate → UnsubscribeCheck
      → spintax render → LLM opener (opt-in) → humanize
      → smtp.Send() přes mailbox pool přes SOCKS5
      → protection_trace zapsán
9.  IMAP poller → matchuje reply přes In-Reply-To
      → classifier: interested / not_interested / meeting / opt_out
      → opt_out → suppression, žádná auto-reply
      → interested → leads tabulka + webhook
10. Operator otevře /inbox → filtr interested+meeting
      → vidí vlákno → odpovídá manuálně ze stejné persony
```

---

## 5. Email „jako člověk"

### Struktura
- plain-text first, HTML minimální (žádné tabulky, žádný hero)
- max 700 znaků těla
- 1 link (landing page), žádný v podpisu
- **mail 1 bez tracking pixelu** — pixel = bot signal pro filtry
- pixel zapnout od follow-upu 1

### Jazyk
- česky, krátké věty, přirozený tón
- šablona (kostra) + LLM opener (1–2 věta personalizace) + spintax variace
- zakázaná slova: REVOLUČNÍ, ULTIMÁTNÍ, NEUVĚŘITELNÝ
- zakázané otvory: „Dobrý den, doufám, že se máte skvěle"
- deterministický seed: `sha256(contact_id + campaign_id + step_idx)`
  → stejný kontakt vždy dostane stejný mail (reodesílání = bezpečné)

### Persona
- adresa `jmeno.prijmeni@dealer-domain.cz` (ne `sales@`, ne `info@`)
- podpis: jméno + telefon + firma, bez odkazu
- 1 persona = 1–3 mailboxy (fingerprint isolation)
- humanize ON: cirkadián jitter ±90 min, tón variace, přirozené imperfekce

### Technické požadavky
- SPF + DKIM + DMARC (≥ quarantine) na všech odesílacích doménách
- quoted-printable encoding pro českou diakritiku (RFC 2047)
- Reply-To == From vždy
- `List-Unsubscribe` header + `{{unsubscribe_link}}` v každém mailu

---

## 6. Verifikace a deduplication

### Verifikace pipeline (existuje, musí být povinná gate)
1. Syntax regex + unicode normalizace
2. MX lookup (doména + MX záznam existuje)
3. Domain cache 7 dní
4. SMTP RCPT TO probe **přes SOCKS5** (≤ 20 domén/min/IP)
5. Catch-all detekce (náhodná local part → 250 = catch_all)
6. Role detekce (info@, sales@, office@ → role_only)
7. Disposable + spamtrap listy

**Gate:** `status = valid` only. Ostatní → skip + protection_trace.

### Deduplication (A5 — nové)
| Vrstva | Mechanismus | Limit |
|---|---|---|
| Identická adresa | `UNIQUE (campaign_id, email_hash)` | 1 mail per adresa |
| Doménový flood | DomainCap per-kampaň | default 3/doména |
| Holding cluster | `parent_ico` klastry | 1/klastru |

Každý skip → `protection_trace(gate="dedup", value=reason)`.

---

## 7. TDD architektura

### Vrstvy testů

```
┌─────────────────────────────────────────────────────┐
│ E2E (Playwright)          ~200 scénářů               │
│ Kritické user flows, reálný server + DB              │
├─────────────────────────────────────────────────────┤
│ BFF Contract (Vitest, real Express)   ~500 cases     │
│ Každý endpoint: happy path, error codes, validation  │
├─────────────────────────────────────────────────────┤
│ React (Vitest + RTL + userEvent)     ~10 000 cases   │
│ Každý stav komponenty × každá interakce              │
├─────────────────────────────────────────────────────┤
│ Go Integration (testcontainers, real PG) ~5 000 cases│
│ Store layer, migrations, SQL constraints             │
├─────────────────────────────────────────────────────┤
│ Go Unit (mock interfaces)           ~20 000 cases    │
│ Business logic, table-driven, property-based         │
└─────────────────────────────────────────────────────┘
```

### Pravidla

- **Go unit:** mock interface (ne real DB). `testify/assert`. Table-driven default.
  Každý error path = vlastní case. Každý boundary = vlastní case.
- **Go integration:** `testcontainers-go` PostgreSQL. Spouštět paralelně (`t.Parallel()`).
  Čistit state per-test (`TRUNCATE ... CASCADE` v `t.Cleanup()`).
- **Property-based:** `testing/quick` nebo `pgregory.net/rapid` pro invarianty
  (dedup, spintax seed, scheduler lock). 1000+ runs per property.
- **React:** `@testing-library/react` + `userEvent`. Žádné snapshot testy —
  pouze behaviour. MSW pro fetch mock. Accessibility asertace (`aria-*`).
- **BFF contract:** MSW off, real Express, real Go server (nebo recorded fixtures).
- **E2E:** Playwright. Každý kritický flow end-to-end. Seed DB před testem.

### Coverage targets
| Vrstva | Min coverage |
|---|---|
| Go business logic | 90 % |
| Go store layer | 85 % |
| Go HTTP handlers | 80 % |
| React components | 80 % |
| React hooks | 90 % |

### CI gate
```
pnpm test              # Vitest unit + BFF
go test ./... -race    # Go unit + integration (-race = datové závody)
pnpm playwright test   # E2E (staging env)
go test -fuzz ./...    # Fuzz targets (5 min budget v CI)
```

---

## 8. Sprints — DAG

```
EPIC A (A1→A2→A3→A4→A5)    blokuje vše
  ├── EPIC B (B1→B2→B3)     paralelně s A3+
  ├── EPIC C (C1→C2→C3)     po A1 + B
  ├── EPIC D (D1→D2)        paralelně s B/C
  └── EPIC E (E1→E2→E3)     po C1
        └── EPIC F (F1→F2→F3)   vše hotové
```

---

## 9. Sprint breakdown s realistickými počty testů

> **Jak číst čísla:** `Go unit` = table-driven sub-cases + property runs.
> `React` = assertions (stav × interakce × chybové stavy).
> `Integration` = real-DB cases přes testcontainers.

---

### EPIC A — Foundations

#### A1 — Campaign scheduler daemon

**Soubory:** `internal/campaign/scheduler.go`, `internal/campaign/scheduler_test.go`,
`cmd/outreach/main.go`

**Testovací pokrytí:**

| Skupina | Příklady | Cases |
|---|---|---|
| Advisory lock — happy path | dva goroutiny, jen jeden winner | 20 |
| Advisory lock — error paths | timeout, DB down, lock nevydán | 15 |
| Campaign status filter | running/paused/draft/completed × tick | 25 |
| Concurrent instances | 2, 5, 10 instancí → 0 double-runs | 15 |
| Context cancellation | cancel mid-tick, cancel between ticks | 10 |
| Metrics emission | counter increment, gauge hodnoty | 12 |
| Error recovery | RunCampaign error → nezastaví scheduler | 20 |
| Tick interval | 30s, 60s, 120s konfigurace | 8 |
| Integration (real PG) | advisory lock přes skutečné Postgres | 15 |
| Property: no double-run | quick.Check N instances → 0 duplicates | 500 |
| **Σ A1** | | **~640** |

---

#### A2 — Pre-send verification gate

**Soubory:** `internal/sender/engine.go`, `internal/sender/gate.go`,
`internal/sender/engine_test.go`

| Skupina | Cases |
|---|---|
| Status table (7 stavů × skip/proceed) | 50 |
| Boundary: prázdný email, nil, unicode | 20 |
| protection_trace zápis per status | 30 |
| ErrGated vs infra error rozlišení | 15 |
| Concurrent sends různé statusy | 20 |
| Gate + bouncehold kombinace | 20 |
| Property: valid vždy proceeds | 300 |
| Property: non-valid nikdy smtp.Dial | 300 |
| Integration: gate + real DB state | 25 |
| **Σ A2** | **~780** |

---

#### A3 — Unsubscribe footer enforce

**Soubory:** `internal/content/template.go`, `templates/*.tmpl`

| Skupina | Cases |
|---|---|
| Token přítomen (HTML) | 15 |
| Token přítomen (plain-text) | 15 |
| Token chybí (HTML) — error | 15 |
| Token chybí (plain-text) — error | 15 |
| Token v komentáři — nesmí počítat | 10 |
| Všechny existující šablony | N (počet šablon) × 2 varianty | 30 |
| Render s tokenem → URL expanzí | 20 |
| Různé URL formáty tokenu | 15 |
| Property: render nikdy neobsahuje raw token | 200 |
| **Σ A3** | **~335** |

---

#### A4 — DNS/DMARC preflight audit

**Soubory:** `internal/protections/probe/audit.go`,
`internal/web/mailboxes.go`, `src/components/DnsAuditPanel.jsx`

| Skupina | Cases |
|---|---|
| SPF pass/fail/missing | 30 |
| DKIM pass/fail/missing | 30 |
| DMARC none/quarantine/reject | 30 |
| Kombinace SPF×DKIM×DMARC | 27 (3³) |
| Auto-pause při SPF fail | 15 |
| Cache 1h — no repeat DNS | 20 |
| React: pill stavy (zelená/žlutá/červená) | 40 |
| React: trigger audit → loading → result | 30 |
| BFF endpoint: 200/404/500 | 15 |
| Integration: real DNS mock server | 20 |
| Property: audit result idempotent | 200 |
| **Σ A4** | **~457** |

---

#### A5 — Email deduplication gate

**Soubory:** `internal/campaign/dedup.go`, `internal/campaign/dedup_test.go`,
migrace `045_campaign_enrollments_email_hash.sql`

| Skupina | Cases |
|---|---|
| Identická adresa: 1–1000 kontaktů | 80 |
| DomainCap: cap 1/2/3/5/10 × 1–50 kontaktů | 150 |
| DomainCap default vs. override | 20 |
| Holding cluster: hloubka 1/2/3 | 40 |
| Holding: cyklická reference (edge case) | 10 |
| Smíšené scénáře (email + doména + holding) | 60 |
| Audit log per skip reason | 50 |
| UNIQUE constraint v DB (integration) | 20 |
| Performance: 10k, 100k kontaktů | 10 |
| React: dedup warning v SaveSegmentModal | 50 |
| BFF: dedup-preview endpoint | 20 |
| Property: invariant enrolled ≤ total | 500 |
| Property: skip + enrolled == total | 500 |
| Property: DomainCap nikdy překročen | 500 |
| **Σ A5** | **~2 010** |

---

### EPIC B — Segment UI

#### B1 — `/api/segments` CRUD

| Skupina | Cases |
|---|---|
| Go store: Create (valid, duplicate name, empty name) | 30 |
| Go store: Get (found, not found, wrong owner) | 20 |
| Go store: List (empty, 1, many, pagination) | 30 |
| Go store: Delete (OK, not found, has campaigns → error) | 25 |
| Go store: memberCount accuracy | 20 |
| Filter validation (unknown keys, type mismatch) | 40 |
| BFF: POST/GET/DELETE happy paths | 30 |
| BFF: všechny error kódy (400/404/409/500) | 40 |
| BFF: payload size limits | 15 |
| Integration: filter → SQL query correct | 25 |
| Property: create+get+delete = no leak | 200 |
| **Σ B1** | **~475** |

---

#### B2 — „Uložit jako segment"

| Skupina | Cases |
|---|---|
| Button disabled (0 aktivních filtrů) | 20 |
| Button enabled (≥ 1 aktivní filtr) | 20 |
| Validace názvu: délka 1–60, hranice | 30 |
| Validace: speciální znaky, unicode, emoji | 20 |
| 409 duplicate → inline error | 15 |
| 500 server error → toast error | 15 |
| 201 success → toast + redirect link | 20 |
| Dedup warning z response → zobrazení | 25 |
| Loading state (submit disabled) | 15 |
| Modal: otevřít/zavřít/keyboard (Escape) | 25 |
| Accessibility: role, aria-labels | 30 |
| **Σ B2** | **~235** |

---

#### B3 — `/segmenty`

| Skupina | Cases |
|---|---|
| Empty state | 15 |
| Karta: název, počet, datum | 20 |
| Karta: dedup badge (když > 0 skip) | 20 |
| „Otevřít v Firmách" → sessionStorage | 25 |
| „Vytvořit kampaň" → navigate | 10 |
| Smazání: confirm modal → optimistic UI | 30 |
| Smazání: chyba → rollback | 20 |
| Smazání: segment má aktivní kampaň → disabled | 20 |
| Sorting, search v listu | 30 |
| Pagination | 25 |
| Accessibility | 30 |
| Property: optimistic remove + error = původní stav | 200 |
| **Σ B3** | **~445** |

---

### EPIC C — Campaign UI

#### C1 — `/kampane` list

| Skupina | Cases |
|---|---|
| Badge per status (4 stavy) | 30 |
| Progress bar accuracy | 25 |
| Pause/resume endpoint calls | 25 |
| Polling 15s (fake timers) | 20 |
| Empty state | 10 |
| Karta: sparkline sent/hod | 25 |
| Error state (fetch fail) | 15 |
| BFF: GET, pause, resume | 30 |
| Accessibility | 25 |
| **Σ C1** | **~205** |

---

#### C2 — `/kampane/nova` formulář

| Skupina | Cases |
|---|---|
| Stepper: navigace forward/back | 30 |
| Step 1: segment required, dropdown | 25 |
| Step 2: max 5 kroků enforce | 20 |
| Step 2: delay < 0 → error | 20 |
| Step 2: template required | 15 |
| Step 3: send window validace | 35 |
| Step 3: timezone CZ default | 10 |
| Step 4: start now vs. scheduled | 25 |
| Dry-run preview render | 30 |
| Submit → POST /api/campaigns | 25 |
| Submit error handling | 20 |
| Go: DryRun_NoSMTPCalls | 30 |
| Go: DryRun_SpintaxDeterminism | 50 |
| Go: DryRun_CalendarCapacity | 40 |
| BFF: POST /api/campaigns validace | 30 |
| E2E: celý flow create → dry-run → confirm | — |
| Accessibility | 30 |
| **Σ C2** | **~435** |

---

#### C3 — Detail kampaně

| Skupina | Cases |
|---|---|
| Progress per-step (0/partial/full) | 40 |
| Sparkline sent/hod | 20 |
| protection_trace tabulka (20 řádků) | 25 |
| Stop: confirm modal → POST | 25 |
| Stop: cancel → žádný POST | 15 |
| Pause/resume z detailu | 20 |
| Dry-run TAB: mail preview | 30 |
| Dry-run TAB: kalendář heatmap | 25 |
| Refresh polling 30s | 15 |
| Accessibility | 25 |
| **Σ C3** | **~240** |

---

### EPIC D — Content Library

#### D1 — 3 šablony + spintax

| Skupina | Cases |
|---|---|
| Unsubscribe token (HTML + plain-text, každá šablona) | 20 |
| Body délka ≤ 700 znaků | 20 |
| Žádný dangling `{{` po renderu | 20 |
| Tracking pixel nepřítomen v heavy-01 | 10 |
| Spintax: seed determinism (1000 kontaktů × 3 šablony) | 3 000 |
| Spintax: variance (různé seedy → různý výstup) | 200 |
| Spintax: nested `{A|{B|C}|D}` | 50 |
| Spintax: unicode bezpečnost | 30 |
| Render s prázdnými proměnnými | 40 |
| Subject variace: 3 varianty rotují | 30 |
| Property: render idempotent (stejný seed) | 1 000 |
| Property: výstup nikdy neobsahuje raw token | 500 |
| **Σ D1** | **~4 920** |

---

#### D2 — LLM variace úvodu

| Skupina | Cases |
|---|---|
| use_llm_opener=false → no API call | 20 |
| Timeout → fallback spintax | 20 |
| HTTP 500 → fallback | 20 |
| HTTP 429 (rate limit) → fallback + backoff | 15 |
| Seed determinism (temperature=0) | 50 |
| Opener vložen na začátek (ne uprostřed) | 20 |
| Délka openeru ≤ 2 věty | 20 |
| Prometheus counters (generated/fallback) | 15 |
| Singleflight: duplicitní seed v 1s → 1 API call | 10 |
| Property: fallback nikdy nevyhodí panic | 300 |
| Property: seed → idempotent output | 500 |
| **Σ D2** | **~990** |

---

### EPIC E — Reply loop

#### E1 — Leads tabulka

| Skupina | Cases |
|---|---|
| Create: all fields | 20 |
| Idempotence: 2. interested = UPDATE | 20 |
| Idempotence: 3., 4., 10. interested | 15 |
| not_interested → nikdy lead | 20 |
| opt_out → suppression, nikdy lead | 20 |
| Webhook: success | 15 |
| Webhook: retry 3× (HTTP 500, 500, 200) | 20 |
| Webhook: retry exhaust → log, no panic | 15 |
| Webhook: LEAD_WEBHOOK_URL empty → skip | 10 |
| Webhook: timeout | 10 |
| Integration: real DB insert + unique | 30 |
| Integration: inbound → interested → lead | 25 |
| Property: idempotent insert | 300 |
| Property: not_interested never creates lead | 300 |
| **Σ E1** | **~820** |

---

#### E2 — `/inbox`

| Skupina | Cases |
|---|---|
| Default filtr interested+meeting | 20 |
| Filtr změna → refetch s params | 25 |
| Unread count v nav | 20 |
| Per-vlákno: firma, persona, preview | 25 |
| Unread indicator | 15 |
| Empty state per filtr | 20 |
| Pagination | 25 |
| Error state | 15 |
| BFF: GET /threads s params | 30 |
| BFF: GET /threads/unread-count | 20 |
| Accessibility | 25 |
| **Σ E2** | **~240** |

---

#### E3 — Thread detail + manuální reply

| Skupina | Cases |
|---|---|
| Renderuje všechny zprávy (odeslané + příchozí) | 25 |
| Attachment preview: image/pdf → náhled | 20 |
| Attachment: text/csv → žádný náhled | 15 |
| Manual reply: textarea → submit | 25 |
| Manual reply: prázdný text → disabled | 10 |
| Manual reply: POST correct endpoint | 20 |
| Manual reply: kind='manual' v response | 20 |
| Go: manual reply uses original mailbox | 30 |
| Go: kind=manual → bypass campaign quota | 25 |
| Go: kind=manual zapsán do send_events | 20 |
| Accessibility | 25 |
| E2E: reply flow end-to-end | — |
| **Σ E3** | **~235** |

---

### EPIC F — Pre-flight + Go-live

#### F1 — Batch segment verifikace

| Skupina | Cases |
|---|---|
| Rate limit ≤ 20 domén/min enforce | 30 |
| SOCKS5: probe nikdy z přímé IP | 20 |
| Result per contact (valid/risky/catch_all/invalid) | 40 |
| Domain cache hit → no SMTP probe | 25 |
| Batch size: 1, 10, 100, 1000, 10000 kontaktů | 25 |
| Create clean subsegment z výsledků | 25 |
| Progress emitter (SSE stream) | 20 |
| UI: modal progress + report | 40 |
| Error recovery (mid-batch network fail) | 20 |
| Property: rate limit nikdy překročen | 500 |
| Property: probe vždy přes proxy | 300 |
| **Σ F1** | **~1 045** |

---

#### F2 — Dry-run (preview UI)

| Skupina | Cases |
|---|---|
| Žádné SMTP volání | 20 |
| Render všech N kontaktů | 25 |
| Spintax variance ≥ 2 unikátní subjects / 50 mailů | 20 |
| Kalendář: žádný mailbox nepřekročí denní cap | 30 |
| Kalendář: send window respektován | 25 |
| UI: mail preview stránkování | 25 |
| UI: kalendář heatmap render | 25 |
| Property: dry-run idempotent | 300 |
| Property: calendar cap invariant | 500 |
| **Σ F2** | **~970** |

---

#### F3 — Preflight + go-live

| Skupina | Cases |
|---|---|
| SPF/DKIM/DMARC check (všechny mailboxy) | 30 |
| Scheduler health check | 15 |
| Segment: 0 unverified kontaktů | 20 |
| Segment: 0 non-deduped kontaktů | 20 |
| Žádná running kampaň nad stejným segmentem | 20 |
| PreflightIssue serialization | 15 |
| UI: start button disabled + issue list | 30 |
| UI: preflight pass → button enabled | 15 |
| Property: preflight extensible (N checks) | 200 |
| **Σ F3** | **~365** |

---

## 10. Celkový počet testů

| Kategorie | Počet |
|---|---|
| Go unit + property | ~22 000 |
| Go integration (testcontainers) | ~3 000 |
| React (RTL + assertions) | ~10 000 |
| BFF contract (real Express) | ~500 |
| Playwright E2E scénáře | ~200 |
| **CELKEM** | **~35 700** |

> Reálně po dokončení implementace + refactor cycles: **40 000–50 000** assertions.
> Property-based tests generují stovky runs per invariant — to jsou největší čísla.

---

## 11. Pasti

| Past | Dopad | Mitigace |
|---|---|---|
| Holding/pobočky — stejná schránka | 50 mailů jedné osobě | A5 dedup: UNIQUE email_hash + DomainCap + HoldingCap |
| Doménový flood | doména zablokuje | A5 DomainCap default 3, konfig per-kampaň |
| SMTP probe z provozní IP | „scanning" → blacklist | SOCKS5 pool, rate ≤20/min |
| Nový mailbox 300/den od D1 | Google/O365 blok | warmup rampa +10/den |
| SPF/DKIM/DMARC chybí | 40 % do spamu | A4 DNS audit + auto-pause |
| Scheduler race — double-send | kontakt 2× | advisory lock + UNIQUE enrollment |
| Česká diakritika v Subject | encoding `???` | quoted-printable RFC 2047 |
| Tracking pixel v 1. mailu | bot signal → spam | pixel off na heavy-01 |
| Auto-reply na opt-out | confirms live inbox → spam | žádná auto-reply, jen suppression |
| LLM halucinace v openeru | zmínka neexistujícího projektu | max 2 věty + fallback spintax |
| send_events race (manual vs. campaign) | quota overflow | kind=manual bypasses quota |
| Suppression race | opt-out po enroll | re-check suppression těsně před smtp.Data() |

---

## 12. Timeline

| Týden | EPIC | Výstup |
|---|---|---|
| 1 | A1–A5 | Foundations: scheduler, gate, dedup, DNS audit |
| 2 | B1–B3 + D1 | Segment UI + šablony |
| 3 | C1–C3 + D2 | Campaign UI + LLM opener |
| 4 | E1–E3 | Reply loop + leads |
| 5 | F1–F3 | Pre-flight + ostrý start 30 kontaktů |

> S paralelizací B/C/D: realně **3–4 týdny** do prvního ostrého odeslání.

---

## 13. Go-live runbook (F3)

```
Pre-start (den D, 09:00):
  [ ] A4 DNS audit zelený na všech mailboxech
  [ ] Scheduler health endpoint → "running"
  [ ] Segment F1 ověřen — 0 unverified
  [ ] F3 preflight → 0 critical issues
  [ ] mail-tester.com ≥ 9/10 na heavy-01 + heavy-02

Start (D, 09:30):
  [ ] Vytvořit kampaň: 30 kontaktů, 6 mailboxů × 5/den
  [ ] Status → running
  [ ] protection_trace monitoring otevřít

T+4h:
  [ ] bounce rate < 2 %  → pokračovat
  [ ] bounce rate 2–5 %  → pauza, zkontrolovat DNS + dedup
  [ ] bounce rate > 5 %  → abort, vyšetřit

T+24h:
  [ ] interested count → předat obchoďákovi
  [ ] reply rate cíl ≥ 3 %
  [ ] Open rate (N/A pro mail 1 bez pixelu)

Pokud OK: pustit zbytek segmentu (5 dní, ~30/den)
Follow-up 1 scheduler: automaticky +4 dny
Follow-up 2 scheduler: automaticky +8 dní

Abort podmínky (kdykoli):
  [ ] mailbox v bounce_hold > 3× za den → pause all
  [ ] protection alert S7 → vyšetřit
  [ ] spam complaint → immediate stop + šablona revize
```

---

*Tento dokument je master reference. Detailní sprint soubory:*
- *[FIRST-CAMPAIGN-SPRINTS.md](FIRST-CAMPAIGN-SPRINTS.md) — RED/GREEN/REFACTOR per sprint*
- *[FIRST-CAMPAIGN-PLAN.md](FIRST-CAMPAIGN-PLAN.md) — business context*
