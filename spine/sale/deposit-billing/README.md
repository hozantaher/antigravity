# Deposit & Billing (module)
![Version](https://img.shields.io/badge/version-v1.3.3-blue)


Vertical-axis module — see `plan.md` §2.

- **Top node (UX/UI):** `ui/Invoices.vue` (auto-imported as `<Invoices>`) + the deposit wizard under `ui/deposit/*.vue`, auto-imported by bare name: `<DepositCard>`, `<DepositWizard>`, `<DepositStepper>`, `<DepositStepBilling>`, `<DepositStepCard>`, `<DepositStepCurrency>`, `<DepositStepMethod>`, `<DepositStepPayment>`, `<DepositStepSuccess>`, `<DepositStepVerifying>`.
- **Contract:** `contract.ts` — the data types the UI + logic bind to (`Invoice`, `InvoiceStatus`, `DepositCurrency`, `DepositBankDetails`, `DepositMethod`, `DepositState`, `DepositStatus`), re-exported from the central `models/` barrel (decision §7.2). Deposit API: `POST /api/deposit/transfer`, `POST /api/deposit/checkout`, `GET /api/deposit/status`. Invoices API: `GET /api/invoices`. Stripe webhook (machine-to-machine): `POST /api/webhooks/stripe`.
- **Bottom node (pure data):** the `Deposit` + `Invoice` model types — not physically moved (decision §7.2).
- **Behind the contract (swappable impl):** `logic/useDeposit.ts` + `logic/useInvoices.ts` (auto-imported via `imports.dirs: features/*/logic`). ⚠️ This is money: ALL server logic stays under `server/` — `server/utils/{deposit,fakturoid,fio,spayd,stripe}.ts`, `server/repos/depositRepo.ts`, the Stripe webhook (`server/api/webhooks/stripe.post.ts`) and the Fio payments cron stay where they are, untouched.

Self-measure: `pnpm module:signal deposit-billing`.
