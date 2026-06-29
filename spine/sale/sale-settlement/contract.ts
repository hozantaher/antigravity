// Sale Settlement — module contract (binds the settlement UI top-node + logic to the money surface).
//
//   top node      ./ui/settlement/*.vue — the settlement wizard, auto-imported by bare name
//        │        (<SettlementCard>, <SettlementWizard>, <SettlementStepper>, <SettlementStepSummary>,
//        │        <SettlementStepBilling>, <SettlementStepMethod>, <SettlementStepCard>,
//        │        <SettlementStepPayment>, <SettlementStepVerifying>, <SettlementStepSuccess>);
//        │        the page-local winner branch in pages/item/ui/PriceStatus.vue mounts <SettlementCard>
//   contract      this file — the data types the UI + logic bind to
//        │        settlement API:  GET  /api/item/:id/settlement,
//        │                         POST /api/item/:id/settlement/transfer,
//        │                         POST /api/item/:id/settlement/checkout
//        │        Stripe webhook (machine-to-machine, shared, branch on type): POST /api/webhooks/stripe
//        │        Fio sweep (machine-to-machine, shared): POST /api/cron/fio-payments
//   bottom node   pure Settlement/Invoice/Price model types, re-exported here as the module's
//                 contract-tagged subset of the central models/ barrel (decision §7.2)
//
// Behind the contract (swappable impl): logic/useSettlement (auto-imported via imports.dirs
// features/*/logic); ALL money server logic stays under server/ — server/utils/settlement.ts,
// server/repos/settlementRepo.ts, the SHARED settle core server/repos/settleCore.ts (reused by the
// deposit path too), the added createFakturoidInvoice in server/utils/fakturoid.ts + the sale branch
// of the Stripe webhook and the Fio sweep.
//
// Value consts (SALE_INVOICE_TYPE, computeAmountDue, settlementStateFrom, INVOICE_STATUS) stay
// auto-imported from the models/ barrel — not re-exported here.
export type {
  Settlement,
  SettlementState,
  SettlementBankDetails,
  IssueSaleTransferResult,
  Invoice,
  InvoiceStatus,
  Price,
} from '~/models'
