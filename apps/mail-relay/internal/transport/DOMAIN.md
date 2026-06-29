# services/relay/internal/transport/

**Status:** M2.2 marker — domain grouping for transport-layer packages.
See `services/relay/MIGRATION-M2.md` for the full reorg plan.

## What lives here

Currently transport/ holds proxy pool rotation + related helpers.
M2.3 will consolidate these additional sibling packages under this
namespace (rename path + update imports mechanically):

| Sibling pkg   | Move target                | Rationale                          |
|---------------|----------------------------|------------------------------------|
| onion/        | transport/onion/           | Tor transport                      |
| bridge/       | transport/bridge/          | obfs4/meek transport               |
| pool/         | transport/pool/            | connection pooling                 |
| traffic/      | transport/traffic/         | traffic shaping                    |
| vpn/          | transport/vpn/             | VPN transport                      |
| fragment/     | transport/fragment/        | message fragmentation              |
| decoy/        | transport/decoy/           | decoy traffic                      |
| constrate/    | transport/constrate/       | constant-rate cover                |
| metamin/      | transport/metamin/         | metadata minimizer                 |

## Current files

Run `ls services/relay/internal/transport/` for the live list. As packages
migrate, update this DOMAIN.md so the living map matches the directory tree.

## Why this grouping

Transport is the network-layer concern (how bytes reach the destination).
Separating it from intake/ (how bytes enter) and delivery/ (how bytes leave
the relay into SMTP) gives:
- Unambiguous test ownership
- Easier deploy reasoning (Railway service still single-binary)
- Operator mental model aligned with source tree

## References

- Reorg plan: `services/relay/MIGRATION-M2.md`
- Long-range roadmap: `services/relay/DEVELOPMENT-PLAN.md`
