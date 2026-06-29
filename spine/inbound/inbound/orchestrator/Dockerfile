# machinery-outreach orchestrator
# Build context: repository root
# Railway: dockerfilePath = features/inbound/orchestrator/Dockerfile

FROM golang:1.25-alpine AS builder

RUN apk add --no-cache ca-certificates git

WORKDIR /workspace

# Copy go.work for workspace-aware build
COPY go.work go.work.sum* ./

# Copy ALL workspace modules — go build resolves go.work which lists every
# `use ./services/...` even when only orchestrator is built. Stripping the
# go.work to a subset would diverge the workspace from the rest of the repo.
COPY features/inbound/orchestrator/ features/inbound/orchestrator/
COPY features/outreach/campaigns/ features/outreach/campaigns/
COPY features/platform/common/ features/platform/common/
COPY features/outreach/relay/ features/outreach/relay/
COPY features/compliance/privacy-gateway/ features/compliance/privacy-gateway/
COPY features/outreach/mailboxes/ features/outreach/mailboxes/
COPY features/acquisition/contacts/ features/acquisition/contacts/
COPY features/inbound/inbox/ features/inbound/inbox/

# Build the orchestrator binary
RUN CGO_ENABLED=0 GOOS=linux \
    go build -ldflags="-s -w" \
    -o /outreach \
    ./features/inbound/orchestrator/cmd/outreach/

# ----- Runtime stage -----
FROM alpine:3.21

RUN apk add --no-cache ca-certificates tzdata && \
    addgroup -g 10001 -S outreach && \
    adduser -u 10001 -S outreach -G outreach -h /app -s /sbin/nologin

WORKDIR /app

COPY --from=builder /outreach /app/outreach

# Email templates for campaign content engine
COPY modules/outreach/configs/ /app/configs/

RUN chown -R outreach:outreach /app
USER outreach

EXPOSE 8080

HEALTHCHECK --interval=30s --timeout=10s --retries=3 \
  CMD wget -q --spider http://localhost:${PORT:-8080}/healthz || exit 1
