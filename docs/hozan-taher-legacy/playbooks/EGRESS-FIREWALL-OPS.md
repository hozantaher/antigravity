# Egress Firewall Ops (R8b)

> Operator runbook for the network-layer egress lockdown. This is the
> firewall complement to the DNS blackhole (R8a) and the runtime
> DialGuard (R7). Together these three layers enforce: **only
> `anti-trace-relay` talks to public SMTP/IMAP**; every other service is
> cut off at the DNS, runtime, and network layers.

## Goal

| Layer | Enforced by | What it stops |
|---|---|---|
| L7 — runtime | [`DialGuard`](../../features/outreach/relay/internal/transport/guard.go) (R7) | Code paths in the relay that try to dial outside the working proxy pool |
| L4 — DNS | `/etc/hosts` blackhole in outreach + BFF containers (R8a) | Direct dials from outside the relay that go through DNS |
| L3/4 — network | Railway egress rules (this doc, R8b) | Everything else — kernel-level block on the egress interface |

## Service egress matrix

| Service | SMTP (25/465/587) | IMAP (143/993) | HTTPS (443) | Postgres | Relay API |
|---|---|---|---|---|---|
| `anti-trace-relay` | **allow** (via proxy pool) | allow | allow | n/a | n/a |
| `privacy-gateway` | **allow** (Tor exit) | n/a | allow | n/a | n/a |
| `modules/outreach` (Go main) | **deny** | **deny** | allow | allow | allow |
| `features/platform/outreach-dashboard` (BFF) | **deny** | **deny** | allow | allow | allow |
| `features/platform/mcp` | deny | deny | allow | allow | n/a |
| `features/acquisition/scrapers` | deny | deny | allow | allow | n/a |
| `features/platform/worker` | deny | deny | allow | allow | allow |

Ports 25, 143, 465, 587, 993 are **deny** by default for everything
except `anti-trace-relay` and `privacy-gateway`.

## Railway capability check

Railway does **not** expose kernel-level egress rules at the container
level (no `NET_ADMIN` capability, no user-defined iptables). Options:

1. **Project-level private networking** — Railway private network is
   default-on, but it only isolates *inbound* traffic between services.
   Outbound to the public internet is unrestricted.
2. **Railway support ticket** — request egress allowlist per service.
   As of 2026-Q2 this is on the private-beta roadmap but not self-serve.
3. **Sidecar proxy** (recommended interim) — route all outbound traffic
   from non-relay services through a tiny forward proxy that rejects
   ports 25/143/465/587/993. Deployed as a co-located container in the
   same Railway project.
4. **Switch provider for the relay-hot services** — deploy
   `anti-trace-relay` + `privacy-gateway` on Hetzner / Fly.io where
   iptables is available, keep the rest on Railway. This is the path
   R8c assumes for the IP-rotation step.

### What is actually configured today

- **DNS blackhole (R8a)** is live in `modules/outreach` and
  `features/platform/outreach-dashboard` images. `nc -zv smtp.seznam.cz 465` inside
  either container now refuses with `Name or service not known`.
- **DialGuard (R7)** is wired into the relay's rotating proxy transport.
  Any code path that bypasses the pool gets a `dial_guard: refused
  direct egress` error and a `DIRECT_EGRESS_ATTEMPT` alert.
- **Kernel firewall (R8b)** is **not** enforceable on Railway today.
  Tracking ticket: request egress allowlist from Railway support before
  R8c cutover.

## Verification checklist

Run after every deploy:

```sh
# From outreach container (should all fail):
nc -zv smtp.seznam.cz 465        # expect: Name or service not known
nc -zv smtp.gmail.com 587        # expect: Name or service not known
nc -zv imap.seznam.cz 993        # expect: Name or service not known

# From BFF container (should all fail):
nc -zv smtp.seznam.cz 465
nc -zv imap.gmail.com 993

# From anti-trace-relay container (should all succeed):
nc -zv smtp.seznam.cz 465
nc -zv <proxy-pool-member-ip> <proxy-port>
```

If any "should fail" check succeeds, the blackhole image didn't ship —
redeploy from the latest SHA and confirm the entrypoint script is the
first line of `docker logs <container>`.

## Rollback

- **R8a blackhole rollback:** revert the Dockerfile/entrypoint commit
  (SHA in the R8a commit body). Container redeploy is instant.
- **R8b firewall rollback:** if the Railway egress allowlist is ever
  enabled and needs rolling back, remove the rules in the Railway
  dashboard. No code change required.
- **R7 DialGuard rollback:** the guard is optional at the transport
  layer — setting `TRANSPORT_MODE` to anything other than `proxy`
  skips guard attachment entirely. No redeploy required.

## Escalation

If a legitimate outbound SMTP/IMAP connection is being refused:

1. Check the container's `/etc/hosts` for the blackhole block.
2. If the host is supposed to be reachable (e.g. a new proxy-pool
   member on a non-standard port), add it to the `DialGuard` bridge
   allowlist at relay startup (`transport.DialGuard.AddBridge`).
3. Never disable the blackhole to make a test pass — if a test requires
   direct SMTP, it should be using the relay's `/v1/verify` endpoint
   instead. See [R6 sprint entry](../archive/SMTP-EGRESS-LOCKDOWN-SPRINTS.md#r6--validation-probe-migration--den).
