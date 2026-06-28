# Production E2E (`tests/e2e-prod/`)

End-to-end tests that run against the **LIVE** dashboard
(`https://outreach.auction24.cz`). Separate from `tests/e2e/` (local-only) and
**never** wired into `pnpm e2e`.

In production the BFF runs with `BFF_AUTH_DISABLED=1` and talks directly to
**PROD Postgres + the Go sender daemon + the anti-trace relay**. The app's auth
gate is frontend-only, so it cannot protect the data. A single mis-click on
"Spustit kampaň" / "Odeslat" / a mailbox probe could send **real email to real
business recipients**.

## The safety kill-switch (read this)

Every spec installs a browser-level network guard (`_guard/safety-guard.ts`)
that **physically `route.abort()`s**, before the request leaves the browser:

- every `POST/PUT/PATCH/DELETE` to `/api/*` (sends, launches, writes, key
  rotation, GDPR erase, …) — default-deny;
- the external-I/O probe **GET**s (`smtp-check`, `imap-check`, `full-check`,
  `imap-inbox`) that dial real mail servers.

Firebase auth, Google Fonts and Sentry are allowed (login must work). Every
blocked request is recorded in an audit ledger attached to the run, so each run
**proves** nothing dangerous reached the network. The classifier is unit-tested
offline in `_guard/safety-guard.unit.spec.ts`.

## Run

```bash
cd apps/outreach-dashboard

# offline classifier sanity (no prod contact)
pnpm exec playwright test --config=playwright.prod.config.js --project=unit

# everything (setup logs in once, then positive + negative)
PROD_E2E_USER='…' PROD_E2E_PASS='…' \
  pnpm exec playwright test --config=playwright.prod.config.js

# single suite
… --project=authed     # positive (reuses the persisted login)
… --project=anon       # negative (runs logged-out)

# HTML report
pnpm exec playwright show-report playwright-report-prod
```

Credentials come from `PROD_E2E_USER` / `PROD_E2E_PASS` env vars — never
hardcoded. The persisted Firebase session lands in `.auth/state.json`
(git-ignored; contains a refresh token).

## Playwright MCP — complementary, NOT a substitute for the kill-switch

The project `.mcp.json` defines a `playwright` MCP server (headless, isolated,
1440×900). It is great for **read-only** interactive work: navigating, taking
screenshots, debugging selectors, visual review.

**Critical:** the MCP browser does **NOT** carry the kill-switch above — its
`--blocked-origins` is origin-granular and explicitly "not a security
boundary", so it cannot allow `GET /api/campaigns` while blocking
`POST /api/campaigns/:id/run` on the same origin.

Therefore:

- **MCP** → navigate + screenshot + read. Do **not** click send / launch /
  probe / bulk controls against prod.
- **This spec harness** → the safe path for anything that *clicks*, because
  dangerous requests are aborted at the network layer.

The MCP is configured `--isolated` with **no** baked-in `--storage-state`, so it
starts **logged-out** (a safety baseline — `RequireAuth` bounces you to
`/login`). For authenticated read-only exploration, pass the saved session
on-demand, e.g. add `--storage-state apps/outreach-dashboard/tests/e2e-prod/.auth/state.json`
to a one-off MCP invocation after running the `setup` project.
