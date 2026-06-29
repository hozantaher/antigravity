#!/bin/bash
# services/ollama entrypoint — boot Ollama daemon + preload default models.
#
# Per ADR-006 §D2:
#   - text model:   llama3.2:3b           (~2 GB RAM, classifier + generator)
#   - vision model: llama3.2-vision:11b   (~7 GB RAM, photo parser)
#
# Env (Railway secrets):
#   OLLAMA_PRELOAD_TEXT_MODEL    (default: llama3.2:3b)
#   OLLAMA_PRELOAD_VISION_MODEL  (default: llama3.2-vision:11b)
#   OLLAMA_PRELOAD_DISABLE       (set to "1" to skip preload — debug only)
#
# Idempotent: `ollama pull` no-op pokud digest už loaded na volume.
# Recovery: pokud preload selže (network blip), wrapper ji NEretry-uje —
# nechá log a pokračuje. Ollama daemon zůstane up; consumer (llm-runner)
# bude reportovat status="degraded" v /healthz dokud model nedopadne.
# Operator může manuálně retry: `railway run --service ollama -- ollama pull <model>`.

set -e

TEXT_MODEL="${OLLAMA_PRELOAD_TEXT_MODEL:-llama3.2:3b}"
VISION_MODEL="${OLLAMA_PRELOAD_VISION_MODEL:-llama3.2-vision:11b}"

echo "[entrypoint] starting ollama serve on :11434"
ollama serve &
SERVE_PID=$!
echo "[entrypoint] ollama serve pid=$SERVE_PID"

# Wait for /api/tags to respond — Ollama může bootovat 5–15 s, retry s
# exponential-ish backoff.
echo "[entrypoint] waiting for ollama API ready"
for i in 1 2 3 4 5 6 7 8 9 10 11 12; do
    if curl -fsS http://localhost:11434/api/tags > /dev/null 2>&1; then
        echo "[entrypoint] ollama API ready (attempt $i)"
        break
    fi
    if [ "$i" = "12" ]; then
        echo "[entrypoint] FATAL: ollama API not ready after 60 s — exiting"
        kill -TERM "$SERVE_PID" 2>/dev/null || true
        exit 1
    fi
    sleep 5
done

if [ "${OLLAMA_PRELOAD_DISABLE:-0}" = "1" ]; then
    echo "[entrypoint] OLLAMA_PRELOAD_DISABLE=1 — skipping model preload"
else
    echo "[entrypoint] preloading text model: $TEXT_MODEL"
    if ! ollama pull "$TEXT_MODEL"; then
        echo "[entrypoint] WARN: text model pull failed — daemon stays up, llm-runner /healthz will report degraded"
    fi

    echo "[entrypoint] preloading vision model: $VISION_MODEL"
    if ! ollama pull "$VISION_MODEL"; then
        echo "[entrypoint] WARN: vision model pull failed — daemon stays up, llm-runner /healthz will report degraded"
    fi

    echo "[entrypoint] preload complete; current models:"
    ollama list || true
fi

echo "[entrypoint] handing off to ollama serve (pid=$SERVE_PID)"
wait "$SERVE_PID"
