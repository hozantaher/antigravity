# llm-runner — Go HTTP wrapper kolem Ollama daemon (per ADR-006).
#
# Local:    docker build -t llm-runner . && docker run --env-file .env -p 8092:8092 llm-runner
# Railway:  auto-detected via railway.toml
#
# Pozn: Tento image NEOBSAHUJE Ollama daemon. Daemon žije v separátním
# Railway service `ollama` (raw `ollama/ollama:latest`). Tento wrapper
# se k němu připojí přes Railway internal DNS (`ollama.railway.internal:11434`).

# ----- Build stage -----
FROM golang:alpine AS builder

RUN apk add --no-cache ca-certificates git

WORKDIR /build

# Workspace pattern: kopírujeme common (replace target) + service.
COPY common/ /build/common/
COPY llm-runner/ /build/llm-runner/

WORKDIR /build/llm-runner
RUN CGO_ENABLED=0 GOOS=linux go build -ldflags="-s -w" -o /llm-runner ./cmd/llm-runner/

# ----- Runtime stage -----
FROM alpine:3

RUN apk add --no-cache ca-certificates wget

RUN addgroup -g 10003 -S llm && \
    adduser -u 10003 -S llm -G llm -h /app -s /sbin/nologin

WORKDIR /app
COPY --from=builder /llm-runner /app/llm-runner

# Entrypoint wrapper: maps Railway PORT to listen address.
RUN printf '#!/bin/sh\nexport PORT="${PORT:-8092}"\nexec /app/llm-runner\n' > /app/start.sh && \
    chmod +x /app/start.sh

USER llm

EXPOSE 8092

HEALTHCHECK --interval=30s --timeout=5s --retries=3 \
  CMD wget -q --spider http://localhost:${PORT:-8092}/healthz || exit 1

ENTRYPOINT ["/app/start.sh"]
