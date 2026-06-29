#!/usr/bin/env bash
# Morning smoke — operator's pre-launch readiness check from the terminal.
# ─────────────────────────────────────────────────────────────────────────────
# Purpose: single command that exercises the prod readiness signals before
# the operator clicks "Spustit" on the campaign. Catches the deploy / env-var
# / DB-state mistakes that the in-app /priprava page also shows, but in a
# scriptable form so the operator can run it from a launch checklist.
#
# Usage:
#   bash scripts/operator/morning-smoke.sh
#   BFF_URL=https://outreach.garaaage.cz bash scripts/operator/morning-smoke.sh
#   bash scripts/operator/morning-smoke.sh --quiet     # only failures + summary
#
# Exit codes:
#   0  — all checks green, operator is clear to launch
#   1  — at least one blocker; details printed to stderr
#   2  — script invocation error (BFF unreachable, missing curl, etc.)
#
# Dependencies: curl, jq. Both are in every minimal install + GitHub Actions.
#
# Companion piece to `docs/playbooks/morning-routine.md` which describes the
# in-app /priprava page. This script tests the same signals from outside the
# browser, useful when the operator wants a one-liner sanity check.

set -uo pipefail

BFF_URL="${BFF_URL:-http://localhost:18001}"
TIMEOUT="${TIMEOUT:-10}"
QUIET=0
PRIVACY_URL="${PRIVACY_URL:-https://outreach.garaaage.cz/privacy}"
UNSUB_BASE="${UNSUBSCRIBE_BASE_URL:-https://garaaage.cz}"

for arg in "$@"; do
  case "$arg" in
    --quiet|-q) QUIET=1 ;;
    -h|--help)
      sed -n '2,28p' "$0"
      exit 0
      ;;
    *)
      echo "Unknown arg: $arg" >&2
      exit 2
      ;;
  esac
done

if ! command -v curl >/dev/null 2>&1; then
  echo "✗ curl not found in PATH" >&2
  exit 2
fi
if ! command -v jq >/dev/null 2>&1; then
  echo "✗ jq not found in PATH (install: brew install jq)" >&2
  exit 2
fi

ok() { [ "$QUIET" = "1" ] || echo "✓ $1"; }
warn() { echo "⚠ $1" >&2; }
fail() { echo "✗ $1" >&2; FAILS=$((FAILS + 1)); }
note() { [ "$QUIET" = "1" ] || echo "  $1"; }

FAILS=0

# ─── Check 1: BFF reachable ──────────────────────────────────────────────
echo "→ BFF: $BFF_URL"
if ! BODY=$(curl -fsS --max-time "$TIMEOUT" "$BFF_URL/api/morning-readiness" 2>/dev/null); then
  fail "BFF $BFF_URL/api/morning-readiness unreachable (HTTP error or timeout)"
  echo
  echo "Summary: $FAILS check(s) failed. Operator NOT cleared to launch." >&2
  exit 1
fi
ok "BFF /api/morning-readiness reachable"

# ─── Check 2: Readiness flag ─────────────────────────────────────────────
READY=$(echo "$BODY" | jq -r '.ready_to_launch // false')
BLOCKERS=$(echo "$BODY" | jq -r '.blockers | length // 0')
if [ "$READY" = "true" ]; then
  ok "Morning readiness: ready_to_launch=true (0 blockers)"
else
  fail "Morning readiness: ready_to_launch=false ($BLOCKERS blocker(s))"
  echo "$BODY" | jq -r '.blockers[] | "  • \(.label): \(.detail)"' >&2
fi

# ─── Check 3: Mailboxes step detail ──────────────────────────────────────
MB_OK=$(echo "$BODY" | jq -r '.steps[] | select(.key == "mailboxes") | .ok')
MB_VALID=$(echo "$BODY" | jq -r '.steps[] | select(.key == "mailboxes") | .valid // 0')
MB_TOTAL=$(echo "$BODY" | jq -r '.steps[] | select(.key == "mailboxes") | .total // 0')
note "Mailboxes: ${MB_VALID}/${MB_TOTAL} have a real password"
if [ "$MB_OK" != "true" ]; then
  fail "Mailboxes step is RED — open /priprava/hesla to bulk-fill passwords"
fi

# ─── Check 4: Templates step detail ──────────────────────────────────────
T_OK=$(echo "$BODY" | jq -r '.steps[] | select(.key == "templates") | .ok')
T_READY=$(echo "$BODY" | jq -r '.steps[] | select(.key == "templates") | .ready // 0')
T_TOTAL=$(echo "$BODY" | jq -r '.steps[] | select(.key == "templates") | .total // 0')
note "Templates: ${T_READY}/${T_TOTAL} have subject + body"
if [ "$T_OK" != "true" ]; then
  fail "Templates step is RED — open /templates?new=1 to create one"
fi

# ─── Check 5: Segments step detail ───────────────────────────────────────
S_OK=$(echo "$BODY" | jq -r '.steps[] | select(.key == "segments") | .ok')
S_ELIG=$(echo "$BODY" | jq -r '.steps[] | select(.key == "segments") | .total_eligible // 0')
S_SECTORS=$(echo "$BODY" | jq -r '.steps[] | select(.key == "segments") | .sectors_with_contacts // 0')
note "Segments: ${S_ELIG} eligible contacts in ${S_SECTORS} sectors"
if [ "$S_OK" != "true" ]; then
  fail "Segments step is RED — check prospect import / suppression"
fi

# ─── Check 6: Go backend reachability via __schema-check ─────────────────
if SCHEMA=$(curl -fsS --max-time "$TIMEOUT" "$BFF_URL/api/__schema-check" 2>/dev/null); then
  SCHEMA_OK=$(echo "$SCHEMA" | jq -r '.ok // false')
  if [ "$SCHEMA_OK" = "true" ]; then
    ok "Go backend reachable via /api/__schema-check"
  else
    warn "Go backend schema-check returned ok=false (degraded)"
    echo "$SCHEMA" | jq -r '.diff // "(no diff field)"' >&2 | head -5
  fi
else
  warn "Go backend /api/__schema-check unreachable — campaign create will fall back to direct-DB path"
fi

# ─── Check 7: Privacy URL HTTP 200 ───────────────────────────────────────
if PRIV_HTTP=$(curl -fsSL -o /dev/null --max-time "$TIMEOUT" -w '%{http_code}' "$PRIVACY_URL" 2>/dev/null); then
  if [ "$PRIV_HTTP" = "200" ]; then
    ok "Privacy URL $PRIVACY_URL → HTTP 200"
  else
    fail "Privacy URL $PRIVACY_URL returned HTTP $PRIV_HTTP (template footer references this URL — recipients clicking it will see an error)"
  fi
else
  fail "Privacy URL $PRIVACY_URL unreachable"
fi

# ─── Check 8: Unsub base URL HTTP responsive ─────────────────────────────
# Note: $UNSUB_BASE is the runner's UNSUBSCRIBE_BASE_URL env value. We just
# probe the base + /unsubscribe path with a sentinel token to confirm a
# response (the BFF will return 400 invalid-params on the sentinel — that's
# fine, it proves the endpoint is mounted).
if UNSUB_HTTP=$(curl -fsSL -o /dev/null --max-time "$TIMEOUT" -w '%{http_code}' "${UNSUB_BASE}/unsubscribe?c=0&id=0&t=0000000000000000" 2>/dev/null); then
  case "$UNSUB_HTTP" in
    200|400|403|404|503)
      ok "Unsub endpoint ${UNSUB_BASE}/unsubscribe responded HTTP $UNSUB_HTTP (mounted)"
      ;;
    *)
      warn "Unsub endpoint ${UNSUB_BASE}/unsubscribe returned unexpected HTTP $UNSUB_HTTP"
      ;;
  esac
else
  fail "Unsub endpoint ${UNSUB_BASE}/unsubscribe unreachable — recipients clicking unsub link will see an error"
fi

# ─── Summary ─────────────────────────────────────────────────────────────
echo
if [ "$FAILS" = "0" ]; then
  echo "✓ All checks passed. Operator clear to launch."
  exit 0
else
  echo "✗ Summary: $FAILS check(s) failed. Operator NOT cleared to launch." >&2
  echo "  Fix red checks then re-run: bash scripts/operator/morning-smoke.sh" >&2
  exit 1
fi
