# Playbook — LLM stack Railway deploy (ollama + llm-runner)

> Status: Active (M+3 deploy)
> Datum: 2026-05-01
> Trigger: M+3 minimal scope deploy → reply classifier + AI návrh + photo parser potřebují živý LLM stack
> Reference: [ADR-006 — Ollama Railway deployment](../decisions/ADR-006-ollama-railway-deployment.md)

## Architektura (recap)

```
consumer services        ──▶  features/platform/llm-runner       ──▶  features/platform/ollama
(orchestrator, inbox)         Railway service:                Railway service:
                              `llm-runner`                    `ollama`
                              Go HTTP wrapper                 raw ollama/ollama:latest
                              port 8092                       port 11434
                              public, X-LLM-Api-Key auth      internal DNS only
```

Per ADR-006 §D1 jsou to **dvě samostatné Railway services**. Daemon
(`ollama`) drží modely a expose-uje `/api/*`. Wrapper (`llm-runner`)
je stable contract pro consumer služby.

## Resource sizing (per ADR-006 §D3)

| Service       | RAM peak | CPU       | Disk           | Railway plan |
|---------------|----------|-----------|----------------|--------------|
| `ollama`      | 8 GB     | 4 vCPU    | 20 GB volume   | Hobby 8 GB   |
| `llm-runner`  | 256 MB   | 0.5 vCPU  | n/a (stateless)| Hobby starter|
| **Total**     | **~$15/měsíc** vs Anthropic ~$90/měsíc (cca 83 % saving) ||

## Deploy postup (operator runbook)

### Předpoklady

- Railway CLI nainstalované (`railway --version`).
- Push prístup na hozan-taher repo.
- Railway projekt `outreach-go` (kde už žijí `anti-trace-relay`,
  `machinery-outreach`, `outreach-db`, `redis`).

### Krok 1 — Deploy `ollama` service

```bash
# 1.1 Service už existuje na Railway (per SERVICES.md). Pokud ne:
railway service create ollama

# 1.2 Connect lokální clone na služby ollama
cd features/platform/ollama
railway link --service ollama

# 1.3 Set env vars (defaults stačí pro M+3, ale explicit je pro audit)
railway variables --set OLLAMA_PRELOAD_TEXT_MODEL=llama3.2:3b
railway variables --set OLLAMA_PRELOAD_VISION_MODEL=llama3.2-vision:11b

# 1.4 Mount persistent volume (jednorázově, přes Railway dashboard)
#     Settings → Volumes → New Volume
#     Mount path: /root/.ollama
#     Size: 20 GB
#     POZN: bez volume se modely re-stahují při každém redeploy
#     (~10 min cold start, ~9 GB egress).

# 1.5 Deploy
railway up

# 1.6 Tail logs — sleduj entrypoint preload progress
railway logs --service ollama
# očekávaný flow:
#   [entrypoint] starting ollama serve on :11434
#   [entrypoint] ollama serve pid=<n>
#   [entrypoint] waiting for ollama API ready
#   [entrypoint] ollama API ready (attempt 1)
#   [entrypoint] preloading text model: llama3.2:3b
#   <ollama download progress>
#   [entrypoint] preloading vision model: llama3.2-vision:11b
#   <ollama download progress>
#   [entrypoint] preload complete; current models:
#     NAME                ID    SIZE   MODIFIED
#     llama3.2:3b         ...   2.0GB  ...
#     llama3.2-vision:11b ...   7.0GB  ...
```

**Cold start expectation:** první deploy ~10 min (volume prázdný, oba
modely stahuje). Subsequent deploys ~30 s (entrypoint vidí cache, `ollama
pull` no-op).

### Krok 2 — Verify `ollama` healthy

```bash
# 2.1 Z Railway dashboard zkontroluj healthcheck status (zelený dot).
# 2.2 Z linked CLI:
railway run --service ollama -- curl -fsS http://localhost:11434/api/tags
# expected: {"models":[{"name":"llama3.2:3b","..."},{"name":"llama3.2-vision:11b","..."}]}

# 2.3 Quick inference smoke test:
railway run --service ollama -- ollama run llama3.2:3b "Reply with one word: ok"
# expected: ok
```

Pokud krok 2.2 neukáže oba modely → re-pull manuálně:

```bash
railway run --service ollama -- ollama pull llama3.2:3b
railway run --service ollama -- ollama pull llama3.2-vision:11b
```

### Krok 3 — Deploy `llm-runner` service

```bash
# 3.1 Vytvoř novou službu (pokud ještě neexistuje):
railway service create llm-runner

# 3.2 Connect:
cd features/platform/llm-runner
railway link --service llm-runner

# 3.3 Set env vars:
railway variables --set OLLAMA_URL=http://ollama.railway.internal:11434
railway variables --set DEFAULT_TEXT_MODEL=llama3.2:3b
railway variables --set DEFAULT_VISION_MODEL=llama3.2-vision:11b
# Optional: API key gate pro /v1/* endpointy
railway variables --set LLM_API_KEY=$(openssl rand -hex 32)

# 3.4 Deploy
railway up

# 3.5 Verify
railway logs --service llm-runner
# expected: {"level":"INFO","msg":"llm-runner starting","port":"8092",
#            "ollama_url":"http://ollama.railway.internal:11434",...}
```

### Krok 4 — Smoke test end-to-end

```bash
# 4.1 Healthz na llm-runner public URL
curl -fsS https://<llm-runner-domain>.up.railway.app/healthz | jq
# expected:
# {
#   "status": "ok",
#   "service": "llm-runner",
#   "models_loaded": ["llama3.2:3b", "llama3.2-vision:11b"],
#   "text_model": "llama3.2:3b",
#   "vision_model": "llama3.2-vision:11b"
# }

# 4.2 Pokud status="degraded" + reason="default models not yet loaded":
#     ollama service ještě dotahuje modely; wait + retry.
#     Pokud >15 min, viz Recovery procedury níže.

# 4.3 Classify smoke test (vyžaduje LLM_API_KEY pokud byl nastaven):
curl -fsS -X POST https://<llm-runner-domain>.up.railway.app/v1/classify \
  -H "Content-Type: application/json" \
  -H "X-LLM-Api-Key: $LLM_API_KEY" \
  -d '{"text":"Děkuji, ale teď ne, možná za měsíc."}'
# expected: {"category":"later","confidence":...}
```

### Krok 5 — Wire consumer služby

```bash
# 5.1 machinery-outreach (orchestrator):
railway link --service machinery-outreach
railway variables --set OLLAMA_URL=http://ollama.railway.internal:11434
railway variables --set LLM_RUNNER_URL=http://llm-runner.railway.internal:8092
# pokud LLM_API_KEY byl nastaven na llm-runner:
railway variables --set LLM_API_KEY=<same-as-llm-runner>

# 5.2 Re-deploy machinery-outreach aby zachytil nové env vars:
railway up --service machinery-outreach

# 5.3 Sleduj logy — orchestrator by měl při příští intel loop / IMAP poll
#     volat llm-runner místo "ollama unreachable" warning.
```

## Recovery procedury

### Případ 1 — `ollama` healthcheck timeout (60 s) první deploy

**Symptom:** Railway dashboard ukazuje deploy FAILED, log končí v
`waiting for ollama API ready` smyčce.

**Příčina:** první boot bez volume cache + low CPU tier; daemon init >60 s.

**Fix:**

1. Zkontroluj že volume je mounted (`/root/.ollama`).
2. Bump healthcheck timeout v `features/platform/ollama/railway.toml` z 60 → 120 s,
   re-deploy. Po prvním úspěšném deployu lze vrátit zpět na 60 s.

### Případ 2 — `ollama pull` selhal (network)

**Symptom:** entrypoint log `WARN: text model pull failed`.

**Fix:**

```bash
railway run --service ollama -- ollama pull llama3.2:3b
railway run --service ollama -- ollama pull llama3.2-vision:11b
```

Daemon zůstává up; llm-runner `/healthz` vrátí status="degraded" dokud
modely nedopadnou. Consumer služby běží v graceful fallback (per ADR-006
§D6 — manual operator triage).

### Případ 3 — `llm-runner` /healthz vrací 503 + ollama_error

**Symptom:** `{"status":"degraded","ollama_error":"connect: connection refused"}`.

**Fix:**

1. Zkontroluj že `OLLAMA_URL` na `llm-runner` ukazuje na Railway internal
   DNS, ne public domain.
   ```bash
   railway variables --service llm-runner | grep OLLAMA_URL
   # expected: OLLAMA_URL=http://ollama.railway.internal:11434
   ```
2. Verify ollama service je up:
   ```bash
   railway status --service ollama
   ```
3. Pokud ollama running, ale connection refused: Railway internal network
   může mít DNS hiccup; force redeploy llm-runner.

### Případ 4 — OOM kill na ollama (vision peak)

**Symptom:** Railway events log "Container was OOMKilled" na ollama service,
vision parser timeout >60 s.

**Fix per ADR-006 §Recovery 2:**

1. Snížit concurrency wrapperu (llm-runner future LLM_VISION_CONCURRENCY=1).
2. Pokud sustained → upgrade Railway plan Hobby → Pro (32 GB RAM tier).
3. Pokud i pak problém → scale ollama service nahoru přes Railway Settings.

## Post-deploy checklist

- [ ] `ollama` Railway service zelený (`/api/tags` 200)
- [ ] `llm-runner` Railway service zelený (`/healthz` 200, models_loaded contains both modely)
- [ ] `machinery-outreach` env má `OLLAMA_URL` + `LLM_RUNNER_URL`
- [ ] Volume `/root/.ollama` mounted, ne-zero usage (≥9 GB po preload)
- [ ] `features/inbound/orchestrator/cmd/outreach/main.go` při startup neloguje "ollama URL not set"
- [ ] SERVICES.md update: `ollama` status z **active (stale) UNUSED v prod** → **active**
- [ ] Smoke test `/v1/classify` s real reply text vrátí jednu z 6 kategorií

## Reference

- [ADR-006 — Ollama Railway deployment](../decisions/ADR-006-ollama-railway-deployment.md)
- [features/platform/ollama/CLAUDE.md](../../features/platform/ollama/CLAUDE.md)
- [features/platform/llm-runner/CLAUDE.md](../../features/platform/llm-runner/CLAUDE.md)
- [docs/playbooks/SERVICES.md](SERVICES.md) → `ollama` + `llm-runner` rows
- Konzument client lib: [features/inbound/orchestrator/llm/client.go](../../features/inbound/orchestrator/llm/client.go)
