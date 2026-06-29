# ADR-004 — Mail Lab profile API + Operator Practice training environment

**Status:** Accepted
**Date:** 2026-04-30
**Supersedes:** —
**Related:**
- [ADR-002 — Autonomous Ops Architecture](ADR-002-autonomous-ops-architecture.md)
- Initiative: `docs/initiatives/2026-04-29-mail-lab.md` (issue #212)
- Initiative: `docs/initiatives/2026-04-30-operator-practice.md` (PR #263)

## Kontext

Vývojový workflow pro outreach pipeline narážel na dvě paralelní bolesti:

1. **Žádný indistinguishable-from-prod test environment.** Greenmail / mailpit přijímají všechno; reálný Seznam odmítá Mullvad CIDR, vyžaduje strict DKIM, throttluje na 100/h. Lokální vývoj proti greenmailu = "funguje lokálně, fail v prod" loop.
2. **Žádný operátorský tréninkový mode.** Triage / klasifikace / odpovídání lze cvičit jen proti reálným prospektům, což je destruktivní (reální lidé), pomalé (odpovědi přicházejí dny) a neměřitelné (žádný kontrolovaný experiment).

Tato ADR zachycuje architektonická rozhodnutí ze dvou paralelních initiativ shipnutých 2026-04-29 → 2026-04-30:

- **Mail Lab profile API** — virtuální providery se pravidly chovající jako Seznam/Gmail/Outlook (PRs #248-#262, 13 v stacku + 4 off-stack)
- **Operator Practice** — anonymized real-reply replay infrastructure (PRs #263-#269, #281)

Spolu posouvají cyklus: napiš kód → boot lokální stack → vidíš realistic provider behavior → klasifikuj realistic replies → měř improvement.

## Rozhodnutí

### M1 — Per-provider profiles jako runtime-mutable JSON

**Decision:** Profil každého providera je čisté JSON (`max_message_size_bytes`, `rate_limit_per_hour`, `reject_non_cz_origin`, `greylist_unknown_sender`, `dkim_strictness`, `bounce_kind_on_reject`, ...) loadovaný z `features/platform/mail-lab-api/profiles/*.json` do `Registry` chráněné `sync.RWMutex`. Runtime override přes `POST /v1/profile/{domain}/override` tone tře profil bez perzistence (operator restart = baseline).

**Trade-off:** přidání nového pole = přidání do struct + audit existing tests. Nedělá se přes config templating (Helm-style). Důvod: chaos scénáře potřebují program-friendly mutace, nikoli redeploy.

**Alternative considered:** Database-backed profiles. Odmítnuto — extra dependency pro zero-state lab. JSON na disku je expressive enough pro 3 providery × 11 polí.

### M2 — Verdict jako pure function, ne MTA hook

**Decision:** `profile.Verdict(p, MessageContext) → (Decision, reason)` je čistá funkce. Žádný side effect, žádný DB hit, žádný side-channel. `Decision` je stable string (`accept | reject | greylist | spam`).

Order pravidel matches reálnou MTA evaluaci: size → proxy CIDR → DKIM strict → non-CZ origin → greylist → spam classification.

**Trade-off:** harness drivers musí callovat `/check` před každým sendem, což je extra HTTP roundtrip. Profit: deterministic predicate testovatelný bez Postfixu.

**Alternative considered:** Build full Postfix policy daemon. Odmítnuto — moc engineering pro výchozí use case (testovat orchestrator rozhodování, ne reálný MTA flow).

### M3 — DSN synthesizer jako pure function (RFC3464)

**Decision:** `profile.BuildDSN(p, DSNEnvelope, decision, reason) → DSN` skládá multipart/report tělo s 3 parts (text/plain human, message/delivery-status machine, message/rfc822-headers). Status code z `profile.bounce_kind_on_reject`; greylist override na `4.7.1` + `action=delayed`. CRLF endings, `Auto-Submitted: auto-replied` (loop prevention).

**Trade-off:** boundary string fixed (`==BOUNDARY_LAB_DSN==`) pro test grep-ability. Real MTA randomizes; lab nepotřebuje.

### M4 — Tracker triplet: rate / quota / greylist jako separate concerns

**Decision:** Tři nezávislé tracker struktury:
- `Tracker` — sliding-window send rate per mailbox (default 1h)
- `QuotaTracker` — bytes used per mailbox (no time window, accumulate-only)
- `GreylistTracker` — (sender_ip, sender_addr, recipient_addr) triplet state machine (defer → graduated)

Všechny composed do `Registry`, exposed via separate endpoints. `SetClock` pro deterministic tests bez `time.Sleep`.

**Trade-off:** 3 trackers = 3 places to test + 3 places to reset. Profit: každý má jednu zodpovědnost; failure modes jsou izolované.

**Alternative considered:** Single unified "limits" tracker. Odmítnuto — semantics se liší (time-windowed vs accumulate vs state-machine).

### M5 — Combined `/evaluate` pipeline pro orchestrator-friendly callers

**Decision:** Jediný endpoint `POST /v1/profile/{domain}/evaluate` co spustí celý pipeline: greylist → rate → static rules. Vrátí `{decision, reason, fired_by, rate_count, rate_limit}`. Order odpovídá tomu, co reálné MTAs dělají (4xx defer dominuje 5xx reject).

`record_rate=true` flag advances rate tracker — operátor-controlled, default off (preview-only).

**Trade-off:** orchestrator volá jeden endpoint místo tří. Loss: harness driver co chce drill-down musí volat individuální endpointy. Profit: 1 RTT per send vs 3.

### M6 — Bounce delivery via `docker exec sendmail`, ne SMTP relay

**Decision:** `POST /v1/scenario/bounce` synthesize DSN + `docker exec -i <sender_container> sendmail -i -f postmaster@<recipient_domain> <sender>` s tělem na stdin. DSN landne v sender's lab IMAP přes Postfix's lokální delivery.

**Trade-off:** vyžaduje sender's mailbox v jiném lab provideru. Pokud sender není v `seznam.lab|gmail.lab|outlook.lab` mapování → 400. Profit: harness vidí real bounce flow přes IMAP, ne jen JSON response.

**Alternative considered:** SMTP relay z mail-lab-api do sender provideru. Odmítnuto — sendmail v containeru je triviální via `docker exec`, vlastní SMTP klient v mail-lab-api by byl reimplementace go-net/smtp.

### M7 — Go client (`features/platform/common/maillabclient`) jako shared lib, ne per-service

**Decision:** Strongly-typed Go client v `features/platform/common/maillabclient` wrapuje every endpoint. Sentinel errors (`ErrUnknownDomain`, `ErrUnauthorized`, `ErrBadRequest`) pro `errors.Is` matching. Client-side validation šetří roundtripy (`QuotaAdd<=0`, `Greylist` bez recipient).

**Trade-off:** harness driver + orchestrator + future services všichni používají stejný client. Změna v mail-lab-api API = update v jednom místě.

### M8 — Labhook jako standalone package, ne engine modification

**Decision:** `features/inbound/orchestrator/labhook` exportuje `Evaluator` interface s metodou `ShouldSkip(ctx, EvaluateInput) → (bool, reason)`. `LabEvaluator` (default impl) wrapuje `maillabclient.Client` + mode gate. **Pure wrapper** — žádné goroutines, žádný caching.

**Engine integration deferred** — ML5.2 (PR #260 followup) wirne hook do `features/outreach/campaigns/sender/engine.go:361-391` po PreSendHook. Tato ADR shipuje pouze hook + 100% coverage tests. Engine integration je separate PR proti hot-path code.

**Trade-off:** ML5.1 nemá end-to-end demo bez ML5.2. Profit: hook lze testovat bez touchnutí campaign sender (najlocked since R4 enforcement).

### M9 — Fail-open na lab API errors

**Decision:** `LabEvaluator.ShouldSkip()` při lab API selhání vrací `(false, "lab evaluate error: ...")`. Nikdy neblokuje real send protože lab je nedostupný.

**Trade-off:** transient lab issue → real send proceeded. Acceptable, protože lab je dev/test ENV; produkce neběží přes lab evaluator.

### M10 — Toxiproxy jako overlay compose, ne baked-in

**Decision:** `infra/docker/mail-lab-chaos.yml` je separate compose layer. Operator opt-in:
```
docker compose -f mail-lab.yml -f mail-lab-chaos.yml up -d
```

**Trade-off:** chaos requires explicit setup. Profit: production-shape lab boots clean (no toxiproxy latency overhead by default).

### M11 — Operator Practice fixture rule: real anonymized data nebo nic

**Decision:** `tests/fixtures/operator-replies/` přijímá pouze:
1. Soubory s headerem `X-Lab-Source: real-anonymized` (skutečné PII-stripped exporty z prod)
2. Soubory s headerem `X-Lab-Source: placeholder-infrastructure-test` (only in `_placeholders/` subdir)

Audit gate (`tests/audit/operator-practice-seed-shape.test.js`) odmítá Faker/fake samples, vyžaduje every fixture mít validní `X-Lab-Source` header. Real category subdirs hold zero `.eml` until OP1.2 anonymizer runs against prod export.

**Why so strict:** memory `feedback_no_fabricated_test_data` HARD RULE. Synthetic samples by trénovaly LLM classifier na non-existent distribuci.

### M12 — Anonymizer jako script bez external services

**Decision:** `scripts/operator-practice/anonymize.mjs` je čistá `node:*` stdlib (žádný npm dep, žádný OpenAI/Claude API call). Built-in CZECH_FIRSTNAMES list + regex pro phone/email/URL/company suffixes. Manual review checklist printed at end — operator MUST review before commit.

**Trade-off:** Czech name detection je incomplete (top ~80 names). Operator catches edge cases via review. Profit: žádný external dependency, žádný API call leak prod data.

### M13 — Time accel via deterministic seed, ne random

**Decision:** `arrival-curve.mjs` produkuje JSON `[{delay_ms, fixture_category, index}]` z deterministic SHA256 seed (`op-practice-2026` default). `--accel N` v replay-campaign.sh dělí gap_ms / N.

**Trade-off:** identical seed + N → identical timeline. Test/CI lze re-run scénáře. Profit: bug found in chaos run je reproducible.

**Alternative considered:** Math.random with logged seed. Odmítnuto — explicitní seed naming je samodokumentující.

### M14 — Practice mode separation deferred (OP3.4)

**Open question:** practice events leak to prod analytics dokud OP3.4 toggle nelandne.

**Mitigation:** OP1+OP2 ship without dashboard instrumentation; events nejsou capture-d. Když OP3 startne, toggle je first sub-task.

**Status:** OP3.x tracked v GH issues #270-#273, blocked na user direction (DB schema timing + UX placement).

## Důsledky

### Pozitivní

- **Indistinguishable-from-prod lab.** Orchestrator po landed stacku můžete testovat proti providerům s realistic rate limits, DKIM strict, bounce codes — bez prod creds.
- **Operator practice loop.** Real anonymized replies → time-accelerated injection → dashboard triage → measurable accuracy. OP1+OP2 layer ship-ready (waiting on stack landing for live integration).
- **Zero net new dependencies.** Vše stdlib Go + Node. Toxiproxy + docker-mailserver jsou existing OSS containers.
- **Brutal test coverage.** ~720+ asserts shipped napříč 23 PRs této iniciative session.
- **Discoverability.** ADR + initiative docs + GH issues + playbooks tvoří navigable path pro any future agent / reviewer.

### Negativní

- **Stack hloubka.** Mail Lab + Operator Practice = 17 PRs deep stack + 7 off-stack base=main. Landing pass cost geometricky roste s každým dalším PR.
- **No live integration yet.** Smoke E2E specs (#267, #269, #281) skip-pattern když preconditions absent. Real validation gated na user landing PRs #220-#247 + #248-#262.
- **OP3+ blocked.** Workflow měření (#270-#273) potřebuje DB schema rozhodnutí + dashboard widget UX call.
- **Provider-side bias.** ML2-6 work je heavier než operator-side (OP1-2). Per memory `feedback_operator_focus` (saved 2026-04-30), future iterations MUST default to inbound/triage/classify axis.

## Acceptance kritéria pro tuto ADR

- [x] Captures rationale pro každý decision M1–M14
- [x] References konkrétní PR numbers (#248-#281) + initiative files
- [x] Documents trade-offs (ne jen positives)
- [x] Identifikuje OP3.4 jako known open question
- [x] Cross-refs ADR-002 (autonomous ops) + memory `feedback_operator_focus`

## Když by se měla tato rozhodnutí přehodnotit

| Trigger | Kdy revisit |
|---|---|
| Real prod export landed | M11 (anonymizer rules) — tune CZ name list to actual data distribution |
| ML5.2 engine wiring | M8 — confirm Evaluator interface stable; refactor labhook → engine import path |
| OP3.x ships | M14 — close practice mode separation question |
| Provider count grows beyond 3 | M1 — JSON profile path approach may need DB upgrade |
| Multiple consumer services | M7 — maillabclient may need versioned API contract |
| Real campaign sends use lab evaluator | M9 — fail-open semantics may flip to fail-closed in production guard |

## References

- PRs: #248–#262 (Mail Lab API stack), #263–#269 + #281 (Operator Practice)
- Initiatives: `docs/initiatives/2026-04-29-mail-lab.md`, `docs/initiatives/2026-04-30-operator-practice.md`
- Memory: `feedback_operator_focus`, `feedback_no_fabricated_test_data`, `feedback_no_external_services`, `feedback_extreme_testing`
- Memory project: `project_b2b_transport_mode`, `project_seznam_proxy_geo_mismatch`
- Related ADRs: ADR-002 (autonomous ops), ADR-003 (test suite governance)
