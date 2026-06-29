# Privacy Gateway: Multi-stage Docker build
#
# Local:   docker build -t privacy-gateway . && docker run --env-file .env -p 8081:8081 privacy-gateway
# Railway: auto-detected via railway.toml

# ----- Build stage -----
FROM golang:alpine AS builder

RUN apk add --no-cache ca-certificates git

WORKDIR /build
COPY go.mod ./
COPY cmd/ cmd/
COPY internal/ internal/

RUN CGO_ENABLED=0 GOOS=linux go build -ldflags="-s -w" -o /privacy-gateway ./cmd/privacy-gateway/

# ----- Runtime stage -----
FROM alpine:3

RUN apk add --no-cache ca-certificates

RUN addgroup -g 10002 -S pgw && \
    adduser -u 10002 -S pgw -G pgw -h /app -s /sbin/nologin

WORKDIR /app

COPY --from=builder /privacy-gateway /app/privacy-gateway

# Entrypoint wrapper: maps Railway PORT to LISTEN_ADDR
RUN printf '#!/bin/sh\nexport LISTEN_ADDR=":${PORT:-8081}"\nexec /app/privacy-gateway\n' > /app/start.sh && chmod +x /app/start.sh

RUN mkdir -p /app/data && chown pgw:pgw /app/data && chmod 0700 /app/data

USER pgw

EXPOSE 8081

HEALTHCHECK --interval=30s --timeout=5s --retries=3 \
  CMD wget -q --spider http://localhost:${PORT:-8081}/healthz || exit 1

ENTRYPOINT ["/app/start.sh"]
