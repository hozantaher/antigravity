# TDD Task Registry — B2B Outreach Platform

> **Generated:** 2026-04-21
> **Source:** docs/superplan.md
> **Method:** Each task = 1 atomic RED/GREEN/REFACTOR action
> **Format:** `T-XXXX | MVP-NN | PHASE | LAYER | file | description | depends | est`

## Legend

| Field | Values |
|-------|--------|
| Phase | RED = write failing test, GREEN = minimal impl, REFACTOR = cleanup, VERIFY = gate check |
| Layer | Go, React, BFF, E2E, CI, DB, Config |
| Est | 10m, 15m, 20m, 30m, 45m, 1h, 2h |
| Status | `[ ]` pending, `[x]` done, `[~]` in progress, `[-]` skipped |

---

## FÁZE 0: Stabilizace (MVP-01 — MVP-03)

### MVP-01: Fix failing tests [S]

| ID | Phase | Layer | File | Description | Depends | Est | Status |
|----|-------|-------|------|-------------|---------|-----|--------|
| T-0001 | GREEN | React | src/test/setup.js | Fix URL patch: use `location.origin` instead of hardcoded port | — | 15m | [x] |
| T-0002 | GREEN | React | src/pages/Mailboxes.components.test.jsx | Add `within` import from @testing-library/react | — | 10m | [x] |
| T-0003 | GREEN | React | src/pages/Mailboxes.components.test.jsx | Fix filter select assertions (combobox role) | T-0002 | 10m | [x] |
| T-0004 | GREEN | React | src/secrets.scan.test.js | Add ALLOW_SNIPPETS entry for test fixture postgres URL | — | 10m | [x] |
| T-0005 | REFACTOR | React | src/test/setup.js | Add MSW handler: GET /api/mailboxes/health-summary | T-0001 | 10m | [x] |
| T-0006 | REFACTOR | React | src/test/setup.js | Add MSW handler: GET /api/mailboxes/send-trends | T-0001 | 10m | [x] |
| T-0007 | REFACTOR | React | src/test/setup.js | Add MSW handler: GET /api/health/system | T-0001 | 10m | [x] |
| T-0008 | REFACTOR | React | src/test/setup.js | Add MSW handler: GET /api/health/watchdog | T-0001 | 10m | [x] |
| T-0009 | REFACTOR | React | src/test/setup.js | Add MSW handler: GET /api/health/drift | T-0001 | 10m | [x] |
| T-0010 | REFACTOR | React | src/test/setup.js | Add MSW handler: GET /api/health/guards | T-0001 | 10m | [x] |
| T-0011 | REFACTOR | React | src/test/setup.js | Add MSW handler: GET /api/contacts | T-0001 | 10m | [x] |
| T-0012 | REFACTOR | React | src/test/setup.js | Add MSW handler: GET /api/version + /api/companies/facets + mailbox sub-routes | T-0001 | 10m | [x] |
| T-0013 | REFACTOR | Config | vitest.config.ts | Fix setupFiles (remove missing vitest-setup.ts); exclude 13 integration test files from unit run | T-0001 | 20m | [x] |
| T-0014 | VERIFY | React | — | Run `pnpm test` — unit/component tests: 0 failures | T-0013 | 10m | [~] |

### MVP-02: Build clean + baseline [M]

| ID | Phase | Layer | File | Description | Depends | Est | Status |
|----|-------|-------|------|-------------|---------|-----|--------|
| T-0015 | RED | React | — | Run `pnpm build`, document all errors | T-0014 | 15m | [ ] |
| T-0016 | RED | React | — | Run `pnpm test --coverage`, document baseline per-file | T-0014 | 15m | [ ] |
| T-0017 | GREEN | React | (various) | Fix TypeScript/lint errors blocking build | T-0015 | 45m | [ ] |
| T-0018 | GREEN | React | (various) | Fix import issues (missing deps, circular) | T-0015 | 30m | [ ] |
| T-0019 | REFACTOR | Config | — | Remove .stryker-tmp directory if present | T-0017 | 10m | [ ] |
| T-0020 | REFACTOR | React | (various) | Clean unused imports across src/ | T-0017 | 30m | [ ] |
| T-0021 | VERIFY | React | — | `pnpm build` clean + coverage report generated | T-0020 | 10m | [ ] |

### MVP-03: Smoke test + CI [M]

| ID | Phase | Layer | File | Description | Depends | Est | Status |
|----|-------|-------|------|-------------|---------|-----|--------|
| T-0022 | RED | BFF | test/smoke.test.js | Test: GET /api/version returns 200 + has sha field | T-0021 | 15m | [ ] |
| T-0023 | RED | BFF | test/smoke.test.js | Test: GET /api/health/system returns 200 + has db field | T-0021 | 15m | [ ] |
| T-0024 | RED | BFF | test/smoke.test.js | Test: GET /api/health/guards returns 200 | T-0021 | 10m | [ ] |
| T-0025 | RED | BFF | test/smoke.test.js | Test: BFF starts without crash (spawn + health check) | T-0021 | 20m | [ ] |
| T-0026 | GREEN | BFF | test/smoke.test.js | Implement smoke test runner (spawn BFF, wait, probe) | T-0025 | 45m | [ ] |
| T-0027 | GREEN | CI | .github/workflows/ci.yml | CI pipeline: pnpm test && pnpm build | T-0026 | 30m | [ ] |
| T-0028 | REFACTOR | Config | — | Document CI pipeline in superplan | T-0027 | 15m | [ ] |
| T-0029 | VERIFY | CI | — | Smoke green + go test ./... still passing | T-0028 | 10m | [ ] |

---

## FÁZE 1: Campaign wizard (MVP-04 — MVP-08)

### MVP-04: CampaignNew wizard — stepper skeleton [M]

| ID | Phase | Layer | File | Description | Depends | Est | Status |
|----|-------|-------|------|-------------|---------|-----|--------|
| T-0030 | RED | React | src/pages/__tests__/CampaignNew.stepper.test.jsx | Test: renders 4-step indicator (Základní, Šablona, Segment, Sekvence) | T-0014 | 15m | [ ] |
| T-0031 | RED | React | src/pages/__tests__/CampaignNew.stepper.test.jsx | Test: step 1 visible by default, steps 2-4 hidden | T-0030 | 10m | [ ] |
| T-0032 | RED | React | src/pages/__tests__/CampaignNew.stepper.test.jsx | Test: "Další" button advances to step 2 | T-0030 | 10m | [ ] |
| T-0033 | RED | React | src/pages/__tests__/CampaignNew.stepper.test.jsx | Test: "Zpět" button returns to step 1 | T-0030 | 10m | [ ] |
| T-0034 | RED | React | src/pages/__tests__/CampaignNew.stepper.test.jsx | Test: step indicator highlights current step | T-0030 | 10m | [ ] |
| T-0035 | RED | React | src/pages/__tests__/CampaignNew.stepper.test.jsx | Test: cannot advance from step 1 without name (validation) | T-0030 | 15m | [ ] |
| T-0036 | RED | React | src/pages/__tests__/CampaignNew.stepper.test.jsx | Test: step 1 shows name, description, category, match type fields | T-0030 | 15m | [ ] |
| T-0037 | GREEN | React | src/pages/CampaignNew.jsx | Create CampaignNew component with step state (currentStep, formData) | T-0036 | 30m | [ ] |
| T-0038 | GREEN | React | src/pages/CampaignNew.jsx | Step 1 form: name (required) + description + category multi-select + match type radio | T-0037 | 30m | [ ] |
| T-0039 | GREEN | React | src/pages/CampaignNew.jsx | Navigation: Zpět/Další buttons with step bounds | T-0037 | 20m | [ ] |
| T-0040 | GREEN | React | src/pages/CampaignNew.jsx | Validation: required fields per step, error messages | T-0037 | 20m | [ ] |
| T-0041 | GREEN | React | src/pages/Campaigns.jsx | Wire "Nová kampaň" button to open CampaignNew modal | T-0037 | 15m | [ ] |
| T-0042 | REFACTOR | React | src/components/StepIndicator.jsx | Extract StepIndicator into reusable component | T-0041 | 20m | [ ] |
| T-0043 | VERIFY | React | — | Wizard opens from Campaigns. Step 1 renders. Navigation works. | T-0042 | 10m | [ ] |

### MVP-05: CampaignNew — template picker [M]

| ID | Phase | Layer | File | Description | Depends | Est | Status |
|----|-------|-------|------|-------------|---------|-----|--------|
| T-0044 | RED | React | src/pages/__tests__/CampaignNew.templates.test.jsx | Test: step 2 shows list of templates from store | T-0043 | 15m | [ ] |
| T-0045 | RED | React | src/pages/__tests__/CampaignNew.templates.test.jsx | Test: each template shows name + subject preview | T-0044 | 10m | [ ] |
| T-0046 | RED | React | src/pages/__tests__/CampaignNew.templates.test.jsx | Test: can select multiple templates (checkbox) | T-0044 | 15m | [ ] |
| T-0047 | RED | React | src/pages/__tests__/CampaignNew.templates.test.jsx | Test: cannot advance without at least 1 template selected | T-0044 | 10m | [ ] |
| T-0048 | RED | React | src/pages/__tests__/CampaignNew.templates.test.jsx | Test: selected templates carry to step 4 | T-0044 | 15m | [ ] |
| T-0049 | GREEN | React | src/pages/CampaignNew.jsx | Step 2 component: load templates from store, render list | T-0048 | 30m | [ ] |
| T-0050 | GREEN | React | src/pages/CampaignNew.jsx | Template list with checkboxes + subject preview | T-0049 | 20m | [ ] |
| T-0051 | GREEN | React | src/pages/CampaignNew.jsx | Selection state persisted across steps (formData.selectedTemplates) | T-0049 | 15m | [ ] |
| T-0052 | VERIFY | React | — | Step 2 shows templates. Selection works. Validation blocks empty. | T-0051 | 10m | [ ] |

### MVP-06: CampaignNew — segment picker [M]

| ID | Phase | Layer | File | Description | Depends | Est | Status |
|----|-------|-------|------|-------------|---------|-----|--------|
| T-0053 | RED | React | src/pages/__tests__/CampaignNew.segment.test.jsx | Test: step 3 shows dropdown of existing segments | T-0052 | 15m | [ ] |
| T-0054 | RED | React | src/pages/__tests__/CampaignNew.segment.test.jsx | Test: shows segment name + company count | T-0053 | 10m | [ ] |
| T-0055 | RED | React | src/pages/__tests__/CampaignNew.segment.test.jsx | Test: "Preview" button shows count via API | T-0053 | 15m | [ ] |
| T-0056 | RED | React | src/pages/__tests__/CampaignNew.segment.test.jsx | Test: can alternatively build ad-hoc filter (QueryBuilder) | T-0053 | 15m | [ ] |
| T-0057 | RED | React | src/pages/__tests__/CampaignNew.segment.test.jsx | Test: cannot advance without segment or filter | T-0053 | 10m | [ ] |
| T-0058 | GREEN | React | src/pages/CampaignNew.jsx | Step 3: segment dropdown loading from store | T-0057 | 20m | [ ] |
| T-0059 | GREEN | React | src/pages/CampaignNew.jsx | Preview count via POST /api/segments/preview | T-0058 | 20m | [ ] |
| T-0060 | GREEN | React | src/pages/CampaignNew.jsx | QueryBuilder fallback for ad-hoc filter | T-0058 | 30m | [ ] |
| T-0061 | VERIFY | React | — | Step 3 shows segments. Preview works. Segment required. | T-0060 | 10m | [ ] |

### MVP-07: CampaignNew — sequence builder + submit [L]

| ID | Phase | Layer | File | Description | Depends | Est | Status |
|----|-------|-------|------|-------------|---------|-----|--------|
| T-0062 | RED | React | src/pages/__tests__/CampaignNew.sequence.test.jsx | Test: step 4 shows selected templates in order | T-0061 | 15m | [ ] |
| T-0063 | RED | React | src/pages/__tests__/CampaignNew.sequence.test.jsx | Test: can reorder templates (up/down arrows) | T-0062 | 15m | [ ] |
| T-0064 | RED | React | src/pages/__tests__/CampaignNew.sequence.test.jsx | Test: each step has delay_days input (default 3) | T-0062 | 10m | [ ] |
| T-0065 | RED | React | src/pages/__tests__/CampaignNew.sequence.test.jsx | Test: "Vytvořit kampaň" submits POST /api/campaigns | T-0062 | 15m | [ ] |
| T-0066 | RED | React | src/pages/__tests__/CampaignNew.sequence.test.jsx | Test: on success redirect to /campaigns/:id | T-0062 | 10m | [ ] |
| T-0067 | RED | React | src/pages/__tests__/CampaignNew.sequence.test.jsx | Test: shows error toast on failure | T-0062 | 10m | [ ] |
| T-0068 | GREEN | React | src/pages/CampaignNew.jsx | Step 4: ordered template list with reorder arrows | T-0067 | 30m | [ ] |
| T-0069 | GREEN | React | src/pages/CampaignNew.jsx | Delay inputs per step (number input, default 3) | T-0068 | 15m | [ ] |
| T-0070 | GREEN | React | src/pages/CampaignNew.jsx | Submit: build sequence_config JSON, POST via store | T-0068 | 30m | [ ] |
| T-0071 | GREEN | React | src/pages/CampaignNew.jsx | Redirect to /campaigns/:newId on success | T-0070 | 15m | [ ] |
| T-0072 | REFACTOR | React | src/pages/CampaignNew.jsx | Remove old NewCampaignModal if replaced | T-0071 | 20m | [ ] |
| T-0073 | VERIFY | React | — | Full 4-step wizard end-to-end. Campaign created. Redirect works. | T-0072 | 10m | [ ] |

### MVP-08: Quality gate modal [L]

| ID | Phase | Layer | File | Description | Depends | Est | Status |
|----|-------|-------|------|-------------|---------|-----|--------|
| T-0074 | RED | React | src/pages/__tests__/QualityGate.test.jsx | Test: modal opens on "Spustit" for draft campaign | T-0073 | 15m | [ ] |
| T-0075 | RED | React | src/pages/__tests__/QualityGate.test.jsx | Test: shows email quality breakdown (valid/risky/catch-all/invalid/unverified) | T-0074 | 15m | [ ] |
| T-0076 | RED | React | src/pages/__tests__/QualityGate.test.jsx | Test: shows capacity info (active mailboxes, daily capacity, days) | T-0074 | 15m | [ ] |
| T-0077 | RED | React | src/pages/__tests__/QualityGate.test.jsx | Test: shows DNS check (SPF/DKIM/DMARC) | T-0074 | 15m | [ ] |
| T-0078 | RED | React | src/pages/__tests__/QualityGate.test.jsx | Test: "Spustit kampaň" calls POST /api/campaigns/:id/run | T-0074 | 15m | [ ] |
| T-0079 | RED | React | src/pages/__tests__/QualityGate.test.jsx | Test: "Ověřit neověřené" calls batch verify endpoint | T-0074 | 15m | [ ] |
| T-0080 | RED | React | src/pages/__tests__/QualityGate.test.jsx | Test: warning banner when < 80% valid | T-0074 | 10m | [ ] |
| T-0081 | RED | React | src/pages/__tests__/QualityGate.test.jsx | Test: progress bar shows % valid | T-0074 | 10m | [ ] |
| T-0082 | GREEN | React | src/components/QualityGateModal.jsx | Modal shell: open/close, 3 sections layout | T-0081 | 30m | [ ] |
| T-0083 | GREEN | React | src/components/QualityGateModal.jsx | Email quality section: fetch /api/campaigns/:id/email-quality | T-0082 | 20m | [ ] |
| T-0084 | GREEN | React | src/components/QualityGateModal.jsx | Capacity section: fetch /api/campaigns/:id/capacity | T-0082 | 20m | [ ] |
| T-0085 | GREEN | React | src/components/QualityGateModal.jsx | DNS section: display SPF/DKIM/DMARC status | T-0082 | 20m | [ ] |
| T-0086 | GREEN | React | src/components/QualityGateModal.jsx | Action buttons: Zrušit, Ověřit neověřené, Spustit kampaň | T-0082 | 20m | [ ] |
| T-0087 | GREEN | React | src/pages/CampaignDetail.jsx | Wire "Spustit" button to open QualityGateModal | T-0086 | 15m | [ ] |
| T-0088 | REFACTOR | React | src/components/QualityGateModal.jsx | Extract ProgressBar and CheckRow components | T-0087 | 20m | [ ] |
| T-0089 | VERIFY | React | — | Quality gate blocks launch. All data fetched + displayed. | T-0088 | 10m | [ ] |

---

## FÁZE 2: Campaign operations (MVP-09 — MVP-11)

### MVP-09: Campaign run/pause wiring [M]

| ID | Phase | Layer | File | Description | Depends | Est | Status |
|----|-------|-------|------|-------------|---------|-----|--------|
| T-0090 | RED | React | src/pages/__tests__/CampaignDetail.actions.test.jsx | Test: "Spustit" visible on draft/paused campaign | T-0089 | 15m | [ ] |
| T-0091 | RED | React | src/pages/__tests__/CampaignDetail.actions.test.jsx | Test: "Pozastavit" visible on running campaign | T-0090 | 10m | [ ] |
| T-0092 | RED | React | src/pages/__tests__/CampaignDetail.actions.test.jsx | Test: click "Spustit" → quality gate → confirm → status=running | T-0090 | 20m | [ ] |
| T-0093 | RED | React | src/pages/__tests__/CampaignDetail.actions.test.jsx | Test: click "Pozastavit" → confirm → status=paused | T-0090 | 15m | [ ] |
| T-0094 | RED | React | src/pages/__tests__/CampaignDetail.actions.test.jsx | Test: status badge updates optimistically | T-0090 | 10m | [ ] |
| T-0095 | RED | React | src/pages/__tests__/CampaignDetail.actions.test.jsx | Test: toast notification on success | T-0090 | 10m | [ ] |
| T-0096 | GREEN | React | src/pages/CampaignDetail.jsx | Wire run/pause buttons to store.setCampaignStatus() | T-0095 | 20m | [ ] |
| T-0097 | GREEN | React | src/pages/CampaignDetail.jsx | Optimistic UI update on status change | T-0096 | 15m | [ ] |
| T-0098 | GREEN | React | src/pages/CampaignDetail.jsx | Toast feedback on run/pause success/failure | T-0096 | 15m | [ ] |
| T-0099 | VERIFY | React | — | Operator can start and pause campaigns from CampaignDetail. | T-0098 | 10m | [ ] |

### MVP-10: CampaignDetail live KPIs [M]

| ID | Phase | Layer | File | Description | Depends | Est | Status |
|----|-------|-------|------|-------------|---------|-----|--------|
| T-0100 | RED | React | src/pages/__tests__/CampaignDetail.kpis.test.jsx | Test: KPI cells show correct values from API | T-0099 | 15m | [ ] |
| T-0101 | RED | React | src/pages/__tests__/CampaignDetail.kpis.test.jsx | Test: auto-refresh every 30s when campaign running | T-0100 | 15m | [ ] |
| T-0102 | RED | React | src/pages/__tests__/CampaignDetail.kpis.test.jsx | Test: funnel visualization correct proportions | T-0100 | 15m | [ ] |
| T-0103 | RED | React | src/pages/__tests__/CampaignDetail.kpis.test.jsx | Test: send table shows recent sends with status | T-0100 | 15m | [ ] |
| T-0104 | RED | React | src/pages/__tests__/CampaignDetail.kpis.test.jsx | Test: send table pagination (offset-based) | T-0100 | 15m | [ ] |
| T-0105 | GREEN | React | src/pages/CampaignDetail.jsx | Polling: setInterval 30s when status=running, clear on unmount | T-0104 | 20m | [ ] |
| T-0106 | GREEN | React | src/pages/CampaignDetail.jsx | Funnel bar widths calculated from data proportions | T-0105 | 20m | [ ] |
| T-0107 | GREEN | React | src/pages/CampaignDetail.jsx | Send table pagination (limit/offset, next/prev) | T-0105 | 20m | [ ] |
| T-0108 | VERIFY | React | — | KPIs update live. Funnel accurate. Sends paginated. | T-0107 | 10m | [ ] |

### MVP-11: Campaign E2E test [M]

| ID | Phase | Layer | File | Description | Depends | Est | Status |
|----|-------|-------|------|-------------|---------|-----|--------|
| T-0109 | RED | E2E | test/e2e/campaign-lifecycle.spec.ts | E2E: navigate to /campaigns | T-0108 | 15m | [ ] |
| T-0110 | RED | E2E | test/e2e/campaign-lifecycle.spec.ts | E2E: click "Nová kampaň", complete 4-step wizard | T-0109 | 30m | [ ] |
| T-0111 | RED | E2E | test/e2e/campaign-lifecycle.spec.ts | E2E: arrive at CampaignDetail | T-0110 | 10m | [ ] |
| T-0112 | RED | E2E | test/e2e/campaign-lifecycle.spec.ts | E2E: click "Spustit" → quality gate → confirm → running | T-0111 | 20m | [ ] |
| T-0113 | RED | E2E | test/e2e/campaign-lifecycle.spec.ts | E2E: click "Pozastavit" → confirm → paused | T-0112 | 15m | [ ] |
| T-0114 | GREEN | E2E | test/e2e/campaign-lifecycle.spec.ts | Implement E2E with seeded test data or MSW | T-0113 | 1h | [ ] |
| T-0115 | VERIFY | E2E | — | E2E green. Full campaign lifecycle verified. | T-0114 | 10m | [ ] |

---

## FÁZE 3: DNS & Preflight (MVP-12 — MVP-13)

### MVP-12: DNS audit panel [M]

| ID | Phase | Layer | File | Description | Depends | Est | Status |
|----|-------|-------|------|-------------|---------|-----|--------|
| T-0116 | RED | Go | modules/outreach/internal/dns/audit_test.go | Test: DNS probe returns correct SPF result | T-0014 | 15m | [ ] |
| T-0117 | RED | Go | modules/outreach/internal/dns/audit_test.go | Test: DNS probe returns correct DKIM result | T-0116 | 15m | [ ] |
| T-0118 | RED | Go | modules/outreach/internal/dns/audit_test.go | Test: DNS probe returns correct DMARC result | T-0116 | 15m | [ ] |
| T-0119 | RED | Go | modules/outreach/internal/dns/audit_test.go | Test: handles DNS timeout gracefully | T-0116 | 10m | [ ] |
| T-0120 | RED | Go | modules/outreach/internal/dns/audit_test.go | Test: returns pass/warn/fail per check | T-0116 | 10m | [ ] |
| T-0121 | RED | React | src/pages/__tests__/DnsAuditPanel.test.jsx | Test: panel renders in Mailboxes page | T-0014 | 15m | [ ] |
| T-0122 | RED | React | src/pages/__tests__/DnsAuditPanel.test.jsx | Test: shows SPF/DKIM/DMARC per domain | T-0121 | 15m | [ ] |
| T-0123 | RED | React | src/pages/__tests__/DnsAuditPanel.test.jsx | Test: pass=green checkmark, fail=red X | T-0121 | 10m | [ ] |
| T-0124 | RED | React | src/pages/__tests__/DnsAuditPanel.test.jsx | Test: "Refresh" button re-fetches | T-0121 | 10m | [ ] |
| T-0125 | GREEN | Go | modules/outreach/internal/dns/audit.go | Implement DNS probe (SPF/DKIM/DMARC lookup) | T-0120 | 45m | [ ] |
| T-0126 | GREEN | Go | modules/outreach/internal/web/audit_handler.go | GET /api/dns-audit endpoint | T-0125 | 20m | [ ] |
| T-0127 | GREEN | BFF | server.js | BFF proxy route for /api/dns-audit | T-0126 | 15m | [ ] |
| T-0128 | GREEN | React | src/components/DnsAuditPanel.jsx | Panel component with SPF/DKIM/DMARC display | T-0124 | 30m | [ ] |
| T-0129 | GREEN | React | src/pages/Mailboxes.jsx | Integrate DnsAuditPanel into Mailboxes page | T-0128 | 15m | [ ] |
| T-0130 | VERIFY | React | — | DNS audit visible. SPF/DKIM/DMARC checked per domain. | T-0129 | 10m | [ ] |

### MVP-13: Preflight gate [M]

| ID | Phase | Layer | File | Description | Depends | Est | Status |
|----|-------|-------|------|-------------|---------|-----|--------|
| T-0131 | RED | Go | modules/outreach/internal/campaign/preflight_test.go | Test: DNS pass check | T-0130 | 15m | [ ] |
| T-0132 | RED | Go | modules/outreach/internal/campaign/preflight_test.go | Test: active mailboxes > 0 check | T-0131 | 10m | [ ] |
| T-0133 | RED | Go | modules/outreach/internal/campaign/preflight_test.go | Test: segment non-empty check | T-0131 | 10m | [ ] |
| T-0134 | RED | Go | modules/outreach/internal/campaign/preflight_test.go | Test: template valid check | T-0131 | 10m | [ ] |
| T-0135 | RED | Go | modules/outreach/internal/campaign/preflight_test.go | Test: returns pass/fail list | T-0131 | 10m | [ ] |
| T-0136 | RED | Go | modules/outreach/internal/campaign/preflight_test.go | Test: blocks running if any check fails | T-0131 | 15m | [ ] |
| T-0137 | RED | React | src/pages/__tests__/QualityGate.preflight.test.jsx | Test: preflight section in quality gate modal | T-0089 | 15m | [ ] |
| T-0138 | RED | React | src/pages/__tests__/QualityGate.preflight.test.jsx | Test: red/green indicators per check | T-0137 | 10m | [ ] |
| T-0139 | RED | React | src/pages/__tests__/QualityGate.preflight.test.jsx | Test: "Spustit" disabled if any check fails | T-0137 | 10m | [ ] |
| T-0140 | GREEN | Go | modules/outreach/internal/campaign/preflight.go | Implement preflight checks | T-0136 | 30m | [ ] |
| T-0141 | GREEN | Go | modules/outreach/internal/web/campaign_handler.go | Wire preflight into campaign run endpoint | T-0140 | 20m | [ ] |
| T-0142 | GREEN | React | src/components/QualityGateModal.jsx | Add preflight section with check indicators | T-0139 | 20m | [ ] |
| T-0143 | GREEN | React | src/components/QualityGateModal.jsx | Disable "Spustit" when preflight fails | T-0142 | 10m | [ ] |
| T-0144 | VERIFY | — | — | Campaign cannot launch without passing all preflight checks. | T-0143 | 10m | [ ] |

---

## FÁZE 4: Inbox & threading (MVP-14 — MVP-16)

### MVP-14: Inbox page enhancements [L]

| ID | Phase | Layer | File | Description | Depends | Est | Status |
|----|-------|-------|------|-------------|---------|-----|--------|
| T-0145 | RED | React | src/pages/__tests__/Inbox.test.jsx | Test: renders thread list columns (Contact, Subject, Campaign, Classification, Time) | T-0014 | 15m | [ ] |
| T-0146 | RED | React | src/pages/__tests__/Inbox.test.jsx | Test: tabs Vše/Nezpracované/Zájem/Odmítnutí/Auto-reply | T-0145 | 15m | [ ] |
| T-0147 | RED | React | src/pages/__tests__/Inbox.test.jsx | Test: tab counts from /api/replies/stats | T-0145 | 15m | [ ] |
| T-0148 | RED | React | src/pages/__tests__/Inbox.test.jsx | Test: switching tab filters results | T-0145 | 15m | [ ] |
| T-0149 | RED | React | src/pages/__tests__/Inbox.test.jsx | Test: search input filters by contact/subject | T-0145 | 15m | [ ] |
| T-0150 | RED | React | src/pages/__tests__/Inbox.test.jsx | Test: pagination "Načíst další" button | T-0145 | 15m | [ ] |
| T-0151 | RED | React | src/pages/__tests__/Inbox.test.jsx | Test: unhandled rows highlighted background | T-0145 | 10m | [ ] |
| T-0152 | GREEN | React | src/pages/Inbox.jsx | Tab state management + API filter params | T-0151 | 30m | [ ] |
| T-0153 | GREEN | React | src/pages/Inbox.jsx | Search with debounce (300ms) | T-0152 | 20m | [ ] |
| T-0154 | GREEN | React | src/pages/Inbox.jsx | Pagination: offset-based, 30/page | T-0152 | 20m | [ ] |
| T-0155 | GREEN | React | src/pages/Inbox.jsx | Highlighted rows for unhandled | T-0152 | 10m | [ ] |
| T-0156 | VERIFY | React | — | Inbox functional with tabs, search, pagination. | T-0155 | 10m | [ ] |

### MVP-15: Reply slide-over enhancement [M]

| ID | Phase | Layer | File | Description | Depends | Est | Status |
|----|-------|-------|------|-------------|---------|-----|--------|
| T-0157 | RED | React | src/pages/__tests__/ReplySlideOver.test.jsx | Test: clicking row opens slide-over (302px) | T-0156 | 15m | [ ] |
| T-0158 | RED | React | src/pages/__tests__/ReplySlideOver.test.jsx | Test: shows contact name, email, classification, subject, campaign | T-0157 | 15m | [ ] |
| T-0159 | RED | React | src/pages/__tests__/ReplySlideOver.test.jsx | Test: "Handled" button marks as handled | T-0157 | 15m | [ ] |
| T-0160 | RED | React | src/pages/__tests__/ReplySlideOver.test.jsx | Test: "→ Vlákno" navigates to /replies/:id | T-0157 | 10m | [ ] |
| T-0161 | RED | React | src/pages/__tests__/ReplySlideOver.test.jsx | Test: close button closes slide-over | T-0157 | 10m | [ ] |
| T-0162 | GREEN | React | src/pages/Inbox.jsx | Enhance slide-over with all fields | T-0161 | 20m | [ ] |
| T-0163 | GREEN | React | src/pages/Inbox.jsx | Add "→ Vlákno" navigation link | T-0162 | 10m | [ ] |
| T-0164 | VERIFY | React | — | Slide-over shows summary. Navigation to ThreadDetail works. | T-0163 | 10m | [ ] |

### MVP-16: Nav badge [S]

| ID | Phase | Layer | File | Description | Depends | Est | Status |
|----|-------|-------|------|-------------|---------|-----|--------|
| T-0165 | RED | React | src/components/__tests__/NavBadge.test.jsx | Test: badge shows unhandled reply count next to "Odpovědi" | T-0156 | 15m | [ ] |
| T-0166 | RED | React | src/components/__tests__/NavBadge.test.jsx | Test: count updates on store.reloadReplyStats() | T-0165 | 10m | [ ] |
| T-0167 | RED | React | src/components/__tests__/NavBadge.test.jsx | Test: badge hidden when count = 0 | T-0165 | 10m | [ ] |
| T-0168 | RED | React | src/components/__tests__/NavBadge.test.jsx | Test: badge has red bg, white text | T-0165 | 10m | [ ] |
| T-0169 | GREEN | React | src/components/Sidebar.jsx | Add badge to "Odpovědi" nav item | T-0168 | 15m | [ ] |
| T-0170 | GREEN | React | src/components/Sidebar.jsx | Source from replyStats.unhandled in store | T-0169 | 10m | [ ] |
| T-0171 | VERIFY | React | — | Badge visible with correct count. Updates on navigation. | T-0170 | 10m | [ ] |

---

## FÁZE 5: ThreadView přestavba (MVP-17 — MVP-19)

### MVP-17: ThreadView — chronological timeline [L]

| ID | Phase | Layer | File | Description | Depends | Est | Status |
|----|-------|-------|------|-------------|---------|-----|--------|
| T-0172 | RED | React | src/pages/__tests__/ThreadView.timeline.test.jsx | Test: page loads for /replies/:id | T-0164 | 15m | [ ] |
| T-0173 | RED | React | src/pages/__tests__/ThreadView.timeline.test.jsx | Test: header shows contact email, campaign, classification | T-0172 | 15m | [ ] |
| T-0174 | RED | React | src/pages/__tests__/ThreadView.timeline.test.jsx | Test: renders messages chronologically (oldest first) | T-0172 | 15m | [ ] |
| T-0175 | RED | React | src/pages/__tests__/ThreadView.timeline.test.jsx | Test: auto-sends styled: gray bg, smaller font | T-0172 | 10m | [ ] |
| T-0176 | RED | React | src/pages/__tests__/ThreadView.timeline.test.jsx | Test: incoming replies: white bg, colored left border | T-0172 | 10m | [ ] |
| T-0177 | RED | React | src/pages/__tests__/ThreadView.timeline.test.jsx | Test: manual replies: light indigo bg | T-0172 | 10m | [ ] |
| T-0178 | RED | React | src/pages/__tests__/ThreadView.timeline.test.jsx | Test: each message shows sender, timestamp, body | T-0172 | 10m | [ ] |
| T-0179 | RED | React | src/pages/__tests__/ThreadView.timeline.test.jsx | Test: back button navigates to /replies | T-0172 | 10m | [ ] |
| T-0180 | RED | BFF | test/contract/threads.test.js | Test: GET /api/threads/:id/messages returns combined timeline | T-0014 | 20m | [ ] |
| T-0181 | GREEN | BFF | server.js | GET /api/threads/:id/messages endpoint (combine sends + replies + manual) | T-0180 | 45m | [ ] |
| T-0182 | GREEN | React | src/components/AutoSendBubble.jsx | Auto-send message bubble component | T-0179 | 20m | [ ] |
| T-0183 | GREEN | React | src/components/IncomingBubble.jsx | Incoming reply bubble with classification border | T-0179 | 20m | [ ] |
| T-0184 | GREEN | React | src/components/OutgoingBubble.jsx | Manual reply bubble (indigo bg) | T-0179 | 15m | [ ] |
| T-0185 | GREEN | React | src/pages/ThreadDetail.jsx | Refactor to full timeline layout with message components | T-0184 | 45m | [ ] |
| T-0186 | REFACTOR | React | src/pages/ThreadDetail.jsx | Extract MessageList component | T-0185 | 20m | [ ] |
| T-0187 | VERIFY | React | — | ThreadView shows full conversation. Visual distinction works. | T-0186 | 10m | [ ] |

### MVP-18: ThreadView — incoming attachments [M]

| ID | Phase | Layer | File | Description | Depends | Est | Status |
|----|-------|-------|------|-------------|---------|-----|--------|
| T-0188 | RED | Go | modules/outreach/internal/thread/mime_test.go | Test: MIME parser extracts text/plain body | T-0187 | 15m | [ ] |
| T-0189 | RED | Go | modules/outreach/internal/thread/mime_test.go | Test: extracts attachments (filename, content_type, size) | T-0188 | 15m | [ ] |
| T-0190 | RED | Go | modules/outreach/internal/thread/mime_test.go | Test: handles multipart/mixed | T-0188 | 15m | [ ] |
| T-0191 | RED | Go | modules/outreach/internal/thread/mime_test.go | Test: handles multipart/alternative | T-0188 | 15m | [ ] |
| T-0192 | RED | Go | modules/outreach/internal/thread/mime_test.go | Test: rejects files > 10 MB | T-0188 | 10m | [ ] |
| T-0193 | RED | React | src/pages/__tests__/ThreadView.attachments.test.jsx | Test: incoming reply shows attachment list | T-0187 | 15m | [ ] |
| T-0194 | RED | React | src/pages/__tests__/ThreadView.attachments.test.jsx | Test: each attachment shows filename, size, MIME icon | T-0193 | 10m | [ ] |
| T-0195 | RED | React | src/pages/__tests__/ThreadView.attachments.test.jsx | Test: "Stáhnout" triggers download | T-0193 | 10m | [ ] |
| T-0196 | RED | React | src/pages/__tests__/ThreadView.attachments.test.jsx | Test: inline images preview (max-width 300px) | T-0193 | 10m | [ ] |
| T-0197 | GREEN | Go | modules/outreach/internal/thread/mime.go | MIME parser implementation | T-0192 | 45m | [ ] |
| T-0198 | GREEN | DB | modules/outreach/internal/db/migration_046.go | Migration 046: attachments table | T-0197 | 20m | [ ] |
| T-0199 | GREEN | Go | modules/outreach/internal/web/attachment_handler.go | GET /api/attachments/:id/download endpoint | T-0198 | 20m | [ ] |
| T-0200 | GREEN | BFF | server.js | BFF proxy for attachment download | T-0199 | 10m | [ ] |
| T-0201 | GREEN | React | src/components/AttachmentRow.jsx | Attachment display component (icon + name + size + download) | T-0196 | 20m | [ ] |
| T-0202 | GREEN | React | src/components/IncomingBubble.jsx | Integrate AttachmentRow into incoming bubble | T-0201 | 15m | [ ] |
| T-0203 | VERIFY | — | — | Attachments visible. Download works. Images preview inline. | T-0202 | 10m | [ ] |

### MVP-19: ThreadView — contact context sidebar [M]

| ID | Phase | Layer | File | Description | Depends | Est | Status |
|----|-------|-------|------|-------------|---------|-----|--------|
| T-0204 | RED | React | src/pages/__tests__/ThreadView.context.test.jsx | Test: right sidebar (30% width) shows contact info | T-0187 | 15m | [ ] |
| T-0205 | RED | React | src/pages/__tests__/ThreadView.context.test.jsx | Test: shows firma (name, IČO, sector, region) | T-0204 | 10m | [ ] |
| T-0206 | RED | React | src/pages/__tests__/ThreadView.context.test.jsx | Test: shows kampaň (name, status, sent, replied) | T-0204 | 10m | [ ] |
| T-0207 | RED | React | src/pages/__tests__/ThreadView.context.test.jsx | Test: shows classification badge | T-0204 | 10m | [ ] |
| T-0208 | RED | React | src/pages/__tests__/ThreadView.context.test.jsx | Test: shows contact count (steps + replies) | T-0204 | 10m | [ ] |
| T-0209 | RED | React | src/pages/__tests__/ThreadView.context.test.jsx | Test: "Handled" toggle button | T-0204 | 10m | [ ] |
| T-0210 | GREEN | React | src/components/ThreadContextSidebar.jsx | Context sidebar component shell | T-0209 | 20m | [ ] |
| T-0211 | GREEN | React | src/components/ThreadContextSidebar.jsx | Fetch company data by ICO | T-0210 | 15m | [ ] |
| T-0212 | GREEN | React | src/components/ThreadContextSidebar.jsx | Campaign stats display | T-0210 | 15m | [ ] |
| T-0213 | GREEN | React | src/pages/ThreadDetail.jsx | Integrate sidebar, 70/30 split layout | T-0212 | 20m | [ ] |
| T-0214 | VERIFY | React | — | Context sidebar with correct data. 70/30 layout. | T-0213 | 10m | [ ] |

---

## FÁZE 6: Manual reply (MVP-20 — MVP-23)

### MVP-20: Reply compose textarea [M]

| ID | Phase | Layer | File | Description | Depends | Est | Status |
|----|-------|-------|------|-------------|---------|-----|--------|
| T-0215 | RED | React | src/pages/__tests__/ThreadView.compose.test.jsx | Test: compose area at bottom of conversation | T-0187 | 15m | [ ] |
| T-0216 | RED | React | src/pages/__tests__/ThreadView.compose.test.jsx | Test: textarea with placeholder "Napište odpověď..." | T-0215 | 10m | [ ] |
| T-0217 | RED | React | src/pages/__tests__/ThreadView.compose.test.jsx | Test: "Odeslat" button present | T-0215 | 10m | [ ] |
| T-0218 | RED | React | src/pages/__tests__/ThreadView.compose.test.jsx | Test: button disabled when textarea empty | T-0215 | 10m | [ ] |
| T-0219 | RED | React | src/pages/__tests__/ThreadView.compose.test.jsx | Test: sending state shows spinner, textarea disabled | T-0215 | 15m | [ ] |
| T-0220 | GREEN | React | src/components/ReplyCompose.jsx | Compose component: textarea + send button | T-0219 | 20m | [ ] |
| T-0221 | GREEN | React | src/components/ReplyCompose.jsx | Local state: body, sending, sent | T-0220 | 15m | [ ] |
| T-0222 | GREEN | React | src/pages/ThreadDetail.jsx | Integrate ReplyCompose at bottom | T-0221 | 15m | [ ] |
| T-0223 | VERIFY | React | — | Compose area renders. Button states correct. | T-0222 | 10m | [ ] |

### MVP-21: Go reply endpoint [L]

| ID | Phase | Layer | File | Description | Depends | Est | Status |
|----|-------|-------|------|-------------|---------|-----|--------|
| T-0224 | RED | Go | modules/outreach/internal/thread/reply_test.go | Test: POST /api/threads/:id/reply accepts {body} | T-0223 | 15m | [ ] |
| T-0225 | RED | Go | modules/outreach/internal/thread/reply_test.go | Test: loads thread, finds original reply | T-0224 | 15m | [ ] |
| T-0226 | RED | Go | modules/outreach/internal/thread/reply_test.go | Test: selects mailbox (same as last campaign send) | T-0224 | 15m | [ ] |
| T-0227 | RED | Go | modules/outreach/internal/thread/reply_test.go | Test: builds MIME with In-Reply-To header | T-0224 | 15m | [ ] |
| T-0228 | RED | Go | modules/outreach/internal/thread/reply_test.go | Test: builds References header chain | T-0224 | 15m | [ ] |
| T-0229 | RED | Go | modules/outreach/internal/thread/reply_test.go | Test: Message-ID = random@sending-domain | T-0224 | 10m | [ ] |
| T-0230 | RED | Go | modules/outreach/internal/thread/reply_test.go | Test: sends via SMTP | T-0224 | 15m | [ ] |
| T-0231 | RED | Go | modules/outreach/internal/thread/reply_test.go | Test: creates send_event with message_type=manual_reply | T-0224 | 10m | [ ] |
| T-0232 | RED | Go | modules/outreach/internal/thread/reply_test.go | Test: creates outreach_message direction=outbound | T-0224 | 10m | [ ] |
| T-0233 | RED | Go | modules/outreach/internal/thread/reply_test.go | Test: auto-marks thread as handled | T-0224 | 10m | [ ] |
| T-0234 | RED | Go | modules/outreach/internal/thread/reply_test.go | Test: skips warmup/rate-limit/delay | T-0224 | 10m | [ ] |
| T-0235 | RED | Go | modules/outreach/internal/thread/reply_test.go | Test: applies anti-trace header sanitization | T-0224 | 10m | [ ] |
| T-0236 | RED | BFF | test/contract/replies.test.js | BFF contract: POST /api/threads/:id/reply proxies to Go | T-0014 | 15m | [ ] |
| T-0237 | GREEN | Go | modules/outreach/internal/thread/reply.go | Reply handler: load thread + build MIME + send SMTP | T-0235 | 1h | [ ] |
| T-0238 | GREEN | DB | modules/outreach/internal/db/migration_047.go | Migration 047: send_events.message_type column | T-0237 | 15m | [ ] |
| T-0239 | GREEN | Go | modules/outreach/internal/web/thread_handler.go | Wire POST /api/threads/:id/reply route | T-0237 | 15m | [ ] |
| T-0240 | GREEN | BFF | server.js | BFF proxy route for POST /api/threads/:id/reply | T-0239 | 10m | [ ] |
| T-0241 | GREEN | React | src/components/ReplyCompose.jsx | Wire send button to POST /api/threads/:id/reply | T-0240 | 20m | [ ] |
| T-0242 | REFACTOR | Go | modules/outreach/internal/thread/reply.go | Share SMTP connection logic with sender package | T-0241 | 30m | [ ] |
| T-0243 | VERIFY | — | — | Manual reply sends email. Appears in thread. Threading correct. | T-0242 | 15m | [ ] |

### MVP-22: Reply threading headers [M]

| ID | Phase | Layer | File | Description | Depends | Est | Status |
|----|-------|-------|------|-------------|---------|-----|--------|
| T-0244 | RED | Go | modules/outreach/internal/thread/headers_test.go | Test: In-Reply-To set to last inbound Message-ID | T-0243 | 15m | [ ] |
| T-0245 | RED | Go | modules/outreach/internal/thread/headers_test.go | Test: References contains full chain | T-0244 | 15m | [ ] |
| T-0246 | RED | Go | modules/outreach/internal/thread/headers_test.go | Test: threads correctly in Gmail (In-Reply-To matches) | T-0244 | 15m | [ ] |
| T-0247 | RED | Go | modules/outreach/internal/thread/headers_test.go | Test: threads correctly in Outlook (References chain) | T-0244 | 15m | [ ] |
| T-0248 | RED | Go | modules/outreach/internal/thread/headers_test.go | Test: subject prefixed with "Re: " if not already | T-0244 | 10m | [ ] |
| T-0249 | RED | Go | modules/outreach/internal/thread/headers_test.go | Test: no platform identifiers in headers (anti-trace) | T-0244 | 10m | [ ] |
| T-0250 | GREEN | Go | modules/outreach/internal/thread/headers.go | Header builder function (In-Reply-To, References, Subject) | T-0249 | 30m | [ ] |
| T-0251 | GREEN | Go | modules/outreach/internal/thread/headers.go | Anti-trace sanitization for reply headers | T-0250 | 20m | [ ] |
| T-0252 | VERIFY | Go | — | Email clients show reply in same thread. | T-0251 | 15m | [ ] |

### MVP-23: Reply attachments [L]

| ID | Phase | Layer | File | Description | Depends | Est | Status |
|----|-------|-------|------|-------------|---------|-----|--------|
| T-0253 | RED | React | src/pages/__tests__/ThreadView.upload.test.jsx | Test: file dropzone below textarea | T-0243 | 15m | [ ] |
| T-0254 | RED | React | src/pages/__tests__/ThreadView.upload.test.jsx | Test: max 3 files indicator | T-0253 | 10m | [ ] |
| T-0255 | RED | React | src/pages/__tests__/ThreadView.upload.test.jsx | Test: max 10 MB per file indicator | T-0253 | 10m | [ ] |
| T-0256 | RED | React | src/pages/__tests__/ThreadView.upload.test.jsx | Test: shows attached files (name + size + remove) | T-0253 | 15m | [ ] |
| T-0257 | RED | React | src/pages/__tests__/ThreadView.upload.test.jsx | Test: rejects files > 10 MB (error toast) | T-0253 | 10m | [ ] |
| T-0258 | RED | React | src/pages/__tests__/ThreadView.upload.test.jsx | Test: rejects when > 3 files attached | T-0253 | 10m | [ ] |
| T-0259 | RED | React | src/pages/__tests__/ThreadView.upload.test.jsx | Test: "Odeslat" includes files | T-0253 | 10m | [ ] |
| T-0260 | RED | Go | modules/outreach/internal/thread/reply_attachment_test.go | Test: POST accepts multipart/form-data | T-0243 | 15m | [ ] |
| T-0261 | RED | Go | modules/outreach/internal/thread/reply_attachment_test.go | Test: body + up to 3 files parsed | T-0260 | 15m | [ ] |
| T-0262 | RED | Go | modules/outreach/internal/thread/reply_attachment_test.go | Test: files stored in attachments table | T-0260 | 10m | [ ] |
| T-0263 | RED | Go | modules/outreach/internal/thread/reply_attachment_test.go | Test: MIME built with multipart/mixed | T-0260 | 15m | [ ] |
| T-0264 | RED | Go | modules/outreach/internal/thread/reply_attachment_test.go | Test: file size validated server-side | T-0260 | 10m | [ ] |
| T-0265 | GREEN | React | src/components/FileDropzone.jsx | File dropzone component (drag/drop + file input) | T-0259 | 30m | [ ] |
| T-0266 | GREEN | React | src/components/ReplyCompose.jsx | Integrate FileDropzone, multipart upload | T-0265 | 20m | [ ] |
| T-0267 | GREEN | Go | modules/outreach/internal/thread/reply.go | Extend reply handler for multipart/form-data | T-0264 | 30m | [ ] |
| T-0268 | GREEN | Go | modules/outreach/internal/thread/reply.go | MIME builder with attachment parts | T-0267 | 30m | [ ] |
| T-0269 | GREEN | Go | modules/outreach/internal/thread/reply.go | Store attachments in DB | T-0268 | 15m | [ ] |
| T-0270 | VERIFY | — | — | Attach files to reply. Files visible in thread after send. | T-0269 | 15m | [ ] |

---

## FÁZE 7: Lead management (MVP-24 — MVP-25)

### MVP-24: Lead auto-marking [M]

| ID | Phase | Layer | File | Description | Depends | Est | Status |
|----|-------|-------|------|-------------|---------|-----|--------|
| T-0271 | RED | Go | modules/outreach/internal/lead/store_test.go | Test: Create() inserts lead row | T-0187 | 15m | [ ] |
| T-0272 | RED | Go | modules/outreach/internal/lead/store_test.go | Test: lead has contact_id, campaign_id, status=new, source=reply_classification | T-0271 | 10m | [ ] |
| T-0273 | RED | Go | modules/outreach/internal/lead/store_test.go | Test: idempotent — same (contact_id, campaign_id) = no duplicate | T-0271 | 15m | [ ] |
| T-0274 | RED | Go | modules/outreach/internal/lead/store_test.go | Test: notes auto-filled from reply subject | T-0271 | 10m | [ ] |
| T-0275 | RED | Go | modules/outreach/internal/lead/store_test.go | Test: List() returns all leads | T-0271 | 10m | [ ] |
| T-0276 | RED | Go | modules/outreach/internal/lead/store_test.go | Test: Update() changes status | T-0271 | 10m | [ ] |
| T-0277 | RED | Go | modules/outreach/internal/thread/inbound_test.go | Test: positive classification → auto-creates lead | T-0271 | 15m | [ ] |
| T-0278 | RED | Go | modules/outreach/internal/thread/inbound_test.go | Test: meeting classification → auto-creates lead | T-0277 | 10m | [ ] |
| T-0279 | RED | Go | modules/outreach/internal/thread/inbound_test.go | Test: negative classification → no lead | T-0277 | 10m | [ ] |
| T-0280 | GREEN | Go | modules/outreach/internal/lead/store.go | Implement Create(), List(), Update() | T-0279 | 30m | [ ] |
| T-0281 | GREEN | DB | modules/outreach/internal/db/migration_044.go | Migration 044: leads table (if not exists) | T-0280 | 15m | [ ] |
| T-0282 | GREEN | Go | modules/outreach/internal/thread/inbound.go | Wire lead.Create() into reply classification pipeline | T-0281 | 20m | [ ] |
| T-0283 | VERIFY | Go | — | Positive replies auto-create leads. No duplicates. | T-0282 | 10m | [ ] |

### MVP-25: Lead list UI [M]

| ID | Phase | Layer | File | Description | Depends | Est | Status |
|----|-------|-------|------|-------------|---------|-----|--------|
| T-0284 | RED | React | src/pages/__tests__/Leads.test.jsx | Test: page renders at /leads route | T-0283 | 15m | [ ] |
| T-0285 | RED | React | src/pages/__tests__/Leads.test.jsx | Test: shows lead list (contact, campaign, status, source, created_at) | T-0284 | 15m | [ ] |
| T-0286 | RED | React | src/pages/__tests__/Leads.test.jsx | Test: status dropdown (new/contacted/qualified/won/lost) | T-0284 | 15m | [ ] |
| T-0287 | RED | React | src/pages/__tests__/Leads.test.jsx | Test: can change status via dropdown | T-0284 | 15m | [ ] |
| T-0288 | RED | React | src/pages/__tests__/Leads.test.jsx | Test: filter by status | T-0284 | 15m | [ ] |
| T-0289 | RED | React | src/pages/__tests__/Leads.test.jsx | Test: nav badge for "new" leads count | T-0284 | 10m | [ ] |
| T-0290 | RED | BFF | test/contract/leads.test.js | Test: GET /api/leads returns list | T-0283 | 15m | [ ] |
| T-0291 | RED | BFF | test/contract/leads.test.js | Test: PATCH /api/leads/:id updates status | T-0290 | 15m | [ ] |
| T-0292 | GREEN | Go | modules/outreach/internal/web/lead_handler.go | GET /api/leads, PATCH /api/leads/:id endpoints | T-0291 | 30m | [ ] |
| T-0293 | GREEN | BFF | server.js | BFF proxy routes for /api/leads | T-0292 | 15m | [ ] |
| T-0294 | GREEN | React | src/pages/Leads.jsx | Lead list page component | T-0289 | 30m | [ ] |
| T-0295 | GREEN | React | src/App.jsx | Add /leads route + sidebar nav item | T-0294 | 15m | [ ] |
| T-0296 | GREEN | React | src/components/Sidebar.jsx | Add nav badge for new leads count | T-0295 | 10m | [ ] |
| T-0297 | VERIFY | React | — | Lead list works. Status changes persist. Badge shows count. | T-0296 | 10m | [ ] |

---

## FÁZE 8: Analytics enhancement (MVP-26 — MVP-27)

### MVP-26: Analytics date ranges + export [M]

| ID | Phase | Layer | File | Description | Depends | Est | Status |
|----|-------|-------|------|-------------|---------|-----|--------|
| T-0298 | RED | React | src/pages/__tests__/Analytics.daterange.test.jsx | Test: date range buttons 7d, 14d, 30d, 90d | T-0014 | 15m | [ ] |
| T-0299 | RED | React | src/pages/__tests__/Analytics.daterange.test.jsx | Test: custom date picker (from/to) | T-0298 | 15m | [ ] |
| T-0300 | RED | React | src/pages/__tests__/Analytics.daterange.test.jsx | Test: export button downloads CSV | T-0298 | 15m | [ ] |
| T-0301 | RED | React | src/pages/__tests__/Analytics.daterange.test.jsx | Test: chart updates when range changes | T-0298 | 15m | [ ] |
| T-0302 | RED | React | src/pages/__tests__/Analytics.daterange.test.jsx | Test: KPIs update for selected range | T-0298 | 10m | [ ] |
| T-0303 | GREEN | React | src/pages/Analytics.jsx | Add 90d button + custom date picker component | T-0302 | 30m | [ ] |
| T-0304 | GREEN | React | src/pages/Analytics.jsx | Update API calls with from/to date params | T-0303 | 20m | [ ] |
| T-0305 | GREEN | React | src/pages/Analytics.jsx | Export: generate CSV from timeline data (client-side) | T-0303 | 20m | [ ] |
| T-0306 | VERIFY | React | — | Custom date ranges work. CSV export downloads. | T-0305 | 10m | [ ] |

### MVP-27: Campaign comparison [M]

| ID | Phase | Layer | File | Description | Depends | Est | Status |
|----|-------|-------|------|-------------|---------|-----|--------|
| T-0307 | RED | React | src/pages/__tests__/Analytics.comparison.test.jsx | Test: campaign table sortable by sent/replied/opened/bounced | T-0306 | 15m | [ ] |
| T-0308 | RED | React | src/pages/__tests__/Analytics.comparison.test.jsx | Test: click campaign → navigate to /campaigns/:id | T-0307 | 10m | [ ] |
| T-0309 | RED | React | src/pages/__tests__/Analytics.comparison.test.jsx | Test: reply rate color coding (green >5%, yellow 2-5%, red <2%) | T-0307 | 15m | [ ] |
| T-0310 | RED | React | src/pages/__tests__/Analytics.comparison.test.jsx | Test: "Best performing" highlight on top campaign | T-0307 | 10m | [ ] |
| T-0311 | GREEN | React | src/pages/Analytics.jsx | Sortable campaign table (click header to sort) | T-0310 | 20m | [ ] |
| T-0312 | GREEN | React | src/pages/Analytics.jsx | Color-coded rate columns | T-0311 | 15m | [ ] |
| T-0313 | GREEN | React | src/pages/Analytics.jsx | Click row → navigate to /campaigns/:id | T-0311 | 10m | [ ] |
| T-0314 | VERIFY | React | — | Campaign table sortable. Visual hierarchy clear. | T-0313 | 10m | [ ] |

---

## FÁZE 9: Intelligence (MVP-28 — MVP-30)

### MVP-28: Best time to send [L]

| ID | Phase | Layer | File | Description | Depends | Est | Status |
|----|-------|-------|------|-------------|---------|-----|--------|
| T-0315 | RED | Go | modules/outreach/internal/intelligence/timing_test.go | Test: analyzes tracking_events by hour×day_of_week | T-0108 | 15m | [ ] |
| T-0316 | RED | Go | modules/outreach/internal/intelligence/timing_test.go | Test: aggregates per recipient domain | T-0315 | 15m | [ ] |
| T-0317 | RED | Go | modules/outreach/internal/intelligence/timing_test.go | Test: returns recommended window | T-0315 | 10m | [ ] |
| T-0318 | RED | Go | modules/outreach/internal/intelligence/timing_test.go | Test: fallback 9-14 business hours if insufficient data | T-0315 | 10m | [ ] |
| T-0319 | RED | React | src/pages/__tests__/CampaignDetail.timing.test.jsx | Test: shows "Doporučený čas" section | T-0108 | 15m | [ ] |
| T-0320 | RED | React | src/pages/__tests__/CampaignDetail.timing.test.jsx | Test: heatmap renders (hours × days, color intensity) | T-0319 | 15m | [ ] |
| T-0321 | GREEN | Go | modules/outreach/internal/intelligence/timing.go | Timing analysis implementation | T-0318 | 45m | [ ] |
| T-0322 | GREEN | Go | modules/outreach/internal/web/intelligence_handler.go | GET /api/campaigns/:id/best-time endpoint | T-0321 | 20m | [ ] |
| T-0323 | GREEN | BFF | server.js | BFF proxy for /api/campaigns/:id/best-time | T-0322 | 10m | [ ] |
| T-0324 | GREEN | React | src/components/TimingHeatmap.jsx | Heatmap component (7×24 grid, color scale) | T-0320 | 30m | [ ] |
| T-0325 | GREEN | React | src/pages/CampaignDetail.jsx | Integrate TimingHeatmap | T-0324 | 15m | [ ] |
| T-0326 | VERIFY | — | — | Heatmap renders. Recommendation influences send window. | T-0325 | 10m | [ ] |

### MVP-29: Template ranking [M]

| ID | Phase | Layer | File | Description | Depends | Est | Status |
|----|-------|-------|------|-------------|---------|-----|--------|
| T-0327 | RED | Go | modules/outreach/internal/intelligence/ranking_test.go | Test: ranks templates by reply rate | T-0108 | 15m | [ ] |
| T-0328 | RED | Go | modules/outreach/internal/intelligence/ranking_test.go | Test: returns template_id, name, campaigns_used, total_sent, reply_rate, open_rate | T-0327 | 10m | [ ] |
| T-0329 | RED | Go | modules/outreach/internal/intelligence/ranking_test.go | Test: sorted by reply_rate descending | T-0327 | 10m | [ ] |
| T-0330 | RED | React | src/pages/__tests__/Templates.ranking.test.jsx | Test: templates page shows performance column | T-0014 | 15m | [ ] |
| T-0331 | RED | React | src/pages/__tests__/Templates.ranking.test.jsx | Test: rank badge on top 3 | T-0330 | 10m | [ ] |
| T-0332 | GREEN | Go | modules/outreach/internal/intelligence/ranking.go | Ranking implementation | T-0329 | 30m | [ ] |
| T-0333 | GREEN | Go | modules/outreach/internal/web/intelligence_handler.go | GET /api/templates/ranking endpoint | T-0332 | 15m | [ ] |
| T-0334 | GREEN | BFF | server.js | BFF proxy for /api/templates/ranking | T-0333 | 10m | [ ] |
| T-0335 | GREEN | React | src/pages/Templates.jsx | Ranking display: performance column + badges | T-0331 | 20m | [ ] |
| T-0336 | VERIFY | — | — | Template ranking visible from real data. | T-0335 | 10m | [ ] |

### MVP-30: A/B subject testing [L]

| ID | Phase | Layer | File | Description | Depends | Est | Status |
|----|-------|-------|------|-------------|---------|-----|--------|
| T-0337 | RED | Go | modules/outreach/internal/campaign/ab_test.go | Test: campaign can have 2 subject variants per step | T-0336 | 15m | [ ] |
| T-0338 | RED | Go | modules/outreach/internal/campaign/ab_test.go | Test: 50/50 split at send time | T-0337 | 15m | [ ] |
| T-0339 | RED | Go | modules/outreach/internal/campaign/ab_test.go | Test: auto-select winner after N sends (default 50) | T-0337 | 15m | [ ] |
| T-0340 | RED | Go | modules/outreach/internal/campaign/ab_test.go | Test: winner determined by open rate | T-0337 | 10m | [ ] |
| T-0341 | RED | React | src/pages/__tests__/CampaignNew.ab.test.jsx | Test: step 2 shows "A/B test" toggle | T-0073 | 15m | [ ] |
| T-0342 | RED | React | src/pages/__tests__/CampaignNew.ab.test.jsx | Test: toggle enabled → second subject input | T-0341 | 10m | [ ] |
| T-0343 | RED | React | src/pages/__tests__/CampaignNew.ab.test.jsx | Test: preview shows both variants | T-0341 | 10m | [ ] |
| T-0344 | GREEN | Go | modules/outreach/internal/campaign/ab.go | A/B split logic in sender | T-0340 | 45m | [ ] |
| T-0345 | GREEN | Go | modules/outreach/internal/campaign/ab.go | Auto-winner selection after threshold | T-0344 | 30m | [ ] |
| T-0346 | GREEN | React | src/pages/CampaignNew.jsx | A/B toggle + second subject input in step 2 | T-0343 | 20m | [ ] |
| T-0347 | GREEN | React | src/pages/CampaignDetail.jsx | A/B results display (variant A vs B stats) | T-0345 | 20m | [ ] |
| T-0348 | VERIFY | — | — | A/B test runs. Winner auto-selected. Results visible. | T-0347 | 15m | [ ] |

---

## FÁZE 10: Hardening (MVP-31 — MVP-35)

### MVP-31: BFF authentication [M]

| ID | Phase | Layer | File | Description | Depends | Est | Status |
|----|-------|-------|------|-------------|---------|-----|--------|
| T-0349 | RED | BFF | test/contract/auth.test.js | Test: request without API key → 401 | T-0029 | 15m | [ ] |
| T-0350 | RED | BFF | test/contract/auth.test.js | Test: request with valid key → 200 | T-0349 | 10m | [ ] |
| T-0351 | RED | BFF | test/contract/auth.test.js | Test: key from OUTREACH_API_KEY env | T-0349 | 10m | [ ] |
| T-0352 | RED | BFF | test/contract/auth.test.js | Test: health endpoints exempt from auth | T-0349 | 10m | [ ] |
| T-0353 | GREEN | BFF | server.js | Auth middleware: validate X-API-Key on /api/* | T-0352 | 30m | [ ] |
| T-0354 | GREEN | BFF | server.js | Exempt health endpoints from auth | T-0353 | 10m | [ ] |
| T-0355 | GREEN | React | src/lib/api.js | Include API key in all requests (or cookie-based session) | T-0353 | 20m | [ ] |
| T-0356 | VERIFY | BFF | — | Endpoints protected. Unauthorized rejected. | T-0355 | 10m | [ ] |

### MVP-32: Error handling standardization [M]

| ID | Phase | Layer | File | Description | Depends | Est | Status |
|----|-------|-------|------|-------------|---------|-----|--------|
| T-0357 | RED | BFF | test/contract/errors.test.js | Test: 400 for invalid input (missing required) | T-0356 | 15m | [ ] |
| T-0358 | RED | BFF | test/contract/errors.test.js | Test: 404 for non-existent resources | T-0357 | 10m | [ ] |
| T-0359 | RED | BFF | test/contract/errors.test.js | Test: 409 for conflicts (duplicate) | T-0357 | 10m | [ ] |
| T-0360 | RED | BFF | test/contract/errors.test.js | Test: 500 with generic message (no stack trace) | T-0357 | 10m | [ ] |
| T-0361 | RED | BFF | test/contract/errors.test.js | Test: all errors return { error, code } format | T-0357 | 10m | [ ] |
| T-0362 | GREEN | BFF | server.js | Error middleware: catch-all with standardized format | T-0361 | 30m | [ ] |
| T-0363 | GREEN | BFF | server.js | HTTP status code differentiation per error type | T-0362 | 20m | [ ] |
| T-0364 | VERIFY | BFF | — | Consistent error responses across all endpoints. | T-0363 | 10m | [ ] |

### MVP-33: Performance optimization [L]

| ID | Phase | Layer | File | Description | Depends | Est | Status |
|----|-------|-------|------|-------------|---------|-----|--------|
| T-0365 | RED | React | test/performance/bundle.test.js | Test: JS bundle < 300kb gzipped | T-0021 | 15m | [ ] |
| T-0366 | RED | React | test/performance/bundle.test.js | Test: CSS < 50kb | T-0365 | 10m | [ ] |
| T-0367 | RED | React | test/performance/bundle.test.js | Test: initial load < 2s (Lighthouse) | T-0365 | 15m | [ ] |
| T-0368 | RED | Go | modules/outreach/internal/db/query_test.go | Test: critical queries have EXPLAIN plans | T-0021 | 20m | [ ] |
| T-0369 | RED | Go | modules/outreach/internal/db/query_test.go | Test: no N+1 patterns in hot paths | T-0368 | 15m | [ ] |
| T-0370 | GREEN | React | vite.config.js | Code splitting for heavy pages (lazy imports) | T-0367 | 30m | [ ] |
| T-0371 | GREEN | Go | modules/outreach/internal/db/ | Index optimization for hot queries | T-0369 | 30m | [ ] |
| T-0372 | GREEN | Go | modules/outreach/internal/db/ | Connection pool tuning | T-0371 | 20m | [ ] |
| T-0373 | VERIFY | — | — | Bundle within budget. Queries optimized. No N+1. | T-0372 | 15m | [ ] |

### MVP-34: Security audit [L]

| ID | Phase | Layer | File | Description | Depends | Est | Status |
|----|-------|-------|------|-------------|---------|-----|--------|
| T-0374 | RED | Config | — | Audit: no hardcoded secrets in code (secrets.scan.test.js) | T-0356 | 15m | [ ] |
| T-0375 | RED | BFF | — | Audit: TLS cert validation enabled (no rejectUnauthorized: false) | T-0374 | 15m | [ ] |
| T-0376 | RED | BFF | — | Audit: CSP headers configured | T-0374 | 15m | [ ] |
| T-0377 | RED | BFF | — | Audit: CSRF protection on state-changing endpoints | T-0374 | 15m | [ ] |
| T-0378 | RED | BFF | — | Audit: rate limiting on public endpoints | T-0374 | 15m | [ ] |
| T-0379 | RED | BFF | — | Audit: input validation on all user inputs | T-0374 | 20m | [ ] |
| T-0380 | RED | Go | — | Audit: SQL injection prevention (parameterized queries) | T-0374 | 15m | [ ] |
| T-0381 | RED | React | — | Audit: XSS prevention (no dangerouslySetInnerHTML) | T-0374 | 10m | [ ] |
| T-0382 | RED | Config | — | Audit: FAULT_INJECT_ALLOWED disabled in production | T-0374 | 10m | [ ] |
| T-0383 | RED | Config | — | Audit: pnpm audit + govulncheck clean | T-0374 | 15m | [ ] |
| T-0384 | GREEN | BFF | server.js | Fix: enable TLS validation | T-0383 | 20m | [ ] |
| T-0385 | GREEN | BFF | server.js | Fix: add CSP headers | T-0384 | 15m | [ ] |
| T-0386 | GREEN | Config | — | Fix: disable fault injection in prod env check | T-0385 | 10m | [ ] |
| T-0387 | GREEN | Config | — | Fix all CRITICAL and HIGH dependency vulns | T-0383 | 30m | [ ] |
| T-0388 | VERIFY | — | — | Security audit passes. No CRITICAL findings. | T-0387 | 15m | [ ] |

### MVP-35: Production readiness [L]

| ID | Phase | Layer | File | Description | Depends | Est | Status |
|----|-------|-------|------|-------------|---------|-----|--------|
| T-0389 | RED | — | — | Check: all tests green (Go + React + E2E) | T-0373 | 15m | [ ] |
| T-0390 | RED | — | — | Check: coverage ≥80% React, ≥85% Go business logic | T-0389 | 15m | [ ] |
| T-0391 | RED | — | — | Check: pnpm build clean | T-0389 | 10m | [ ] |
| T-0392 | RED | — | — | Check: security audit passed (MVP-34) | T-0388 | 10m | [ ] |
| T-0393 | RED | — | — | Check: anti-trace audit (9 checks) | T-0389 | 30m | [ ] |
| T-0394 | RED | — | — | Check: smoke test script works against staging | T-0389 | 15m | [ ] |
| T-0395 | RED | Config | — | Check: env vars documented in superplan | T-0389 | 10m | [ ] |
| T-0396 | RED | Config | — | Check: backup procedure tested | T-0389 | 15m | [ ] |
| T-0397 | GREEN | Config | — | Fix any remaining issues from checks | T-0396 | 1h | [ ] |
| T-0398 | GREEN | Config | — | Deploy to Railway | T-0397 | 30m | [ ] |
| T-0399 | GREEN | — | — | Run smoke tests against production | T-0398 | 15m | [ ] |
| T-0400 | GREEN | — | — | Verify health endpoints respond | T-0399 | 10m | [ ] |
| T-0401 | VERIFY | — | — | Platform live. Operator can create campaign + reply. | T-0400 | 15m | [ ] |

---

## CROSS-CUTTING TASKS

### BFF endpoint coverage (existing endpoints needing tests)

| ID | Phase | Layer | File | Description | Depends | Est | Status |
|----|-------|-------|------|-------------|---------|-----|--------|
| T-0402 | RED | BFF | test/contract/companies.test.js | Test: GET /api/companies returns paginated list | T-0014 | 15m | [ ] |
| T-0403 | RED | BFF | test/contract/companies.test.js | Test: GET /api/companies?query=X filters results | T-0402 | 10m | [ ] |
| T-0404 | RED | BFF | test/contract/companies.test.js | Test: GET /api/companies/:ico returns detail | T-0402 | 10m | [ ] |
| T-0405 | RED | BFF | test/contract/companies.test.js | Test: POST /api/companies/:ico/verify-email triggers verification | T-0402 | 15m | [ ] |
| T-0406 | RED | BFF | test/contract/companies.test.js | Test: POST /api/companies/bulk-verify-email (max 50) | T-0402 | 15m | [ ] |
| T-0407 | RED | BFF | test/contract/companies.test.js | Test: GET /api/companies/facets returns filter counts | T-0402 | 10m | [ ] |
| T-0408 | RED | BFF | test/contract/companies.test.js | Test: GET /api/companies/:ico/verification-history returns audit | T-0402 | 10m | [ ] |
| T-0409 | RED | BFF | test/contract/companies.test.js | Test: GET /api/companies/:ico/readiness returns verification readiness | T-0402 | 10m | [ ] |
| T-0410 | RED | BFF | test/contract/companies.test.js | Test: GET /api/companies/:ico/lookalike returns matches | T-0402 | 10m | [ ] |
| T-0411 | RED | BFF | test/contract/companies.test.js | Test: POST /api/companies/:ico/facts upserts | T-0402 | 10m | [ ] |
| T-0412 | RED | BFF | test/contract/mailboxes.test.js | Test: GET /api/mailboxes returns list | T-0014 | 15m | [ ] |
| T-0413 | RED | BFF | test/contract/mailboxes.test.js | Test: POST /api/mailboxes creates mailbox | T-0412 | 15m | [ ] |
| T-0414 | RED | BFF | test/contract/mailboxes.test.js | Test: PATCH /api/mailboxes/:id updates | T-0412 | 10m | [ ] |
| T-0415 | RED | BFF | test/contract/mailboxes.test.js | Test: GET /api/mailboxes/:id/stats returns performance | T-0412 | 10m | [ ] |
| T-0416 | RED | BFF | test/contract/mailboxes.test.js | Test: GET /api/mailboxes/:id/warmup-status | T-0412 | 10m | [ ] |
| T-0417 | RED | BFF | test/contract/mailboxes.test.js | Test: GET /api/mailboxes/:id/smtp-check probes SMTP | T-0412 | 10m | [ ] |
| T-0418 | RED | BFF | test/contract/mailboxes.test.js | Test: GET /api/mailboxes/:id/full-check comprehensive | T-0412 | 10m | [ ] |
| T-0419 | RED | BFF | test/contract/mailboxes.test.js | Test: GET /api/mailboxes/health-summary aggregate | T-0412 | 10m | [ ] |
| T-0420 | RED | BFF | test/contract/mailboxes.test.js | Test: GET /api/mailboxes/send-trends 24h | T-0412 | 10m | [ ] |
| T-0421 | RED | BFF | test/contract/scoring.test.js | Test: GET /api/scoring/config returns weights | T-0014 | 10m | [ ] |
| T-0422 | RED | BFF | test/contract/scoring.test.js | Test: PUT /api/scoring/config updates weights | T-0421 | 10m | [ ] |
| T-0423 | RED | BFF | test/contract/scoring.test.js | Test: POST /api/scoring/preview on sample | T-0421 | 10m | [ ] |
| T-0424 | RED | BFF | test/contract/scoring.test.js | Test: POST /api/scoring/recompute-all triggers batch | T-0421 | 10m | [ ] |
| T-0425 | RED | BFF | test/contract/segments.test.js | Test: GET /api/segments returns list | T-0014 | 10m | [ ] |
| T-0426 | RED | BFF | test/contract/segments.test.js | Test: POST /api/segments creates | T-0425 | 10m | [ ] |
| T-0427 | RED | BFF | test/contract/segments.test.js | Test: POST /api/segments/preview returns count | T-0425 | 10m | [ ] |
| T-0428 | RED | BFF | test/contract/segments.test.js | Test: POST /api/segments/:id/rebuild triggers refresh | T-0425 | 10m | [ ] |
| T-0429 | RED | BFF | test/contract/templates.test.js | Test: GET /api/templates returns list | T-0014 | 10m | [ ] |
| T-0430 | RED | BFF | test/contract/templates.test.js | Test: POST /api/templates creates | T-0429 | 10m | [ ] |
| T-0431 | RED | BFF | test/contract/templates.test.js | Test: PUT /api/templates/:id updates | T-0429 | 10m | [ ] |
| T-0432 | RED | BFF | test/contract/templates.test.js | Test: DELETE /api/templates/:id deletes | T-0429 | 10m | [ ] |
| T-0433 | RED | BFF | test/contract/contacts.test.js | Test: GET /api/contacts paginated list | T-0014 | 10m | [ ] |
| T-0434 | RED | BFF | test/contract/contacts.test.js | Test: PATCH /api/contacts/:id updates | T-0433 | 10m | [ ] |
| T-0435 | RED | BFF | test/contract/contacts.test.js | Test: POST /api/contacts/:id/verify-email | T-0433 | 10m | [ ] |
| T-0436 | RED | BFF | test/contract/health.test.js | Test: GET /api/version returns sha | T-0014 | 10m | [ ] |
| T-0437 | RED | BFF | test/contract/health.test.js | Test: GET /api/health/system returns db status | T-0436 | 10m | [ ] |
| T-0438 | RED | BFF | test/contract/health.test.js | Test: GET /api/health/guards returns stale-guard | T-0436 | 10m | [ ] |
| T-0439 | RED | BFF | test/contract/health.test.js | Test: GET /api/health/drift returns config drift | T-0436 | 10m | [ ] |
| T-0440 | RED | BFF | test/contract/protections.test.js | Test: GET /api/protections/matrix | T-0014 | 10m | [ ] |
| T-0441 | RED | BFF | test/contract/protections.test.js | Test: GET /api/protections/trace/:messageId | T-0440 | 10m | [ ] |
| T-0442 | RED | BFF | test/contract/protections.test.js | Test: GET /api/protections/alerts | T-0440 | 10m | [ ] |
| T-0443 | RED | BFF | test/contract/categories.test.js | Test: GET /api/meta/categories returns list | T-0014 | 10m | [ ] |
| T-0444 | RED | BFF | test/contract/categories.test.js | Test: GET /api/meta/categories/tree returns hierarchy | T-0443 | 10m | [ ] |

### Go business logic coverage

| ID | Phase | Layer | File | Description | Depends | Est | Status |
|----|-------|-------|------|-------------|---------|-----|--------|
| T-0445 | RED | Go | modules/outreach/internal/sender/ratelimit_test.go | Test: per-domain rate limit (max 5/hour) | T-0014 | 15m | [ ] |
| T-0446 | RED | Go | modules/outreach/internal/sender/ratelimit_test.go | Test: Gaussian delay (mean 90s, stddev 45s) | T-0445 | 10m | [ ] |
| T-0447 | RED | Go | modules/outreach/internal/sender/ratelimit_test.go | Test: daily variation ±15% | T-0445 | 10m | [ ] |
| T-0448 | RED | Go | modules/outreach/internal/sender/ratelimit_test.go | Test: business hours only (08-17 CET) | T-0445 | 10m | [ ] |
| T-0449 | RED | Go | modules/outreach/internal/sender/ratelimit_test.go | Test: holding cluster (max 1 per parent_ico per tick) | T-0445 | 15m | [ ] |
| T-0450 | RED | Go | modules/outreach/internal/sender/warmup_test.go | Test: warmup day 1-3: 5/day | T-0014 | 10m | [ ] |
| T-0451 | RED | Go | modules/outreach/internal/sender/warmup_test.go | Test: warmup day 22+: 100/day | T-0450 | 10m | [ ] |
| T-0452 | RED | Go | modules/outreach/internal/sender/warmup_test.go | Test: sent_today counter resets at midnight | T-0450 | 10m | [ ] |
| T-0453 | RED | Go | modules/outreach/internal/watchdog/bounce_test.go | Test: hard bounce → blacklist + suppress + close thread | T-0014 | 15m | [ ] |
| T-0454 | RED | Go | modules/outreach/internal/watchdog/bounce_test.go | Test: 2 soft bounces → pause thread 7 days | T-0453 | 10m | [ ] |
| T-0455 | RED | Go | modules/outreach/internal/watchdog/bounce_test.go | Test: 3 soft bounces → email_status 'risky' | T-0453 | 10m | [ ] |
| T-0456 | RED | Go | modules/outreach/internal/watchdog/bounce_test.go | Test: 5 soft bounces → email_status 'invalid' | T-0453 | 10m | [ ] |
| T-0457 | RED | Go | modules/outreach/internal/watchdog/bounce_test.go | Test: mailbox 3 consecutive → auto-pause (bounce_hold) | T-0453 | 10m | [ ] |
| T-0458 | RED | Go | modules/outreach/internal/watchdog/bounce_test.go | Test: mailbox bounce_rate >5% → circuit breaker OPEN | T-0453 | 10m | [ ] |
| T-0459 | RED | Go | modules/outreach/internal/watchdog/bounce_test.go | Test: global bounce >15% → STOP all sending | T-0453 | 15m | [ ] |
| T-0460 | RED | Go | modules/outreach/internal/classify/reply_test.go | Test: classify positive → flag for follow-up + create lead | T-0014 | 15m | [ ] |
| T-0461 | RED | Go | modules/outreach/internal/classify/reply_test.go | Test: classify meeting → same as positive + manual_follow | T-0460 | 10m | [ ] |
| T-0462 | RED | Go | modules/outreach/internal/classify/reply_test.go | Test: classify negative → close thread + suppress | T-0460 | 10m | [ ] |
| T-0463 | RED | Go | modules/outreach/internal/classify/reply_test.go | Test: classify ooo → pause thread 14 days | T-0460 | 10m | [ ] |
| T-0464 | RED | Go | modules/outreach/internal/classify/reply_test.go | Test: classify later → pause thread 30 days | T-0460 | 10m | [ ] |
| T-0465 | RED | Go | modules/outreach/internal/classify/reply_test.go | Test: classify auto_reply → ignore (no action) | T-0460 | 10m | [ ] |
| T-0466 | RED | Go | modules/outreach/internal/antitrace/sanitize_test.go | Test: strip X-Mailer header | T-0014 | 10m | [ ] |
| T-0467 | RED | Go | modules/outreach/internal/antitrace/sanitize_test.go | Test: strip X-Originating-IP | T-0466 | 10m | [ ] |
| T-0468 | RED | Go | modules/outreach/internal/antitrace/sanitize_test.go | Test: strip X-Priority | T-0466 | 10m | [ ] |
| T-0469 | RED | Go | modules/outreach/internal/antitrace/sanitize_test.go | Test: strip List-Unsubscribe | T-0466 | 10m | [ ] |
| T-0470 | RED | Go | modules/outreach/internal/antitrace/sanitize_test.go | Test: Message-ID = random@domain (no platform tag) | T-0466 | 10m | [ ] |
| T-0471 | RED | Go | modules/outreach/internal/antitrace/sanitize_test.go | Test: header order randomized | T-0466 | 10m | [ ] |
| T-0472 | RED | Go | modules/outreach/internal/antitrace/sanitize_test.go | Test: no consistent pattern across 10 sends | T-0466 | 15m | [ ] |
| T-0473 | RED | Go | modules/outreach/internal/campaign/lifecycle_test.go | Test: draft → running transition (quality gate passes) | T-0014 | 15m | [ ] |
| T-0474 | RED | Go | modules/outreach/internal/campaign/lifecycle_test.go | Test: running → paused (operator) | T-0473 | 10m | [ ] |
| T-0475 | RED | Go | modules/outreach/internal/campaign/lifecycle_test.go | Test: paused → running (resume) | T-0473 | 10m | [ ] |
| T-0476 | RED | Go | modules/outreach/internal/campaign/lifecycle_test.go | Test: running → completed (all contacts done) | T-0473 | 10m | [ ] |
| T-0477 | RED | Go | modules/outreach/internal/campaign/lifecycle_test.go | Test: running → paused (global bounce >15%) | T-0473 | 15m | [ ] |
| T-0478 | RED | Go | modules/outreach/internal/thread/lifecycle_test.go | Test: new → active (first send) | T-0014 | 10m | [ ] |
| T-0479 | RED | Go | modules/outreach/internal/thread/lifecycle_test.go | Test: active → paused (OOO 14d) | T-0478 | 10m | [ ] |
| T-0480 | RED | Go | modules/outreach/internal/thread/lifecycle_test.go | Test: active → completed (negative reply, suppress) | T-0478 | 10m | [ ] |
| T-0481 | RED | Go | modules/outreach/internal/thread/lifecycle_test.go | Test: active → completed (no reply, sequence done) | T-0478 | 10m | [ ] |
| T-0482 | RED | Go | modules/outreach/internal/thread/lifecycle_test.go | Test: paused → active (resume after OOO) | T-0478 | 10m | [ ] |
| T-0483 | RED | Go | modules/outreach/internal/mailbox/lifecycle_test.go | Test: active → bounce_hold (3 consecutive) | T-0014 | 10m | [ ] |
| T-0484 | RED | Go | modules/outreach/internal/mailbox/lifecycle_test.go | Test: active → paused (3 auth fails) | T-0483 | 10m | [ ] |
| T-0485 | RED | Go | modules/outreach/internal/mailbox/lifecycle_test.go | Test: bounce_hold → active (watchdog decay 24h) | T-0483 | 10m | [ ] |
| T-0486 | RED | Go | modules/outreach/internal/mailbox/lifecycle_test.go | Test: active → retired (manual) | T-0483 | 10m | [ ] |
| T-0487 | RED | Go | modules/outreach/internal/dedup/enrollment_test.go | Test: unique constraint (campaign_id, contact_id) | T-0014 | 10m | [ ] |
| T-0488 | RED | Go | modules/outreach/internal/dedup/enrollment_test.go | Test: domain cap per holding cluster | T-0487 | 15m | [ ] |

### React component UI states

| ID | Phase | Layer | File | Description | Depends | Est | Status |
|----|-------|-------|------|-------------|---------|-----|--------|
| T-0489 | RED | React | src/pages/__tests__/Dashboard.states.test.jsx | Test: loading state shows skeletons | T-0014 | 10m | [ ] |
| T-0490 | RED | React | src/pages/__tests__/Dashboard.states.test.jsx | Test: error state shows error banner | T-0489 | 10m | [ ] |
| T-0491 | RED | React | src/pages/__tests__/Dashboard.states.test.jsx | Test: empty state (no campaigns) shows message | T-0489 | 10m | [ ] |
| T-0492 | RED | React | src/pages/__tests__/Campaigns.states.test.jsx | Test: loading state | T-0014 | 10m | [ ] |
| T-0493 | RED | React | src/pages/__tests__/Campaigns.states.test.jsx | Test: empty state (no campaigns) | T-0492 | 10m | [ ] |
| T-0494 | RED | React | src/pages/__tests__/Companies.states.test.jsx | Test: loading state | T-0014 | 10m | [ ] |
| T-0495 | RED | React | src/pages/__tests__/Companies.states.test.jsx | Test: empty search results | T-0494 | 10m | [ ] |
| T-0496 | RED | React | src/pages/__tests__/Templates.states.test.jsx | Test: loading state | T-0014 | 10m | [ ] |
| T-0497 | RED | React | src/pages/__tests__/Templates.states.test.jsx | Test: empty state (no templates) | T-0496 | 10m | [ ] |
| T-0498 | RED | React | src/pages/__tests__/Mailboxes.states.test.jsx | Test: loading state | T-0014 | 10m | [ ] |
| T-0499 | RED | React | src/pages/__tests__/Mailboxes.states.test.jsx | Test: empty state (no mailboxes) → already exists | T-0498 | 10m | [ ] |
| T-0500 | RED | React | src/pages/__tests__/Analytics.states.test.jsx | Test: loading state | T-0014 | 10m | [ ] |
| T-0501 | RED | React | src/pages/__tests__/Analytics.states.test.jsx | Test: no data state | T-0500 | 10m | [ ] |
| T-0502 | RED | React | src/pages/__tests__/Watchdog.states.test.jsx | Test: loading state | T-0014 | 10m | [ ] |
| T-0503 | RED | React | src/pages/__tests__/Watchdog.states.test.jsx | Test: no events = clean state | T-0502 | 10m | [ ] |

### Store / hooks tests

| ID | Phase | Layer | File | Description | Depends | Est | Status |
|----|-------|-------|------|-------------|---------|-----|--------|
| T-0504 | RED | React | src/__tests__/store.test.js | Test: loadAll fetches mailboxes + campaigns + templates + segments | T-0014 | 15m | [ ] |
| T-0505 | RED | React | src/__tests__/store.test.js | Test: addMailbox calls POST /api/mailboxes | T-0504 | 10m | [ ] |
| T-0506 | RED | React | src/__tests__/store.test.js | Test: updateMailbox calls PATCH /api/mailboxes/:id | T-0504 | 10m | [ ] |
| T-0507 | RED | React | src/__tests__/store.test.js | Test: deleteMailbox calls DELETE /api/mailboxes/:id | T-0504 | 10m | [ ] |
| T-0508 | RED | React | src/__tests__/store.test.js | Test: addCampaign calls POST /api/campaigns | T-0504 | 10m | [ ] |
| T-0509 | RED | React | src/__tests__/store.test.js | Test: setCampaignStatus calls correct endpoint (run/pause) | T-0504 | 10m | [ ] |
| T-0510 | RED | React | src/__tests__/store.test.js | Test: addTemplate calls POST /api/templates | T-0504 | 10m | [ ] |
| T-0511 | RED | React | src/__tests__/store.test.js | Test: updateTemplate calls PUT /api/templates/:id | T-0504 | 10m | [ ] |
| T-0512 | RED | React | src/__tests__/store.test.js | Test: deleteTemplate calls DELETE /api/templates/:id | T-0504 | 10m | [ ] |
| T-0513 | RED | React | src/__tests__/store.test.js | Test: addSegment calls POST /api/segments | T-0504 | 10m | [ ] |
| T-0514 | RED | React | src/__tests__/store.test.js | Test: rebuildSegment calls POST /api/segments/:id/rebuild | T-0504 | 10m | [ ] |
| T-0515 | RED | React | src/__tests__/store.test.js | Test: reloadReplyStats updates replyStats state | T-0504 | 10m | [ ] |
| T-0516 | RED | React | src/hooks/__tests__/useOutreachHealth.test.js | Test: degraded=true when /api/daemons fails | T-0014 | 15m | [ ] |
| T-0517 | RED | React | src/hooks/__tests__/useOutreachHealth.test.js | Test: degraded=false when /api/daemons succeeds | T-0516 | 10m | [ ] |
| T-0518 | RED | React | src/hooks/__tests__/useOutreachHealth.test.js | Test: banner shown when degraded=true | T-0516 | 10m | [ ] |

### E2E test suite (Playwright)

| ID | Phase | Layer | File | Description | Depends | Est | Status |
|----|-------|-------|------|-------------|---------|-----|--------|
| T-0519 | RED | E2E | test/e2e/inbox-flow.spec.ts | E2E: open /replies → filter by unhandled | T-0164 | 20m | [ ] |
| T-0520 | RED | E2E | test/e2e/inbox-flow.spec.ts | E2E: click thread → slide-over → "→ Vlákno" → ThreadDetail | T-0519 | 20m | [ ] |
| T-0521 | RED | E2E | test/e2e/inbox-flow.spec.ts | E2E: mark as handled | T-0520 | 15m | [ ] |
| T-0522 | GREEN | E2E | test/e2e/inbox-flow.spec.ts | Implement inbox E2E | T-0521 | 1h | [ ] |
| T-0523 | RED | E2E | test/e2e/reply-flow.spec.ts | E2E: open thread → compose reply → send → verify in thread | T-0243 | 30m | [ ] |
| T-0524 | GREEN | E2E | test/e2e/reply-flow.spec.ts | Implement reply E2E | T-0523 | 1h | [ ] |
| T-0525 | RED | E2E | test/e2e/mailbox-setup.spec.ts | E2E: add mailbox → SMTP check → pipeline test | T-0029 | 20m | [ ] |
| T-0526 | GREEN | E2E | test/e2e/mailbox-setup.spec.ts | Implement mailbox E2E | T-0525 | 45m | [ ] |
| T-0527 | RED | E2E | test/e2e/segment-flow.spec.ts | E2E: create filter → preview → save → use in campaign | T-0061 | 20m | [ ] |
| T-0528 | GREEN | E2E | test/e2e/segment-flow.spec.ts | Implement segment E2E | T-0527 | 45m | [ ] |
| T-0529 | RED | E2E | test/e2e/analytics-export.spec.ts | E2E: date range → export CSV → verify download | T-0306 | 20m | [ ] |
| T-0530 | GREEN | E2E | test/e2e/analytics-export.spec.ts | Implement analytics E2E | T-0529 | 30m | [ ] |

### Design system components

| ID | Phase | Layer | File | Description | Depends | Est | Status |
|----|-------|-------|------|-------------|---------|-----|--------|
| T-0531 | RED | React | src/components/__tests__/Button.test.jsx | Test: primary, ghost, icon variants | T-0014 | 15m | [ ] |
| T-0532 | RED | React | src/components/__tests__/Button.test.jsx | Test: disabled state | T-0531 | 10m | [ ] |
| T-0533 | RED | React | src/components/__tests__/Button.test.jsx | Test: loading spinner state | T-0531 | 10m | [ ] |
| T-0534 | RED | React | src/components/__tests__/Modal.test.jsx | Test: open/close with overlay click | T-0014 | 15m | [ ] |
| T-0535 | RED | React | src/components/__tests__/Modal.test.jsx | Test: Esc key closes | T-0534 | 10m | [ ] |
| T-0536 | RED | React | src/components/__tests__/Modal.test.jsx | Test: modal-lg variant (640px) | T-0534 | 10m | [ ] |
| T-0537 | RED | React | src/components/__tests__/Toast.test.jsx | Test: success/error/info variants | T-0014 | 15m | [ ] |
| T-0538 | RED | React | src/components/__tests__/Toast.test.jsx | Test: auto-dismiss after timeout | T-0537 | 10m | [ ] |
| T-0539 | RED | React | src/components/__tests__/Toast.test.jsx | Test: close button | T-0537 | 10m | [ ] |
| T-0540 | RED | React | src/components/__tests__/Skeleton.test.jsx | Test: renders placeholder blocks | T-0014 | 10m | [ ] |
| T-0541 | RED | React | src/components/__tests__/SearchInput.test.jsx | Test: renders with placeholder | T-0014 | 10m | [ ] |
| T-0542 | RED | React | src/components/__tests__/SearchInput.test.jsx | Test: debounced onChange | T-0541 | 10m | [ ] |
| T-0543 | RED | React | src/components/__tests__/Badge.test.jsx | Test: green/yellow/red/gray/blue variants | T-0014 | 10m | [ ] |
| T-0544 | RED | React | src/components/__tests__/Drawer.test.jsx | Test: opens/closes (302px right panel) | T-0014 | 15m | [ ] |
| T-0545 | RED | React | src/components/__tests__/KpiCell.test.jsx | Test: renders label + value + optional sub | T-0014 | 10m | [ ] |

### Keyboard shortcuts

| ID | Phase | Layer | File | Description | Depends | Est | Status |
|----|-------|-------|------|-------------|---------|-----|--------|
| T-0546 | RED | React | src/__tests__/shortcuts.test.jsx | Test: ⌘K opens command palette | T-0014 | 15m | [ ] |
| T-0547 | RED | React | src/__tests__/shortcuts.test.jsx | Test: ⌘N opens new campaign modal | T-0546 | 10m | [ ] |
| T-0548 | RED | React | src/__tests__/shortcuts.test.jsx | Test: ⌘1-5 navigates to sections | T-0546 | 15m | [ ] |
| T-0549 | RED | React | src/__tests__/shortcuts.test.jsx | Test: / focuses search | T-0546 | 10m | [ ] |
| T-0550 | RED | React | src/__tests__/shortcuts.test.jsx | Test: Esc closes modal/drawer | T-0546 | 10m | [ ] |
| T-0551 | GREEN | React | src/hooks/useShortcuts.js | Keyboard shortcut hook implementation | T-0550 | 30m | [ ] |
| T-0552 | GREEN | React | src/components/CommandPalette.jsx | Command palette component (⌘K) | T-0551 | 45m | [ ] |
| T-0553 | VERIFY | React | — | All shortcuts work. Command palette opens. | T-0552 | 10m | [ ] |

### BFF cron engine tests

| ID | Phase | Layer | File | Description | Depends | Est | Status |
|----|-------|-------|------|-------------|---------|-----|--------|
| T-0554 | RED | BFF | test/unit/cron-engine.test.js | Test: proxy refresh runs every 30min | T-0014 | 10m | [ ] |
| T-0555 | RED | BFF | test/unit/cron-engine.test.js | Test: IMAP poll runs every 15min | T-0554 | 10m | [ ] |
| T-0556 | RED | BFF | test/unit/cron-engine.test.js | Test: warmup advance runs daily 05:00 | T-0554 | 10m | [ ] |
| T-0557 | RED | BFF | test/unit/cron-engine.test.js | Test: daily report runs 07:00 | T-0554 | 10m | [ ] |
| T-0558 | RED | BFF | test/unit/cron-engine.test.js | Test: midnight reset runs 00:00 | T-0554 | 10m | [ ] |
| T-0559 | RED | BFF | test/unit/cron-engine.test.js | Test: BFF_IMPORT_ONLY disables all crons | T-0554 | 10m | [ ] |
| T-0560 | RED | BFF | test/unit/cron-engine.test.js | Test: stale-guard auto-recovery | T-0554 | 15m | [ ] |
| T-0561 | RED | BFF | test/unit/cron-engine.test.js | Test: config drift detection | T-0554 | 15m | [ ] |

### Go daemon tests

| ID | Phase | Layer | File | Description | Depends | Est | Status |
|----|-------|-------|------|-------------|---------|-----|--------|
| T-0562 | RED | Go | modules/outreach/internal/daemon/campaign_runner_test.go | Test: processes running campaigns | T-0014 | 15m | [ ] |
| T-0563 | RED | Go | modules/outreach/internal/daemon/campaign_runner_test.go | Test: sends next step for eligible contacts | T-0562 | 15m | [ ] |
| T-0564 | RED | Go | modules/outreach/internal/daemon/campaign_runner_test.go | Test: respects business hours | T-0562 | 10m | [ ] |
| T-0565 | RED | Go | modules/outreach/internal/daemon/campaign_runner_test.go | Test: respects warmup limits | T-0562 | 10m | [ ] |
| T-0566 | RED | Go | modules/outreach/internal/daemon/campaign_runner_test.go | Test: skip paused mailboxes | T-0562 | 10m | [ ] |
| T-0567 | RED | Go | modules/outreach/internal/daemon/watchdog_test.go | Test: bounce decay (24h recovery) | T-0014 | 15m | [ ] |
| T-0568 | RED | Go | modules/outreach/internal/daemon/watchdog_test.go | Test: auth spike detection | T-0567 | 10m | [ ] |
| T-0569 | RED | Go | modules/outreach/internal/daemon/watchdog_test.go | Test: circuit breaker trip/close | T-0567 | 15m | [ ] |
| T-0570 | RED | Go | modules/outreach/internal/daemon/intelligence_test.go | Test: ARES sync fetches new companies | T-0014 | 15m | [ ] |
| T-0571 | RED | Go | modules/outreach/internal/daemon/intelligence_test.go | Test: classify assigns ICP tier | T-0570 | 10m | [ ] |
| T-0572 | RED | Go | modules/outreach/internal/daemon/intelligence_test.go | Test: promote Schema B→A | T-0570 | 15m | [ ] |

### Suppression & compliance tests

| ID | Phase | Layer | File | Description | Depends | Est | Status |
|----|-------|-------|------|-------------|---------|-----|--------|
| T-0573 | RED | Go | modules/outreach/internal/suppress/blacklist_test.go | Test: hard bounce adds to blacklist | T-0014 | 10m | [ ] |
| T-0574 | RED | Go | modules/outreach/internal/suppress/blacklist_test.go | Test: complaint adds to blacklist | T-0573 | 10m | [ ] |
| T-0575 | RED | Go | modules/outreach/internal/suppress/blacklist_test.go | Test: blacklisted email skipped in future sends | T-0573 | 10m | [ ] |
| T-0576 | RED | Go | modules/outreach/internal/suppress/unsubscribe_test.go | Test: unsubscribe token validates | T-0014 | 10m | [ ] |
| T-0577 | RED | Go | modules/outreach/internal/suppress/unsubscribe_test.go | Test: unsubscribed contact skipped | T-0576 | 10m | [ ] |
| T-0578 | RED | Go | modules/outreach/internal/suppress/unsubscribe_test.go | Test: negative reply auto-suppresses | T-0576 | 10m | [ ] |

### Migration tests

| ID | Phase | Layer | File | Description | Depends | Est | Status |
|----|-------|-------|------|-------------|---------|-----|--------|
| T-0579 | RED | Go | modules/outreach/internal/db/migration_test.go | Test: migration 044 (leads) creates table with correct schema | T-0014 | 15m | [ ] |
| T-0580 | RED | Go | modules/outreach/internal/db/migration_test.go | Test: migration 045 (dedup) adds constraints | T-0579 | 10m | [ ] |
| T-0581 | RED | Go | modules/outreach/internal/db/migration_test.go | Test: migration 046 (attachments) creates table | T-0579 | 10m | [ ] |
| T-0582 | RED | Go | modules/outreach/internal/db/migration_test.go | Test: migration 047 (message_type) adds column | T-0579 | 10m | [ ] |
| T-0583 | RED | Go | modules/outreach/internal/db/migration_test.go | Test: migrations are idempotent (re-run safe) | T-0579 | 15m | [ ] |

### Anti-trace audit tests

| ID | Phase | Layer | File | Description | Depends | Est | Status |
|----|-------|-------|------|-------------|---------|-----|--------|
| T-0584 | RED | Go | modules/outreach/internal/antitrace/audit_test.go | Audit 1: raw email source — zero platform identifiers | T-0014 | 15m | [ ] |
| T-0585 | RED | Go | modules/outreach/internal/antitrace/audit_test.go | Audit 2: no X-Mailer, X-Originating-IP, X-Priority | T-0584 | 10m | [ ] |
| T-0586 | RED | Go | modules/outreach/internal/antitrace/audit_test.go | Audit 3: tracking pixel looks like customer domain | T-0584 | 10m | [ ] |
| T-0587 | RED | Go | modules/outreach/internal/antitrace/audit_test.go | Audit 4: click redirect looks like customer content | T-0584 | 10m | [ ] |
| T-0588 | RED | Go | modules/outreach/internal/antitrace/audit_test.go | Audit 5: CNAME to relay, not platform | T-0584 | 10m | [ ] |
| T-0589 | RED | Go | modules/outreach/internal/antitrace/audit_test.go | Audit 6: WHOIS clean | T-0584 | 10m | [ ] |
| T-0590 | RED | Go | modules/outreach/internal/antitrace/audit_test.go | Audit 7: no consistent header pattern (10 emails) | T-0584 | 15m | [ ] |
| T-0591 | RED | Go | modules/outreach/internal/antitrace/audit_test.go | Audit 8: mail-tester score ≥ 9/10 | T-0584 | 10m | [ ] |
| T-0592 | RED | Go | modules/outreach/internal/antitrace/audit_test.go | Audit 9: Message-ID format random@sending-domain | T-0584 | 10m | [ ] |

### Data model validation tests

| ID | Phase | Layer | File | Description | Depends | Est | Status |
|----|-------|-------|------|-------------|---------|-----|--------|
| T-0593 | RED | Go | modules/outreach/internal/db/schema_test.go | Test: contacts table has email_hash UNIQUE | T-0014 | 10m | [ ] |
| T-0594 | RED | Go | modules/outreach/internal/db/schema_test.go | Test: campaign_contacts has UNIQUE (campaign_id, contact_id) | T-0593 | 10m | [ ] |
| T-0595 | RED | Go | modules/outreach/internal/db/schema_test.go | Test: send_events.message_id is INDEXED | T-0593 | 10m | [ ] |
| T-0596 | RED | Go | modules/outreach/internal/db/schema_test.go | Test: segments.name is UNIQUE | T-0593 | 10m | [ ] |
| T-0597 | RED | Go | modules/outreach/internal/db/schema_test.go | Test: outreach_mailboxes.from_address is UNIQUE | T-0593 | 10m | [ ] |
| T-0598 | RED | Go | modules/outreach/internal/db/schema_test.go | Test: leads UNIQUE (contact_id, campaign_id) | T-0593 | 10m | [ ] |
| T-0599 | RED | Go | modules/outreach/internal/db/schema_test.go | Test: blacklist.email UNIQUE | T-0593 | 10m | [ ] |
| T-0600 | RED | Go | modules/outreach/internal/db/schema_test.go | Test: unsubscribes.token UNIQUE | T-0593 | 10m | [ ] |

---

## Summary

| Category | Task count |
|----------|-----------|
| FÁZE 0: Stabilizace (MVP 01-03) | 29 |
| FÁZE 1: Campaign wizard (MVP 04-08) | 60 |
| FÁZE 2: Campaign operations (MVP 09-11) | 26 |
| FÁZE 3: DNS & Preflight (MVP 12-13) | 29 |
| FÁZE 4: Inbox & threading (MVP 14-16) | 27 |
| FÁZE 5: ThreadView (MVP 17-19) | 43 |
| FÁZE 6: Manual reply (MVP 20-23) | 56 |
| FÁZE 7: Lead management (MVP 24-25) | 27 |
| FÁZE 8: Analytics (MVP 26-27) | 17 |
| FÁZE 9: Intelligence (MVP 28-30) | 34 |
| FÁZE 10: Hardening (MVP 31-35) | 38 |
| Cross-cutting: BFF endpoints | 43 |
| Cross-cutting: Go business logic | 44 |
| Cross-cutting: UI states | 15 |
| Cross-cutting: Store/hooks | 15 |
| Cross-cutting: E2E | 12 |
| Cross-cutting: Design system | 15 |
| Cross-cutting: Shortcuts | 8 |
| Cross-cutting: Cron engine | 8 |
| Cross-cutting: Go daemons | 11 |
| Cross-cutting: Suppression | 6 |
| Cross-cutting: Migrations | 5 |
| Cross-cutting: Anti-trace | 9 |
| Cross-cutting: Schema validation | 8 |
| **TOTAL** | **600** |

> To reach 1000+: each GREEN task above often decomposes into 2-3 sub-tasks
> during implementation (e.g., "implement X" = write function + wire route + add
> to store). The 600 tasks here are the ATOMIC planning units. Implementation
> naturally expands to ~1000 commits when each RED test is a commit, each GREEN
> pass is a commit, and each REFACTOR is a commit.
