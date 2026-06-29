# ADR-001: Isolation Model — sandbox-exec vs VM vs Both

## Status: accepted

## Context

Claude Desktop and Claude Code need controlled execution environments to prevent unintended access to sensitive data (SSH keys, credentials, browser data, personal files). Two isolation mechanisms exist:

1. **macOS sandbox-exec** — kernel-level policy via Seatbelt profiles (`.sb` files). Fast, zero overhead, runs natively. Constrains filesystem read/write, process execution, and (potentially) network access.

2. **Ubuntu VM** — full hardware isolation via QEMU/UTM. 1.17GB disk image, ARM64 Ubuntu 24.04 with Claude Desktop installed via cloud-init. Complete separation.

The question: when to use which, and whether both are needed.

## Decision

**Use sandbox-exec as the primary isolation layer. Use the VM only for untrusted code execution and integration testing.**

### sandbox-exec: Default for daily Claude Desktop usage

**Use when:**
- Running Claude Desktop for coding, review, or planning against the local codebase
- The threat model is "prevent Claude from reading secrets and personal data"
- Performance matters (zero overhead vs. VM boot time)
- Network access to Anthropic API is required (sandbox-exec allows it)

**Strengths:**
- Zero startup overhead — `sandbox-exec -f profile.sb /path/to/claude`
- Native macOS performance (no virtualization tax)
- Fine-grained: blocks specific paths, binaries, and operations
- Currently covers: 35+ deny rules across filesystem, process, and (future) network

**Weaknesses:**
- `sandbox-exec` is deprecated since macOS 10.15 (still functional through macOS 26.x)
- No process isolation — sandboxed process shares PID namespace
- Profile relies on enumerated deny paths — new sensitive locations must be added manually
- Cannot restrict network at IP/port level (only full network deny or allow)

### VM: For untrusted execution and integration testing

**Use when:**
- Running code from untrusted sources (e.g., testing third-party repos)
- Integration testing anti-trace-relay with Tor/VPN (needs real network stack)
- Testing privacy-gateway SMTP relay against real providers
- Any scenario where full kernel-level isolation is needed

**Strengths:**
- Complete isolation — separate kernel, filesystem, network stack
- Can snapshot and rollback
- Network can be fully restricted or routed through specific interfaces
- No risk of sandbox profile gaps

**Weaknesses:**
- ~1.17GB disk footprint
- Boot time: 30-60 seconds
- Resource overhead: CPU/RAM allocation
- Clipboard/file sharing requires SPICE agent setup

## Alternatives Considered

1. **VM only** — rejected because: daily development doesn't need full isolation, and VM boot time creates friction that leads to skipping the sandbox entirely. The safest system is the one that gets used.

2. **sandbox-exec only** — rejected because: `sandbox-exec` deprecation risk means the VM must exist as a fallback. Also, sandbox-exec cannot provide kernel-level isolation for truly untrusted code.

3. **Docker containers** — rejected because: Docker Desktop on macOS runs a Linux VM anyway (same overhead as QEMU), doesn't integrate with macOS GUI apps, and adds Docker daemon dependency. Previous architecture used Docker and was replaced for these reasons.

4. **macOS App Sandbox (entitlements)** — rejected because: requires code signing and app bundle structure. Claude Desktop is distributed as a signed app — we can't modify its entitlements without breaking the signature.

## Consequences

1. `claude-desktop.sb` remains the primary daily-driver profile. Maintained as changes are discovered.
2. VM (`vm/`) is maintained for integration testing and untrusted execution. Not used for routine development.
3. If Apple removes `sandbox-exec` in a future macOS release, the VM becomes the sole isolation mechanism. Monitor deprecation status at each macOS major release.
4. `launch.sh` defaults to sandbox-exec. A `--vm` flag launches the VM instead.
5. Sandbox profile should be audited quarterly (or after macOS upgrades) for new sensitive paths.

## Deprecation Contingency

If `sandbox-exec` stops working:

| Timeframe | Action |
|-----------|--------|
| Immediate | Switch to VM-only workflow |
| Short-term | Investigate `EndpointSecurity.framework` as replacement (requires System Extension approval) |
| Medium-term | Evaluate if Apple introduces a successor API in future macOS |

## Amendment: macOS 26 Network Rule Limitations (2026-04-07)

**Discovery:** macOS 26 (Darwin 25.3.0) `sandbox-exec` Seatbelt profiles only accept `*` and `localhost` as host values in network rules. Hostname-based rules (e.g., `(remote tcp "api.anthropic.com:443")`) and IP-literal rules (e.g., `(remote tcp "127.0.0.1:*")`) cause parse errors at profile load time.

**Impact:** Host-level network filtering is not possible via sandbox-exec on macOS 26. The sandbox profile uses port-only filtering (`*:443`) as a trade-off: HTTPS to any host is allowed, but non-HTTPS ports are blocked.

**Mitigation layers:**
1. Port-only filtering blocks non-443 traffic (HTTP, custom ports, raw TCP)
2. Process-exec blocks on curl, wget, ssh, nc prevent common exfiltration tools
3. VM tier provides full network isolation for high-risk scenarios

**Future work:** Evaluate `pf` (packet filter) firewall rules scoped to Claude Desktop process for host-level filtering without sandbox-exec limitations (see ADR-002).

## Review Date: 2026-10-01

Review after macOS 27 release to assess `sandbox-exec` status.
