# mail-lab-api — TEST-ONLY admin REST API for Mail Lab mailbox management.
#
# Build context: repo root (so we can include services/common dependency).
#   docker build -f services/mail-lab-api/Dockerfile -t mail-lab-api .
#
# Or via docker compose (infra/docker/mail-lab.yml sets build context to
# services/mail-lab-api with a relative path to the repo root).

# ----- Build stage -----
FROM golang:1.25-alpine AS builder

RUN apk add --no-cache ca-certificates git

WORKDIR /build

# Copy the common dependency first (replace directive in go.mod). Dest layout
# keeps /build/services/{common,mail-lab-api} so the `replace common => ../common`
# directive still resolves; only the COPY sources moved to features/platform/.
COPY features/platform/common/ ./services/common/

# Copy the service sources.
COPY features/platform/mail-lab-api/go.mod ./services/mail-lab-api/
COPY features/platform/mail-lab-api/cmd/     ./services/mail-lab-api/cmd/
COPY features/platform/mail-lab-api/internal/ ./services/mail-lab-api/internal/
COPY features/platform/mail-lab-api/profiles/ ./services/mail-lab-api/profiles/

WORKDIR /build/services/mail-lab-api

RUN CGO_ENABLED=0 GOOS=linux go build -ldflags="-s -w" -o /mail-lab-api ./cmd/mail-lab-api/

# ----- Runtime stage -----
FROM alpine:3

RUN apk add --no-cache ca-certificates

RUN addgroup -g 10090 -S mla && \
    adduser -u 10090 -S mla -G mla -h /app -s /sbin/nologin

WORKDIR /app

COPY --from=builder /mail-lab-api /app/mail-lab-api

# Default profiles (can be overridden by bind-mounting /profiles at runtime).
COPY --from=builder /build/services/mail-lab-api/profiles /app/profiles

EXPOSE 8090

HEALTHCHECK --interval=30s --timeout=5s --retries=3 \
  CMD wget -qO- http://localhost:${PORT:-8090}/healthz | grep -q '"ok"' || exit 1

USER mla

ENV PORT=8090
ENV PROFILES_DIR=/app/profiles

ENTRYPOINT ["/app/mail-lab-api"]
