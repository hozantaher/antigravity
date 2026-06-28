# Kampaň výkupu techniky — Chat B (Quality/Tests) sprint plan

**Status:** active (draft → schválení)
**Created:** 2026-04-30
**Owner:** Chat B — `wm/tests` worktree (`/Users/messingtomas/Documents/Projekty/hozan-taher-tests/`)
**Cross-link:** [Master](2026-04-30-kampan-vykupu-techniky-master.md) · [Chat A Build](2026-04-30-kampan-vykupu-techniky-A-build.md)
**Bootstrap:** `docs/handoff/bootstrap-tests.md` (DORMANT od 2026-04-22 — reaktivace per sekce níže)

15 sprintů přiřazených Chatu B z 30-sprint master plánu.

> **DSR endpointy upřesnění:** Master plán uvádí `features/inbound/orchestrator/web/dsr.go` — ten Go file **NEEXISTUJE**. Skutečné DSR endpointy jsou v `features/platform/outreach-dashboard/server.js:410` (GET `/api/dsr/access`) + `:480` (POST `/api/dsr/erase`), s rate-limit `_dsrAllow` na `:391-407`. Runbook `docs/playbooks/dsr-runbook.md`. KT-B11 cílí na skutečnou lokaci.

## Cíl Chatu B (rolling)

| D+ | Acceptance | Sprint |
|---|---|---|
| D+1 | Reply IMAP poll cyklus prokazatelně přijal první reálnou odpověď v `reply_inbox` | KT-B1 |
| D+3 | LLM klasifikátor accuracy ≥90% na first-20 ground-truth | KT-B2 |
| D+3 | Reply triage E2E (Playwright) zelený | KT-B3 |
| D+5 | Override capture log obsahuje ≥3 reálné overrides s root-cause notes | KT-B4 |
| D+7 | Mail Lab feedback loop běží — anonymized reply do lab inboxu, klasifikace shoda s prod | KT-B5 |
| D+10 | Operator Practice OP3-OP5 testy shipped (timer + override + confusion matrix) | KT-B6 |
| D+14 | Real-time scraping přežije injektovaný block (ARES → firmy.cz failover) | KT-B15 |
| D+21 | Replies UI E2E pokrývá forward, search, label, threading | KT-B14 |
| D+25 | Adversarial sweep findings všechny CRITICAL/HIGH closed; mutation score ≥75% | KT-B7, KT-B9 |
| D+27 | Load test 1000 replies/h zvládá BFF + IMAP poller bez ztráty | KT-B10 |
| D+28 | GDPR DSR access + erase manual run produces auditable artifact | KT-B11 |
| D+29 | Self-healing validation per Tests as Heart Phase 6-7 (chaos cron OK 7d) | KT-B12 |
| D+30 | Bug bash report → 0 unaddressed CRITICAL/HIGH před scale-out | KT-B13 |

## Scope vs non-scope

**Chat B DOES:**
- Test code only — vitest workspace (unit, integration, contract, property, chaos, audit, synthetic, regression, e2e)
- Go test layers — table-driven, race, fuzz, property, discipline ratchets
- Playwright E2E (replies UI deep test)
- LLM classifier accuracy ground-truth labeling
- Mail Lab anonymized replay validation
- Adversarial fuzzing + chaos extensions
- Mutation testing (Stryker)
- Load + reliability testing
- GDPR DSR audit
- Self-healing validation
- Bug bash protocol koordinace
- BOARD updates "Active — wm/tests" + Cross-branch signals (B→A)

**Chat B DOES NOT:**
- **Žádný production code** — bug → signál do Chat A přes reverse trailer
- Žádné nové features — patří do KT-A
- Žádný direct send (operator gates)
- Žádné nové scrapery / ETL — KT-A9
- Žádný operator data fill — KT-A2/A4

## Test architektura

| Layer | Cesta | Pattern |
|---|---|---|
| Vitest workspace | `features/platform/outreach-dashboard/vitest.config.ts` | shared config |
| Unit | `tests/unit/` | Vitest + JSDOM, 284+ files |
| Integration | `tests/integration/` | Postgres testcontainers |
| Contract (BFF) | `tests/contract/` | HTTP fixture + schema |
| Audit (ratchets) | `tests/audit/` | source-text scan + baseline cap |
| Chaos | `tests/chaos/` | fault injection harness |
| Synthetic | `tests/synthetic/` | prod smoke probe |
| Regression | `tests/regression/` | guard-against-known-bugs |
| E2E | `tests/e2e/*.spec.ts` | Playwright, 30+ specs |
| Go discipline | `features/outreach/campaigns/sender/slog_op_audit_test.go` | AST scan + baseline=N constant |
| Go classifier | `features/inbound/orchestrator/llm/reply_classifier_table_test.go` | table-driven |
| Go IMAP | `features/inbound/orchestrator/imap/{poller,monkey,integration}_test.go` | poller harness |
| Go thread | `features/inbound/orchestrator/thread/{inbound,property_monkey}_test.go` | inbound + sentiment |
| Mutation | Stryker `pnpm test:mutation` | per-config |
| Property (JS) | `tests/contract/bff-property-fuzz.contract.test.ts` | fast-check |

**Operátorské fixtury reply** (kostra existuje, prázdná):
```
tests/fixtures/operator-replies/
├── ambiguous/ interested/ not-interested/ ooo/ spam/ wrong-person/
```

Žádné `.eml` fixtury **zatím nejsou commitnuté** — KT-B2/B5 čekají na operátorský export + AT1.x landing.

## 15 sprintů — detail

### KT-B1 — Reply IMAP poll verification + first replies arrive

**Goal:** Po prvním send (KT-A5/A6) ověřit IMAP poller pollnul mb=631/632 a vložil ≥1 reply do `reply_inbox`.

**Acceptance:**
- [ ] `features/inbound/orchestrator/imap/integration_test.go` rozšíření — `PollOnce` vloží ≥1 row do `reply_inbox` (idempotent)
- [ ] BFF kontrakt `tests/contract/bff-replies-stats.contract.test.ts` assert `total_replies > 0` po D+1
- [ ] `features/inbound/orchestrator/imap/poll_once_test.go` race-clean (`go test -race`)
- [ ] Operator vidí first reply v BFF `/api/replies/list`
- [ ] Sentry breadcrumb `imap.poll.success` zachycený v synthetic probe

**Atomic units (≥10 brutal asserts each):**
- B1.1 rozšířit `poll_once_test.go`: empty inbox, malformed message, duplicate UID, large attachment, non-UTF8 subject, X-Lab-Source filter, OOO auto-reply, multi-recipient, missing Message-ID, partial fetch retry
- B1.2 synthetic probe NEW `tests/synthetic/imap-poll-cycle.test.js` (skipped pokud `IMAP_SMOKE=0`)
- B1.3 BFF integration extension `tests/integration/bff-replies-integration.test.ts`
- B1.4 race + property — `imap/monkey_test.go` concurrent pollers

**Dependencies:** KT-A5 (first send 0→1→5), KT-A4 mailbox passwords.
**Days:** 1.
**Risk:** First reply nedorazí (zero open) → fixture inject z `tests/fixtures/operator-replies/interested/`.

### KT-B2 — LLM classifier accuracy on first 20 replies (manual ground-truth)

**Goal:** Změřit reálnou přesnost klasifikátoru. Per `2026-04-27-llm-reply-classifier.md` Sprint E cíl ≥90% při confidence ≥0.7.

**Acceptance:**
- [ ] CSV `docs/test-data/reply-samples-batch1.csv` (20 řádků): id, subject, body, ground_truth_label, llm_label, llm_confidence, agreement, notes
- [ ] Operátor manuálně labeloval všech 20 (gate)
- [ ] Accuracy ≥90% pro confidence ≥0.7, baseline ratchet
- [ ] Confusion matrix `docs/test-data/reply-classifier-confusion-2026-04-30.md`
- [ ] False-positives → KT-B4 override capture
- [ ] `reply_classifier_table_test.go` rozšířen o 20 redacted rows

**Dependencies:** KT-B1, klasifikátor PR shipped, operator gate (20 reálných exportů s SHA-256 redaction).
**Days:** 2.
**Risk:** PII leak → SHA-256 redaction map, žádný plain-text PII v CI.

### KT-B3 — Reply triage workflow E2E

**Goal:** Playwright E2E pokryje flow: list → detail → reply compose → send → status flips. Anti-trace-relay v cestě (NE direct SMTP).

**Acceptance:**
- [ ] `tests/e2e/reply-triage.spec.ts` (NEW) zelený
- [ ] Pokrývá: list → detail → reply compose → send → suppression conditional → status update
- [ ] Mock pre-send abort hook (per ML5.1 PR #260) — žádný reálný send
- [ ] Existující `inbox.spec.ts` + `thread-detail.spec.ts` zelené
- [ ] BFF `bff-replies-forward.contract.test.ts` rozšířen o `POST /api/replies/:id/respond`
- [ ] Discipline ratchet `tests/audit/observability-audit.test.js` — reply send call site má 5 surface markers

**Dependencies:** KT-B1, KT-B2, ML5.1 (#260).
**Days:** 2.

### KT-B4 — Edge case discovery — classifier override capture

**Goal:** Při operátor override → log: text input, LLM label, confidence, operator label, timestamp, reason. Cíl ≥10 overrides do D+5.

**Acceptance:**
- [ ] DB schema `classifier_overrides` (signál Chat A pokud chybí)
- [ ] BFF endpoint `POST /api/replies/:id/override-classifier` test pokrývá
- [ ] React UI override widget v Inbox.tsx má test (KT-B14 deep)
- [ ] Audit log `slog op="reply.classifier.override"` ratcheted
- [ ] `tests/integration/classifier-override.test.ts` (NEW) pokrývá: úprava labelu, audit row, fixture extension flow
- [ ] D+5: ≥10 overrides v DB

**Dependencies:** KT-B2, KT-A schema migration.
**Days:** 2.

### KT-B5 — Mail Lab feedback loop — anonymized replay (post AT1.x)

**Goal:** Prod reply → anonymize (`scripts/operator-practice/anonymize.mjs` PR #266) → lab IMAP (`seed-replies.mjs` PR #264) → time-accel replay (`replay-campaign.sh` PR #268). Klasifikace v lab=prod.

**Acceptance:**
- [ ] AT1.1-AT1.3 PRs merged (gate — pokud ne, B5 odložen)
- [ ] Replay smoke `tests/integration/mail-lab-replay.test.ts` (NEW) zelený
- [ ] Drift report — pokud lab classifier disagrees s prod ≥10%, signál do KT-B12 self-healing recalibration
- [ ] Anonymized reply má `X-Lab-Source: real-anonymized` header
- [ ] PII redaction round-trip — original → anonymize → assert no email/phone/IČO/IBAN/address/names leak

**Brutal asserts target:** ≥10 PII regex coverage (email, phone +420, IČO 8-digit, IBAN CZ, address, person names from CZ surname dictionary, custom org names).

**Dependencies:** AT1.1-A1.3 merged (HARD blocker).
**Days:** 3.
**Risk:** AT1.x neshippnuté → B5 lockne D+7+; alternatively paralelně ladit drift detector na fixturách.

### KT-B6 — Operator Practice OP3-OP5 (timer + override + confusion matrix)

**Goal:** Test infra pro 11 GH issues #270-#280 — OP3 timer per session, OP4 override capture, OP5 confusion matrix UI.

**Acceptance:**
- [ ] `OperatorPracticeTimer.tsx` unit test
- [ ] Confusion matrix widget vykresluje correctly s mock data (E2E)
- [ ] Timer accuracy ±100ms ověřená
- [ ] BFF `/api/operator-practice/sessions/*` contract test
- [ ] Audit ratchet — operator practice call sites mají `op="practice.<action>"`

**Dependencies:** GH issues #270-#280, KT-B5.
**Days:** 3.

### KT-B7 — Adversarial test sweep

**Goal:** Per `2026-04-27-adversarial-fixes.md` — adversarial fuzzing na sender + reply hot paths. Surface NBSP, EN OOO, sarcasm, mixed CZ/EN edge cases PŘED scale.

**Acceptance:**
- [ ] `tests/contract/adversarial-replies.test.ts` (NEW): ≥50 záludných reply vzorků (manual + redact prod, NE Faker)
- [ ] Klasifikátor + keyword fallback + suppression pipeline všechny prošly
- [ ] Identifikované adversarial inputs co selhávají → reverse signál Chat A `Needs-Tests:`
- [ ] BFF `bff-property-fuzz` rozšířen o reply endpoints
- [ ] Sender hot path adversarial — template injection (URL, header, RFC 5322)

**Brutal asserts target:** ≥10 (NBSP, ZWSP, RTL marker, BOM, emoji confusables, homoglyph, multi-byte UTF-8 boundary, RFC 5322 quoted-string edge, MIME boundary collision, attachment >25MB).

**Dependencies:** `2026-04-27-adversarial-fixes.md`, KT-B2.
**Days:** 2.

### KT-B8 — Property + chaos extensions (sender + replies hot paths)

**Goal:** Per `2026-04-26-comprehensive-testing-self-healing.md` Phase 4-5 — chaos cron 7d bez incidentů.

**Acceptance:**
- [ ] `tests/chaos/heal-h1-mailbox-cycle.test.js` baseline drží + reply path added
- [ ] NEW `tests/chaos/reply-poll-chaos.test.js` — random IMAP disconnect, partial fetch, duplicate UID, malformed multipart
- [ ] `features/inbound/orchestrator/thread/n3_inbound_property_test.go` rozšířený — ≥1000 generated inputs, žádný panic, klasifikace deterministic per fixed seed
- [ ] Chaos 7-day cron zelený
- [ ] Mailbox state invariants extension

**Dependencies:** KT-B7.
**Days:** 3.

### KT-B9 — Mutation testing (Stryker)

**Goal:** Mutation testing na critical lib. Mutation score ≥75% pro reply triage + classifier wrapper + suppression UNION.

**Acceptance:**
- [ ] `pnpm test:mutation` zelené, score ≥75%
- [ ] Stryker config cílí: `src/lib/llmReplyClassifier.js`, `src/lib/suppressionUnion.ts`, `campaignPreflight.js`
- [ ] Mutants kterým unikly → nové testy (každý dropped mutant → ≥1 nový test)
- [ ] Discipline ratchet `tests/audit/test-quality-workflow-audit.test.js` má mutation gate

**Dependencies:** KT-B7, KT-B8.
**Days:** 2.

### KT-B10 — Load + reliability testing

**Goal:** BFF + IMAP poller + sender pipeline zvládá 1000 replies/h bez ztráty.

**Acceptance:**
- [ ] `pnpm test:load` zelený s 1000 req/h profilem
- [ ] BFF p95 latency <500ms pro `/api/replies/list`, `/api/replies/:id`
- [ ] IMAP poller throughput ≥100 messages/min
- [ ] Sender 100 mailů/min přes anti-trace-relay
- [ ] Postgres pool exhaustion ne v load test
- [ ] Load report `docs/audits/2026-04-30-load-test.md`

**Dependencies:** KT-B7-B9.
**Days:** 2.

### KT-B11 — GDPR + compliance audit (DSR access + erase)

**Goal:** Manual + automated DSR run. Real DSR endpointy v `features/platform/outreach-dashboard/server.js:410` (access) + `:480` (erase). Runbook `docs/playbooks/dsr-runbook.md`.

**Acceptance:**
- [ ] Manual DSR access run pro 1 testovací subjekt, výstup auditní artifact (JSON)
- [ ] Manual DSR erase run, ověření downstream propagation (suppression, reply_inbox, leads)
- [ ] BFF kontrakt `tests/contract/bff-dsr.contract.test.ts` (NEW) pro `/api/dsr/access` + `/api/dsr/erase`
- [ ] Rate-limit test (`_dsrAllow` 5/min/IP)
- [ ] Privacy artifact: každý DSR call → row v `audit_log`
- [ ] GDPR Art. 15/17/21 + zákon 480/2004 compliance map v `docs/compliance/2026-04-30-dsr-audit.md` (NEW)

**Brutal asserts target:** ≥10 (8 retention buckets per dsr-runbook.md, rate limit roll-over, header injection in email param, SQL injection, auth absence, idempotence on duplicate erase, race on concurrent access+erase, audit log integrity).

**Dependencies:** DSR endpoints v server.js (existují), KT-B5.
**Days:** 2.

### KT-B12 — Self-healing validation (per Tests as Heart)

**Goal:** Per `2026-04-26-comprehensive-testing-self-healing.md` Phase 6-7. Audit ratchets baseline lock + healing SLO + heal explanation.

**Acceptance:**
- [ ] 3 audit ratchets zelené, baseline NE INCREASED
- [ ] `tests/chaos/heal-h2-proxy-watchdog.test.js`, `heal-h6-authcache-ttl.test.js` baseline lock
- [ ] Healing log SQL view rapport — ≥1 healing event/day za 7d
- [ ] Reporter integrace — healing kindy v `system-report.mjs detectBottlenecks`
- [ ] Self-healing playbook `docs/playbooks/self-healing-validation.md` (NEW/update)

**Dependencies:** KT-B8.
**Days:** 2.

### KT-B13 — Bug bash — surface every CRITICAL/HIGH before scale-out

**Goal:** Před scale-out na 1000+ recipients (D+30) — coordinated bug bash. Cíl: 0 unaddressed CRITICAL/HIGH.

**Acceptance:**
- [ ] Všech CRITICAL/HIGH issues otevřené (filter `priority/p1` neclosed) inventarizované
- [ ] Každý CRITICAL/HIGH má fix PR merged NEBO explicit "wontfix" rationale
- [ ] Bug bash report `docs/audits/2026-04-30-bug-bash.md` se severity histogram + root cause
- [ ] Žádné regrese v contract suite baseline
- [ ] Audit ratchet baselines locked at minimum

**Bug bash methodology** (3 paralelní zdroje):

**Source 1 — Adversarial input fuzzing** (KT-B7 corpus):
```bash
pnpm vitest run tests/contract/adversarial-replies.test.ts
pnpm vitest run tests/contract/adversarial-sender.test.ts
go test -tags=property -run TestPropertyMonkey ./features/inbound/orchestrator/thread/
```

**Source 2 — Race condition discovery:**
```bash
go test -race ./services/...
go test -tags=property -race ./features/inbound/orchestrator/...
go test -race -count=100 ./features/inbound/orchestrator/imap/
```

**Source 3 — Parallel agent dispatch (3 paralelní bash sessions):**
- Agent BB-1: `pnpm vitest run tests/chaos/` cyklus 4h
- Agent BB-2: `pnpm e2e --grep="@critical"` cyklus
- Agent BB-3: `go test -race -count=10 ./services/...` cyklus

Output → `docs/audits/2026-04-30-bug-bash.md`. Každý unique fail → GH issue s `priority/p1` + `from/initiative`.

**Severity taxonomy:**
- **CRITICAL:** Data loss, GDPR violation, security exposure, prod-down, false suppression z misclass
- **HIGH:** Test regression, baseline drift, ≥10% accuracy drop, missed reply, DSR partial erase
- **MEDIUM:** UI bug bez data impact, flaky test <5%, observability gap
- **LOW:** Cosmetic, doc typo, log format

CRITICAL/HIGH MUST close před scale-out.

**Dependencies:** KT-B1 až KT-B12.
**Days:** 2.

### KT-B14 — Replies UI deep test (forward, search, label, threading)

**Goal:** Po landing KT-A11/A12/A13 — Playwright deep coverage.

**Acceptance:**
- [ ] `tests/e2e/inbox.spec.ts` rozšíření: forward, search, label, bulk
- [ ] `tests/e2e/thread-detail.spec.ts` rozšíření: threading, parent-child, in-reply-to, references chain
- [ ] `tests/e2e/a11y.spec.ts` rozšíření o reply UI (axe-core)
- [ ] Visual regression snapshot — replies pages
- [ ] Keyboard nav E2E (Tab order, focus trap v compose modal)
- [ ] BFF `bff-replies-stats.contract.test.ts` rozšíření na search filters

**Dependencies:** KT-A11/A12/A13 merged.
**Days:** 2.

### KT-B15 — Real-time scraping chaos validation — block scenarios + recovery

**Goal:** Po landing KT-A7/A8/A9 — chaos test simulující reálný block. Cíl: ≤30s recovery do alternative source.

**Acceptance:**
- [ ] `tests/chaos/scraping-block-chaos.test.js` (NEW): inject HTTP 429, captcha HTML, TCP RST, Mullvad pool exhausted, ARES outage
- [ ] Recovery latency p95 <30s do alternative source
- [ ] Žádný silent fail — block detection emit slog + sentry breadcrumb + healing_log row
- [ ] Refresh cron (KT-A10) cadence respected (NE thrashing)
- [ ] Mullvad wireproxy CZ exit verified (per `project_seznam_proxy_geo_mismatch`)

**Brutal asserts target:** ≥10 (5 block types × CZ exit verify × healing emit × NO direct fallback × refresh cadence).

**Dependencies:** KT-A7, KT-A8, KT-A9.
**Days:** 2.

## Bootstrap protocol pro Chat B (reaktivace)

`docs/handoff/bootstrap-tests.md` označen DORMANT od 2026-04-22. Reaktivace:

```bash
cd /Users/messingtomas/Documents/Projekty/hozan-taher-tests
git fetch origin && git rebase origin/main
cat ../hozan-taher/docs/initiatives/2026-04-30-kampan-vykupu-techniky-B-quality.md
cat ../hozan-taher/docs/handoff/BOARD.md
gh pr list --state open --head wm/development --json number,title,body
gh issue list --label "from/initiative" --label "priority/p1" --state open
git log origin/main --grep="Needs-Tests:" --format="%h %s%n%b" -20
```

**Reading priority:** BOARD "Active — wm/tests" → Cross-branch signals → open `wm/development` PRs s `Needs-Tests:` / `Breaks-Contract:` trailery → KT-A sprint stav.

**Daily commands:**
```bash
cd features/platform/outreach-dashboard
pnpm vitest run tests/{unit,integration,contract,audit,chaos}/
pnpm e2e
pnpm test:mutation
pnpm test:load

cd /Users/messingtomas/Documents/Projekty/hozan-taher-tests
go test -race ./services/...
go test -tags=property ./features/inbound/orchestrator/thread/...
go test -fuzz=FuzzPollOnce -fuzztime=30s ./features/inbound/orchestrator/imap/
```

## Cross-branch signals (B→A)

| Trailer | Význam | Příklad |
|---|---|---|
| `Covers: #<PR>` | Test PR pokrývá kód PR z A | `Covers: #260` |
| `Resolves-Trailer: Needs-Tests: <modul>` | Test PR vyřešil signál z A→B | `Resolves-Trailer: Needs-Tests: reply triage E2E` |
| `Cross-Initiative: KT-B<N>` | Reference master sprint | `Cross-Initiative: KT-B3` |
| `Blocks-On: #<PR>` | Bug v testu blokuje merge (PR comment) | (NE commit trailer) |

**Reverse signál** — Chat B najde bug:
- B→A entry do BOARD "Cross-branch signals"
- Volitelně PR comment: `Blocks-On: <test PR#>`
- **NEPSÁT prod kód** — fix patří do `wm/development`

## Open questions / gates pro operátora

| # | Question | Blokuje | Default |
|---|---|---|---|
| 1 | Real reply export sample (≥20 anonymized) for KT-B2 ground-truth | KT-B2 | manual gate |
| 2 | Permission DSR access + erase against synthetic test subject | KT-B11 | operator + Tomáš sign-off |
| 3 | AT1.1-AT1.3 (Mail Lab + replay) merge schedule | KT-B5 | gate Chat A |
| 4 | OP3-OP5 (timer/override/confusion) shipped Chat A? | KT-B6 | check #270-#280 |
| 5 | KT-A7-A9 (proxy + block + multi-source) merge schedule | KT-B15 | gate Chat A |
| 6 | KT-A11-A13 (UI evolution) merge schedule | KT-B14 | gate Chat A |
| 7 | Operator review override capture daily (≥10 D+5) | KT-B4 | manual |
| 8 | Sentry tunnel + alerting wired pro chaos cron 7-day? | KT-B12 | per Phase 6 Tests as Heart |
| 9 | Mutation score gate v CI? | KT-B9 | manual until ≥75% stable |
| 10 | Bug bash dispatch 4h cont. run | KT-B13 | gate operator hardware |

## Reference

- [Master](2026-04-30-kampan-vykupu-techniky-master.md), [Sourozenec A](2026-04-30-kampan-vykupu-techniky-A-build.md)
- [Tests as Heart](2026-04-26-comprehensive-testing-self-healing.md) — Phase 0-7
- [Adversarial fixes](2026-04-27-adversarial-fixes.md)
- [LLM classifier](2026-04-27-llm-reply-classifier.md) — Sprint A-E
- [Operator flow](2026-04-28-operator-flow-architecture.md)
- [Mail Lab](2026-04-29-mail-lab.md)
- [Operator Practice](2026-04-30-operator-practice.md)
- [bootstrap-tests](../handoff/bootstrap-tests.md), [BOARD](../handoff/BOARD.md), [DISCIPLINE](../playbooks/DISCIPLINE.md)
- [dsr-runbook](../playbooks/dsr-runbook.md), [ROPA](../legal/ROPA.md)
