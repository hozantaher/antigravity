# Public-page URL fix — option playbook (2026-05-01)

> **Status:** open / awaiting operator decision.
> **Trigger:** today's BFF smoke test against
> `outreach-dashboard-production-e4ce.up.railway.app` returned 302→`/login`
> for `/privacy`, `/unsubscribe/test`, and `/healthz`. In parallel,
> `https://garaaage.cz/privacy` returned `401 Basic Auth` (Cloudflare
> origin guard). Both URLs appear in every campaign's GDPR footer
> (`docs/playbooks/launch-readiness.md` § "Required fields").
> **Blast radius if shipped broken:** every email in campaign 455
> contains a non-functional unsubscribe link → Art. 21 GDPR breach →
> ÚOOÚ exposure. Hard launch gate.

## Diagnosis recap

| Surface | Observation | Inference |
|---|---|---|
| `outreach-dashboard-production-e4ce.up.railway.app/privacy` | 302 → `/login` | Service is an orphaned Nuxt build; last successful deploy 2026-04-17 + 6 subsequent failed redeploys. The current React+Express BFF lives under `features/platform/outreach-dashboard/` but has never reached this Railway service. |
| same URL `/unsubscribe/test` | 302 → `/login` | Same orphan — Nuxt SSR did not register an `/unsubscribe` route for the new HMAC contract; the Nuxt auth middleware runs first and bounces unauthenticated GETs. |
| same URL `/healthz` | 302 → `/login` | Same. The current React+Express BFF exposes `/api/health` — even if deployed, `/healthz` would still 404, but it would not 302. |
| `garaaage.cz/privacy` | 401 Basic Auth | Cloudflare-level access policy on the apex; nothing in the repo emits this — operator's Cloudflare config. |

The render-time templates for campaign 455 use:

- `{{.UnsubURL}}` → resolves to `${UNSUBSCRIBE_BASE_URL}/unsubscribe?...`
  (see `features/outreach/campaigns/campaign/runner.go:806`).
- `Privacy policy: https://garaaage.cz/privacy` (hard-coded in the
  GDPR footer body — see migration `025_campaign_455_unsub_footer.sql`
  and `docs/playbooks/launch-readiness.md`).

The unsub URL host is operator-controllable via env. The privacy URL is
literal text in the template body and only changes by re-rendering
templates or putting a working endpoint behind that exact host.

---

## Option A — Force-deploy current React+Express BFF to the orphaned `outreach-dashboard` Railway service

**When to choose:** you want a single canonical public surface for both
`/unsubscribe` and `/privacy`, and the custom apex `garaaage.cz` is not
ready (or you don't want to touch Cloudflare today).

### Pre-conditions

1. `features/platform/outreach-dashboard/Dockerfile` is current (verify by reading the
   first 40 lines and matching against `features/platform/outreach-dashboard/server.js`
   imports).
2. `features/platform/outreach-dashboard/railway.toml` references the service name
   `outreach-dashboard` and a healthcheck path the React+Express server
   actually serves (`/api/health`).
3. The 6 failed redeploys are NOT due to a runtime bug — most likely
   stale build cache or a missing env var. Confirm by:
   ```bash
   railway logs --service outreach-dashboard --tail 200 \
     | grep -iE 'error|failed|cannot find|enoent' | head
   ```
4. All env vars from `docs/playbooks/kt-a3-bff-deploy-checklist.md` § 3
   are set on the Railway service (table rows 1–8 mandatory). Inspect:
   ```bash
   railway variables --service outreach-dashboard | sort
   ```

### Execute

```bash
# 1. Pin to the right Railway project + service
railway link
railway service outreach-dashboard

# 2. Force a clean rebuild (clears stale cache + the 6 failed deploy state)
railway up --service outreach-dashboard --detach --ci

# 3. Tail the boot
railway logs --service outreach-dashboard --tail 200
# Expect: [boot] BFF listening on :PORT  → [cron] schemaCheck duration_ms=…

# 4. Confirm UNSUBSCRIBE_BASE_URL points at THIS service's public URL
railway variables --service outreach-dashboard --get UNSUBSCRIBE_BASE_URL
# Should match the host you'll smoke-test below (no trailing slash).
```

### Post-checks

```bash
export BFF_URL='https://outreach-dashboard-production-e4ce.up.railway.app'

# /api/health (correct path on the React+Express BFF)
curl -sf "${BFF_URL}/api/health" | jq .

# /privacy (public, no auth)
curl -sif "${BFF_URL}/privacy" | head -20
# Expect: HTTP/2 200 + text/html with the Privacy Notice body

# /unsubscribe (HMAC token will be invalid — that's fine for shape probe)
curl -sif "${BFF_URL}/unsubscribe?c=999&id=1&t=00" | head -5
# Expect: HTTP/2 200 (rejection page) or 400 (bad token) — NOT 302 to /login
```

If `/privacy` still 302s after redeploy, the build deployed but a
catch-all auth middleware is intercepting public routes. Diff
`features/platform/outreach-dashboard/server.js` against the `server-routes/privacy.js`
+ `server-routes/unsubscribe.js` mounters and confirm they are wired
**before** any auth gate.

### Rollback

```bash
railway deployments list --service outreach-dashboard
railway redeploy <previous_stable_id> --service outreach-dashboard
```

If the redeploy itself broke something downstream, pause the service —
sender engine reads DB directly and tolerates BFF-down for hours:
```bash
railway service pause outreach-dashboard
```

---

## Option B — Point `UNSUBSCRIBE_BASE_URL` to a DIFFERENT Railway service that already serves `/unsubscribe` + `/privacy`

**When to choose:** you want the unsub link working in <30 minutes
without touching the orphaned service. Privacy URL stays a separate
problem (Option C) since it's a literal in the template body.

### Pre-conditions

1. Identify a Railway service that:
   - Boots from `features/platform/outreach-dashboard/` (the React+Express BFF).
   - Has `/privacy` and `/unsubscribe` mounted (verify via
     `features/platform/outreach-dashboard/src/server-routes/privacy.js` +
     `unsubscribe.js`).
   - Is healthy + reachable on a public URL.
2. **Discovery commands:**
   ```bash
   railway projects
   railway environment
   # For each service:
   railway service <name>
   railway domain          # show public URLs
   curl -sif "https://<service>.up.railway.app/api/health" | head -5
   curl -sif "https://<service>.up.railway.app/privacy"   | head -5
   ```
3. Note: `features/inbound/orchestrator` (Go) does NOT serve `/privacy` or
   `/unsubscribe` — those are Express-only. Disqualify any Go-only
   service from this option.
4. The chosen service's `UNSUBSCRIBE_SECRET` must match the value used
   by the sender engine (`features/outreach/campaigns/campaign/runner.go:806`),
   otherwise tokens generated at send-time will fail HMAC validation
   at click-time.

### Execute

```bash
# Identify the working dashboard URL (call it $TARGET).
TARGET='https://<healthy-bff>.up.railway.app'   # filled by operator

# Confirm it actually serves both pages (no auth gate):
curl -sif "${TARGET}/privacy"             | head -3
curl -sif "${TARGET}/unsubscribe?c=1&id=1&t=00" | head -3

# Set on the service that emits the campaign sends. Per
# docs/playbooks/kt-a3-bff-deploy-checklist.md § 4, the sender reads
# UNSUBSCRIBE_BASE_URL from its own env (NOT the BFF's).
railway service machinery-outreach    # the Go orchestrator
railway variables --service machinery-outreach \
    --set "UNSUBSCRIBE_BASE_URL=${TARGET}"

# Confirm UNSUBSCRIBE_SECRET parity between services
railway variables --service machinery-outreach --get UNSUBSCRIBE_SECRET
railway variables --service <bff-service>     --get UNSUBSCRIBE_SECRET
# These two values MUST match.

# Restart the orchestrator so the new env is picked up by the next
# campaign tick (engine reads at runner.go startup).
railway redeploy --service machinery-outreach
```

### Post-checks

```bash
# 1. Render a test email locally with the new env set:
UNSUBSCRIBE_BASE_URL="${TARGET}" \
  go test ./features/outreach/campaigns/campaign -run TestBuildUnsubURL -v

# 2. From the BFF, simulate a click with a real HMAC:
CAMPAIGN=999; CONTACT=12345; EMAIL='test@example.cz'
SECRET="$(railway variables --service machinery-outreach --get UNSUBSCRIBE_SECRET)"
TOKEN=$(printf '%s|%s|%s' "$CAMPAIGN" "$CONTACT" "$EMAIL" \
  | openssl dgst -sha256 -hmac "$SECRET" -binary | xxd -p -c 256 | cut -c1-16)

curl -sif "${TARGET}/unsubscribe?c=${CAMPAIGN}&id=${CONTACT}&t=${TOKEN}" | head -10
# Expect: HTTP/2 200 + 'Kontakt nenalezen' (404 contact, not 404 route).
```

### Rollback

```bash
railway variables --service machinery-outreach \
    --set "UNSUBSCRIBE_BASE_URL=https://outreach-dashboard-production-e4ce.up.railway.app"
railway redeploy --service machinery-outreach
```

(Reverts to the broken-but-known surface; sender will continue to
generate non-functional links until you pick A or B again.)

### Caveat

Option B does NOT fix `https://garaaage.cz/privacy` (that string is
hard-coded in the template body via migration 025). Footer links to
that host will remain 401 until Option C runs. If you choose only B,
a recipient who clicks "Privacy policy" in the email gets Cloudflare
Basic Auth → still a launch blocker.

---

## Option C — Remove Cloudflare Basic Auth on `garaaage.cz/privacy` + `/unsubscribe`

**When to choose:** you want the canonical apex URLs (`garaaage.cz/...`)
publicly reachable and don't want the Railway `*.up.railway.app` host
in every email.

### Pre-conditions

1. Operator has Cloudflare account access for the `garaaage.cz` zone
   (Tomáš).
2. The 401 is from a Cloudflare Access policy or a Worker-level Basic
   Auth — confirm by inspecting response headers:
   ```bash
   curl -sI 'https://garaaage.cz/privacy' | grep -iE 'cf-mitigated|cf-ray|www-authenticate|server'
   ```
   `www-authenticate: Basic realm=...` + `server: cloudflare` →
   Cloudflare-level Basic Auth (Worker, Page Rule, or Access app).
3. The apex `garaaage.cz` actually has an origin behind it that serves
   the privacy page. If the only thing serving content is Cloudflare
   Pages or a Worker, Option C might require deploying a new origin
   (escalate to a separate playbook — out of scope here).

### Execute (Cloudflare dashboard, NOT in repo)

> **Repo cannot drive this — operator runs in Cloudflare UI.**

1. Cloudflare dashboard → `garaaage.cz` zone.
2. Security → WAF → "Custom rules" → look for any rule matching
   `(http.request.uri.path eq "/privacy")` with action
   `Block | JS Challenge | Managed Challenge`. Disable or remove.
3. Security → Access → Applications → look for an app whose
   "Application domain" matches `garaaage.cz/privacy` or
   `garaaage.cz/*`. Either delete the app or change its policy from
   "Allow only authenticated" to "Bypass" / "Service Auth".
4. Workers & Pages → check for any Worker route on `garaaage.cz/*`
   that issues a 401 (read the Worker source — Basic Auth is usually
   a single `if (!authHeader) return new Response("...", {status:401, headers:{'WWW-Authenticate':'Basic realm="..."'}})`).
   Remove the Worker route or the auth branch.
5. Page Rules (legacy) → delete any rule that injects auth on `/privacy`
   or `/unsubscribe`.

### Post-checks

```bash
curl -sif 'https://garaaage.cz/privacy'      | head -5    # expect 200
curl -sif 'https://garaaage.cz/unsubscribe?c=1&id=1&t=00' | head -5
# expect 200 (or whatever the BFF returns) — NOT 401
```

If `/privacy` returns 200 but the body is empty / 404 from origin →
Cloudflare auth was the only thing serving content. Either deploy an
origin (Option A's BFF on a custom domain `outreach.garaaage.cz`) or
publish the markdown via Cloudflare Pages from `docs/legal/privacy-notice.md`.

### Rollback

Re-enable the Cloudflare rule / Access policy / Worker — these changes
are atomic in the Cloudflare UI and reversible from the audit log.

---

## Decision matrix

| You want | Pick |
|---|---|
| One canonical surface, fastest path to green smoke test, comfortable redeploying Railway | **A** |
| Unsub working in <30min, accept that privacy link is still 401 until later | **B** (then schedule **C**) |
| Branded apex URLs in every email, Cloudflare access available | **C** + (A or already-deployed BFF behind apex) |
| Belt-and-braces: both surfaces working independently | **A** + **C**; ignore B |

Operator picks. None of the three commit code or migrations — all are
ops-surface changes.

---

## Reference

- `docs/playbooks/kt-a3-bff-deploy-checklist.md` — full BFF deploy procedure (env vars + smoke tests)
- `docs/playbooks/machinery-outreach-deploy.md` — Go orchestrator deploy
- `features/platform/outreach-dashboard/src/server-routes/privacy.js` — `/privacy` mount
- `features/platform/outreach-dashboard/src/server-routes/unsubscribe.js` — `/unsubscribe` HMAC handler
- `features/outreach/campaigns/campaign/runner.go:806` — `buildUnsubURL`
- `scripts/migrations/025_campaign_455_unsub_footer.sql` — template footer migration (hard-codes `https://garaaage.cz/privacy` literal)
