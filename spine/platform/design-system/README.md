# Design System (module)
![Version](https://img.shields.io/badge/version-v1.1.0-blue)


Vertical-axis module — see `plan.md` §2.

- **Top node (UX/UI):** `ui/Base*.vue` — the 12 shared UI primitives (auto-imported as `<BaseInput>`, `<BaseModal>`, …).
- **Contract:** `contract.ts` — each primitive's props/emits + the data types they bind to (`BaseValidator`, `OptionItem`, `ModalSize`).
- **Bottom node (pure data):** `BaseValidator`, `OptionItem`, `ModalSize` — re-exported from the central `models/` barrel (not physically moved; decision §7.2).
- **Behind the contract (swappable impl):** `logic/useValidators.ts` — auto-imported via `imports.dirs: features/*/logic`.

Self-measure: `pnpm module:signal design-system` (rolls up the member cells; `module.json` view via `pnpm module:map`).
