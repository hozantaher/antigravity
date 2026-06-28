# Secret Hygiene Sweep — 2026-04-23

**Task:** P1-4 (#73). Status: **completed this pass**.

## What was scanned

Full repo grep for:
- Env-assignment patterns: `(SECRET|API_KEY|TOKEN|PASSWORD|BEARER)=<20+ chars>`
- String literals: `(password|token|api-key|secret)\s*[:=]\s*"[A-Za-z0-9+/=_.-]{16,}"`
- Tracked `.env*` files in git (should be `*.example` only)

## Findings

### Tracked `.env*` files (git ls-files)

All 12 tracked `.env` files are `.example` templates — no real secrets committed:

```
_template/service/.env.example
features/platform/outreach-dashboard/.env.example
infra/docker/.env.example
modules/outreach/.env.{dev,railway,}.example
features/acquisition/contacts/.env.example
features/inbound/inbox/.env.example
features/outreach/mailboxes/.env.example
features/platform/mcp/.env.example
features/compliance/privacy-gateway/.env.*.example
features/acquisition/scrapers/.env.example
features/platform/worker/.env.example
```

### Local-only `.env` files (NOT tracked, ignored per per-app .gitignore)

- `features/platform/outreach-dashboard/.env` — contains real DATABASE_URL + ANTI_TRACE_RELAY_TOKEN + OUTREACH_API_KEY
  - **Status:** properly ignored via `features/platform/outreach-dashboard/.gitignore:16`
  - **Risk:** low (file is gitignored); rotation in a prior sweep

### Secret-looking strings in source code

Two hits in test-only files (false positives):

- `services/smoke-privacy-r5.sh:12` — `BRIDGE_TOKEN="bridge-intake-secret-r5"`
  - This is a **fixture token** for smoke-test dev env (never prod).
- `features/platform/outreach-dashboard/test/contract/bff-mailboxes-has-valid-password.contract.test.ts` + `bff-property-fuzz.contract.test.ts`
  - Stubbed test tokens in unit-test strings (never reach prod).

Remaining hits are in `node_modules` (third-party libs) — not our code.

## Hardening this pass

Added root-level `.env` blanket ignore in `.gitignore`:

```gitignore
# Environment and secrets (never commit)
*.local
secrets
.env           # NEW — root-level blanket
.env.*         # NEW — blanket all variants
!.env.example  # NEW — exempt templates
!.env*.example
!*.example
```

Per-app `.gitignore` already covered the existing `.env` files, but belt-and-suspenders. Any new subdirectory that creates a `.env` file is now ignored by default without requiring a per-app rule.

## Rotation status of known secrets (for #69 P0-5)

The following were referenced in PR #7 / public logs. **Rotation is a
destructive user action** — not performed autonomously. User must rotate
and update env in Railway + local `.env`:

1. `DATABASE_URL` password fragment `outreach_053ff0c20c74809c` — PG password
2. `ANTI_TRACE_RELAY_TOKEN` `WuZHxaYqtAYsT2agTs/lkg==` — relay bearer
3. `OUTREACH_API_KEY` `d755731507bb7b68f85b54d4ebcf280ed864e2f6d650270be383331aba342e06` — BFF auth

**Rotation procedure** (when user confirms):
1. Railway PG: rotate DB user password via Railway UI → update 3 places
   (modules/outreach, features/platform/outreach-dashboard, scripts)
2. Relay bearer: generate new token, set as `ANTI_TRACE_RELAY_TOKEN` in
   Railway relay service + dashboard service
3. OUTREACH_API_KEY: generate new hex, set in Railway outreach service +
   dashboard service

## Verification commands for future sweeps

```bash
# 1. Any .env in git index?
git ls-files | grep -E '\.env$|\.env\.[^.]+$' | grep -v '\.example'
# expected: empty

# 2. Hardcoded secret-like strings in source?
rtk grep -rE "(SECRET|API_KEY|TOKEN|PASSWORD|BEARER)\s*=\s*['\"][A-Za-z0-9+/=_-]{20,}" \
  --include='*.go' --include='*.js' --include='*.jsx' --include='*.ts' --include='*.sh'

# 3. AWS-style leak patterns?
grep -rE "AKIA[0-9A-Z]{16}|aws_secret_access_key" --include='*'

# 4. Tracked .env files that aren't .example?
git ls-files '.env*' '**/.env*' | grep -v '\.example$'
```

## Next-sweep triggers

Run this sweep whenever:
- Before major release
- After any "rotate" action to confirm the old secret is gone
- Before making the repo public
- Quarterly hygiene check
