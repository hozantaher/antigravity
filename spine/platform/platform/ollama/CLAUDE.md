# services/ollama

## Stack
Ollama daemon (raw `ollama/ollama:latest` upstream image) + tenký bash
entrypoint wrapper pro model preload. Žádný Go kód v této service —
HTTP wrapper kontrakt žije v `services/llm-runner/` (per ADR-006 §D1).

## Účel
Serve LLM inference API (`/api/generate`, `/api/chat`, `/api/tags`) na
Railway internal DNS `ollama.railway.internal:11434`. Konzument je
**výhradně** `services/llm-runner` — žádný consumer nesmí volat ollama
přímo (per ADR-006 stable contract argument).

## Hot files
- `Dockerfile` — extends `ollama/ollama:latest` o entrypoint wrapper.
- `entrypoint.sh` — boot daemon + preload `llama3.2:3b` + `llama3.2-vision:11b`.
- `railway.toml` — healthcheck `/api/tags`, restart on-failure.

## Env (Railway secrets)
- `OLLAMA_PRELOAD_TEXT_MODEL` (default `llama3.2:3b`) — text inference model.
- `OLLAMA_PRELOAD_VISION_MODEL` (default `llama3.2-vision:11b`) — vision parser model.
- `OLLAMA_PRELOAD_DISABLE` — set to `1` aby skip preload (debug only).

## Volume
Railway persistent volume mounted at `/root/.ollama` — Ollama default
model cache. Sizing per ADR-006 §D3: 20 GB. Modely:
- `llama3.2:3b` ~ 2 GB digest
- `llama3.2-vision:11b` ~ 7 GB digest
- Headroom pro budoucí modely + Ollama metadata: ~11 GB.

## Don't
- **Nevolej ollama přímo z consumer služeb** — vždy přes `llm-runner`
  wrapper (per ADR-006 §D1 audit/validation/rate-limit gates).
- **Nezveřejni daemon na public Railway URL** — Ollama nemá auth gate.
  Nech `RAILWAY_PUBLIC_DOMAIN` ne-set; consumer používá internal DNS.
- **Nemažte volume** — model re-download = 9+ GB cold start = ~10 min boot.

## Deploy
Viz [`docs/playbooks/llm-runner-deploy.md`](../../docs/playbooks/llm-runner-deploy.md).

## Reference
- [ADR-006 — Ollama Railway deployment](../../docs/decisions/ADR-006-ollama-railway-deployment.md)
- Konzument wrapper: [`services/llm-runner/CLAUDE.md`](../llm-runner/CLAUDE.md)
- Service registry: [`docs/playbooks/SERVICES.md`](../../docs/playbooks/SERVICES.md) → `ollama`
