# verify-launch smoke audit — campaign 455 — 2026-05-01

**Status:** RED (4/5 gates failed)
**Date:** 2026-05-01
**Trigger:** Sprint smoke validation of `pnpm verify:launch` CLI (PR #582)

---

## Invocation

```
DATABASE_URL=postgresql://outreach:***@junction.proxy.rlwy.net:54755/outreach?sslmode=disable \
  pnpm verify:launch --campaign-id=455 --json
```

- Mode: `dry-run` (default)
- BFF running locally: NO (`pnpm dev` not started)
- Relay base: `https://anti-trace-relay-production-a706.up.railway.app` (from `.env` `ANTI_TRACE_RELAY_URL`)
- Total elapsed: **6.33 s**
- Raw JSON output: [`verify-launch-455-2026-05-01.json`](./verify-launch-455-2026-05-01.json)

---

## Per-gate results

| # | Gate | Result | Detail |
|---|------|--------|--------|
| 1 | `egress_sanity` | RED | BFF not running — `fetch failed`. Gate requires `pnpm dev` on port 18001. |
| 2 | `bff_preflight` | RED | BFF not running — `fetch failed`. Gate requires `pnpm dev` on port 18001. |
| 3 | `smtp_probe` | RED | All 4 active mailboxes returned HTTP 401 from relay `/v1/probe`. Script sends no `Authorization` header and uses wrong request shape. |
| 4 | `template_render` | RED | 5/5 sampled contacts missing `UnsubURL` in rendered body. Template for campaign 455 does not contain `{{.UnsubURL}}` / `{{unsuburl}}` placeholder. |
| 5 | `db_write_probe` | GREEN | Skipped in dry-run mode (correct). |

---

## Gate 1 — `egress_sanity` RED

**Exact output:**
```
"Egress probe failed: fetch failed. Ensure BFF is running on port 18001."
```

**Root cause:** Gate polls `http://localhost:18001/api/anti-trace/egress`. BFF was not running during this audit session.

**Limitation vs. bug:** This is a documented operational constraint, not a script defect. The script correctly surfaces the missing dependency.

**Action:** Start `pnpm dev` before invoking `pnpm verify:launch`. Document in script usage header.

**action_url:** `/diagnostika/anonymita`

---

## Gate 2 — `bff_preflight` RED

**Exact output:**
```
"BFF preflight request failed: fetch failed. Ensure BFF is running on port 18001."
```

**Root cause:** Same as Gate 1 — BFF not running. Gate polls `http://localhost:18001/api/campaigns/455/run` with `x-preflight-only: 1`.

**action_url:** `/campaigns/455`

---

## Gate 3 — `smtp_probe` RED

**Exact output:**
```
"SMTP AUTH probe failed for 4/4 mailboxes: mb=1 (mazher.a@email.cz): HTTP 401 — {"error":"unauthorized"}
; mb=3 (a.mazher@email.cz): HTTP 401 — {"error":"unauthorized"}
; mb=631 (b.maarek@email.cz): HTTP 401 — {"error":"unauthorized"}
; mb=632 (maarek.b@email.cz): HTTP 401 — {"error":"unauthorized"}"
```

**Root cause — two distinct bugs in `scripts/verify-launch.mjs`:**

1. **Missing `Authorization` header.** `features/outreach/relay/web/probe.go:295` calls `s.requireActor(w, r)` before processing any probe request. The relay requires a valid auth token. `verify-launch.mjs` posts to `/v1/probe` with no `Authorization` header. The `ANTI_TRACE_RELAY_TOKEN` env var is present in `.env` but never read or attached.

2. **Wrong request body shape.** The script posts `{ mailbox: mb.from_address }` (one string field). `probe.go:304` requires `smtp_host`, `smtp_port`, `smtp_username`, `password` — none of which are present. Even if auth were fixed, the relay would return HTTP 400 `smtp_host, smtp_port, smtp_username, password required`.

**Fix needed in `scripts/verify-launch.mjs`:**
- Read `ANTI_TRACE_RELAY_TOKEN` env var and pass it as `Authorization: Bearer <token>` on the `/v1/probe` fetch.
- Either (a) look up `smtp_host`/`smtp_port`/`smtp_username`/`password` from the DB per mailbox row, or (b) route the probe through the BFF `/api/mailboxes/:id/probe` endpoint which already owns credentials.

**action_url:** `/mailboxes`

---

## Gate 4 — `template_render` RED

**Exact output:**
```
"Template render issues for 5 contact(s): contact 3921 (hustak@hustak.cz): missing UnsubURL in rendered body; contact 5557 (klimatizace.ostrava@email.cz): missing UnsubURL in rendered body; contact 11860 (skorupa@mspact.cz): missing UnsubURL in rendered body"
```
(All 5 sampled contacts failed — output truncates at 3 per script logic.)

**Root cause:** Campaign 455's active template does not contain a `{{.UnsubURL}}` or `{{unsuburl}}` placeholder. The render check in step 4 asserts `body.includes('/unsubscribe?')` after substitution. Because the placeholder is absent, no unsubscribe URL is injected, and the assertion fails for every contact.

**GDPR implication:** Per `CLAUDE.md` ("All outbound campaigns MUST include footer with: ... unsubscribe link"), a template without an unsubscribe link is non-compliant. This gate is correctly blocking launch.

**action_url:** `/templates`

---

## Gate 5 — `db_write_probe` GREEN

**Exact output:**
```
"Mode=dry-run — DB write probe skipped (read-only mode)"
```

Correct behaviour. The probe is intentionally a no-op in dry-run mode.

---

## Action items summary

| Priority | Gate | Item |
|----------|------|------|
| P1 | Gate 3 | Fix `verify-launch.mjs`: read `ANTI_TRACE_RELAY_TOKEN`, attach as `Authorization: Bearer` on `/v1/probe` fetch |
| P1 | Gate 3 | Fix `verify-launch.mjs`: send correct probe body (`smtp_host`, `smtp_port`, `smtp_username`, `password`) — fetch from DB or route through BFF |
| P1 | Gate 4 | Add `{{.UnsubURL}}` placeholder to campaign 455 template; verify GDPR footer present |
| P0 (ops) | Gates 1+2 | Document in script README/header: BFF must be running (`pnpm dev`) for egress + preflight gates |

---

## Reproduce

```bash
# With BFF running (gates 1+2 require it):
pnpm dev &
DATABASE_URL=postgresql://outreach:outreach_053ff0c20c74809c@junction.proxy.rlwy.net:54755/outreach?sslmode=disable \
  pnpm verify:launch --campaign-id=455 --json
```
