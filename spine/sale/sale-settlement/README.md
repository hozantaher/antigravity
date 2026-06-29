# Sale Settlement (module)

Vertical-axis money module that **closes the money loop**: after a user *wins* an auction
(`auctionCloser` → `items.sold/closed/winner`), the winner pays the **final price minus the held
deposit**, a taxable Fakturoid invoice is issued, and the sale completes. Built to the
`deposit-billing` standard and **reusing** its machinery — the in-transaction settle core, the
Fakturoid/Stripe clients, the SPAYD builder, the Fio cron, and the `processed_stripe_events` claim
table — rather than duplicating them (plan §sale-settlement).

- **Top node (UX/UI):** `ui/settlement/*.vue` (auto-imported as `<SettlementCard>`, `<SettlementWizard>`,
  `<SettlementStepper>`, `<SettlementStepSummary>`, `<SettlementStepBilling>`, `<SettlementStepMethod>`,
  `<SettlementStepCard>`, `<SettlementStepPayment>`, `<SettlementStepVerifying>`, `<SettlementStepSuccess>`).
  The page-local winner branch in `pages/item/ui/PriceStatus.vue` mounts `<SettlementCard>` when the
  viewer is the winner of a sold item. The wizard's **first step is `summary`** (final price − deposit
  credit = amount due); the deposit's `currency` step is gone (the sale currency is fixed by the auction).
- **Contract:** `contract.ts` — the `Settlement` type the UI + logic bind to, re-exported from the
  central `models/` barrel (decision §7.2). API: `GET /api/item/:id/settlement`,
  `POST /api/item/:id/settlement/transfer`, `POST /api/item/:id/settlement/checkout`. The Stripe
  webhook (`POST /api/webhooks/stripe`) and the Fio sweep (`POST /api/cron/fio-payments`) are **shared**
  — both branch on the invoice `type='sale'`; no second endpoint.
- **Bottom node:** the pure `Settlement` model + `computeAmountDue`/`settlementStateFrom` helpers and
  the `SALE_INVOICE_TYPE` const — not physically moved (decision §7.2). Settlement state is **derived**
  from `invoices.status` × the `items.settled_at` marker (no fifth stored enum). The money row is a row
  in the existing `invoices` table with `type='sale'` (no new table); `items.settled_at` +
  `items.settlement_invoice_id` (migration 025) are the only schema delta.
- **Behind the contract (swappable impl):** `logic/useSettlement.ts` (status poll + transfer/checkout).
  Server-side: `server/repos/settlementRepo.ts` (the sale repo + pure `settlementError` gate +
  claim/settle/complete CAS), the **shared** `server/repos/settleCore.ts` (extracted from
  `depositRepo`'s former private `settleInvoiceInTx`, parameterised by invoice `type` + a
  `cancelSiblings` knob — ON for deposits, OFF for sales), `server/utils/settlement.ts` (orchestration),
  `createFakturoidInvoice` (taxable `document_type:'invoice'`, beside the deposit proforma), and the
  sale branches of the Stripe webhook + Fio sweep.

**Money-safety invariants (load-bearing):** charge once (one sale invoice per item via the
`items.settlement_invoice_id` claim CAS + partial unique index), settle once (the shared
`WHERE status='unpaid'` CAS), complete once (`WHERE settled_at IS NULL`), no money without a counterpart
(unmatched/cross-rail → refund-candidate error log, never a silent accept), claim+settle in one
transaction (a crash rolls back and the next run retries), and the currency offset refuses to cross
currencies (a deposit in another currency is never converted — the winner owes the full price).

**V1 scope cuts:** seller payout, commission/buyer's-premium, deposit residual refund,
partial/installment payments, non-payment re-listing, VAT-scheme decisioning (one `vatRate` knob).

Self-measure: `pnpm module:signal sale-settlement`.
