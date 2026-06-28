# ADR-006 — Ollama Railway deployment (self-hosted LLM stack pro M+3)

**Status:** Proposed
**Date:** 2026-04-30
**Supersedes:** —
**Related:**
- [ADR-002 — Autonomous Ops Architecture](ADR-002-autonomous-ops-architecture.md)
- [ADR-005 — Airtight dev env](ADR-005-airtight-dev-env.md)
- Strategy: [`docs/strategy/2026-04-30-m3-minimal-scope.md`](../strategy/2026-04-30-m3-minimal-scope.md) §2 LLM stack
- Initiative: [`docs/initiatives/2026-04-27-llm-reply-classifier.md`](../initiatives/2026-04-27-llm-reply-classifier.md)
- Memory rules: `feedback_no_external_services`, `feedback_no_speculation`
- Existing client: `features/inbound/orchestrator/llm/client.go` (Ollama-compatible HTTP)
- Service registry: [`docs/playbooks/SERVICES.md`](../playbooks/SERVICES.md) → `ollama` (kandidát na shutdown 2026-04-22; rehabilitace touto ADR)

## Kontext

M+3 minimal scope (`docs/strategy/2026-04-30-m3-minimal-scope.md`) volí
**self-contained Ollama stack** místo cloud LLM (Anthropic, OpenAI).
Tři distinct workloads:

1. **Reply text classifier** — IMAP poll → 6-kategorií klasifikace
   (interested/meeting/later/objection/negative/ooo). Existující kód
   v `features/inbound/orchestrator/llm/classify.go` a `client.go` už
   Ollama-compatible REST (`/api/generate`). Volume ~144 calls/den
   (24 mailboxů × 20 sendů × 30 % reply rate).
2. **AI návrh generator** — z reply textu + thread historie generuje
   draft odpovědi pro operator approval. Same model jako classifier
   (text-only). Volume ~ten samý jako #1 (one-to-one s reply).
3. **Photo parser (vision)** — z attachmentů (TP, foto techniky) extrahuje
   structured atributy (year/make/model/condition/odometer). Volume
   ~10 attachmentů/den (cca 70 % replies obsahuje attachment, podle
   strategy doc očekávání).

Existující Ollama deploy na Railway (`ollama-production-51cd.up.railway.app`)
běží stale od 2026-04-04, žádný consumer nemá `OLLAMA_URL` env nastaven
(viz `SERVICES.md` Shutdown decisions). Service byl
**kandidát na shutdown** dokud M+3 strategy doc explicit neeskaloval
LLM stack jako required dependency.

Tato ADR stanovuje (a) jestli reusenout existující `ollama` Railway
service vs spawn dedicated `features/platform/llm-runner`, (b) model selection
pro 3 use cases, (c) sizing/latency budget, (d) self-learning loop,
(e) failover strategii.

## Rozhodnutí

### D1 — Dedicated `features/platform/llm-runner` Go HTTP wrapper, ne raw Ollama

Spawn nový Railway service `llm-runner` (Go HTTP server) který interně
volá Ollama daemon. Existující `ollama` Railway service zůstává jako
**model server** (raw `ollama/ollama:latest` image), ale klientský
přístup jde přes wrapper.

```
┌──────────────────────────────────────────────────────────────┐
│ features/inbound/orchestrator    features/inbound/inbox/reply/classify       │
│ (existing consumer)      (planned consumer)                  │
└──────────────────┬─────────────────┬─────────────────────────┘
                   │                 │
                   ▼                 ▼
          ┌────────────────────────────────┐
          │ features/platform/llm-runner (Go)       │
          │ Railway service: llm-runner    │
          │                                │
          │ /v1/classify                   │   ← stable wrapper API
          │ /v1/generate                   │   ← validation, rate limit
          │ /v1/parse-photo                │   ← audit logging
          │ /healthz                       │
          └─────────────────┬──────────────┘
                            │
                            ▼ HTTP (Railway internal)
                  ┌─────────────────────┐
                  │ Railway: ollama      │
                  │ ollama/ollama:latest │
                  │ /api/generate        │
                  │ /api/chat            │
                  └─────────────────────┘
```

**Důvod pro wrapper:**

- **Stable contract** — consumer services nepoužívají Ollama-specific
  schema přímo. Kdybychom v M+6 swapli na llama.cpp, vLLM, nebo zpět
  na cloud LLM (incident recovery), jen `llm-runner` interní handler
  se mění. Kompatibilní s ADR-002 "stable interfaces between services".
- **Validation gate** — input length cap, prompt template enforcement,
  forbidden-token scanner před hit-em models. Raw Ollama API tohle
  nedá.
- **Audit logging** — každá klasifikace + generation jde do
  `ai_suggestion_audit` table (per M+3 strategy §2 storage). Wrapper
  je ideal place pro single-source-of-truth audit insert.
- **Self-learning hook** — quarterly prompt-tuning (D5) potřebuje
  centrální místo kde lze hot-reload Modelfile / few-shot examples
  bez restartu Ollama daemon. Wrapper dělá template injection on the
  fly.
- **Rate limiting** — Railway ollama instance je single GPU/CPU box.
  Wrapper enforce-uje per-tenant limity (1 in-flight vision call max,
  3 in-flight text calls max). Bez wrappers race condition na RAM.

### D2 — Model selection: `llama3.2:3b` (text) + `llama3.2-vision:11b` (vision)

| Use case            | Model                  | RAM   | CPU       | Latency cíl |
|---------------------|-------------------------|-------|-----------|-------------|
| Reply classifier    | `llama3.2:3b`          | ~2 GB | 4 vCPU    | ≤ 3 s       |
| AI návrh generator  | `llama3.2:3b`          | ~2 GB | 4 vCPU    | ≤ 5 s       |
| Photo parser        | `llama3.2-vision:11b`  | ~7 GB | 4 vCPU    | ≤ 30 s      |

Model selection rationale:

- **`llama3.2:3b`** — Meta release Q4 2024, instruction-tuned, 3B
  parametrů. CPU-friendly (žádný GPU need pro 144 calls/den). Czech
  jazyk solidně (testováno v `features/inbound/orchestrator/llm/k3_llm_test.go`
  proti `gemma2:2b` baseline; 3.2:3b vyhrává na few-shot CZ examples).
  Volně licensované (Llama 3.2 Community License), žádný runtime cost
  jako Anthropic API.
- **`llama3.2-vision:11b`** — multimodal, akceptuje image+text. 11B
  parametrů → CPU-only inference je pomalý (~30 s/photo), ale
  M+3 photo workload je batch-friendly (operator approval flow má
  několik-minut latency budget per reply). Pro Phase 4+ (post-M+3)
  upgrade na GPU instance pokud volume vzroste.

Alternativní zvažované modely:
- `gemma2:2b` (current default v `features/inbound/orchestrator/llm/client.go`)
  → menší (1.6 GB RAM) ale slabší na CZ instruction-following per
  k3_llm_test baseline. Necháme jako fallback ENV override.
- `llava:7b` (vision alternative) → starší architektura, nižší
  accuracy než llama3.2-vision na multimodal tasks (per Meta blog).
- `phi-3-mini:3.8b` (Microsoft) → comparable size, ale CZ podpora
  horší, license více restriktivní pro commercial use.

### D3 — Sizing budget: Railway $10/měsíc kompromis

| Resource              | Estimát        | Railway plan       |
|-----------------------|----------------|---------------------|
| `ollama` service RAM  | 8 GB (peak)    | Hobby 8GB plan      |
| `ollama` service CPU  | 4 vCPU         | included            |
| `llm-runner` service  | 256 MB / 0.5 vCPU | Hobby starter   |
| Persistent volume     | 20 GB (models) | $0.25/GB/měsíc      |
| **Total compute**     | **~$15/měsíc** | (vs Anthropic ~$200/měsíc pro stejný volume) |

Volume calc: 144 reply classifications + 144 návrhů + 10 vision
parses = ~298 calls/den. Anthropic Sonnet 4.6 pricing 2026-04
($3/M input + $15/M output, ~500 tokens avg per text call,
~2000 tokens per vision call) = ~$2.50/den text + ~$0.50/den vision
= ~$90/měsíc Anthropic. **Self-hosted Railway ~$15/měsíc =
~83 % saving**.

**Budget cliff:** pokud volume roste 5× (Phase 4 scale), Anthropic
dosáhne ~$450/měsíc, Railway ollama při unchanged sizing crash-loop
(out of RAM). Recovery: upgrade na Railway Pro $20/měsíc + GPU
add-on $50/měsíc = $70/měsíc → still ~85 % saving vs cloud.

### D4 — Latence: batch processing OK, ne realtime

- **Reply classifier**: 3 s P95 latence acceptable. Trigger je IMAP
  poll cycle (60 s intervaly), reply objeví v queue 0–60 s po doručení,
  klasifikace +3 s je bezvýznamná.
- **AI návrh generator**: 5 s P95 latence acceptable. Trigger je
  operator otevře thread → spinner se ukazuje 5 s → operator vidí
  draft. UX-acceptable per ADR-004 operator-practice training data.
- **Photo parser**: 30 s P95 latence acceptable. Trigger je reply má
  attachment → background batch job (per `features/inbound/inbox/poll`) →
  vision parser běží async, výsledek se zobrazí v thread UI po refresh
  (push notification post-M+3).

**Žádný streaming response** (Ollama support, ale wrapper API ne).
Důvod: response shape musí být structured JSON (classification
category enum, návrh draft text), ne raw text stream. Streaming by
přidalo complexity bez UX value pro M+3.

### D5 — Self-learning loop přes prompt-tuning, ne fine-tune

Ollama nepodporuje LoRA fine-tune in-place; full model retrain je
GPU-heavy a operator-side znalost neúměrná. Místo toho:

```
┌──────────────────────────────────────────────────────────────┐
│ Operator override v UI (per-firma timeline)                  │
│   AI navrhne: "kategorie=interested"                         │
│   Operator override: "kategorie=objection-price"             │
└─────────────────────────┬────────────────────────────────────┘
                          ▼
        ┌────────────────────────────────────┐
        │ INSERT into ai_suggestion_audit    │
        │   (suggestion, override, reason)   │
        └────────────────┬───────────────────┘
                         ▼
        ┌────────────────────────────────────┐
        │ quarterly cron (Mar/Jun/Sep/Dec)   │
        │ features/platform/llm-runner/cron/promptkit │
        │   1. SELECT top-50 overrides       │
        │   2. group by category             │
        │   3. emit Modelfile FEW_SHOT       │
        │   4. ollama create llama3.2:3b-tuned-vN -f Modelfile │
        │   5. update llm-runner DEFAULT_MODEL env             │
        └────────────────────────────────────┘
```

Modelfile pattern (per Ollama docs):

```
FROM llama3.2:3b
SYSTEM "Jsi klasifikátor odpovědí na výkup techniky..."
MESSAGE user "Děkujeme, ale teď ne..."
MESSAGE assistant "later"
... (50 examples accumulated)
```

**Žádný fine-tune** = žádné accidental personal-data exposure (PII
embedding ve weight space). Few-shot examples žijí v Modelfile a lze
je auditovat / mazat per ADR-002 §audit.

### D6 — Failover: degradace, ne fallback na cloud

Pokud `llm-runner` nebo `ollama` Railway down:

```
┌────────────────────────────────────────────────────┐
│ features/inbound/inbox/reply/classify                       │
│   → llm-runner unreachable                          │
│   → fall back: classification = "needs_review"     │
│   → operator UI flag "AI not available, manual"    │
└────────────────────────────────────────────────────┘
```

**Žádný cloud LLM fallback** v M+3 (per `feedback_no_external_services`
memory rule). Pokud Ollama down >24h, operator klasifikuje manuálně.
Acceptable degradation pro 3000 emails/měsíc volume.

V Phase 4+ (post-M+3) zvážit cloud fallback s explicit operator
opt-in (žádné default-cloud).

## Důsledky

### Pozitivní

- **~83 % saving** vs cloud LLM (~$15 vs ~$90 Anthropic monthly)
- **Žádný subprocessor** — interní processing per Recital 47, nemusíme
  doplňovat ROPA Činnost o Anthropic/OpenAI processor (per M+3 strategy
  §2 GDPR layer)
- **Wrapper stable contract** — výměna underlying model server bez
  consumer change
- **Audit trail** centralized — `llm-runner` je single point pro
  audit insert (vs ad-hoc audit v každém consumer)
- **Self-learning bez retrain risk** — prompt-tuning je auditable a
  reversible (delete Modelfile vN, fall back vN-1)

### Negativní

- **CPU latency penalty** — vision parser 30s je acceptable pro M+3
  volume, ale post-M+3 5× scale = blocking → GPU upgrade required
- **Two Railway services** misto one → operational overhead (env vars,
  health checks, logs); mitigace: `features/platform/common/envconfig.MustHave`
  za boot validation, `/healthz` na llm-runner pings ollama
- **No automatic cloud fallback** — operator manuální triage při
  outage (acceptable per memory rule)
- **Model drift** — Ollama image upgrade může změnit response shape
  sutilně; mitigace: `features/inbound/orchestrator/llm/llm_test.go` golden
  fixtures + wrapper integration test pinned na konkrétní model tag
  (`llama3.2:3b@<digest>` post-M+3, currently floating tag pro speed)
- **Account ban risk (Railway TOS)** — žádný explicit precedent pro
  shutdown LLM-self-host workloads; CPU/RAM usage jasný (žádné mining
  signature, žádný outbound spam). Pokud Railway TOS update zakáže LLM
  hosting, migrace na Hetzner / DigitalOcean dedicated 1-2 dny práce
  (Docker compose portable)
- **Memory exhaustion (vision peak)** — `llama3.2-vision:11b` peak ~7
  GB; concurrent text+vision call → OOM kill. Mitigace: wrapper
  semaphore enforces max 1 vision in-flight (D1)

### Neutrální

- Existující `features/inbound/orchestrator/llm/client.go` zůstává jako Go
  klient knihovna pro orchestrator-internal calls (intel loop,
  enrichment), nepůjde přes llm-runner v M+3 (později můžeme
  konsolidovat). Reply classifier + photo parser jsou nové consumer
  cesty, ty volají llm-runner přímo.
- `OLLAMA_URL` env var pattern (per `features/inbound/orchestrator/cmd/outreach/main.go`)
  zůstává; llm-runner adds `LLM_RUNNER_URL` pro consumer (orchestrator,
  inbox).

## Recovery procedury

### Případ 1 — `llm-runner` health check fails (boot loop)

Symptom: Railway dashboard shows llm-runner crash-loop, `/healthz`
non-200, consumer services log `llm runner unreachable`.

Recovery:
```bash
# 1. Check llm-runner logs in Railway dashboard
#    Likely cause: OLLAMA_URL points to stale ollama service URL
# 2. Verify ollama service running independently:
curl http://ollama.railway.internal:11434/api/tags
# 3. Update LLM_RUNNER_URL or fix OLLAMA_URL env in llm-runner
# 4. Force redeploy
```

### Případ 2 — Ollama OOM kill (peak vision load)

Symptom: ollama service OOM event v Railway dashboard, vision
classification timeouts > 60 s.

Recovery:
```bash
# 1. Reduce wrapper concurrency limit (LLM_VISION_CONCURRENCY=1 default)
# 2. If sustained, upgrade Railway plan from Hobby → Pro
# 3. If still problem, scale ollama service up RAM tier
```

### Případ 3 — Self-learning prompt regression

Symptom: po quarterly prompt-tuning rollout override rate vzroste
(operator přepisuje AI častěji než před tuning).

Recovery:
```bash
# 1. Roll back DEFAULT_MODEL env to previous version (vN-1)
# 2. Restart llm-runner — picks up env, calls old Modelfile
# 3. Open issue: investigate which override examples poisoned tuning
# 4. Manual review of accumulated overrides before next quarterly cron
```

## Rejected alternatives

### A — Cloud LLM (Anthropic Sonnet, OpenAI gpt-4o-mini)

Odmítnuto:
- Cost ~6× vs self-hosted (D3 budget)
- Subprocessor expansion v ROPA
- Memory rule `feedback_no_external_services` explicit BAN
- Recovery story horší (dependency on external availability)

### B — Reuse existing Railway `ollama` service přímo bez wrapper

Odmítnuto (D1):
- Žádný validation gate (input cap, prompt template)
- Žádný centralized audit insert path
- Self-learning loop musí žít někde — pokud ne wrapper, tak per-consumer
  duplikace (orchestrator + inbox + photo-parser každý vlastní logic)
- Stable contract argument (wrapper API zachovaný i po změně backend)

### C — llama.cpp místo Ollama (tighter binary)

Odmítnuto:
- Ollama API už integrated v `features/inbound/orchestrator/llm/client.go`
- llama.cpp HTTP server méně mature
- Migration cost > savings (žádný measurable performance delta pro
  M+3 volume)

### D — vLLM (continuous batching, GPU-optimized)

Odmítnuto pro M+3:
- Vyžaduje GPU (Railway Hobby plan no GPU)
- M+3 volume ~300 calls/den nedosahuje continuous batching break-even
- Phase 4+ zvážit, pokud volume vzroste 10×

### E — Fine-tuning (LoRA na Phi-3 / Llama 3.2)

Odmítnuto (D5):
- Operator-side znalost zbytečná pro 50 examples/quarter
- PII embedding risk ve weight space
- Few-shot prompt-tuning postačí pro M+3 accuracy cíl ≤25 % override
  rate (per strategy doc týden 9 acceptance)

## Implementation plan

| Sprint | Obsah | Dependency |
|---|---|---|
| LLM1.1 | THIS ADR + skeleton service `features/platform/llm-runner/` | — |
| LLM1.2 | go.work register, Dockerfile, `/healthz` smoke | LLM1.1 |
| LLM1.3 | Ollama daemon Railway service redeploy + model preload (`llama3.2:3b`, `llama3.2-vision:11b`) | LLM1.2 |
| LLM2.1 | `/v1/classify` real implementation (replace stub) | LLM1.3 |
| LLM2.2 | `/v1/generate` real implementation | LLM2.1 |
| LLM2.3 | `/v1/parse-photo` real implementation | LLM2.1 |
| LLM3.1 | `ai_suggestion_audit` schema + wrapper insert path | LLM2.2 |
| LLM4.1 | Quarterly cron `cron/promptkit` skeleton | LLM3.1 |
| LLM4.2 | Modelfile generator + ollama create automation | LLM4.1 |

Issues `[LLM1.x]`–`[LLM4.x]` v GH backlog (vytvoří follow-up PR po
landing této ADR).

## Reference

- ADR-002 — multi-agent ops kontext, stable interface principle
- ADR-005 — airtight dev env (LAB_ONLY pattern shoduje s LLM disable
  pattern: `LLM_RUNNER_URL=""` → consumer skips LLM calls)
- Strategy: `docs/strategy/2026-04-30-m3-minimal-scope.md` §2 LLM stack
- Memory: `feedback_no_external_services`, `feedback_no_speculation`
- Existing client: `features/inbound/orchestrator/llm/client.go`
- Service registry: `docs/playbooks/SERVICES.md` → `ollama` rehab
- Initiative: `docs/initiatives/2026-04-27-llm-reply-classifier.md`
