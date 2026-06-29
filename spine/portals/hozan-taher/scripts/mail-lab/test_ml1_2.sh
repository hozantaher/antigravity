#!/usr/bin/env bash
# ════════════════════════════════════════════════════════════════════════
# ML1.2 — test suite: mail-lab-dns (unbound DNS resolver pro *.lab zóny)
# ════════════════════════════════════════════════════════════════════════
#
# ≥10 assertions per issue #214:
#   1.  dig @127.0.0.1 A mx.seznam.lab → 10.20.0.10
#   2.  dig @127.0.0.1 MX seznam.lab → "10 mx.seznam.lab."
#   3.  dig @127.0.0.1 TXT seznam.lab obsahuje "v=spf1"
#   4.  dig @127.0.0.1 TXT mail._domainkey.seznam.lab obsahuje "v=DKIM1"
#   5.  dig @127.0.0.1 A imap.seznam.lab → 10.20.0.10
#   6.  dig @127.0.0.1 A webmail.seznam.lab → 10.20.0.20
#   7.  dig @127.0.0.1 A google.com → SERVFAIL (no upstream)
#   8.  dig @127.0.0.1 A seznam.cz → SERVFAIL (sealed env)
#   9.  dig @127.0.0.1 ANY . → no crash (returns NOERROR or REFUSED)
#  10.  Resolver responds < 50ms (dig +stats)
#  11.  Reverse PTR: dig @127.0.0.1 -x 10.20.0.10 → mx.seznam.lab
#  12.  unbound.conf má service mail-lab-dns v compose
#
# Standalone mode (no docker): verifies compose config + unbound.conf files.
# Integration mode (MAIL_LAB_INTEGRATION=1): connects to running container
# at 127.0.0.1 port 53 (host-mapped from mail-lab-dns).
#
# Usage:
#   bash scripts/mail-lab/test_ml1_2.sh                  # standalone
#   MAIL_LAB_INTEGRATION=1 bash scripts/mail-lab/test_ml1_2.sh  # full
#
# Exit codes:
#   0   all assertions pass
#   1   one or more assertions failed

set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/../.." && pwd)"
COMPOSE_FILE="${REPO_ROOT}/infra/docker/mail-lab.yml"
UNBOUND_CONF="${REPO_ROOT}/infra/mail-lab/dns/unbound.conf"

# DNS port on host — mail-lab-dns does not publish port 53 to host in this
# compose setup (internal network). Integration assertions exec into the
# container itself and use 127.0.0.1 from inside.
DNS_CONTAINER="mail-lab-dns"

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

assert_file_exists() {
  local desc="$1"
  local path="$2"
  if [[ -f "${path}" ]]; then
    printf 'PASS  %s\n' "${desc}"
    PASS=$((PASS + 1))
  else
    printf 'FAIL  %s — file not found: %s\n' "${desc}" "${path}" >&2
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

# Run a command inside mail-lab-dns container via docker exec.
# Returns the exit code and outputs stdout/stderr.
dns_exec() {
  docker exec "${DNS_CONTAINER}" "$@" 2>&1
}

# Execute a drill query inside the container and return its stdout.
# drill is available in mvance/unbound:1.20.0 via ldns package.
dns_drill() {
  dns_exec drill "$@" 2>/dev/null
}

echo "=== ML1.2 unbound DNS resolver tests ==="
echo

# ── A1: unbound.conf exists ──────────────────────────────────────────────────
assert_file_exists "A1: infra/mail-lab/dns/unbound.conf exists" "${UNBOUND_CONF}"

# ── A2: unbound.conf defines mail-lab subnet access-control ─────────────────
assert_file_contains "A2: unbound.conf has access-control 10.20.0.0/24 allow" \
  "${UNBOUND_CONF}" "10.20.0.0/24 allow"

# ── A3: unbound.conf has seznam.lab local-zone ──────────────────────────────
assert_file_contains "A3: unbound.conf has seznam.lab local-zone" \
  "${UNBOUND_CONF}" 'local-zone: "seznam.lab."'

# ── A4: unbound.conf has mx.seznam.lab A record ──────────────────────────────
assert_file_contains "A4: unbound.conf has mx.seznam.lab → 10.20.0.10" \
  "${UNBOUND_CONF}" 'mx.seznam.lab.'

# ── A5: unbound.conf has DKIM TXT record for seznam.lab ─────────────────────
assert_file_contains "A5: unbound.conf has DKIM TXT for seznam.lab" \
  "${UNBOUND_CONF}" "mail._domainkey.seznam.lab."

# ── A6: unbound.conf has SPF TXT record ─────────────────────────────────────
assert_file_contains "A6: unbound.conf has SPF TXT (v=spf1)" \
  "${UNBOUND_CONF}" "v=spf1"

# ── A7: compose service mail-lab-dns is present in mail-lab.yml ─────────────
assert_file_contains "A7: mail-lab.yml defines mail-lab-dns service" \
  "${COMPOSE_FILE}" "mail-lab-dns"

# ── A8: compose references mvance/unbound image ──────────────────────────────
assert_file_contains "A8: mail-lab.yml uses mvance/unbound image" \
  "${COMPOSE_FILE}" "mvance/unbound"

# ── A9: mail-lab-seznam has dns: entry pointing to 10.20.0.2 ────────────────
assert_file_contains "A9: mail-lab.yml sets dns: 10.20.0.2 for lab containers" \
  "${COMPOSE_FILE}" "10.20.0.2"

# ── A10: mail-lab-dns is assigned static IP 10.20.0.2 in compose ────────────
assert_file_contains "A10: mail-lab-dns has static IP 10.20.0.2 in compose" \
  "${COMPOSE_FILE}" "ipv4_address: 10.20.0.2"

# ── A11: unbound.conf disables upstream forwarding ───────────────────────────
# "do-not-query-localhost: no" is intentional (needed for container loopback),
# but no "forward-zone" stanza should exist — that would leak queries upstream.
if grep -q "forward-zone" "${UNBOUND_CONF}" 2>/dev/null; then
  printf 'FAIL  A11: unbound.conf contains forward-zone (upstream forwarding enabled — lab should be sealed)\n' >&2
  FAIL=$((FAIL + 1))
else
  printf 'PASS  A11: unbound.conf has no forward-zone (sealed, no upstream)\n'
  PASS=$((PASS + 1))
fi

# ── A12: unbound.conf has webmail.seznam.lab A record (Roundcube ML1.3) ──────
assert_file_contains "A12: unbound.conf has webmail.seznam.lab → 10.20.0.20" \
  "${UNBOUND_CONF}" "webmail.seznam.lab."

# ── Integration assertions (requires MAIL_LAB_INTEGRATION=1) ─────────────────
if [[ -z "${MAIL_LAB_INTEGRATION:-}" ]]; then
  echo
  echo "Standalone assertions: PASS=${PASS}  FAIL=${FAIL}  SKIP=${SKIP}"
  echo
  echo "To run full integration tests (requires running mail-lab stack):"
  echo "  MAIL_LAB_INTEGRATION=1 bash scripts/mail-lab/test_ml1_2.sh"
  echo
  exit $(( FAIL > 0 ? 1 : 0 ))
fi

if ! docker inspect "${DNS_CONTAINER}" >/dev/null 2>&1; then
  echo "ERROR: container ${DNS_CONTAINER} not found — run 'bash scripts/mail-lab/up.sh' first" >&2
  exit 1
fi

echo
echo "── Integration assertions (container: ${DNS_CONTAINER})"

# ── I1: mx.seznam.lab A → 10.20.0.10 ────────────────────────────────────────
I1_OUT=$(dns_drill "@127.0.0.1" mx.seznam.lab A)
if echo "${I1_OUT}" | grep -q "10.20.0.10"; then
  printf 'PASS  I1: dig A mx.seznam.lab → 10.20.0.10\n'
  PASS=$((PASS + 1))
else
  printf 'FAIL  I1: dig A mx.seznam.lab did not return 10.20.0.10\n' >&2
  printf '      output: %s\n' "${I1_OUT}" >&2
  FAIL=$((FAIL + 1))
fi

# ── I2: MX seznam.lab → 10 mx.seznam.lab ────────────────────────────────────
I2_OUT=$(dns_drill "@127.0.0.1" seznam.lab MX)
if echo "${I2_OUT}" | grep -qi "mx.seznam.lab"; then
  printf 'PASS  I2: dig MX seznam.lab → mx.seznam.lab\n'
  PASS=$((PASS + 1))
else
  printf 'FAIL  I2: dig MX seznam.lab missing mx.seznam.lab\n' >&2
  FAIL=$((FAIL + 1))
fi

# ── I3: TXT seznam.lab contains v=spf1 ──────────────────────────────────────
I3_OUT=$(dns_drill "@127.0.0.1" seznam.lab TXT)
if echo "${I3_OUT}" | grep -q "v=spf1"; then
  printf 'PASS  I3: dig TXT seznam.lab contains "v=spf1"\n'
  PASS=$((PASS + 1))
else
  printf 'FAIL  I3: dig TXT seznam.lab missing "v=spf1"\n' >&2
  FAIL=$((FAIL + 1))
fi

# ── I4: TXT mail._domainkey.seznam.lab contains v=DKIM1 ──────────────────────
I4_OUT=$(dns_drill "@127.0.0.1" mail._domainkey.seznam.lab TXT)
if echo "${I4_OUT}" | grep -q "v=DKIM1"; then
  printf 'PASS  I4: dig TXT mail._domainkey.seznam.lab contains "v=DKIM1"\n'
  PASS=$((PASS + 1))
else
  printf 'FAIL  I4: dig TXT mail._domainkey.seznam.lab missing "v=DKIM1"\n' >&2
  FAIL=$((FAIL + 1))
fi

# ── I5: A imap.seznam.lab → 10.20.0.10 ──────────────────────────────────────
I5_OUT=$(dns_drill "@127.0.0.1" imap.seznam.lab A)
if echo "${I5_OUT}" | grep -q "10.20.0.10"; then
  printf 'PASS  I5: dig A imap.seznam.lab → 10.20.0.10\n'
  PASS=$((PASS + 1))
else
  printf 'FAIL  I5: dig A imap.seznam.lab did not return 10.20.0.10\n' >&2
  FAIL=$((FAIL + 1))
fi

# ── I6: A webmail.seznam.lab → 10.20.0.20 ────────────────────────────────────
I6_OUT=$(dns_drill "@127.0.0.1" webmail.seznam.lab A)
if echo "${I6_OUT}" | grep -q "10.20.0.20"; then
  printf 'PASS  I6: dig A webmail.seznam.lab → 10.20.0.20\n'
  PASS=$((PASS + 1))
else
  printf 'FAIL  I6: dig A webmail.seznam.lab did not return 10.20.0.20\n' >&2
  FAIL=$((FAIL + 1))
fi

# ── I7: A google.com → SERVFAIL (no upstream) ────────────────────────────────
I7_OUT=$(dns_drill "@127.0.0.1" google.com A 2>&1 || true)
if echo "${I7_OUT}" | grep -qi "SERVFAIL\|;; ERROR"; then
  printf 'PASS  I7: dig A google.com → SERVFAIL (no upstream — sealed)\n'
  PASS=$((PASS + 1))
else
  printf 'FAIL  I7: dig A google.com did not return SERVFAIL\n' >&2
  printf '      output: %s\n' "${I7_OUT}" >&2
  FAIL=$((FAIL + 1))
fi

# ── I8: A seznam.cz → SERVFAIL ───────────────────────────────────────────────
I8_OUT=$(dns_drill "@127.0.0.1" seznam.cz A 2>&1 || true)
if echo "${I8_OUT}" | grep -qi "SERVFAIL\|;; ERROR"; then
  printf 'PASS  I8: dig A seznam.cz → SERVFAIL (real domain blocked)\n'
  PASS=$((PASS + 1))
else
  printf 'FAIL  I8: dig A seznam.cz did not return SERVFAIL\n' >&2
  Fail=$((FAIL + 1))
fi

# ── I9: ANY . → no crash ────────────────────────────────────────────────────
I9_OUT=$(dns_exec drill "@127.0.0.1" . ANY 2>&1 || true)
# Acceptable outcomes: NOERROR, REFUSED, SERVFAIL — anything but a crash.
if [[ -n "${I9_OUT}" ]]; then
  printf 'PASS  I9: dig ANY . returns without crash\n'
  PASS=$((PASS + 1))
else
  printf 'FAIL  I9: dig ANY . returned empty output (possible crash)\n' >&2
  FAIL=$((FAIL + 1))
fi

# ── I10: resolver responds < 50ms ────────────────────────────────────────────
# Measure round-trip by timing drill inside container.
I10_START=$(date +%s%N)
dns_drill "@127.0.0.1" mx.seznam.lab A >/dev/null 2>&1
I10_END=$(date +%s%N)
I10_MS=$(( (I10_END - I10_START) / 1000000 ))
if [[ ${I10_MS} -lt 50 ]]; then
  printf 'PASS  I10: resolver responds in %dms (< 50ms)\n' "${I10_MS}"
  PASS=$((PASS + 1))
else
  printf 'FAIL  I10: resolver took %dms (>= 50ms)\n' "${I10_MS}" >&2
  FAIL=$((FAIL + 1))
fi

# ── I11: reverse PTR 10.20.0.10 → mx.seznam.lab ──────────────────────────────
I11_OUT=$(dns_drill "@127.0.0.1" -x 10.20.0.10 2>/dev/null || true)
if echo "${I11_OUT}" | grep -qi "mx.seznam.lab"; then
  printf 'PASS  I11: reverse PTR 10.20.0.10 → mx.seznam.lab\n'
  PASS=$((PASS + 1))
else
  printf 'FAIL  I11: reverse PTR 10.20.0.10 did not return mx.seznam.lab\n' >&2
  printf '      output: %s\n' "${I11_OUT}" >&2
  FAIL=$((FAIL + 1))
fi

# ── I12: container healthcheck passes ────────────────────────────────────────
I12_STATUS=$(docker inspect --format='{{.State.Health.Status}}' "${DNS_CONTAINER}" 2>/dev/null || echo "missing")
if [[ "${I12_STATUS}" == "healthy" ]]; then
  printf 'PASS  I12: mail-lab-dns container healthcheck → healthy\n'
  PASS=$((PASS + 1))
else
  printf 'FAIL  I12: mail-lab-dns healthcheck status: %s\n' "${I12_STATUS}" >&2
  FAIL=$((FAIL + 1))
fi

echo
echo "=== Results: PASS=${PASS}  FAIL=${FAIL}  SKIP=${SKIP} ==="

[[ ${FAIL} -eq 0 ]]
