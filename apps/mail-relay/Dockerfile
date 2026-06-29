# Anti-Trace Relay: Multi-stage Docker build
#
# Local:   docker build -t anti-trace-relay . && docker run --env-file .env -p 8090:8090 anti-trace-relay
# Railway: auto-detected via railway.toml

# ----- Build stage -----
FROM golang:alpine AS builder

RUN apk add --no-cache ca-certificates git

WORKDIR /build
COPY go.mod ./
# Copy source — cache bust: 2026-04-09T10
COPY cmd/submit/ cmd/submit/
COPY cmd/receive/ cmd/receive/
COPY cmd/relay/ cmd/relay/
COPY internal/ internal/

RUN CGO_ENABLED=0 GOOS=linux go build -ldflags="-s -w" -o /anti-trace-relay ./cmd/relay/
RUN CGO_ENABLED=0 GOOS=linux go build -ldflags="-s -w" -o /submit ./cmd/submit/
RUN CGO_ENABLED=0 GOOS=linux go build -ldflags="-s -w" -o /receive ./cmd/receive/

# ----- Runtime stage -----
FROM alpine:3

RUN apk add --no-cache ca-certificates tor

RUN addgroup -g 10001 -S antitrace && \
    adduser -u 10001 -S antitrace -G antitrace -h /app -s /sbin/nologin

WORKDIR /app

COPY --from=builder /anti-trace-relay /app/anti-trace-relay
COPY --from=builder /submit /app/submit
COPY --from=builder /receive /app/receive

RUN mkdir -p /app/data && chown antitrace:antitrace /app/data && chmod 0700 /app/data

USER antitrace

# Railway sets PORT env var; default 8090
EXPOSE 8090

HEALTHCHECK --interval=30s --timeout=5s --retries=3 \
  CMD wget -q --spider http://localhost:${PORT:-8090}/healthz || exit 1

ENTRYPOINT ["/app/anti-trace-relay"]
