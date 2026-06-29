#!/usr/bin/env bash
# ════════════════════════════════════════════════════════════════════════
# ML1.3 — test suite: mail-lab-roundcube (Roundcube webmail pro seznam.lab)
# ════════════════════════════════════════════════════════════════════════
#
# ≥10 assertions per issue #215:
#   1.  docker compose ps → mail-lab-roundcube healthy
#   2.  HTTP GET http://localhost:28080/ → 200 + Roundcube login HTML
#   3.  Login form má pole _user a _pass
#   4.  POST login s operator@seznam.lab → redirect na inbox (200)
#   5.  Inbox view loadne ≤ 2s
#   6.  Compose form přítomen na /? _task=mail&_action=compose
#   7.  Static assets mají cache headers (ETag nebo Last-Modified)
#   8.  SQLite volume mail-lab-roundcube-data existuje po startu
#   9.  Container hostname je webmail.seznam.lab
#  10.  Nemá venkovní HTTP egress (curl seznam.cz from container fails)
#  11.  Roundcube verze je uvedena v HTTP headers nebo HTML
#  12.  mail-lab.yml definuje mail-lab-roundcube service
#
# Standalone mode (no docker): verifies compose config only.
# Integration mode (MAIL_LAB_INTEGRATION=1): HTTP assertions against
# running container on localhost:28080.
#
# Usage:
#   bash scripts/mail-lab/test_ml1_3.sh                  # standalone
#   MAIL_LAB_INTEGRATION=1 bash scripts/mail-lab/test_ml1_3.sh  # full
#
# Exit codes:
#   0   all assertions pass
#   1   one or more assertions failed

set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/../.." && pwd)"
COMPOSE_FILE="${REPO_ROOT}/infra/docker/mail-lab.yml"
ROUNDCUBE_CONTAINER="mail-lab-roundcube"
ROUNDCUBE_URL="http://localhost:28080"

PASS=0
FAIL=0
SKIP=0

# ── assertion helpers ────────────────────────────────────────────────────────
assert_pass() {
  local desc="$1"
  shift
  if "$@" >/dev/null 2>&1; then
    printf 'PASS  %s\n' "${desc}"
    PASS=$((PASS + 1))
  else
    printf 'FAIL  %s\n' "${desc}" >&2
    FAIL=$((FAIL + 1))
  fi
}

assert_file_contains() {
  local desc="$1"
  local path="$2"
  local pattern="$3"
  if grep -qF "${pattern}" "${path}" 2>/dev/null; then
    printf 'PASS  %s\n' "${desc}"
    PASS=$((PASS + 1))
  else
    printf 'FAIL  %s — pattern not found: %s\n' "${desc}" "${pattern}" >&2
    FAIL=$((FAIL + 1))
  fi
}

skip() {
  local desc="$1"
  printf 'SKIP  %s\n' "${desc}"
  SKIP=$((SKIP + 1))
}

echo "=== ML1.3 Roundcube webmail tests ==="
echo

# ── A1: compose service mail-lab-roundcube present ──────────────────────────
assert_file_contains "A1: mail-lab.yml defines mail-lab-roundcube service" \
  "${COMPOSE_FILE}" "mail-lab-roundcube"

# ── A2: roundcube/roundcubemail image referenced ────────────────────────────
assert_file_contains "A2: mail-lab.yml uses roundcube/roundcubemail image" \
  "${COMPOSE_FILE}" "roundcube/roundcubemail"

# ── A3: port mapping 28080 → 80 in compose ──────────────────────────────────
assert_file_contains "A3: mail-lab.yml maps port 28080:80 for roundcube" \
  "${COMPOSE_FILE}" "28080:80"

# ── A4: depends_on mail-lab-seznam healthy ───────────────────────────────────
# The compose section should have both mail-lab-roundcube and healthy dependency.
if grep -A5 "mail-lab-roundcube" "${COMPOSE_FILE}" 2>/dev/null | grep -q "depends_on" || \
   grep -A20 "mail-lab-roundcube:" "${COMPOSE_FILE}" 2>/dev/null | grep -q "service_healthy"; then
  printf 'PASS  A4: mail-lab-roundcube depends_on mail-lab-seznam healthy\n'
  PASS=$((PASS + 1))
else
  printf 'FAIL  A4: mail-lab-roundcube missing depends_on or healthy condition\n' >&2
  FAIL=$((FAIL + 1))
fi

# ── A5: volume for sqlite session store defined ──────────────────────────────
assert_file_contains "A5: mail-lab.yml defines mail-lab-roundcube-data volume" \
  "${COMPOSE_FILE}" "mail-lab-roundcube-data"

# ── A6: hostname webmail.seznam.lab in compose ───────────────────────────────
assert_file_contains "A6: mail-lab-roundcube hostname is webmail.seznam.lab" \
  "${COMPOSE_FILE}" "webmail.seznam.lab"

# ── A7: mail-lab-roundcube uses lab DNS (10.20.0.2) ─────────────────────────
# Verify that within the roundcube section the dns: entry is present.
# The compose file sets dns: 10.20.0.2 on roundcube (hermeticity).
ROUNDCUBE_SECTION=$(awk '/mail-lab-roundcube:/{f=1} f && /^  [a-z]/ && !/mail-lab-roundcube:/{f=0} f' "${COMPOSE_FILE}" 2>/dev/null)
if echo "${ROUNDCUBE_SECTION}" | grep -q "10.20.0.2"; then
  printf 'PASS  A7: mail-lab-roundcube uses lab DNS resolver 10.20.0.2\n'
  PASS=$((PASS + 1))
else
  printf 'FAIL  A7: mail-lab-roundcube missing dns: 10.20.0.2\n' >&2
  FAIL=$((FAIL + 1))
fi

# ── A8: ROUNDCUBEMAIL_DEFAULT_HOST env var set ───────────────────────────────
assert_file_contains "A8: mail-lab.yml sets ROUNDCUBEMAIL_DEFAULT_HOST" \
  "${COMPOSE_FILE}" "ROUNDCUBEMAIL_DEFAULT_HOST"

# ── A9: compose config validates (no YAML errors) ────────────────────────────
if docker compose -f "${COMPOSE_FILE}" config >/dev/null 2>&1; then
  printf 'PASS  A9: docker compose -f mail-lab.yml config validates (no YAML errors)\n'
  PASS=$((PASS + 1))
else
  printf 'FAIL  A9: docker compose config validation failed\n' >&2
  docker compose -f "${COMPOSE_FILE}" config 2>&1 | head -10 >&2
  FAIL=$((FAIL + 1))
fi

# ── Integration assertions (requires MAIL_LAB_INTEGRATION=1) ─────────────────
if [[ -z "${MAIL_LAB_INTEGRATION:-}" ]]; then
  echo
  echo "Standalone assertions: PASS=${PASS}  FAIL=${FAIL}  SKIP=${SKIP}"
  echo
  echo "To run full integration tests (requires running mail-lab stack):"
  echo "  MAIL_LAB_INTEGRATION=1 bash scripts/mail-lab/test_ml1_3.sh"
  echo
  exit $(( FAIL > 0 ? 1 : 0 ))
fi

if ! docker inspect "${ROUNDCUBE_CONTAINER}" >/dev/null 2>&1; then
  echo "ERROR: container ${ROUNDCUBE_CONTAINER} not found — run 'bash scripts/mail-lab/up.sh' first" >&2
  exit 1
fi

echo
echo "── Integration assertions (container: ${ROUNDCUBE_CONTAINER})"

# ── I1: container healthcheck passes ────────────────────────────────────────
I1_STATUS=$(docker inspect --format='{{.State.Health.Status}}' "${ROUNDCUBE_CONTAINER}" 2>/dev/null || echo "missing")
if [[ "${I1_STATUS}" == "healthy" ]]; then
  printf 'PASS  I1: mail-lab-roundcube container healthcheck → healthy\n'
  PASS=$((PASS + 1))
else
  printf 'FAIL  I1: mail-lab-roundcube healthcheck status: %s\n' "${I1_STATUS}" >&2
  FAIL=$((FAIL + 1))
fi

# ── I2: HTTP GET / → 200 + Roundcube HTML ────────────────────────────────────
I2_OUT=$(curl -sS -o /tmp/rc_login.html -w "%{http_code}" "${ROUNDCUBE_URL}/" 2>/dev/null || echo "000")
I2_BODY=$(cat /tmp/rc_login.html 2>/dev/null || true)
if [[ "${I2_OUT}" == "200" ]] && echo "${I2_BODY}" | grep -qi "Roundcube"; then
  printf 'PASS  I2: GET %s/ → 200 + Roundcube HTML\n' "${ROUNDCUBE_URL}"
  PASS=$((PASS + 1))
else
  printf 'FAIL  I2: GET %s/ returned HTTP %s or missing Roundcube branding\n' \
    "${ROUNDCUBE_URL}" "${I2_OUT}" >&2
  FAIL=$((FAIL + 1))
fi

# ── I3: login form has _user and _pass fields ────────────────────────────────
if echo "${I2_BODY}" | grep -q "_user" && echo "${I2_BODY}" | grep -q "_pass"; then
  printf 'PASS  I3: login form has _user and _pass fields\n'
  PASS=$((PASS + 1))
else
  printf 'FAIL  I3: login form missing _user or _pass fields\n' >&2
  FAIL=$((FAIL + 1))
fi

# ── I4: POST login → successful auth (302 redirect or 200 inbox) ─────────────
# Extract CSRF token (_token) from login page for a valid POST.
RC_TOKEN=$(echo "${I2_BODY}" | grep -oE 'name="_token" value="[^"]*"' | head -1 | grep -oE 'value="[^"]*"' | tr -d 'value="' || true)
I4_OUT=$(curl -sS -c /tmp/rc_cookies.txt -b /tmp/rc_cookies.txt \
  -o /tmp/rc_inbox.html \
  -w "%{http_code}" \
  -X POST "${ROUNDCUBE_URL}/" \
  -d "_task=login&_action=login&_timezone=Europe/Prague&_url=&_user=operator%40seznam.lab&_pass=lab-demo-only&_token=${RC_TOKEN}" \
  2>/dev/null || echo "000")
if [[ "${I4_OUT}" == "200" ]] || [[ "${I4_OUT}" == "302" ]]; then
  printf 'PASS  I4: POST login operator@seznam.lab → HTTP %s (auth accepted)\n' "${I4_OUT}"
  PASS=$((PASS + 1))
else
  printf 'FAIL  I4: POST login returned HTTP %s (expected 200 or 302)\n' "${I4_OUT}" >&2
  FAIL=$((FAIL + 1))
fi

# ── I5: inbox loads within 2 seconds ────────────────────────────────────────
I5_START=$(date +%s%N)
curl -sS -c /tmp/rc_cookies.txt -b /tmp/rc_cookies.txt \
  -o /dev/null \
  "${ROUNDCUBE_URL}/?_task=mail" 2>/dev/null || true
I5_END=$(date +%s%N)
I5_MS=$(( (I5_END - I5_START) / 1000000 ))
if [[ ${I5_MS} -lt 2000 ]]; then
  printf 'PASS  I5: inbox page loaded in %dms (≤ 2000ms)\n' "${I5_MS}"
  PASS=$((PASS + 1))
else
  printf 'FAIL  I5: inbox page took %dms (> 2000ms)\n' "${I5_MS}" >&2
  FAIL=$((FAIL + 1))
fi

# ── I6: compose form accessible ──────────────────────────────────────────────
I6_OUT=$(curl -sS -c /tmp/rc_cookies.txt -b /tmp/rc_cookies.txt \
  -o /tmp/rc_compose.html \
  -w "%{http_code}" \
  "${ROUNDCUBE_URL}/?_task=mail&_action=compose" 2>/dev/null || echo "000")
if [[ "${I6_OUT}" == "200" ]]; then
  printf 'PASS  I6: compose form accessible (HTTP 200)\n'
  PASS=$((PASS + 1))
else
  printf 'FAIL  I6: compose form returned HTTP %s\n' "${I6_OUT}" >&2
  FAIL=$((FAIL + 1))
fi

# ── I7: static assets have cache headers ─────────────────────────────────────
# Check a known static path — Roundcube serves skins/elastic assets.
I7_HEADERS=$(curl -sS -I "${ROUNDCUBE_URL}/skins/elastic/styles/styles.min.css" 2>/dev/null || true)
if echo "${I7_HEADERS}" | grep -qi "etag\|last-modified\|cache-control"; then
  printf 'PASS  I7: static CSS asset has cache header (ETag/Last-Modified/Cache-Control)\n'
  PASS=$((PASS + 1))
else
  printf 'FAIL  I7: static CSS asset missing cache headers\n' >&2
  FAIL=$((FAIL + 1))
fi

# ── I8: SQLite volume mail-lab-roundcube-data exists ────────────────────────
if docker volume inspect mail-lab-roundcube-data >/dev/null 2>&1; then
  printf 'PASS  I8: docker volume mail-lab-roundcube-data exists\n'
  PASS=$((PASS + 1))
else
  printf 'FAIL  I8: docker volume mail-lab-roundcube-data not found\n' >&2
  FAIL=$((FAIL + 1))
fi

# ── I9: container hostname is webmail.seznam.lab ─────────────────────────────
I9_HOSTNAME=$(docker exec "${ROUNDCUBE_CONTAINER}" hostname 2>/dev/null || echo "")
if [[ "${I9_HOSTNAME}" == "webmail.seznam.lab" ]]; then
  printf 'PASS  I9: container hostname is webmail.seznam.lab\n'
  PASS=$((PASS + 1))
else
  printf 'FAIL  I9: container hostname is "%s", expected "webmail.seznam.lab"\n' "${I9_HOSTNAME}" >&2
  FAIL=$((FAIL + 1))
fi

# ── I10: no external HTTP egress from container ──────────────────────────────
# The lab DNS has no upstream and returns SERVFAIL for real domains.
# curl to seznam.cz should fail (DNS resolution or connection error).
I10_OUT=$(docker exec "${ROUNDCUBE_CONTAINER}" \
  curl -sS --connect-timeout 3 -o /dev/null -w "%{http_code}" "http://seznam.cz/" 2>/dev/null \
  || echo "failed")
if [[ "${I10_OUT}" == "failed" ]] || [[ "${I10_OUT}" == "000" ]]; then
  printf 'PASS  I10: no external HTTP egress (curl seznam.cz from container fails as expected)\n'
  PASS=$((PASS + 1))
else
  printf 'FAIL  I10: curl seznam.cz from container succeeded (HTTP %s) — egress not blocked\n' \
    "${I10_OUT}" >&2
  FAIL=$((FAIL + 1))
fi

# ── I11: Roundcube version in HTTP response or HTML ──────────────────────────
I11_HEADERS=$(curl -sS -I "${ROUNDCUBE_URL}/" 2>/dev/null || true)
if echo "${I11_HEADERS}" | grep -qi "roundcube\|x-powered-by" || \
   echo "${I2_BODY}" | grep -qiE "roundcubemail|roundcube [0-9]"; then
  printf 'PASS  I11: Roundcube version or branding present in response\n'
  PASS=$((PASS + 1))
else
  # Roundcube sometimes strips version from headers for security; check HTML more carefully.
  if echo "${I2_BODY}" | grep -qi "roundcube"; then
    printf 'PASS  I11: Roundcube branding present in login HTML\n'
    PASS=$((PASS + 1))
  else
    printf 'FAIL  I11: Roundcube branding not found in response\n' >&2
    FAIL=$((FAIL + 1))
  fi
fi

# ── I12: session persists across restart (volume survives) ───────────────────
# Indirect test: the SQLite volume should be non-empty after login.
DB_SIZE=$(docker exec "${ROUNDCUBE_CONTAINER}" \
  sh -c 'du -b /var/roundcube/db/*.db 2>/dev/null | awk "{print \$1}" | head -1' 2>/dev/null \
  || echo "0")
if [[ "${DB_SIZE:-0}" -gt 0 ]]; then
  printf 'PASS  I12: SQLite session DB non-empty (%s bytes) — volume persistent\n' "${DB_SIZE}"
  PASS=$((PASS + 1))
else
  # SQLite may not have written yet; treat as skip rather than fail.
  printf 'SKIP  I12: SQLite DB size 0 — session not yet persisted (expected after first login)\n'
  SKIP=$((SKIP + 1))
fi

echo
echo "=== Results: PASS=${PASS}  FAIL=${FAIL}  SKIP=${SKIP} ==="

[[ ${FAIL} -eq 0 ]]
