#!/usr/bin/env bash
# test_ml1_4.sh — standalone assertions for ML1.4 DKIM key generation.
#
# Runs ALL non-container assertions without Docker/Postfix/Dovecot/unbound.
# Assertions that require a running mail stack are marked "# requires up-stack"
# and are printed as SKIP rather than FAIL.
#
# Usage:  bash scripts/mail-lab/test_ml1_4.sh
# Exit:   0 if all runnable assertions pass, 1 otherwise.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/../.." && pwd)"
INIT_DKIM="${SCRIPT_DIR}/init-dkim.sh"
DKIM_DIR="${REPO_ROOT}/infra/mail-lab/dkim"
UNBOUND_CONF="${REPO_ROOT}/infra/mail-lab/dns/unbound.conf"
OPENDKIM_DIR="${REPO_ROOT}/infra/mail-lab/postfix/opendkim"

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

assert_fail() {
  local desc="$1"
  shift
  if ! "$@" >/dev/null 2>&1; then
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
    printf 'FAIL  %s — pattern not found in %s: %s\n' "${desc}" "${path}" "${pattern}" >&2
    FAIL=$((FAIL + 1))
  fi
}

assert_mode() {
  local desc="$1"
  local path="$2"
  local expected_mode="$3"
  local actual
  actual=$(stat -f "%OLp" "${path}" 2>/dev/null || stat --format="%a" "${path}" 2>/dev/null || echo "unknown")
  if [[ "${actual}" == "${expected_mode}" ]]; then
    printf 'PASS  %s\n' "${desc}"
    PASS=$((PASS + 1))
  else
    printf 'FAIL  %s — expected mode %s, got %s\n' "${desc}" "${expected_mode}" "${actual}" >&2
    FAIL=$((FAIL + 1))
  fi
}

skip() {
  local desc="$1"
  printf 'SKIP  %s\n' "${desc}"
  SKIP=$((SKIP + 1))
}

echo "=== ML1.4 DKIM key generation tests ==="
echo

# ── Prerequisite: use a temp dir so we don't pollute existing keys ───────────
# For idempotency test we operate on the real DKIM_DIR but restore afterwards.

# ── A1: init-dkim.sh exits 0 for a single domain ───────────────────────────
# Use seznam.lab (keys already in repo → idempotent path).
assert_pass "A1: init-dkim.sh seznam.lab exits 0" \
  bash "${INIT_DKIM}" seznam.lab

# ── A2: mail.private exists for seznam.lab ──────────────────────────────────
assert_file_exists "A2: infra/mail-lab/dkim/seznam.lab/mail.private exists" \
  "${DKIM_DIR}/seznam.lab/mail.private"

# ── A3: mail.private mode is 0600 ───────────────────────────────────────────
assert_mode "A3: mail.private has mode 0600" \
  "${DKIM_DIR}/seznam.lab/mail.private" "600"

# ── A4: mail.txt exists ──────────────────────────────────────────────────────
assert_file_exists "A4: infra/mail-lab/dkim/seznam.lab/mail.txt exists" \
  "${DKIM_DIR}/seznam.lab/mail.txt"

# ── A5: mail.txt contains v=DKIM1 ───────────────────────────────────────────
assert_file_contains "A5: mail.txt contains 'v=DKIM1'" \
  "${DKIM_DIR}/seznam.lab/mail.txt" "v=DKIM1"

# ── A6: mail.private is a valid RSA private key ─────────────────────────────
assert_pass "A6: mail.private passes openssl rsa -check" \
  openssl rsa -check -in "${DKIM_DIR}/seznam.lab/mail.private" -noout

# ── A7: key is 2048-bit (not 1024-bit weak) ─────────────────────────────────
KEY_BITS="$(openssl rsa -in "${DKIM_DIR}/seznam.lab/mail.private" -noout -text 2>/dev/null \
  | grep -oE '[0-9]+ bit' | grep -oE '[0-9]+')"
if [[ "${KEY_BITS}" == "2048" ]]; then
  printf 'PASS  A7: key is 2048-bit\n'
  PASS=$((PASS + 1))
else
  printf 'FAIL  A7: expected 2048-bit, got %s\n' "${KEY_BITS}" >&2
  FAIL=$((FAIL + 1))
fi

# ── A8: public key in mail.txt matches private key in mail.private ───────────
# Strategy: derive pubkey from private key, compare with p= value in mail.txt.
# Extract from the single-line comment ("; local-data: ...") which has the full
# unsplit key — it's the last grep match, or use the longest p= hit.
PRIV_PUBKEY="$(openssl rsa -in "${DKIM_DIR}/seznam.lab/mail.private" \
  -pubout -outform DER 2>/dev/null | base64 | tr -d '\n')"
# Get the longest p= match (the full single-line key from the comment line).
TXT_PUBKEY="$(grep -oE 'p=[A-Za-z0-9+/=]+' "${DKIM_DIR}/seznam.lab/mail.txt" \
  | awk '{ if (length > max) { max=length; val=$0 } } END { print val }' \
  | sed 's/p=//')"

if [[ "${PRIV_PUBKEY}" == "${TXT_PUBKEY}" ]]; then
  printf 'PASS  A8: public key in mail.txt matches mail.private\n'
  PASS=$((PASS + 1))
else
  printf 'FAIL  A8: public key mismatch between mail.txt and mail.private\n' >&2
  printf '       priv_pubkey: %.60s...\n' "${PRIV_PUBKEY}" >&2
  printf '       txt_pubkey:  %.60s...\n' "${TXT_PUBKEY}" >&2
  FAIL=$((FAIL + 1))
fi

# ── A9: selector in mail.txt is "mail" ───────────────────────────────────────
assert_file_contains "A9: mail.txt selector is 'mail._domainkey'" \
  "${DKIM_DIR}/seznam.lab/mail.txt" "mail._domainkey"

# ── A10: idempotency — second run for seznam.lab does not regenerate key ─────
MTIME_BEFORE="$(stat -f "%m" "${DKIM_DIR}/seznam.lab/mail.private" 2>/dev/null \
  || stat --format="%Y" "${DKIM_DIR}/seznam.lab/mail.private" 2>/dev/null)"
bash "${INIT_DKIM}" seznam.lab >/dev/null 2>&1
MTIME_AFTER="$(stat -f "%m" "${DKIM_DIR}/seznam.lab/mail.private" 2>/dev/null \
  || stat --format="%Y" "${DKIM_DIR}/seznam.lab/mail.private" 2>/dev/null)"
if [[ "${MTIME_BEFORE}" == "${MTIME_AFTER}" ]]; then
  printf 'PASS  A10: idempotent — second run does not modify mail.private\n'
  PASS=$((PASS + 1))
else
  printf 'FAIL  A10: mail.private mtime changed on second run (key was regenerated)\n' >&2
  FAIL=$((FAIL + 1))
fi

# ── A11: multi-domain — gmail.lab and seznam.lab keys exist and differ ────────
assert_pass "A11a: init-dkim.sh seznam.lab gmail.lab exits 0" \
  bash "${INIT_DKIM}" seznam.lab gmail.lab

assert_file_exists "A11b: infra/mail-lab/dkim/gmail.lab/mail.private exists" \
  "${DKIM_DIR}/gmail.lab/mail.private"

SEZNAM_PUB="$(openssl rsa -in "${DKIM_DIR}/seznam.lab/mail.private" \
  -pubout -outform DER 2>/dev/null | base64 | tr -d '\n')"
GMAIL_PUB="$(openssl rsa -in "${DKIM_DIR}/gmail.lab/mail.private" \
  -pubout -outform DER 2>/dev/null | base64 | tr -d '\n')"
if [[ "${SEZNAM_PUB}" != "${GMAIL_PUB}" ]]; then
  printf 'PASS  A11c: seznam.lab and gmail.lab keys are distinct\n'
  PASS=$((PASS + 1))
else
  printf 'FAIL  A11c: seznam.lab and gmail.lab have identical keys\n' >&2
  FAIL=$((FAIL + 1))
fi

# ── A12: unbound.conf contains real key (not PLACEHOLDER) for seznam.lab ─────
if [[ -f "${UNBOUND_CONF}" ]]; then
  if grep -qF "mail._domainkey.seznam.lab" "${UNBOUND_CONF}"; then
    if grep "mail._domainkey.seznam.lab" "${UNBOUND_CONF}" | grep -qF "PLACEHOLDER"; then
      printf 'FAIL  A12: unbound.conf still has PLACEHOLDER for seznam.lab\n' >&2
      FAIL=$((FAIL + 1))
    else
      printf 'PASS  A12: unbound.conf has real DKIM key for seznam.lab (no PLACEHOLDER)\n'
      PASS=$((PASS + 1))
    fi
  else
    printf 'FAIL  A12: unbound.conf missing entry for mail._domainkey.seznam.lab\n' >&2
    FAIL=$((FAIL + 1))
  fi
else
  skip "A12: unbound.conf not found — skipping DNS check"
fi

# ── A13: keytable and signingtable exist under postfix/opendkim/ ─────────────
assert_file_exists "A13a: infra/mail-lab/postfix/opendkim/keytable exists" \
  "${OPENDKIM_DIR}/keytable"

assert_file_exists "A13b: infra/mail-lab/postfix/opendkim/signingtable exists" \
  "${OPENDKIM_DIR}/signingtable"

# ── A14: keytable contains seznam.lab entry ──────────────────────────────────
assert_file_contains "A14: keytable contains seznam.lab" \
  "${OPENDKIM_DIR}/keytable" "seznam.lab"

# ── A15: signingtable contains *@seznam.lab ──────────────────────────────────
assert_file_contains "A15: signingtable contains *@seznam.lab" \
  "${OPENDKIM_DIR}/signingtable" "*@seznam.lab"

# ── Assertions requiring running containers (skipped in standalone mode) ──────
skip "A16: opendkim-testkey pass (# requires up-stack)"
skip "A17: send mail via SMTP, fetch from Dovecot, verify dkim=pass (# requires up-stack)"
skip "A18: DNS query via unbound resolves DKIM TXT (# requires up-stack)"

echo
echo "=== Results: PASS=${PASS}  FAIL=${FAIL}  SKIP=${SKIP} ==="

[[ ${FAIL} -eq 0 ]]
