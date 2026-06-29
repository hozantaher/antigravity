# contacts

**Status:** scaffold (M4.1)
**Owner:** tomas
**Initiative:** [2026-04-22-discipline-and-domain-migration](../../docs/initiatives/2026-04-22-discipline-and-domain-migration.md)

## Purpose

Prospekti, leady, segmenty, enrichment, deliverability. Zdroj pravdy pro
`outreach_contacts`, `outreach_companies`, `outreach_segments` tabulky.

## Public API

12 REST endpoints (contacts / companies / segments / leads). Viz `service.yaml`.

## Invariants

1. **Unique (email, tenant)** — deduplikační pravidlo na DB level.
2. **Segment membership** deterministický — stejný query + stejný snapshot = stejné IDs.
3. **Enrichment TTL 7d** — data refresh po 7 dnech; starší považován stale.
4. **Suppression list** je blocker napříč kampaněmi.
5. **Exclusion rules** (`outreach/exclusion` pkg) rozšiřují suppression o domain-level/regex.

## Getting Started

Kód žije stále v `modules/outreach/internal/{contact,lead,prospect,enrich,segment}/`. Tato složka = scaffold.

Track migrace:
- **M4.1** ✅ scaffold (this)
- **M4.2** move enrich (23 files, 0 internal deps)
- **M4.3** move segment + contact/lead/prospect
- **M4.4** UI extract do `@hozan/contacts-ui`
- **M4.5** finalize

## Related

- [DOMAIN-MAP contacts](../../docs/architecture/DOMAIN-MAP.md)
- [DOMAIN-MIGRATION playbook](../../docs/playbooks/DOMAIN-MIGRATION.md)
- Prerekvizity: `outreach/company` + `outreach/exclusion` (moved 2026-04-22)
