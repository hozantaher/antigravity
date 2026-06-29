# M2 Relay Reorganization Plan

**Status (2026-04-23):** M2.1 done (rename anti-trace-relay → relay ✅). M2.2+ planned. Owner: tomas. Target: 2026-05-06 (Sprint 2 week).

## Goal

The `services/relay/` subtree currently has 33 internal/ packages. For Sprint
2 we reorganize into 3 clean domains so operators can reason about the
deploy surface and so test ownership is unambiguous:

```
services/relay/
├── internal/
│   ├── transport/           # SOCKS rotation, proxy pool, onion bridge
│   │   ├── proxy_pool.go    # already promoted in M2.1
│   │   ├── onion/
│   │   └── bridge/
│   ├── intake/              # /submit + /v1/proxy-pool HTTP API
│   │   ├── httpapi/
│   │   └── auth/
│   └── delivery/            # outbound SMTP + envelope rewrite
│       ├── sanitizer/
│       └── contentenc/
├── web/                     # NEW — public handler surface (M2.4 carve)
└── go.mod                   # already exists
```

## Source packages (current internal/ layout)

| Pkg               | Target domain    | Notes                              |
|-------------------|------------------|------------------------------------|
| transport/        | transport/       | already there ✅                   |
| onion/            | transport/onion/ | consolidate                        |
| bridge/           | transport/bridge/| consolidate                        |
| pool/             | transport/pool/  | ?                                  |
| httpapi/          | intake/httpapi/  | move                               |
| intake/           | intake/          | already there                      |
| auth/             | intake/auth/     | move (request auth, not SMTP)      |
| delivery/         | delivery/        | already there                      |
| sanitizer/        | delivery/sanitizer/ | move                            |
| contentenc/       | delivery/contentenc/| move                            |
| relay/            | shared core/     | too generic — investigate          |
| abuse/            | shared core/     | could stay top-level               |
| admin/            | intake/admin/    | operator-only endpoints            |
| amnesic/          | storage/         | ephemeral metadata                 |
| audit/            | shared core/     | cross-cutting audit                |
| boundary/         | shared core/     | trust boundary helpers             |
| config/           | shared core/     | config loader                      |
| constrate/        | transport/       | constant-rate cover traffic        |
| deaddrop/         | storage/         | dead-drop store                    |
| decoy/            | transport/       | decoy traffic                      |
| duress/           | intake/          | duress-code auth                   |
| ephemeral/        | storage/         | ephemeral state                    |
| epochkeys/        | shared core/     | key rotation                       |
| filestore/        | storage/         | file store backend                 |
| fragment/         | transport/       | message fragmentation              |
| identity/         | shared core/     | sender identity                    |
| metamin/          | transport/       | metadata minimizer                 |
| metrics/          | shared core/     | prom metrics                       |
| minlog/           | shared core/     | minimal logger                     |
| model/            | shared core/     | data types                         |
| msgbus/           | shared core/     | internal message bus               |
| shamir/           | shared core/     | secret-sharing                     |
| traffic/          | transport/       | traffic shaping                    |
| vault/            | storage/         | encrypted vault                    |
| vpn/              | transport/       | VPN transport                      |

Many of these (metamin, constrate, fragment, decoy, duress, shamir, epochkeys)
are research-track packages not wired into the production `/submit` +
`/v1/proxy-pool` endpoints. They can stay nested; the main reorganization is
the 3-domain grouping of the active pkgs.

## Phased rollout

### M2.2 — establish 3 top-level domain directories (no code move yet)

Add `services/relay/internal/{transport,intake,delivery}/` directories + 
README stubs pointing to current sub-pkg locations. Zero code change.

### M2.3 — consolidate transport/ pkgs

Move onion/, bridge/, pool/, traffic/, vpn/, fragment/, decoy/,
constrate/, metamin/ under transport/. Baseline: preserve test counts.

### M2.4 — consolidate intake/ + delivery/ pkgs

Move httpapi/, auth/, duress/, admin/ into intake/. Move sanitizer/,
contentenc/ into delivery/.

### M2.5 — carve public handler surface → `services/relay/web/`

Following the pattern proven in M3.3/M5.3 — handlers for /submit,
/v1/proxy-pool, /v1/auth-check get public-module path. Currently in
internal/httpapi; move out.

## Tests

Relay module is self-contained (own go.mod). Test count baseline at the
start of each M2.x commit MUST be preserved:
```bash
cd services/relay && go test -count=1 ./... | tail -3
```

## Dependencies

Relay module consumes:
- None from other services/* (cleanly isolated)

Relay module is consumed by:
- BFF (Express) via HTTP to its /submit + /v1/proxy-pool endpoints
- `outreach/sender` via anti-trace URL env var
- `scripts/send-*.sh` via /v1/auth-check

No Go cross-module imports. This makes M2 low-risk from a dependency
perspective.

## Out of scope

- Research-track pkgs (metamin, shamir, epochkeys, …) stay where they are
- Deploy boundary — still one Railway service (`anti-trace-relay-production-*`)

## Cross-branch signals

- A → B: `Needs-Tests: services/relay/internal/transport full regression after M2.3`
- A → B: `Breaks-Contract: none` (each M2.x is rename + re-export, no API shape change)

## References

- Commit `f4106f4` — proxifly primary source (M2.1 tail)
- `services/relay/DEVELOPMENT-PLAN.md` — long-range relay roadmap
- `docs/architecture/DOMAIN-MAP.md#relay`
