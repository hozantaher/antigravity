# anti-trace-relay: builds from services/relay/, with services/common as a
# replace target (relay/go.mod has `replace common => ../common`). Build
# context is the repository root.

FROM golang:1.26-alpine AS builder

RUN apk add --no-cache ca-certificates git

WORKDIR /build

# Copy common (replace target) AND relay together so relay/go.mod's
# `replace common => ../../platform/common` resolves. Layout inside /build
# mirrors the features/ tree: /build/features/platform/common + /build/features/outreach/relay.
COPY features/platform/common /build/features/platform/common
COPY features/outreach/relay /build/features/outreach/relay

WORKDIR /build/features/outreach/relay

RUN CGO_ENABLED=0 GOOS=linux go build -ldflags="-s -w" -o /anti-trace-relay ./cmd/relay/
RUN CGO_ENABLED=0 GOOS=linux go build -ldflags="-s -w" -o /submit ./cmd/submit/
RUN CGO_ENABLED=0 GOOS=linux go build -ldflags="-s -w" -o /receive ./cmd/receive/

# wgsocks: in-house userspace WireGuard + SOCKS5 server (replaces
# windtf/wireproxy v1.1.2). wireproxy hangs at 28s i/o timeout on
# STARTTLS for 9/10 SMTP hosts (Seznam, Gmail, Yahoo, Mailgun, SendGrid,
# Brevo, Fastmail, Zoho); only Outlook completes. Bug is in wireproxy's
# SOCKS5 connForward — it uses io.Copy without propagating CloseWrite,
# so SMTP servers waiting for the client's TLS ClientHello after EHLO
# response have the upstream half-closed prematurely.
#
# wgsocks is a single-file Go binary built directly against
# wireguard-go's netstack (gVisor TCP/IP) + a hand-rolled CONNECT-only
# SOCKS5 server that uses gonet.TCPConn.CloseWrite for proper half-close
# propagation. Same WIREPROXY_CONFIG ini format consumed unchanged.
#
# Module lives at services/anti-trace-relay/wgsocks/ with its own go.mod
# (kept out of the root go.work so it does not pull wireguard-go +
# gVisor into the rest of the monorepo).
FROM golang:1.26-alpine AS wgsocks
RUN apk add --no-cache git
WORKDIR /build/wgsocks
COPY features/outreach/anti-trace-relay/wgsocks /build/wgsocks
ENV GOWORK=off
RUN CGO_ENABLED=0 GOOS=linux go build -ldflags="-s -w" -o /out/wgsocks .

# Legacy wireproxy stage retained behind the EGRESS_TRANSPORT feature
# flag so we can flip back without redeploying the relay binary if a
# regression appears in wgsocks. Set EGRESS_TRANSPORT=wireproxy at
# runtime to use the legacy bundled binary; default (unset or "wgsocks")
# uses the new path.
FROM golang:1.26-alpine AS wireproxy
ARG WIREPROXY_VERSION=v1.1.2
RUN apk add --no-cache git && \
    CGO_ENABLED=0 GOBIN=/out go install github.com/windtf/wireproxy/cmd/wireproxy@${WIREPROXY_VERSION}

FROM alpine:3.21

RUN apk add --no-cache ca-certificates && \
    addgroup -g 10001 -S antitrace && \
    adduser -u 10001 -S antitrace -G antitrace -h /app -s /sbin/nologin

WORKDIR /app

COPY --from=builder /anti-trace-relay /app/anti-trace-relay
COPY --from=builder /submit /app/submit
COPY --from=builder /receive /app/receive
COPY --from=wgsocks /out/wgsocks /usr/local/bin/wgsocks
COPY --from=wireproxy /out/wireproxy /usr/local/bin/wireproxy
COPY features/outreach/anti-trace-relay/entrypoint.sh /app/entrypoint.sh

RUN chmod 0755 /app/entrypoint.sh && \
    mkdir -p /app/data && chown antitrace:antitrace /app/data && chmod 0700 /app/data

USER antitrace

EXPOSE 8090

HEALTHCHECK --interval=30s --timeout=5s --retries=3 \
  CMD wget -q --spider http://localhost:${PORT:-8090}/healthz || exit 1

ENTRYPOINT ["/app/entrypoint.sh"]
