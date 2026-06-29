# ADR-002: Network Isolation Strategy — Port-Only Filtering

## Status: accepted

## Context

macOS 26 `sandbox-exec` Seatbelt profiles only accept `*` and `localhost` as host values in network rules. Hostname-based rules (e.g., `api.anthropic.com:443`) and IP-literal rules (e.g., `127.0.0.1:*`) cause parse errors at profile load time.

This means per-host network filtering is impossible via sandbox-exec on macOS 26. The original design in POC-network-isolation.md intended to allowlist only Anthropic API endpoints, but this approach is not feasible.

## Decision

**Accept port-only filtering for the sandbox-exec tier. Defer host-level filtering to `pf` firewall or VM tier.**

### What the sandbox allows

| Protocol | Ports | Hosts |
|----------|-------|-------|
| TCP | 443 | Any (HTTPS) |
| TCP | Any | localhost only |
| UDP/TCP | 53 | Any (DNS) |
| Unix sockets | n/a | Local IPC |

### What the sandbox blocks

- All non-HTTPS TCP traffic (HTTP on port 80, custom ports)
- All outbound UDP except DNS
- Process execution of curl, wget, ssh, nc, ncat, and other network tools
- Process execution of osascript, security (keychain), pbcopy/pbpaste

### Defense-in-depth

Exfiltration requires bypassing **both** layers:

1. **Network layer:** Only port 443 and localhost are open
2. **Process layer:** All common network tools are blocked at exec level

A compiled binary or in-process HTTP client (e.g., Node.js `fetch`) could still connect to `*:443`. This is the accepted residual risk for the sandbox-exec tier.

## Alternatives Considered

1. **`pf` (packet filter) firewall** — kernel-level, supports host/IP filtering. Requires root. Could be scoped to Claude Desktop UID. Deferred as future enhancement (separate POC).

2. **Little Snitch / Lulu** — per-app network filtering. Commercial (Little Snitch) or open-source (Lulu). Not suitable for automated/scripted sandboxing.

3. **IP-range allowlisting** — hardcode Cloudflare IP ranges for Anthropic. Fragile: ranges change, require periodic auditing. Rejected.

4. **Full network deny** — block all outbound. Breaks Claude Desktop (requires API access). Rejected.

## Consequences

1. Port-only filtering is less restrictive than per-host filtering
2. Process-exec blocks provide compensating control
3. For high-security scenarios, use VM tier (full network isolation)
4. `pf` firewall POC is a future enhancement that could add host-level filtering

## Review Date: 2026-10-01

Re-evaluate if macOS 27 restores hostname-based sandbox rules.
