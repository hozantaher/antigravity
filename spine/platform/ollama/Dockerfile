# services/ollama — raw Ollama daemon Railway service (per ADR-006 §D1)
#
# Tento image NENÍ Go binary wrapper — ten žije v `services/llm-runner/`.
# Tento Dockerfile je minimal extension `ollama/ollama:latest` který přidává
# entrypoint wrapper. Wrapper:
#   1. spustí `ollama serve` na pozadí (HTTP API na :11434)
#   2. počká až API odpovídá
#   3. pokud OLLAMA_PRELOAD_TEXT_MODEL / OLLAMA_PRELOAD_VISION_MODEL set,
#      spustí `ollama pull <model>` (idempotent — Ollama nepulluje pokud
#      digest už existuje na volume)
#   4. wait on serve (foreground)
#
# Konzument: `services/llm-runner` přes Railway internal DNS
# (`ollama.railway.internal:11434`).
#
# Volume mount (Railway): `/root/.ollama` (Ollama default model cache).
# Per ADR-006 §D3: 20 GB persistent volume = ~$0.25/GB/měsíc.
#
# Local:    docker build -t ollama-runner . && docker run -p 11434:11434 ollama-runner
# Railway:  auto-detected via railway.toml

FROM ollama/ollama:latest

# Ollama upstream image je Ubuntu-based. Pro entrypoint wrapper potřebujeme
# pouze `curl` (already present) + `bash` (present). Žádné další balíčky.

COPY entrypoint.sh /usr/local/bin/ollama-entrypoint.sh
RUN chmod 0755 /usr/local/bin/ollama-entrypoint.sh

# Ollama default API port. Railway přepíše PORT env, ale Ollama daemon
# poslouchá na 11434 nezávisle (entrypoint wrapper pouze preload-uje, není
# HTTP proxy). Pokud Railway PORT != 11434, llm-runner OLLAMA_URL musí
# explicit obsahovat `:11434` suffix (per railway.toml comment).
EXPOSE 11434

# Healthcheck: API musí odpovědět + alespoň jeden model loaded.
# `ollama list` exit code je 0 i když žádný model — proto check cez API.
HEALTHCHECK --interval=30s --timeout=10s --retries=3 --start-period=120s \
  CMD curl -fsS http://localhost:11434/api/tags > /dev/null || exit 1

ENTRYPOINT ["/usr/local/bin/ollama-entrypoint.sh"]
