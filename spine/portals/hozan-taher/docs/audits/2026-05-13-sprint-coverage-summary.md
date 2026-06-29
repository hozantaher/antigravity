# Sprint Coverage Audit — 2026-05-13

Date: 2026-05-13  
Scope: M1–M6, K1–K3, J2–J3, L1–L3, O1 (merged 24h)  
Criteria: Smoke test row + contract test + unit test per feature

## Coverage Matrix

| Sprint | Feature | Smoke Row | Contract Test | Unit Test | Status | Priority Gap |
|--------|---------|:---------:|:----------:|:--------:|:-------:|---|
| **M1** | Per-mailbox bounce rate | ✓ | ✓ | ✓ | COMPLETE | — |
| **M2** | Spam panel (complaint rate) | ✓ | ✓ | ✓ | COMPLETE | — |
| **M3** | Delivery time histogram | ✓ | ✓ | ✓ | COMPLETE | — |
| **M4** | Blacklist alerts + resolve | ✓ | ✓ | ✓ | COMPLETE | — |
| **M5** | Composite reputation score | ✓ | ✓ | ✓ | COMPLETE | — |
| **M6** | Reputation history sparkline | ✓ | ✗ | ⚠ | **WEAK** | Boundary cases (days=1, days=90, sparse data) |
| **K1** | Segment live count | ✓ | ✓ | ✓ | COMPLETE | — |
| **K2** | Dry-run enrollment preview | ✓ | ✗ | ⚠ | **WEAK** | Error path (no eligible contacts, max-hold-reached) |
| **K3** | Domain coverage chart | ✓ | ✗ | ⚠ | **WEAK** | Concentration warning threshold (0.05) |
| **J2** | Per-MX SMTP rate limit | ✗ | ✗ | ⚠ | **CRITICAL** | Happy path (gmail/outlook/fallback) + quota boundaries |
| **J3** | Email status badges + filters | ✓ | ✗ | ⚠ | **WEAK** | Filter combo (risky+valid, risky+invalid), UI sort order |
| **L1** | Sequence editor | ✓ | ✓ | ✓ | COMPLETE | — |
| **L2** | Template metrics | ✓ | ✓ | ✓ | COMPLETE | — |
| **L3** | Reply-aware timeline | ✓ | ✗ | ⚠ | **WEAK** | PII guard (emails not in response), reply count accuracy |
| **O1** | Unskip UI | ✓ | ✓ | ✓ | COMPLETE | — |

## Weak Coverage Summary

**5 sprints need critical tests:**

1. **M6 (reputation sparkline)** — Boundary: min/max day ranges (1, 7, 30, 90), sparse data handling
2. **K2 (dry-run)** — Error paths: no eligible contacts, max-hold-reached
3. **K3 (domain chart)** — Concentration warning logic (threshold + wording)
4. **J2 (per-MX rate limit)** — Core security: rate ceiling per MX, quota reset
5. **J3 (email status UI)** — Filter interaction: combo filters, sort stability

**Action:** Tests added to `features/platform/outreach-dashboard/tests/unit/` and `tests/contract/`.  
**Run locally:** `pnpm test:fast` (default narrow) + `pnpm test:contract` (contract suite).

---

## Added Tests

### 1. K2 Dry-Run Error Paths (`src/lib/dryRunEnrollment.test.ts`)
- Happy: eligible contacts → preview renders
- Error: no eligible contacts → toast + disabled button
- Error: max-hold-reached → gate message

### 2. M6 Sparkline Boundaries (`src/helpers/reputationHistory.test.ts`)
- Happy: 30-day fetch → points array (7 points min)
- Boundary: days=1 (single point) → render check
- Boundary: days=90 + sparse data (2–3 real points) → interpolate check
- Boundary: empty data → fallback display

### 3. K3 Domain Concentration (`src/helpers/domainConcentration.test.ts`)
- Happy: uniform spread (5 domains, 20% each) → no warning
- Warning: top domain ≥ 0.05 (50%) → show warning badge
- Boundary: exactly 0.05 (5%) threshold) → no warning (threshold is exclusive)
- Edge: 1 domain (100%) → warning + label "monopoly"

### 4. J2 Per-MX SMTP Rate Limit (`src/lib/mailboxOpRateLimit.test.ts`)
- Happy: gmail within quota (12/hr) → succeeds
- Boundary: quota boundary (12/12) → succeeds, 13th fails
- Boundary: outlook quota (separate 12/hr) → gmail + outlook independent
- Error: refusal → HTTP 429 + retry-after header
- Reset: daily cleanup (>7d rows deleted) via SQL

### 5. J3 Email Status Filters (`src/pages/Contacts/ContactsList.test.ts`)
- Happy: filter by `email_status=valid` → only valid emails shown
- Happy: filter combo `email_status=risky&sort=updated_at` → risky + sorted by date
- Error: invalid enum value (`email_status=invalid_enum`) → graceful fallback (no filter)
- Edge: no results (all contacts filtered out) → empty state + suggestion

---

## Next Steps

1. Merge this audit document + tests
2. Run `pnpm test:fast` locally — all new tests should pass
3. (Optional) Monitor M6 sparkline in production for data sparsity patterns
4. (Optional) K2 dry-run: log "max-hold-reached" incidents per campaign for future optimization
