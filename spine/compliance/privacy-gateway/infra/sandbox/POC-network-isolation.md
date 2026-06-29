# POC: Network Isolation for sandbox-exec

## Status: accepted

_Last updated: 2026-04-07_

## Hypothesis

Restricting network access at the Seatbelt (sandbox-exec) level is practical for Claude Desktop without breaking core functionality. Currently, network tools are blocked at the process-exec level, but the sandboxed process can still open arbitrary TCP/UDP connections via system calls.

## Context

The current sandbox profile (`claude-desktop.sb`) uses `(allow default)` which permits all network operations. Process-level blocks on `curl`, `wget`, `ssh` prevent common exfiltration tools, but a compiled binary or Python/Node script inside the sandbox could still open raw sockets.

## Scope

**In scope:**
- Testing `(deny network-outbound)` with selective `(allow network-outbound ...)` rules
- Identifying which network endpoints Claude Desktop requires (Anthropic API, updates, telemetry)
- Measuring breakage when network is restricted
- Documenting a working allowlist

**Out of scope:**
- DNS-level filtering (Little Snitch, etc.)
- VPN-based isolation
- Full air-gap (that's the VM's job per ADR-001)

## Test Plan

### Phase 1: Baseline observation

Observe Claude Desktop's network connections without restrictions:

```bash
# Run Claude Desktop in sandbox with network logging
sudo lsof -i -n -P | grep -i claude
# Or use nettop for real-time
sudo nettop -p $(pgrep -f "Claude Desktop")
```

Expected endpoints:
- `api.anthropic.com` (443) - API calls
- `*.anthropic.com` (443) - updates, telemetry
- `*.sentry.io` (443) - crash reporting (optional)

### Phase 2: Deny-all + selective allow

Add to `claude-desktop.sb`:

```scheme
;; ── Network restrictions ──────────────────────────────────
;; Deny all outbound network by default
(deny network-outbound)

;; Allow DNS resolution (required)
(allow network-outbound (remote udp "*:53"))
(allow network-outbound (remote tcp "*:53"))

;; Allow Anthropic API (Claude Desktop requires this)
(allow network-outbound (remote tcp "*.anthropic.com:443"))

;; Allow localhost (for local dev servers, MCP)
(allow network-outbound (remote tcp "localhost:*"))
(allow network-outbound (remote tcp "127.0.0.1:*"))
(allow network-outbound (remote unix-socket))
```

**Note:** Seatbelt `network-outbound` rules use hostname patterns, not IPs. DNS resolution must be allowed separately.

### Phase 3: Functional verification

Test with network restrictions:

1. **Chat works:** Send a message, get response
2. **File operations work:** Read/write within sandboxed-home
3. **MCP servers work:** localhost connections to MCP tools
4. **Git works:** Local operations (push blocked by design)
5. **No leaks:** Attempt `python3 -c "import urllib.request; urllib.request.urlopen('https://evil.com')"` inside sandbox -- should fail

### Phase 4: Edge case discovery

- Does Claude Desktop use WebSocket (wss://) or HTTP/2?
- Are there CDN endpoints for assets?
- Does update checking fail gracefully or crash the app?
- Are there connectivity check endpoints (captive portal style)?

## Success Signal

- Claude Desktop chat and file operations function normally with network restrictions
- Unauthorized outbound connections are blocked (verified with test script)
- No crash or hang from blocked network calls (graceful failure)

## Failure Signal

- Claude Desktop crashes or hangs when network is restricted
- Seatbelt network rules cannot filter by hostname (only IP), making maintenance impractical
- Required endpoints change frequently, making allowlist unmaintainable
- Performance degradation from network filtering overhead

## Risk Assessment

| Risk | Probability | Impact | Mitigation |
|------|------------|--------|------------|
| Claude Desktop uses IP-only connections (no DNS) | Low | Medium | Capture IPs, add explicit IP rules |
| Seatbelt `network-outbound` not granular enough | Medium | High | Fall back to Little Snitch or VM |
| Update mechanism breaks silently | Medium | Low | Periodic version check outside sandbox |
| WebSocket connections treated differently | Low | Medium | Test with `(allow network-outbound (remote tcp "*:443"))` fallback |

## Implementation

Network isolation rules have been added to `claude-desktop.sb` (SB-001). The rules follow a deny-first model with **port-only filtering** (see Known Limitations for why):

```scheme
;; Default: deny all outbound network connections
(deny network-outbound)

;; Allow DNS resolution (UDP/TCP port 53)
(allow network-outbound
    (remote udp "*:53")
    (remote tcp "*:53")
)

;; Allow HTTPS (port 443) to any host
;; macOS 26 sandbox-exec only accepts "*" and "localhost" as host values
(allow network-outbound
    (remote tcp "*:443")
)

;; Allow localhost for IPC (Electron apps need this)
(allow network-outbound
    (remote tcp "localhost:*")
)

;; Allow Unix domain sockets (required for MCP and Electron IPC)
(allow network-outbound
    (remote unix-socket)
)
```

## Known Limitations

1. **Hostname resolution in sandbox profiles is unreliable on macOS 13+.** The `(remote tcp "hostname:port")` form in Seatbelt profiles does not perform DNS resolution at rule evaluation time. Rules are matched against already-resolved IP addresses. If Claude Desktop resolves `api.anthropic.com` via DNS (allowed) and then connects to the resulting IP, the connection may be blocked because the sandbox sees an IP, not the hostname.

2. **Cloudflare IP range as fallback.** `api.anthropic.com` is served behind Cloudflare. The primary IP range is `104.16.0.0/12` (104.16.0.0 – 104.31.255.255). If hostname-based rules fail, replace them with explicit IP ranges:
   ```scheme
   ;; Cloudflare IP ranges (api.anthropic.com)
   (allow network-outbound (remote tcp "104.16.0.0/12:443"))
   (allow network-outbound (remote tcp "104.64.0.0/10:443"))
   ```
   This is operationally fragile — Cloudflare IP ranges change and require periodic auditing.

3. **pf (packet filter) as alternative.** macOS `pf` operates at the kernel network stack level and is not subject to the hostname-resolution limitation. A `pf` anchor scoped to the Claude Desktop process UID or a network namespace (via `utun` + routing) would be more reliable. However, `pf` rules require root and are global to the system, not per-process.

4. **No inbound filtering.** `(deny network-outbound)` only blocks outbound connections. Inbound is not constrained by these rules (Claude Desktop does not accept inbound connections, so this is acceptable for the current threat model).

## Next Steps

- [ ] Test whether hostname-based rules work on macOS 15 (Sequoia) — launch Claude Desktop via `sandbox-exec -f claude-desktop.sb` and observe if chat API calls succeed
- [ ] If hostname rules fail, switch to Cloudflare IP ranges and document the maintenance burden
- [ ] Evaluate `pf`-based filtering as a more robust alternative (separate POC)
- [ ] Capture full network trace (`sudo nettop` or `sudo lsof -i`) to discover all endpoints Claude Desktop contacts (updates, telemetry, sentry)
- [ ] Add `*.sentry.io:443` or deny it intentionally (privacy consideration)

## Evidence

_Tested 2026-04-07 on macOS 26 (Darwin 25.3.0), Apple Silicon._

### Test 1: Profile parses

```
$ sandbox-exec -f claude-desktop.sb /usr/bin/true
(exit 0)
```

**PASS** — profile loads without parse errors after replacing hostname/IP rules with port-only rules.

### Test 2: Claude Desktop launches

**MANUAL** — requires GUI interaction. To verify: `./launch.sh`, send a message, confirm response.

### Test 3: Filesystem isolation

```
$ sandbox-exec -f claude-desktop.sb cat ~/.ssh/id_rsa
cat: /Users/messingtomas/.ssh/id_rsa: Operation not permitted
(exit 1)
```

**PASS** — SSH key read blocked by sandbox.

### Test 4: Process execution block

```
$ sandbox-exec -f claude-desktop.sb /usr/bin/osascript -e 'display dialog "test"'
sandbox-exec: execvp() of '/usr/bin/osascript' failed: Operation not permitted
(exit 71)
```

**PASS** — dangerous process execution blocked.

### Test 5: Network restriction (non-443 port)

```
$ sandbox-exec -f claude-desktop.sb /usr/bin/curl http://example.com:8080
sandbox-exec: execvp() of '/usr/bin/curl' failed: Operation not permitted
(exit 71)
```

**PASS** — curl blocked at process-exec level. Network port filtering provides defense-in-depth: even if a process somehow bypasses exec rules, port 8080 connections are denied at network level.

### macOS 26 Seatbelt hostname limitation

Hostname-based rules (`api.anthropic.com:443`) and IP-literal rules (`127.0.0.1:*`) cause parse errors on macOS 26. Only `*` and `localhost` are valid host values. This was discovered after the original rules in claude-desktop.sb caused silent failures.

## Decision

**accepted** — with port-only filtering trade-off.

Network isolation via sandbox-exec is practical for Claude Desktop on macOS 26. The port-only approach (`*:443` instead of `api.anthropic.com:443`) is less restrictive than intended but still blocks:
- All non-HTTPS traffic (HTTP, custom ports, raw TCP)
- Combined with process-exec blocks on curl/wget/ssh/nc, exfiltration requires a custom compiled binary

For host-level filtering, see ADR-002 (deferred to `pf` firewall or VM tier).
