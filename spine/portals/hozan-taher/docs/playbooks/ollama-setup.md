# Ollama Setup — Reply Classifier (G3.5)

## Status (2026-05-29)

The reply classifier (`classifyReplyWithLLM`) has a two-stage pipeline:
1. **Regex stage** — always runs, fast, `classifier_version: regex_v1`
2. **Ollama stage** — runs when regex confidence < `LLM_TRIGGER_THRESHOLD` (0.75)

The Ollama stage requires `LLM_RUNNER_URL` to be set. Without it, the
`llmRunnerClient.js` returns `{ ok: false }` silently and the regex verdict
is used as final.

## Why pre_classification shows intent=null, confidence=0.3

The regex classifier's `CONFIDENCE_FALLBACK = 0.3` is returned when no
pattern matches the input text. Root cause (diagnosed 2026-05-29):

- `loadReplyContent` was joining `outreach_messages` (outbound sent body)
  instead of `channel_messages` (inbound reply body).
- The outbound body never matches reply-intent patterns → `intent=null`.
- Fixed in G3.5: `loadReplyContent` now joins `channel_messages` on
  `from_handle + direction='inbound' + received_at ±5 min`.

## Bootstrap (operator machine)

```bash
# Install Ollama
brew install ollama

# Start Ollama daemon (background)
ollama serve &

# Pull the default model
ollama pull llama3.2:3b

# Verify
curl -s http://localhost:11434/api/tags | jq '.models[].name'
# Expected: ["llama3.2:3b"]
```

## Wire into BFF

Add to `features/platform/outreach-dashboard/.env`:

```bash
LLM_RUNNER_URL=http://localhost:<llm-runner-port>
# e.g. if llm-runner runs locally:
# LLM_RUNNER_URL=http://localhost:8090
```

The `llm-runner` Go service (`features/platform/llm-runner/`) wraps Ollama. It is
NOT the raw Ollama endpoint — the BFF talks to `llm-runner`, which talks
to Ollama.

To run `llm-runner` locally:
```bash
cd features/platform/llm-runner
OLLAMA_URL=http://localhost:11434 go run ./cmd/llm-runner/
```

Then set `LLM_RUNNER_URL=http://localhost:8090` (or whichever port it binds).

## Without Ollama (current production state)

The regex classifier alone handles ~76% of replies (AV-F2 baseline). The
remaining 24% receive `classification = NULL` until the operator manually
classifies them in the UI, or until Ollama is wired.

The `runAutoClassifyCron` in server.js runs every 15 minutes and re-attempts
classification for `reply_inbox` rows where `classification IS NULL` and
`received_at > now() - 24h`.

## Confidence threshold (named constant, T0)

`LLM_TRIGGER_THRESHOLD = 0.75` in `src/lib/replyClassifier.js`. Override
via `operator_settings.llm_trigger_threshold` key (DB-first per T0 rule).
