# Cesta A — Archived (replaced by UI flow as of S4.3)

These SQL scripts were the **operator-driven SQL bypass** for first-campaign
launch when the UI/BFF↔Go enrollment bridge wasn't yet wired.

**Status**: superseded by Cesta B (commits `0e9a3ee` + `69608de`):
- BFF `POST /api/campaigns` proxies to Go service (S4.1)
- BFF `POST /api/campaigns/:id/run` + `/pause` proxy (S4.2)
- UI `CampaignNew` Step 3 multi-checkbox sectors (S4.3)

The SQL approach is preserved here as a **fallback for production
emergencies** where:

1. Go service is unreachable (Railway outage, deploy in progress)
2. Operator needs to create a campaign immediately without UI
3. Post-mortem replay requires deterministic enrollment from a snapshot

## Files

- `launch-001-machinery-soft-20.sql` — idempotent INSERT campaign + 20 enrollments
- `preview-001-machinery-soft-20.sql` — read-only diagnostic preview

## Last verified working

- 2026-04-25 — campaign 455 created via these scripts (before Cesta B landed)

## When to use

**Don't** unless UI flow is broken. Standard path is:
- Dashboard → Campaigns → "Vytvořit kampaň" → Step 1-4 → Submit
- BFF proxies to Go, Go runs `CreateCampaign` + `enrollContacts`
- Operator activates via "Spustit" button

## Reversal

To re-enable Cesta A as primary, move files back to `scripts/campaigns/`
and update `docs/playbooks/LAUNCH-CAMPAIGN-001.md`.
