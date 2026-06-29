# Auth & Account (module)

Vertical-axis module — see `plan.md` §2.

- **Top node (UX/UI):** `ui/LettersAvatar.vue`, `ui/UserMenuAvatar.vue` (auto-imported as `<LettersAvatar>`, `<UserMenuAvatar>`).
- **Contract:** `contract.ts` — the auth/account data types the UI + logic bind to (`User`, `RegisterDto`, `RegisterProfile`, `Request`, `ApiTokenRow`, `ApiTokenCreated`, `AuthType`), re-exported from the central `models/` barrel (decision §7.2). API surface: `/api/auth/*` (login, logout, register), `/api/me*`.
- **Behind the contract (swappable impl):** `logic/{useUser,authHeader,state}` (auto-imported via `imports.dirs: features/*/logic`); server-side `server/utils/{firebase,session}.ts` + `server/repos/{userRepo,apiTokenRepo}.ts` stay under `server/`; `middleware/{auth,admin}` stay under `middleware/`.

Self-measure: `pnpm module:signal auth-account`.
