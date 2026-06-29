# First Campaign — TDD Sprints

> **Metodika:** každý sprint = RED → GREEN → REFACTOR → commit.
> Commit projde až `pnpm test` + `go test ./...` zelené.
> EPIC lze paralelizovat; sekvence uvnitř EPIC povinná.

## DAG závislostí

```
EPIC A (A1→A2→A3→A4→A5)   blokuje vše
  ├── EPIC B (B1→B2→B3)   paralelně s A2+
  ├── EPIC C (C1→C2→C3)   po A1 + B hotové
  ├── EPIC D (D1→D2)      paralelně s B/C
  └── EPIC E (E1→E2→E3)   po C1
        └── EPIC F (F1→F2→F3)   vše hotové
```

---

## EPIC A — Foundations

### A1 — Campaign scheduler daemon

**Cíl:** Runner je dnes CLI-only. Přidat goroutine v main daemon — každých 60s
projde `campaigns WHERE status='running'`, každou uzamkne Postgres advisory lockem
a spustí `RunCampaign()`. Dvě instance démona = stejný kontakt dostane mail 1×.

**🔴 RED**

`modules/outreach/internal/campaign/scheduler_test.go` (nový):

```go
// TestScheduler_AdvisoryLock_OnlyOneInstanceRuns
// Spustit dvě goroutiny scheduler.Tick() nad sdílenou mockDB.
// Ověřit: pg_try_advisory_lock volán, jen jeden "winner" zavolá RunCampaign().

// TestScheduler_PausedCampaign_Skipped
// Kampaň se status='paused' — RunCampaign NESMÍ být volán.

// TestScheduler_ErrorOnLock_LogsAndContinues
// pg_try_advisory_lock vrátí error — scheduler nepanic, pokračuje v dalším ticku.

// TestScheduler_Tick_EmitsPrometheusMetrics
// Po každém ticku: counter "scheduler_tick_total" inkrementován.
```

**🟢 GREEN**

- `internal/campaign/scheduler.go` — `type Scheduler struct`, `func New(db DB, runner Runner) *Scheduler`, `func (s *Scheduler) Start(ctx context.Context, interval time.Duration)`
- `cmd/outreach/main.go` — `s := campaign.New(db, runner); go s.Start(ctx, 60*time.Second)`
- Mock interfaces: `Runner interface { RunCampaign(ctx, id) error }`, `DB interface { TryAdvisoryLock(ctx, id) (bool, error); ... }`

**🔵 REFACTOR**

- Extracted `Locker` interface — testovatelný bez Postgres.
- Interval konfigurovatelný přes env `SCHEDULER_INTERVAL_SEC` (default 60).

---

### A2 — Pre-send verification gate

**Cíl:** `sender.engine` odmítnout vše mimo `email_status=valid`. Dnes fallback
na `unverified` = odesílá se živelně.

**🔴 RED**

`modules/outreach/internal/sender/engine_test.go` (rozšíření):

```go
// TestGate_AllNonValidStatuses_Skip — table-driven:
//   risky / catch_all / role_only / unverified / invalid / spamtrap / disposable
//   → každý stav = smtp.Dial NESMÍ být volán + protection_trace entry zapsán

// TestGate_ValidStatus_Proceeds
//   status=valid → smtp.Dial MUSÍ být volán

// TestGate_WritesProtectionTrace_GateField
//   skip → trace.gate == "email_status", trace.value == skutečný status
```

**🟢 GREEN**

- `internal/sender/engine.go` — před `smtp.Dial`: `if c.EmailStatus != StatusValid { s.trace.Write(...); return ErrGated }`
- `internal/sender/gate.go` — `var validStatuses = map[Status]bool{StatusValid: true}`

**🔵 REFACTOR**

- `ErrGated` sentinel exportovaný → caller může rozlišit skip vs. infra error.

---

### A3 — Unsubscribe footer enforce

**Cíl:** Každý rendered mail MUSÍ obsahovat `{{unsubscribe_link}}`. Šablona bez
tokenu → `ErrMissingUnsubscribeToken` při `RenderDry()` před odesláním.

**🔴 RED**

`modules/outreach/internal/content/template_test.go` (rozšíření):

```go
// TestRenderDry_MissingToken_Error
//   šablona bez {{unsubscribe_link}} → ErrMissingUnsubscribeToken

// TestRenderDry_PlaintextVariant_AlsoChecked
//   HTML má token, plain-text nemá → stále error

// TestRenderDry_ValidTemplate_OK
//   oba varianty mají token → nil

// TestExistingTemplates_AllHaveToken
//   načte všechny *.tmpl ze /templates → každá musí projít RenderDry()
```

**🟢 GREEN**

- `internal/content/template.go` — `func validateUnsubscribeToken(html, plain string) error`
- Opravit existující šablony kde token chybí.

**🔵 REFACTOR**

- Validace spuštěna i při `RenderFull()` — double-check in prod path.

---

### A4 — DNS/DMARC preflight audit

**Cíl:** Využít S4 `probes_l3_dns.go`. Nový endpoint `/api/mailboxes/dns-audit`
spustí jednorázový audit 24 mailboxů. Mailbox s SPF fail → auto-pause.

**🔴 RED**

`modules/outreach/internal/protections/probe/audit_test.go` (nový):

```go
// TestDNSAudit_SPFFail_MailboxSetToPaused
// TestDNSAudit_DMARCNone_ReportsWarn (nePauze, jen warn)
// TestDNSAudit_AllPass_NoStatusChange
// TestDNSAudit_ReturnsSummary_AllMailboxes
```

`features/platform/outreach-dashboard/src/components/DnsAuditPanel.test.jsx` (nový):

```jsx
// DnsAuditPanel_RedPill_WhenDMARCNone
// DnsAuditPanel_GreyMailbox_WhenSPFFail
// DnsAuditPanel_TriggerAudit_CallsEndpoint
```

**🟢 GREEN**

- `internal/protections/probe/audit.go` — `RunAudit(ctx, mailboxes) []AuditResult`
- `internal/web/mailboxes.go` — GET `/mailboxes/dns-audit`
- BFF proxy: `server.js` GET `/api/mailboxes/dns-audit`
- `src/components/DnsAuditPanel.jsx` — pills per mailbox (spf/dkim/dmarc)

**🔵 REFACTOR**

- Audit výsledky cachované 1h — DNS se nemění po minutách.

---

### A5 — Email deduplication gate

**Cíl:** Tři formy dedupu před enrollmentem i před odesláním:

1. **Identická adresa** — `info@holding.cz` u 50 poboček → poslat jen 1×
2. **Doménový flood** — max N kontaktů ze stejné domény per-kampaň (default `3`)
3. **Holding strom** — firmy se stejným DIČ/IČ mateřské → max 1 kontakt z klastru

**🔴 RED**

`modules/outreach/internal/campaign/dedup_test.go` (nový):

```go
// TestDedup_IdenticalEmail_OnlyFirstEnrolled
//   segment: 50 kontaktů, všichni email=info@holding.cz
//   → enrollment: 1 enrolled, 49 skipped s reason="duplicate_email"

// TestDedup_DomainFlood_CapAt3
//   segment: 10 kontaktů ze stejné domény velka-firma.cz
//   → max 3 enrolled, 7 skipped s reason="domain_cap"

// TestDedup_DomainCap_Configurable
//   kampaň má domain_cap_override=1 → jen 1 per doménu

// TestDedup_HoldingCluster_Max1
//   3 firmy se stejným parent_ico → jen 1 enrolled, 2 skipped s reason="holding_cluster"

// TestDedup_DifferentDomains_NoSkip
//   10 kontaktů, každý jiná doména → všech 10 enrolled

// TestDedup_SkippedContactsAuditLogged
//   každý skip → zápis do protection_trace s gate="dedup", value=důvod
```

`modules/outreach/internal/campaign/enrollment_test.go` (rozšíření):

```go
// TestEnrollment_UniqueEmail_DBConstraint
//   UNIQUE (campaign_id, email_hash) v campaign_enrollments
//   druhý pokus o zápis stejné adresy → error z DB, ne panic

// TestEnrollment_PreviewDedupReport
//   dry-run F2 vrátí { enrolled: N, skipped_duplicate_email: X,
//     skipped_domain_cap: Y, skipped_holding: Z }
```

`features/platform/outreach-dashboard/src/components/SaveSegmentModal.test.jsx` (rozšíření):

```jsx
// SaveSegmentModal_DedupWarning_ShowsCount
//   response 201 + { dedupWarnings: { duplicateEmails: 12, domainFlood: 5 } }
//   → "⚠ 17 kontaktů bude při kampani přeskočeno (duplicity)"
```

**🟢 GREEN**

- `modules/outreach/internal/campaign/dedup.go`
  - `type DedupConfig struct { DomainCap int; HoldingCap int }`
  - `func Deduplicate(contacts []Contact, cfg DedupConfig) (keep []Contact, skipped []SkipRecord)`
  - Volá se v `runner.go` při enrollment, před SMTP

- Migrace `045_campaign_enrollments_email_hash.sql`
  - `ALTER TABLE campaign_enrollments ADD COLUMN email_hash TEXT`
  - `CREATE UNIQUE INDEX ON campaign_enrollments (campaign_id, email_hash)`

- `internal/campaign/runner.go` — volat `Deduplicate()` před `EnrollContact()`

- `internal/web/segments.go` — endpoint GET `/api/segments/:id/dedup-preview`
  vrací `{ duplicateEmails: N, domainFloodGroups: [...], holdingClusters: [...] }`

- BFF proxy `/api/segments/:id/dedup-preview`

- `src/pages/Segments.jsx` — dedup preview widget na kartě segmentu

**🔵 REFACTOR**

- `DomainCap` konfigurovatelný per-kampaň (pole v C2 formuláři, default 3).
- `HoldingCap` zatím hardcoded 1 — stačí pro MVP.
- Skipped reason uložen do `protection_trace` stejně jako ostatní gate reasons (A2).

---

## EPIC B — Segment UI

### B1 — `/api/segments` CRUD

**Cíl:** BFF proxy pro existující `internal/segment/store.go`.
`POST`, `GET /list`, `GET /:id`, `DELETE /:id`.

**🔴 RED**

`modules/outreach/internal/segment/store_test.go` (nový):

```go
// TestSegmentStore_Create_ReturnsMemberCount
// TestSegmentStore_Get_NotFound_ErrNotFound
// TestSegmentStore_Delete_CampaignReference_DoesNotCascade
// TestSegmentStore_List_Empty_ReturnsEmptySlice
```

`features/platform/outreach-dashboard/src/server.test.js` (rozšíření — real Express):

```js
// POST /api/segments → 201 + { id, memberCount }
// GET /api/segments → 200 + array
// DELETE /api/segments/:id → 204
// DELETE /api/segments/:id neexistující → 404
```

**🟢 GREEN**

- `internal/web/segments.go` (pokud chybí endpointy) — CRUD handlers
- `server.js` — proxy bloky pro `/api/segments`

**🔵 REFACTOR**

- Segment filter validace: neznámé klíče → 400 s popisem.

---

### B2 — „Uložit jako segment" na Companies

**Cíl:** Tlačítko vedle filtru → modal → POST B1. Disabled bez aktivního filtru.

**🔴 RED**

`features/platform/outreach-dashboard/src/components/SaveSegmentModal.test.jsx` (nový):

```jsx
// SaveSegmentModal_Disabled_NoActiveFilters
//   active=[] → tlačítko disabled

// SaveSegmentModal_Validation_NameTooShort
//   submit s "ab" → inline error "Název musí mít 3–60 znaků"

// SaveSegmentModal_DuplicateName_Shows409
//   fetch mock → 409 → "Segment s tímto názvem již existuje"

// SaveSegmentModal_Success_ShowsToast
//   fetch mock → 201 + { id: 42 } → toast text "Segment uložen"

// SaveSegmentModal_Success_RedirectLink
//   po úspěchu → link href obsahuje "/segmenty/42"
```

**🟢 GREEN**

- `src/components/SaveSegmentModal.jsx`
- `src/pages/Companies.jsx` — tlačítko + mount modalu

**🔵 REFACTOR**

- `useSegmentSave` hook extrahovat z modalu → testovatelný izolovaně.

---

### B3 — Stránka `/segmenty`

**Cíl:** List segmentů. Karta: název, počet členů, datum, „Otevřít v Firmách",
„Vytvořit kampaň", „Smazat".

**🔴 RED**

`features/platform/outreach-dashboard/src/pages/Segments.test.jsx` (nový):

```jsx
// SegmentsPage_EmptyState_ShowsLinkToFirmy
// SegmentsPage_CardRenders_NameAndCount
// SegmentsPage_Delete_ConfirmModal_ThenOptimisticRemove
// SegmentsPage_OpenInFirmy_SetsSessionStorageFilter
//   klik → sessionStorage["co.restore_filter"] nastaven + navigate /firmy
```

**🟢 GREEN**

- `src/pages/Segments.jsx`
- `src/App.jsx` — route `/segmenty` + nav odkaz
- `src/pages/Companies.jsx` — na mount přečíst `sessionStorage["co.restore_filter"]` a aplikovat

**🔵 REFACTOR**

- Segment karta extrahovat jako `SegmentCard.jsx` — testovatelná izolovaně.

---

## EPIC C — Campaign UI

### C1 — `/kampane` list + status

**Cíl:** Karty kampaní s badges `draft / running / paused / completed`. Pause/resume
inline. Poll 15s pro running.

**🔴 RED**

`features/platform/outreach-dashboard/src/pages/Campaigns.test.jsx` (nový):

```jsx
// CampaignList_StatusBadge_Variants
//   mock fetch → [{status:'running'}, {status:'draft'}]
//   → badge třídy "badge-running", "badge-draft"

// CampaignList_PauseButton_CallsPauseEndpoint
//   userEvent.click(pauseBtn) → fetch('/api/campaigns/1/pause', {method:'POST'})

// CampaignList_Polling_RefetchAfter15s
//   vi.useFakeTimers() → advance 15000ms → fetch volán 2×
```

BFF (`server.test.js` rozšíření):

```js
// GET /api/campaigns → 200 + array
// POST /api/campaigns/:id/pause → 200
// POST /api/campaigns/:id/resume → 200
```

**🟢 GREEN**

- `src/pages/Campaigns.jsx`
- `server.js` proxy bloky
- Go `internal/web/campaigns.go` pause/resume endpointy (pokud chybí)

**🔵 REFACTOR**

- Progress bar extrahovat jako `CampaignProgress.jsx`.

---

### C2 — Formulář `/kampane/nova`

**Cíl:** 4-stepper: (1) segment, (2) sekvence kroků, (3) send window, (4) start.
Dry-run preview před submitem.

**🔴 RED**

`features/platform/outreach-dashboard/src/pages/CampaignNew.test.jsx` (nový):

```jsx
// CampaignNew_Step1_SegmentRequired
//   submit krok 1 bez segmentu → "Vyber segment"

// CampaignNew_Step2_MaxSteps_5
//   přidat 6. krok → tlačítko "Přidat krok" disabled

// CampaignNew_Step2_DelayNegative_Error
//   delay = -1 → inline "Zpoždění musí být ≥ 0"

// CampaignNew_Step4_DryRunPreview_RendersBeforeSubmit
//   fetch mock /dry-run → zobrazí preview mailu pro kontakt #1

// CampaignNew_Submit_PostsToCampaigns
//   vyplnit všechny kroky → fetch('/api/campaigns', {method:'POST', ...})
```

`internal/campaign/runner_test.go` (rozšíření):

```go
// TestDryRun_NoSMTPCalls
// TestDryRun_RendersCorrectTemplate
// TestDryRun_RespectsSpintaxSeed
```

**🟢 GREEN**

- `src/pages/CampaignNew.jsx`
- `src/components/SequenceEditor.jsx`
- `internal/campaign/dryrun.go` (preview renderer)
- BFF `/api/campaigns/dry-run`

**🔵 REFACTOR**

- Stepper logika extrahovat jako `useStepper` hook.

---

### C3 — Detail `/kampane/:id`

**Cíl:** Progress per-step, sparkline sent/hod, `protection_trace` preview,
pause/resume/stop.

**🔴 RED**

`features/platform/outreach-dashboard/src/pages/CampaignDetail.test.jsx` (nový):

```jsx
// CampaignDetail_ProgressPerStep_Correct
//   mock: {steps: [{sent:180, total:200}, {sent:40, total:200}]}
//   → "180 / 200", "40 / 200"

// CampaignDetail_StopButton_RequiresConfirmModal
//   klik Stop → confirm modal s textem "nelze obnovit"
//   cancel → fetch NE volán

// CampaignDetail_ProtectionTrace_Shows20Rows
//   mock trace[20 items] → 20 řádků tabulky
```

**🟢 GREEN**

- `src/pages/CampaignDetail.jsx`
- BFF `/api/campaigns/:id` (detail + trace)

**🔵 REFACTOR**

- Sdílená `<ConfirmModal>` komponenta — použije i B3 smazání segmentu.

---

## EPIC D — Content Library

### D1 — 3 šablony + spintax

**Cíl:** Tři reálné šablony pro dealer těžké techniky.
- `heavy-01-intro.tmpl` — prvokontakt, 500–600 znaků, bez tracking pixelu
- `heavy-02-followup.tmpl` — follow-up +4 dny, 400 znaků
- `heavy-03-bump.tmpl` — bump +8 dní, 300 znaků

Každá: 3 subject varianty (spintax), 2 body varianty, povinný `{{unsubscribe_link}}`.

**🔴 RED**

`modules/outreach/internal/content/templates_heavy_test.go` (nový):

```go
// TestHeavyTemplates_AllHaveUnsubscribeToken   (A3 validátor)
// TestHeavyTemplates_BodyLength_Under700
// TestHeavyTemplates_SpintaxDeterministic
//   stejný seed → stejný output, různý seed → různý output v ≥1 variantě
// TestHeavyTemplates_RenderValid_NoDanglingBraces
//   render s dummy kontaktem → žádné "{{" v outputu
// TestHeavy01_NoTrackingPixel
//   heavy-01 rendered HTML nesmí obsahovat "/o?t="
```

**🟢 GREEN**

- `modules/outreach/templates/heavy-01-intro.tmpl`
- `modules/outreach/templates/heavy-02-followup.tmpl`
- `modules/outreach/templates/heavy-03-bump.tmpl`

**🔵 REFACTOR**

- Shared spintax helper: `{{spin "A|B|C"}}` místo inline `{A|B|C}` kde čitelnost padá.

---

### D2 — LLM variace úvodu

**Cíl:** Pre-send hook generuje 1–2 větu personalizovaného úvodu přes Anthropic SDK.
Seeded deterministicky. Fallback na spintax při error/timeout. Opt-in per-kampaň.

**🔴 RED**

`modules/outreach/internal/llm/anthropic_content_test.go` (nový):

```go
// TestLLMOpener_Timeout_FallbackToSpintax
//   mock HTTP timeout → vrácen spintax opener, žádný panic

// TestLLMOpener_APIError_FallbackToSpintax
//   mock 500 → fallback

// TestLLMOpener_SeedDeterministic
//   stejný contact_id + step → identický output (temperature=0)

// TestLLMOpener_UseFlagFalse_NoAPICall
//   use_llm_opener=false → Anthropic client NESMÍ být volán
```

`modules/outreach/internal/content/template_test.go` (rozšíření):

```go
// TestRenderWithLLMOpener_InjectsAtStartOfBody
//   opener vložen na začátek, zbytek šablony zachován
```

**🟢 GREEN**

- `internal/llm/anthropic_content.go` — `GenerateOpener(ctx, contact, campaign, seed) (string, error)`
- `internal/content/template.go` — pre-send hook pokud `use_llm_opener=true`
- Prometheus counter: `llm_opener_generated_total`, `llm_opener_fallback_total`

**🔵 REFACTOR**

- LLM call obalený `singleflight` pro identický seed ve stejné sekundě (batch flush).

---

## EPIC E — Reply loop

### E1 — `leads` tabulka + auto-insert

**Cíl:** Migrace `044_leads.sql`. Při `reply_type=interested` → zápis do `leads`.
Idempotentní. Webhook na `LEAD_WEBHOOK_URL` s retry 3×.

**🔴 RED**

`modules/outreach/internal/lead/store_test.go` (nový):

```go
// TestLeadStore_Create_OK
// TestLeadStore_Idempotent_SecondInsertUpdatesNotDuplicates
//   druhý interested reply na stejné vlákno → UPDATE last_reply_at, ne nový řádek
// TestLeadStore_WebhookRetry_3Times
//   mock HTTP server vrátí 500 dvakrát, pak 200 → 3 volání, OK
// TestLeadStore_WebhookSkipped_WhenURLEmpty
//   LEAD_WEBHOOK_URL="" → žádný HTTP call
```

`modules/outreach/internal/thread/inbound_test.go` (rozšíření):

```go
// TestInbound_InterestedReply_CreatesLead
// TestInbound_NotInterestedReply_NeverCreatesLead
```

**🟢 GREEN**

- `modules/outreach/internal/db/migrations/044_leads.sql`
- `internal/lead/store.go`
- `internal/thread/inbound.go` — hook po klasifikaci

**🔵 REFACTOR**

- Webhook client extrahovat jako `internal/webhook/client.go` — sdílí se i pro budoucí CRM integrace.

---

### E2 — Stránka `/inbox`

**Cíl:** Thread list, filtr classification (`interested / meeting / not_interested / all`).
Per-vlákno: firma, persona, last reply preview, unread indicator.

**🔴 RED**

`features/platform/outreach-dashboard/src/pages/Inbox.test.jsx` (nový):

```jsx
// Inbox_DefaultFilter_InterestingAndMeeting
//   fetch mock zahrnuje vlákna různých typů
//   → výchozí zobrazení jen interested + meeting

// Inbox_UnreadCount_ShowsInNav
//   mock: 3 unread → nav badge "3"

// Inbox_FilterChange_RefetchesCorrectParam
//   userEvent.click("Vše") → fetch s ?classification=all
```

BFF (`server.test.js` rozšíření):

```js
// GET /api/threads?classification=interested → 200 + array
// GET /api/threads/unread-count → 200 + { count: N }
```

**🟢 GREEN**

- `src/pages/Inbox.jsx`
- BFF proxy bloky
- Nav badge v `src/App.jsx`

**🔵 REFACTOR**

- `useInboxThreads(filter)` hook extrahovat.

---

### E3 — Detail vlákna + manuální reply

**Cíl:** Celá konverzace. Textarea „Odpovědět" → odeslání přes původní personu/mailbox.
Manuální reply = `send_events.kind='manual'`, nezapočítává do kampaně quotas.

**🔴 RED**

`features/platform/outreach-dashboard/src/pages/ThreadDetail.test.jsx` (nový):

```jsx
// ThreadDetail_Renders_AllMessages
// ThreadDetail_ManualReply_PostsToCorrectEndpoint
//   userEvent.type(textarea, "text") → submit → fetch('/api/threads/42/reply', POST)
// ThreadDetail_AttachmentPreview_OnlyImages_PDF
//   attachment s type="text/csv" → žádný preview element
```

`modules/outreach/internal/web/threads_test.go` (nový):

```go
// TestManualReply_UsesOriginalMailbox
// TestManualReply_KindSetToManual
// TestManualReply_NotCountedInCampaignQuota
```

**🟢 GREEN**

- `src/pages/ThreadDetail.jsx`
- `internal/web/threads.go` — POST `/threads/:id/reply`
- `internal/sender/engine.go` — podpora `kind=manual` (bypass campaign quota check)

**🔵 REFACTOR**

- `MessageBubble.jsx` komponenta — použitelná pro budoucí in-app chat.

---

## EPIC F — Pre-flight + Go-live

### F1 — Batch segment verifikace

**Cíl:** Tlačítko „Ověřit e-maily" na `/segmenty/:id`. SMTP probe celého segmentu
přes SOCKS5 pool (rate ≤ 20 domén/min). Progress modal. Report + „Vytvořit clean sublist".

**🔴 RED**

`modules/outreach/internal/validation/batch_test.go` (nový):

```go
// TestBatchVerify_RespectsSocks5Proxy_NoDirectConnect
//   mock SMTP server — probe musí jít přes proxy, ne přímo

// TestBatchVerify_RateLimit_Max20DomainsPerMin
//   100 různých domén → trvá ≥ 5s (rate limiter aktivní)

// TestBatchVerify_ResultsSaved_PerContact
//   po proběhu → email_status aktualizován pro každý kontakt v segmentu

// TestBatchVerify_ProducesCleanSublist
//   z 100 kontaktů 70 valid → nový segment se 70 členy
```

`features/platform/outreach-dashboard/src/pages/Segments.test.jsx` (rozšíření):

```jsx
// SegmentDetail_VerifyButton_ShowsProgressModal
// SegmentDetail_AfterVerify_ShowsReport
```

**🟢 GREEN**

- `internal/validation/batch.go`
- BFF POST `/api/segments/:id/verify`
- UI progress modal v `Segments.jsx`

**🔵 REFACTOR**

- `BatchVerifier` strukturovaný jako `io.Writer`-style progress emitter → SSE stream pro UI.

---

### F2 — Dry-run kampaně (preview UI)

**Cíl:** Na `/kampane/:id` (status=draft) → „Dry run". Vygeneruje rendered maily
pro všechny kontakty + timing kalendář. Žádné SMTP.

**🔴 RED**

`modules/outreach/internal/campaign/dryrun_test.go` (nový — většina již v C2):

```go
// TestDryRun_CalendarNoMailboxOverCapacity
//   kampaň na 200 kontaktů, 4 mailboxy po 50/den → žádný mailbox nepřekročí limit
// TestDryRun_SpintaxVariance
//   preview 50 mailů → ≥2 unikátní subject varianty (dokazuje rotaci seedu)
```

`features/platform/outreach-dashboard/src/pages/CampaignDetail.test.jsx` (rozšíření):

```jsx
// CampaignDetail_DryRunTab_ShowsMailPreview
// CampaignDetail_DryRunTab_CalendarHeatmap_Renders
```

**🟢 GREEN**

- `src/pages/CampaignDetail.jsx` — TAB „Dry run" (maily + kalendář heatmap)
- `internal/campaign/dryrun.go` — calendar builder

**🔵 REFACTOR**

- Calendar heatmap extrahovat jako `SendCalendar.jsx` — sdílí se pro F3 monitoring.

---

### F3 — Ostrý start — 30 kontaktů + runbook

**Cíl:** Runbook pro první živé odeslání. Ne kód, ale checklist s podmínkami abort.

**🔴 RED** — pre-launch checklist testy:

`modules/outreach/internal/campaign/preflight_test.go` (nový):

```go
// TestPreflight_AllMailboxesSPFPass
//   DNS audit A4 byl spuštěn < 24h → OK

// TestPreflight_SchedulerRunning
//   daemon health endpoint vrátí {scheduler: "running"}

// TestPreflight_SegmentAllValid
//   segment nemá žádný kontakt s email_status != 'valid'

// TestPreflight_NoCampaignRunning_SameSegment
//   nelze spustit dvě kampaně nad stejným segmentem současně
```

**🟢 GREEN**

- `internal/campaign/preflight.go` — `RunPreflight(ctx, campaign) []PreflightIssue`
- BFF GET `/api/campaigns/:id/preflight`
- UI: „Spustit kampaň" tlačítko disabled pokud `preflight.issues.length > 0`, seznam problémů inline

**🔵 REFACTOR**

- Preflight rozšiřitelný: slice `[]PreflightCheck` — přidat nový check = přidat do slice.

`docs/playbooks/FIRST-CAMPAIGN-RUNBOOK.md`:

```markdown
## Pre-start (den D)
- [ ] DNS audit A4 zelený pro všechny aktivní mailboxy
- [ ] Scheduler health endpoint vrací "running"
- [ ] Segment verifikován F1 — 0 unverified kontaktů
- [ ] Preflight F3 projde bez kritických issues
- [ ] mail-tester.com ≥ 9/10 na 2 vzorových mailech

## Start (D, 09:30)
- Vytvořit kampaň přes C2 na 30 kontaktů (10 % segmentu)
- 6 mailboxů × 5 mailů/den
- Status → running

## T+4h watch
- Bounce rate < 2 % → pokračovat
- Bounce rate 2–5 % → pauza, zkontrolovat DNS
- Bounce rate > 5 % → abort, circuit breaker check

## T+24h watch
- Open rate (povoleno až od follow-upu) → N/A pro D1
- Reply rate cíl ≥ 3 %
- Interested count → předat obchoďákovi

## Abort podmínky
- Jakýkoliv mailbox v stavu `bounce_hold` > 3 × za den → pauza všeho
- Alert z S7 protection_alerts → vyšetřit před pokračováním
- Spam complaint → okamžitý stop, revize šablon
```

---

## Shrnutí sprintů

| Sprint | Nové Go testy | Nové React testy | BFF testy | E2E |
|---|---|---|---|---|
| A1 | 4 | — | — | — |
| A2 | 3 | — | — | — |
| A3 | 4 | — | — | — |
| A4 | 4 | 3 | — | — |
| A5 | 8 | 1 | 1 | — |
| B1 | 4 | — | 4 | — |
| B2 | — | 5 | — | — |
| B3 | — | 4 | — | — |
| C1 | — | 3 | 3 | — |
| C2 | 3 | 5 | — | 1 |
| C3 | — | 3 | — | — |
| D1 | 5 | — | — | — |
| D2 | 4 | — | — | — |
| E1 | 5 | — | — | — |
| E2 | — | 3 | 2 | — |
| E3 | 3 | 3 | — | 1 |
| F1 | 4 | 2 | — | — |
| F2 | 2 | 2 | — | — |
| F3 | 4 | — | — | 1 |
| **Σ** | **57** | **34** | **10** | **3** |

> Všechny testy musí projít před commitem příslušného sprintu.
> `pnpm test` (Vitest) + `go test ./...` = gate.
