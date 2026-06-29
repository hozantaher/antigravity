// Deposit & Billing — module contract (binds the UI top-node + logic to the money surface).
//
//   top node      ./ui/Invoices.vue (auto-imported as <Invoices>) + ./ui/deposit/*.vue —
//        │        the deposit wizard, auto-imported by bare name (<DepositCard>, <DepositWizard>,
//        │        <DepositStepBilling>, <DepositStepCard>, <DepositStepCurrency>,
//        │        <DepositStepMethod>, <DepositStepPayment>, <DepositStepSuccess>,
//        │        <DepositStepVerifying>, <DepositStepper>)
//   contract      this file — the data types the UI + logic bind to
//        │        deposit API:  POST /api/deposit/transfer, POST /api/deposit/checkout,
//        │        GET /api/deposit/status
//        │        invoices API: GET /api/invoices
//        │        Stripe webhook (machine-to-machine): POST /api/webhooks/stripe
//   bottom node   pure Deposit/Invoice model types, re-exported here as the module's
//                 contract-tagged subset of the central models/ barrel (decision §7.2)
//
// Behind the contract (swappable impl): logic/{useDeposit,useInvoices} (auto-imported via
// imports.dirs features/*/logic); ALL money server logic stays under server/ —
// server/utils/{deposit,fakturoid,fio,spayd,stripe}.ts, server/repos/depositRepo.ts,
// the Stripe webhook (server/api/webhooks/stripe.post.ts) + the Fio cron.
//
// Value consts (DEPOSIT_AMOUNTS, INVOICE_STATUS, depositAmountFor, isDepositCurrency,
// DEPOSIT_INVOICE_TYPE) stay auto-imported from the models/ barrel — not re-exported here.
export type {
  Invoice,
  InvoiceStatus,
  DepositCurrency,
  DepositBankDetails,
  DepositMethod,
  DepositState,
  DepositStatus,
} from '~/models'
