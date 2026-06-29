# services/llm-runner

## Stack
Go 1.25, stdlib only (žádný third-party require kromě `common/envconfig`),
single binary HTTP wrapper kolem Ollama daemon. ADR-006 ratifikuje šíř
designu.

## Status (LLM1.1 skeleton)
- `cmd/llm-runner/main.go` — boot + 4 HTTP handlery (`/healthz`,
  `/v1/classify`, `/v1/generate`, `/v1/parse-photo`).
- `internal/ollama/client.go` — thin Ollama HTTP klient.
  `Generate`/`GenerateWithImage` vrací `ErrNotImplemented` — real
  implementace v LLM2.x sprint.
- Endpointy `/v1/*` vrací **501 Not Implemented** v této PR; existují
  jen pro stable contract definici a Railway smoke testy.

## Hot files
- `cmd/llm-runner/main.go` — boot, env config, route mux.
- `internal/ollama/client.go` — Ollama API klient (Ping, ListModels,
  Generate, GenerateWithImage).

## Env
- `PORT` (default `8092`) — HTTP listen port; Railway přepíše.
- `OLLAMA_URL` — required na prod; např.
  `http://ollama.railway.internal:11434`. Pokud unset, healthz reporting
  status="degraded".
- `DEFAULT_TEXT_MODEL` (default `llama3.2:3b`) — pro `/v1/classify`,
  `/v1/generate`.
- `DEFAULT_VISION_MODEL` (default `llama3.2-vision:11b`) — pro
  `/v1/parse-photo`.
- `LLM_API_KEY` — optional; pokud set, vyžaduje `X-LLM-Api-Key` header
  na `/v1/*` endpointech.

## Conventions
- `op` field na každém slog.Info/Warn/Error (per project-wide
  convention v root CLAUDE.md).
- `error` (ne `err`) jako klíč pro chybu.
- Žádný third-party Go require kromě `common` (envconfig).

## Don't
- Nepřidávej cloud LLM fallback bez explicit operator opt-in (per
  `feedback_no_external_services` memory rule).
- Nestreamuj responses — wrapper vrací structured JSON only (per
  ADR-006 §D4).
- Neobcházej audit log path (LLM3.1 přidá `ai_suggestion_audit` insert
  uvnitř handler logic — všechny generation/classification calls musí
  jít skrz tento gate).

## Reference
- [ADR-006 — Ollama Railway deployment](../../docs/decisions/ADR-006-ollama-railway-deployment.md)
- Strategy: `docs/strategy/2026-04-30-m3-minimal-scope.md` §2 LLM stack
- Existing client: `services/orchestrator/llm/client.go` (sister
  knihovna — orchestrator-internal LLM calls; postupně migrate
  na llm-runner v LLM3.x sprint pokud bude smysl).
