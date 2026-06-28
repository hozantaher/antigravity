# Operator Practice — hands-on triage / classify / reply tréninkové prostředí

**Status:** active (draft → schválení v této session)
**Created:** 2026-04-30
**Owner:** Tomáš (gates: prod export, anonymization rules, distribuce klasifikací) + Chat A (autonomous: build + tests + docs)
**Trigger:** 2026-04-30, user explicitly pivoted od provider-side simulace (Mail Lab) na operátorský denní loop. "Potřebuju trénovat přijímání mailu, odpovídání, kategorizaci e-mailu, apod."

## Problém

Operátor (Tomáš) běží denně tento loop:

```
1. Otevři dashboard → vidíš inbox s novými odpověďmi
2. Klikni thread → ThreadDetail (HTML render + přílohy)
3. LLM auto-klasifikuje (interested / OOO / wrong-person / not-interested / spam)
4. Potvrď nebo přepiš klasifikaci
5. Drafts reply (template OR custom)
6. Send → out
```

**Aktuálně tento loop NELZE trénovat bez prod dat.**

Jediný způsob jak vidět chování pipeline je posílat reálné kampaně reálným prospektům a čekat na odpovědi. To je **destruktivní** (reální lidé), pomalé (odpovědi přicházejí dny), a měřitelné jen retrospektivně (žádný kontrolovaný experiment).

Důsledky:
- **Klasifikator quality unknown.** LLM Reply Classifier (`docs/initiatives/2026-04-27-llm-reply-classifier.md`) běží proti prod, ale neměříme accuracy proti ground-truth setu.
- **UX iterace pomalé.** Změnit ThreadDetail layout → vyzkoušet → znamená čekat na real reply. Per `feedback_iteration_workflow` chceme rychlý cyklus.
- **Edge cases nikdo nezachytí.** Jak se chová render při HTML s embedded image, multipart/related, base64 přílohy, neexistující charset? Real flow tyto scénáře pokrývá náhodně.
- **Nový operátor netrénuje.** Onboarding znamená "tady máš live inbox, nezkrouhej dotazem zákazníka". Žádný safe playground.

## Cíl

**Indistinguishable-from-prod operátorský playground.** Stejné UI, stejný SSE push, stejný LLM klasifikator, stejné šablony — ale proti **lab inboxu seedovanému anonymized real replies**.

Měřitelné:
- Operator může 1 příkazem injektovat 25 anonymized odpovědí do `op@gmail.lab` během 5s
- Time-accelerated arrival: 50 odpovědí přes 24h zkomprimováno do 60s SSE-pushed dashboard updates
- Workflow timer: kolik vteřin operátor tráví per thread, kde override LLM
- Confusion matrix dashboard: classifier accuracy proti operátorovým override volbám

## Non-goals

- Provider behavioral edge cases (rate limit, DKIM strictness, greylist) — pokrývá samostatná Mail Lab initiative (#212)
- Outbound delivery testing (campaign send pipeline) — pokrývá `2026-04-22-send-pipeline-unblock.md` + ML stack
- LLM model změny / fine-tuning — `2026-04-27-llm-reply-classifier.md`
- Synthetic reply generation — **per `feedback_no_fabricated_test_data` HARD RULE**: pouze real anonymized data, žádné LLM-generated samples

## Constraints

| # | Pravidlo | Zdroj | Aplikace |
|---|---|---|---|
| 1 | Pouze real anonymized data | `feedback_no_fabricated_test_data` | OP1.2 anonymizer = MUST; žádné `Faker.email()` |
| 2 | GDPR Art. 6/1/f legitimate interest | `docs/legal/lia-direct-marketing.md` | Anonymized reply fixtures = vnitřní system improvement |
| 3 | No external services | `feedback_no_external_services` | Anonymizace lokálně (nikoli OpenAI / Anthropic API) |
| 4 | No campaign send | `feedback_campaign_send` | Tréninkové prostředí NIKDY netriggeruje real campaign run |
| 5 | Local docker stack | `feedback_no_external_services` | Mail Lab (existující) jako IMAP/SMTP provider |
| 6 | Brutal testing | `feedback_extreme_testing` | ≥10 asserts per atomic unit |

## Architektura

### Datový tok

```
[prod orchestrator DB]
   outreach_messages (real replies)
        ↓ export script (OP1.2)
[anonymized .eml fixtures]
   tests/fixtures/operator-replies/
   ├── interested/ (~20 .eml)
   ├── not-interested/ (~20)
   ├── ooo/ (~10)
   ├── wrong-person/ (~10)
   ├── spam/ (~5)
   └── ambiguous/ (~5) — pro classifier edge cases
        ↓ replay script (OP1.3, OP2.2)
[lab IMAP append]
   IMAP APPEND → mail-lab-gmail:993 → op@gmail.lab inbox
        ↓
[orchestrator IMAP poll] (existující, S1.2 #229)
        ↓
[MIME parse + persist] (existující, S1.3-S1.4)
        ↓
[BFF SSE push] (existující, S3.1-S3.3)
        ↓
[dashboard ThreadDetail] (existující, S2.3 #236)
        ↓
[operátor klasifikuje]
   timer start (OP3.1) → click classification → timer stop
        ↓
[OP3.2 capture: { thread_id, llm_predicted, operator_chose, latency_ms }]
        ↓
[OP4 confusion matrix dashboard]
```

### Klíčové stavební kameny

| Komponenta | Existuje? | Co chybí |
|---|---|---|
| IMAP poller | ✓ (S1.2 #229) | Pointing at lab port (29993 toxiproxy / 25993 raw) |
| MIME parser | ✓ (S1.3 #230) | — |
| Sanitize + persist | ✓ (S1.4 #231) | — |
| SSE push | ✓ (S3.1-3.3) | — |
| ThreadDetail | ✓ (S2.3 #236) | — |
| LLM classifier | ✓ (initiative aktivní) | Quality measurement loop |
| Inbound generator | ✗ | OP1.2 anonymizer + OP1.3 IMAP injector |
| Time accel | ✗ | OP2.x sprint |
| Workflow timer | ✗ | OP3.1 instrumentace |
| Accuracy capture | ✗ | OP3.2 + OP4.x |
| Confusion dashboard | ✗ | OP4.3 BFF endpoint + UI panel |

## Sprint plán

### Sprint OP1 — POC + first usable replay (~2 dny)

**Cíl:** Operator může injektnout 10 anonymized odpovědí do `op@gmail.lab` jedním příkazem, otevřít dashboard, vidět je tam, kliknout, klasifikovat.

| ID | Subject | Acceptance |
|---|---|---|
| OP1.1 | Define `tests/fixtures/operator-replies/` schema | README explains category subdir + .eml format + minimum metadata (X-Lab-Category header for ground truth) |
| OP1.2 | Anonymizer: prod export → fixtures | `scripts/operator-practice/anonymize.mjs <prod.sql> <out-dir>`. Strip names (regex + namedb), emails (replace @company.cz with @anon.lab), phone (CZ +420 patterns), URLs (preserve domain pattern, randomize path). Manual review checklist printed at end. ≥15 asserts. |
| OP1.3 | IMAP injector: fixture → lab inbox | `scripts/mail-lab/seed-replies.sh <count> <mailbox> [--category <name>]`. IMAP APPEND via curl/imap-cli into lab. ≥10 asserts. |
| OP1.4 | Smoke E2E: boot lab → seed 10 → dashboard sees 10 | Playwright test: lab up, run injector, open Replies page, assert ≥10 threads visible, each has correct category header in DB. ≥10 asserts. |
| OP1.5 | Operator playbook | `docs/playbooks/operator-practice.md` — quickstart, daily training routine, expected timings. Audit test for TOC + section count. |

**Definition of Done OP1:**
- [ ] Operator runs `bash scripts/mail-lab/up.sh` + `bash scripts/mail-lab/seed-replies.sh 10 op@gmail.lab`
- [ ] Operator opens dashboard, sees 10 new threads in `/replies` page within 30s
- [ ] Klasifikuje všech 10, vidí stats update
- [ ] Žádný real PII v žádné fixture (manual sample audit)

### Sprint OP2 — Time-accelerated arrival (~2 dny)

**Cíl:** Místo "10 zpráv najednou" simulovat reálnou křivku: "50 odpovědí přes 24h, ale stlačeno do 60s pro dashboard SSE flow."

| ID | Subject | Acceptance |
|---|---|---|
| OP2.1 | Arrival curve generator | `scripts/operator-practice/arrival-curve.mjs <campaign-size> <duration-h>` returns JSON `[{delay_ms, fixture_path}]` per real-world distribution (capture from prod). ≥10 asserts. |
| OP2.2 | Replay scheduler | `scripts/mail-lab/replay-campaign.sh <curve.json> <mailbox> [--accel 86400]` — accel=86400 means 24h → 1s. Spawns one IMAP append per delay_ms. ≥10 asserts. |
| OP2.3 | SSE delivery verification | Playwright spec: schedule 20 replies over 5min real-time / 5s accel-time, assert all 20 SSE events received in correct order. ≥10 asserts. |
| OP2.4 | Reset between runs | `scripts/mail-lab/clear-inbox.sh <mailbox>` — IMAP DELETE all + EXPUNGE. Idempotent. ≥5 asserts. |

**Definition of Done OP2:**
- [ ] Operator runs `replay-campaign.sh curves/seznam-baseline.json op@gmail.lab --accel 1440`
- [ ] 50 replies arrive over 60s real-time on dashboard, distributed per real curve
- [ ] Reset → run again identical scenario for repeat practice

### Sprint OP3 — Workflow measurement (~2 dny)

**Cíl:** Měřit kolik trvá triage + kde operátor přepisuje LLM. Bez měření nemá zlepšování signál.

| ID | Subject | Acceptance |
|---|---|---|
| OP3.1 | Timer instrumentation | BFF emits `operator.thread_opened` (+ `operator.thread_classified`) events with `{thread_id, llm_predicted, latency_ms}` to new table `operator_practice_events`. Wired in `features/platform/outreach-dashboard/src/pages/ThreadDetail.jsx`. ≥10 asserts. |
| OP3.2 | Override capture | When operator overrides LLM classification, capture `{thread_id, llm_label, operator_label, override_reason?}`. Stored in `operator_practice_overrides`. ≥10 asserts. |
| OP3.3 | Daily stats panel | Dashboard widget: "today: 23 threads classified, 5 LLM overrides (78% accuracy), median 12s/thread". Updates in real-time. ≥10 asserts. |
| OP3.4 | Practice mode toggle | Header button "Practice Mode On/Off" — when ON, all events go to `_practice` tables (separate from prod analytics). ≥10 asserts. |

**Definition of Done OP3:**
- [ ] After OP1 + OP2 + OP3 land, operator sees: "trained 50 replies in 8min 23s; classifier accuracy 84%"
- [ ] Practice mode separates training data from prod analytics

### Sprint OP4 — Classifier feedback loop (~3 dny)

**Cíl:** Operator override → label růst → re-evaluate classifier → confusion matrix. Bez tohoto loop classifier kvalita stagnuje.

| ID | Subject | Acceptance |
|---|---|---|
| OP4.1 | Override → labeled training set | View `operator_practice_overrides` joined to `outreach_messages.body_text` produces ground-truth labeled rows. Export script `scripts/operator-practice/export-labels.mjs <out.jsonl>`. ≥10 asserts. |
| OP4.2 | Re-evaluate classifier on growing set | `scripts/operator-practice/eval-classifier.mjs <labels.jsonl>` runs LLM classifier on every labeled message, computes accuracy/precision/recall per class. ≥10 asserts. |
| OP4.3 | Confusion matrix BFF + UI | New endpoint `GET /api/practice/confusion-matrix` returns 5x5 matrix per ground truth label. Dashboard panel renders matrix with hover tooltip showing 3 sample misclassifications per cell. ≥15 asserts. |
| OP4.4 | Edge case discovery | Script flags messages where LLM confidence is high but operator overrides — classified as "edge cases" surfaced in dashboard. ≥10 asserts. |

**Definition of Done OP4:**
- [ ] Confusion matrix updates as operator practices
- [ ] Edge cases flagged for prompt tuning (feeds into LLM Reply Classifier initiative)

### Sprint OP5 — Initiative wrap (~1 den)

**Cíl:** End-to-end Playwright + final docs + closure check.

| ID | Subject | Acceptance |
|---|---|---|
| OP5.1 | E2E Playwright spec | Full operator workflow: boot → seed 25 → classify all → verify timer + override capture + confusion matrix updated. ≥15 asserts. |
| OP5.2 | Operator runbook (final) | `docs/playbooks/operator-practice.md` updated with all sprints, known gotchas, troubleshooting. |
| OP5.3 | Metrics export | Daily collector includes operator practice metrics (per-day accuracy + median latency). Adds to `docs/metrics/daily.jsonl`. ≥5 asserts. |

## Acceptance celé iniciativy

- [ ] Operator může spustit `pnpm operator:practice 50` a dostat zkomprimovaný 24h scénář během 5min real-time
- [ ] Po cvičení vidí: thread count, accuracy, override count, edge cases
- [ ] Žádné syntetické samples použité kdekoli (audit grep "Faker\|fake-" returns 0 hits in tests/fixtures/operator-replies/)
- [ ] Confusion matrix updates každých 5 min, dashboard widget visible
- [ ] LLM classifier initiative pickuje edge cases z OP4.4 jako prompt-tuning input

## Risks + dependencies

### Závislosti
- **mail-client-fidelity stack** (#192, 17 PRs in flight) — bez S1.2-S1.4 (IMAP fetch + parse + persist) nelze poll lab inbox. **Blocker pro OP1.4 onwards.** OP1.1-OP1.3 můžou jet paralelně.
- **Mail Lab stack** (ML2.1 multi-provider #246) — bez gmail.lab nemá kam injektnout, dnes existuje jen seznam.lab.
- **LLM Reply Classifier initiative** — runs in tandem; OP4.4 edge cases feeduje classifier prompt tuning.

### Rizika
| Riziko | Mitigace |
|---|---|
| Anonymizer nezachytí všechno PII | Manual review checklist v OP1.2 + spot audit script |
| Lab IMAP append breaks RFC822 boundary | Use existing fixture-loader from harness; round-trip parse before append |
| LLM API rate limit při OP4.2 eval | Local Ollama model option per `2026-04-27-llm-reply-classifier.md`; cache eval results per message hash |
| Operator practice events leak to prod analytics | OP3.4 toggle gates separation; audit query "any practice rows in prod tables" |
| Time-accel breaks SSE buffer | OP2.3 explicit ordering test catches |

### Open questions for user

| # | Question | Blocking? |
|---|---|---|
| 1 | Máš export reálných odpovědí z prod orchestrator? Kolik (100 / 500 / 1000)? | **OP1.2** — bez exportu nelze začít |
| 2 | Distribuce klasifikací známá (kolik % interested vs OOO vs ...) nebo zjistíme? | OP1.1 — schema design záleží |
| 3 | Anonymizer rules — máš preferovaný regex/PII list, nebo já navrhnu? | OP1.2 — výchozí návrh stačí, můžeme iterovat |
| 4 | LLM model — Ollama lokálně, nebo Claude API? | OP4.2 — Ollama default per `feedback_no_external_services` |
| 5 | Mail Lab multi-provider (gmail.lab) ready před OP1.4? | OP1.4 onwards — pokud ne, fallback na seznam.lab |

## Spojení s ostatními iniciativami

- **2026-04-27-llm-reply-classifier.md** — OP4 měří + feeduje edge cases zpět; obě běží paralelně
- **2026-04-28-operator-flow-architecture.md** — operátorská UX coherence; OP3.3 dashboard panel je její kandidát
- **2026-04-29-mail-lab.md** — OP používá Mail Lab jako IMAP/SMTP provider; ML2.1 je hard dependency

## Quick Start cesta (Cesta A z user pre-discussion)

Pokud user chce dnes večer trénovat (před plnou iniciativou):

1. **Tomáš:** Export 10-20 reálných odpovědí z prod (SQL `SELECT body_html, body_text, classification FROM outreach_messages WHERE direction='inbound' LIMIT 20`).
2. **Chat A:** OP1.1 + OP1.2 (anonymizer) + OP1.3 (IMAP injector) v jednom PR.
3. **Tomáš:** Run `bash scripts/mail-lab/seed-replies.sh 10 op@gmail.lab`.
4. **Tomáš:** Open dashboard `/replies`, klasifikuj.

Hotovo. OP2-OP5 jako follow-on.

## Total scope

- **5 sprintů, 19 atomických unitů**
- **~10 dní práce** (Chat A autonomous + user gates)
- **Brutal asserts target:** ≥200 ( aprox 10-15 per atomic unit)
- **PRs:** ~10-15 (per atomic unit, někdy bundle)

## Status tracking

Per CLAUDE.md backlog protocol: každý OP-prefixed task → GitHub issue s `[OP1.x]` titulkem + label `priority/p1` + `automation/ok`. PR titles include `[OPx.y]` for discoverability.
