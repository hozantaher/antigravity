# POC: Constant-Rate Emission Economics

## Status: Deferred (insufficient operational data)

## Hypothesis

Cover traffic at constant rate is cost-effective for single-operator deployment.

## Scope

- In scope: bandwidth and storage cost modeling at default emission rate (5s interval = 12 msg/min = 720 msg/hr)
- In scope: operator cost envelope (monthly bandwidth, storage, compute)
- In scope: comparison with no cover traffic (bridge-only) cost baseline
- Out of scope: multi-tenant cost allocation

## Cost Model (Theoretical)

### Bandwidth

At default settings:
- Emission rate: 12 msg/min (5s interval)
- Max payload: 65,536 bytes per message
- Cover traffic: same size as real messages (indistinguishable)
- Worst case: 12 * 65,536 = 786 KB/min = 47 MB/hr = 1.1 GB/day

In practice, most messages are much smaller (1-5 KB), and cover traffic is generated at typical message size:
- Realistic: ~5 KB * 12/min = 60 KB/min = 3.6 MB/hr = 86 MB/day

### Storage

Dead drop slots have 24h TTL:
- Max slots: 720/hr * 24h = 17,280 unique slots (theoretical max)
- In practice: single-operator deployment has far fewer slots
- With GC hourly: only unexpired slots consume memory
- Persistent pool (optional): ~1 MB for 20 envelopes at max size

### Compute

- Emitter: one goroutine, one HMAC per message, negligible CPU
- Pool: one crypto/rand call per draw, negligible
- GC: hourly map iteration, negligible

### Monthly Cost Estimate (single operator)

| Component | Estimate |
|-----------|----------|
| Bandwidth (realistic) | 2.5 GB/month |
| Storage (in-memory) | <10 MB peak |
| Compute | Negligible (single goroutine) |
| Total incremental cost | ~$0-1/month on any cloud |

## Success Signal

Cover traffic cost is <10% of total deployment cost for a single-operator instance.

## Failure Signal

Cover traffic consumes >50% of deployment budget, or bandwidth costs become the primary cost driver.

## Decision

**Deferred** — The theoretical model shows negligible cost for single-operator deployment. Real measurement requires a sustained multi-day run with monitoring, which depends on the deaddrop credibility POC (POC-deaddrop-credibility). The theoretical analysis suggests this POC will pass when measured.

## Review Date: When POC-deaddrop-credibility is promoted from deferred.
