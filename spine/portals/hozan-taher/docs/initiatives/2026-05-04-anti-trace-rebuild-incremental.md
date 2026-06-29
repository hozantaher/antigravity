# Anti-Trace Pipeline Rebuild — Incremental Step-by-Step

**Status:** active
**Vlastník:** Chat A (engineering) + operátor pro per-step go/no-go
**Datum založení:** 2026-05-04
**Datum uzavření:** —
**Trigger:** Po dnešním H1-H7 sprintu byla potvrzena root cause — Engine.WithAntiTrace transformations rozbíjí Seznam delivery. Raw MIME přes Railway wgpool DE endpoint doručil 1/1 (PR #695 endpoint /v1/raw-smtp-test, subject `[H7-DIAG-1777847978158037000-1]` v INBOX a.mazher@email.cz uid=12). Tato iniciativa rebuilds anti-trace pipeline incrementálně — přidává transformace jednu po druhé s delivery testem mezi krokem aby se identifikovala přesná hranice akceptovatelnosti vs Seznam spam-flagging.

## Kontext

Stávající stav po H7 finalizaci. PR #694 fixed Message-Id format (D5 anonymizeMessageID nyní zachová sender FQDN). PR #695 přidal /v1/raw-smtp-test diagnostic endpoint který bypasuje Engine + všechny anti-trace transformace. Test 8 retries s rozdílným routing key (= rozdílný wgpool endpoint) → 1× hit DE endpoint (port 1081) → delivery 1/1 do INBOX. Předchozí 7× hit SE endpoint (port 1083) → connection refused (SE socks5 není live; bug v wgsocks SE keepalive — peer keepalive nikde v logu).

Per H1 investigation jsou identifikované top 5 likely Seznam spam-trigger transformations (post-D5):
- **#2 Forced multipart/alternative** v `features/outreach/campaigns/render/template.go:136` — every send hardcoded `BodyHTML = plainToHTML(body)` i pro plain-text content
- **#3 Per-line random `<span style="font-size:13-15px">` injection** v `features/outreach/campaigns/render/humanize/fingerprint.go:67-76` — 30 % šance per line (HTML structure churn)
- **#4 Diacritics random-degrade + typo injection** v `features/outreach/campaigns/render/humanize/imperfect.go:43-66` — `vážený` mixed s `vazeny` v rámci jednoho odstavce (klasický CZ-spam ML signál)
- **#5 X-Mailer: Seznam.cz forged tag** v `features/outreach/campaigns/render/humanize/fingerprint.go:39` — později strippnut D5 ale potenciální regression vector

Plus tucet drobnějších transformations (subject prefix injection, encoding manipulation, character substitutions). Celkem 24 transformations enumerated v `reports/anti-trace-mime-transformations-2026-05-03.md`.

Strategie rebuild je: začít od proven raw MIME baseline (delivery confirmed) a přidávat transformace po jednotlivých krocích. Každý krok send 5 envelope, IMAP poll, measure delivery rate. První krok kde delivery ratio padne pod 100 % = identifikovaná hranice. Tu lze pak ladit (např. snížit probabilita span injection, vypnout diacritics degrade pro CZ recipients, použít multipart jen když HTML body je skutečně different than plain).

Operator gate je per-step. Žádný auto-execute multi-step rebuild — každý krok vyžaduje explicitní operator schválení před spuštěním + po vyhodnocení delivery results.

## Cíle

Primární cíl je identifikovat minimální hranice anti-trace transformations které Seznam tolerují. Sekundární cíl je rebuild Engine tak aby produkoval MIME content akceptovaný cílovými mailbox providers (Seznam priority pro CZ B2B audience, Gmail/Outlook secondary). Terciární cíl je dokumentovat compatibility matrix per provider (které transformations spam-trigger Gmail vs Seznam vs Outlook).

Důsledně nepouhý fix Seznam delivery, ale systematic understanding kterou anonymizační vrstvu lze udržet a kterou musíme buďto vypnout nebo přepsat. Anonymity vs deliverability tradeoff musí být explicitně dokumentovaný v ADR po dokončení.

## Plán (sprinty)

### Sprint I0 — Baseline confirmation (1 sezení) {#sprint-i0}

Cíl je rozšířit dnešní jediné delivery na statisticky robustní baseline. PR #695 endpoint /v1/raw-smtp-test bypassuje vše. Jediný delivery test (DE endpoint) je n=1. Statisticky chceme 5+ úspěšných deliveries z různých endpoints.

I0.1 — pošli 10 raw MIME envelope via /v1/raw-smtp-test, různé subjects (= různé routing hashes = různé endpoints). Some hits SE endpoint = connection refused error (bonus side-finding viditelný). Cíl: 5+ deliveries do INBOX z různých endpoints (CZ, DE, NL — možná i SE jakmile se opraví).

I0.2 — fix SE endpoint v wgpool. Side-finding z dnes: SE peer keepalive nikde v logu, port 1083 connection refused. Bug v wgsocks SE configuration nebo Mullvad SE WG endpoint je nedostupný. Investigate + fix.

DoD I0: 5/10 raw MIME deliveries confirmed do recipient INBOX. SE endpoint buď fixed nebo permanently quarantined.

### Sprint I1 — Engine Message-Id format (1 sezení) {#sprint-i1}

Cíl je přidat Engine's HMAC Message-Id format místo random hex. Engine v `headers.go:227` produkuje `<HMAC(envelope_id+key)@<sender-FQDN>>` — properly RFC compliant, just identifiable s HMAC. Test if Seznam ML detects HMAC pattern as bot-signature.

I1.1 — patch /v1/raw-smtp-test aby přijal `?engine_messageid=1` flag. Použij Engine's Message-Id generator místo random hex. Send 5× engine-style Message-Id, IMAP poll, measure delivery.

I1.2 — pokud 5/5 deliver: HMAC format je safe → přesun na I2. Pokud 0-4/5: HMAC pattern is spam trigger → use random hex format permanently (Engine code change needed).

DoD I1: Decision per evidence: HMAC pattern OK or banned. Documented v reports/i-sprint-results.md.

### Sprint I2 — Multipart/alternative (1 sezení) {#sprint-i2}

Cíl je test multipart/alternative s minimal HTML (just plain text wrapped). H1 identified this as HIGH suspicion. Real B2B emails often jsou multipart. Otázka: jakou minimální HTML structure Seznam toleruje.

I2.1 — patch /v1/raw-smtp-test aby přijal `?multipart=1` flag. Build multipart/alternative s text/plain + minimal text/html (just `<html><body>${body_escaped}</body></html>`). Send 5×, measure.

I2.2 — pokud OK: přidávat HTML formatting (paragraphs, links, signature). Pokud FAIL: stay plain-text only pro CZ audience. Document.

DoD I2: Decision multipart vs plain. Test 5 envelopes per configuration.

### Sprint I3 — Humanize variance light (1 sezení) {#sprint-i3}

Cíl je test humanize variance — subtle character substitutions (zero-width spaces, em-dash vs hyphen). Engine's `humanize/imperfect.go` má hodně variance. Začni s nejlehčí.

I3.1 — patch endpoint `?humanize=light` flag. Apply only character-level substitutions (no diacritics degrade, no typos). Send 5×.

I3.2 — pokud OK: ramp na medium humanize (paragraph variance). Pokud FAIL: identify konkrétní substitution (zero-width? em-dash? non-breaking space?).

DoD I3: Acceptable humanize level identified.

### Sprint I4 — Diacritics random-degrade (1 sezení, gating) {#sprint-i4}

Cíl je explicitně otestovat diacritics degrade — nejhlavnější CZ spam ML signal per H1. Hypothesis: tohle je single biggest blocker.

I4.1 — `?diacritics=degrade` flag. Apply random-degrade + typo injection. Send 5×.

I4.2 — almost guaranteed FAIL. Document delivery ratio. Decision: disable for CZ providers, possibly enable for non-CZ.

DoD I4: Diacritics degrade impact measured. ADR proposal: disable for cz/sk providers.

### Sprint I5 — Span injection HTML structure churn (1 sezení) {#sprint-i5}

Cíl je test span injection. H1 identified as HIGH suspicion (HTML structure churn). After I2 (multipart) confirmed, test if random spans are tolerated.

I5.1 — `?spans=inject` flag. Random spans 30 % per line. Send 5×.

I5.2 — measure. Decision: spans OK or disable.

DoD I5: Span injection impact measured.

### Sprint I6 — Full Engine.WithAntiTrace integration (1 sezení) {#sprint-i6}

Cíl je apply všechny accepted transformations from I1-I5 in production Engine. Engine.WithAntiTrace().Run() configurable per-transformation. After I1-I5, we know which transformations to keep vs disable.

I6.1 — patch Engine s configurable transformation flags (via env or config). Default profile: SAFE (only verified passing transformations from I1-I5).

I6.2 — full anonymity-test (4 mailboxes × 3 templates × varying receivers, 36 envelopes). IMAP harvest. Goal: ≥80 % delivery rate.

I6.3 — comparison anonymity score vs raw MIME baseline. Quantify privacy/deliverability tradeoff.

DoD I6: 4×3 anonymity test ≥80 % delivery. ADR-012 documenting which transformations stay vs go.

### Sprint I7 — Production cutover (1 destructive sezení) {#sprint-i7}

Cíl je flip production campaign sender path z dnešního Engine.WithAntiTrace().Run() (broken) na new SAFE profile (verified delivering).

I7.1 — campaigns 1+456+455 paused (currently). Verify all paused.

I7.2 — deploy Engine s SAFE profile. Re-run anonymity-test for cutover sanity.

I7.3 — resume campaign 1 with conservative cadence (5 sends per mailbox per day initially). Daily delivery monitoring via tracking pixels (need to verify pixel server delivery — separate gap).

I7.4 — 7-day stability window. If delivery >80 % maintained, full ramp. If degrades, rollback to raw MIME path.

DoD I7: Production campaign 1 delivering verified at scale. ADR-012 finalized.

### Sprint K — Drain goroutine panic resolution (resolved 2026-05-04 03:14 UTC) {#sprint-k}

**Status:** RESOLVED via PR #706.

V průběhu I7 production cutover přípravy bylo zjištěno že 302 production envelopes proteklo přes Engine.WithAntiTrace().Run() s 0 měřitelnými delivery (Sentry žádné `outbound_smtp_delivered` events). K1 reverted PR #703 (ENGINE_MIME_DEBUG breadcrumb). K2 redeploy potvrdil že panic přetrvává i bez #703 — root cause je hlubší.

K3 — captured drain goroutine panic stack trace pomocí `fmt.Fprintf(os.Stderr, ...)` bypassu relay logger redaction (logger.Error redactuje stack=[REDACTED]). Stack směřuje na `features/outreach/relay/cmd/relay/main.go:1219` — `accountPool.Deliver(deliverCtx, fromAddr, []string{content.Recipient}, msg)`.

Root cause: classic Go typed-nil interface gotcha. Linka 312 v main.go deklaruje `var accountPool *delivery.AccountPool` — typed-nil pointer. Když `cfg.smtpAccounts` je prázdný (Railway env nemá `SMTP_ACCOUNTS` set), pointer zůstane nil. Linka 502 jej předává jako `drainAccountPool` interface parametr → wrapped do `(type=*AccountPool, value=nil)` non-nil interface. Kontrola na linka 1218 `accountPool != nil` vrací **true** přestože hodnota je nil. Linka 1219 zavolá `Deliver` na nil receiver → `p.accounts` deref → panic. `runDrainLoop.func1` recovers, scheduler resetuje envelope na pending, další tick znova panicuje. Net effect: každý envelope tiše selhal v nekonečné panic loop. 302 envelopes → 0 deliveries.

PR #706 fix (3-vrstvý defense-in-depth):
1. **Call site** (main.go:500-509) — convert `*AccountPool` na `drainAccountPool` interface jen když concrete pointer non-nil. Jinak interface zůstane true-nil a elif větev na 1218 se správně přeskočí.
2. **Receiver** (smtp.go AccountPool.Has + Deliver) — nil-receiver-safe, vrací false / error místo panicu. Také handluje nil `fallback` explicitně.
3. **Regression tests** (smtp_extra_test.go) — `TestAccountPoolNilReceiverSafe` + `TestAccountPoolDeliverNilFallbackUnknownFrom` ratchet aby tato třída bugu neunikla znova.

Verifikace post-deploy:
- Build čistý, full relay test suite green (38 packages).
- 6 drain ticks po fresh boot (`drain_tick batch_size=0 pending=0`), 0 panic markerů, 0 nil pointer errorů.
- Empty-queue path verifikován live. Populated-queue path strukturálně bezpečný (oba původní panic vektory uzavřené).

**Lekce:** logger.Error v anti-trace-relay redactuje stack traces (privacy hardening). Pro debugging paniců přidávat `fmt.Fprintf(os.Stderr, "DRAIN_PANIC_STACK: %v\n%s\n", r, debug.Stack())` jako bypass. Long-term zvážit `LOG_LEVEL=debug` flag který stack traces NEremovuje (pouze v non-production env).

DoD K: PR #706 merged. Empty drain verifikován panic-free. Když operator znova povolí campaign pak populated-queue path se ověří automaticky.

### Sprint I-side — Pool SE endpoint fix (parallel, 1 sezení) {#sprint-i-side}

Vedlejší fix dnes nalezený: pool SE endpoint nelistens (port 1083 connection refused, peer keepalive missing v logu). Pool stats říkají healthy = misleading.

Side.1 — debug wgsocks SE startup. Check entrypoint.sh, env vars, WIREPROXY_POOL_CONFIG SE entry validity.

Side.2 — fix or quarantine SE permanently. Update pool stats so /v1/proxy-pool reports accurate live state.

DoD: SE endpoint connection succeeds OR quarantined and pool reports 3 active.

## Pořadí a paralelismus

I0 first — baseline solidify. Single sezení.

I1-I5 sequential — každý krok závisí na předchozím (additive transformations). Operator gate per step. Žádný parallelism (per dnešní lekce parallel agent na server.js, anti-trace ratchet hot path stejný princip).

I-side parallel s I1-I5 — different code (relay wgpool SE bug), no conflict.

I6 navazuje na I1-I5 success. Single sezení (no parallel agents on Engine code).

I7 production cutover — operator-supervised, single sezení.

## Open questions

První otázka je granularity per-test envelope count. 5 sends per step je nominal sample size ale Seznam ML detection může být probabilistic — kdy 5/5 OK ale 100/100 by FAIL. Larger sample sizes (50+) zvyšují statistical confidence ale spotřebují daily SMTP quota. Decision: 5/5 = pass for I1-I5 individual transformations; full 36-envelope anonymity test pro I6 cumulative validation; production 50+ in I7 launch.

Druhá je co když některá transformation jednotlivě = OK, ale cumulative sets (I1+I2+I3) FAIL. Possible v některých kombinacích. Mitigation: I6 cumulative test catches it.

Třetí je co když Seznam reputation memory už má naše 4 testovací mailboxes flagged from today's 326 spam-flagged sends. Per memory architectural ceiling — pokud Seznam blocks all subsequent sends bez ohledu na content, žádný anti-trace rebuild neopraví. Mitigation: monitor delivery ratio over 7 days; if mailboxes permanently degraded, rotate to fresh accounts.

Čtvrtá je tracking instrumentation. Ani PR #694+#695 nepřidávají tracking events (open pixel, click redirect). 0 tracking events za 302 production sends suggests pixel/redirect domains are blocked OR instrumentation never fired. Need separate sprint to verify tracking pipeline.

## Cross-references

- [`docs/subsystem-maps/anti-trace.md`](../subsystem-maps/anti-trace.md) — canonical 42-step pipeline
- [`reports/anti-trace-mime-transformations-2026-05-03.md`](../../reports/anti-trace-mime-transformations-2026-05-03.md) — H1 investigation, 24 transformations enumerated
- [`docs/initiatives/2026-05-01-egress-fix-rollout.md`](2026-05-01-egress-fix-rollout.md) — historic Hetzner VPS plán (operator-rejected)
- [`docs/initiatives/2026-05-03-launch-readiness-and-scaling.md`](2026-05-03-launch-readiness-and-scaling.md) — Sprint A6 launch staircase blocked by delivery
- PR #694 — Message-Id sender FQDN preservation (D5 fix)
- PR #695 — /v1/raw-smtp-test diagnostic endpoint (TEMPORARY — gate behind EGRESS_DIAG_MODE post I7 finalization)
- Memory: `project_egress_canonical` (T1) — Mullvad-only egress
- Memory: `project_seznam_proxy_geo_mismatch` (T2) — anti-VPN reputation discussion (now superseded by content-vs-egress evidence)
- Memory: `feedback_anti_trace_full_stack` (T0 HARD RULE) — Engine.WithAntiTrace mandatory; po I6/I7 update na "Engine SAFE profile mandatory"
- Memory: `project_first_campaign_launch` (T1) — current delivery state
