#!/usr/bin/env bash
# classify-task-tier.test.sh — bash test runner pro classifier
#
# Per memory rule `feedback_extreme_testing` — ≥10 cases per change;
# tady ≥20 covering: chore prefix, docs prefix variants, test prefix
# variants, feat/sec/perf, override keywords (cleanup, security, wire,
# crypto, lock), opus triggers, edge cases (empty input, unknown prefix,
# stdin vs argument), fix(test) vs fix(modul) split.
#
# Usage:
#   bash scripts/agent-fleet/classify-task-tier.test.sh
#
# Exit codes:
#   0  all assertions passed
#   1  one or more failed

set -u

SCRIPT_DIR=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
CLASSIFY="$SCRIPT_DIR/classify-task-tier.sh"

if [ ! -x "$CLASSIFY" ]; then
  printf '[test] classifier není executable: %s\n' "$CLASSIFY" >&2
  exit 1
fi

PASS=0
FAIL=0
FAIL_DETAIL=""

# Assert: classifier(input) == expected_tier && exit_code == expected_rc.
# $1=name $2=input $3=expected_tier ("" pokud expect non-zero exit) $4=expected_rc
assert_classify() {
  local name=$1
  local input=$2
  local expected_tier=$3
  local expected_rc=$4

  local got
  local rc
  got=$(printf '%s' "$input" | "$CLASSIFY" 2>/dev/null)
  rc=$?

  if [ "$rc" = "$expected_rc" ] && [ "$got" = "$expected_tier" ]; then
    PASS=$((PASS+1))
    printf '  PASS  %s\n' "$name"
  else
    FAIL=$((FAIL+1))
    FAIL_DETAIL="$FAIL_DETAIL\n  FAIL  $name: input='$input' expected_tier='$expected_tier' rc=$expected_rc; got_tier='$got' rc=$rc"
    printf '  FAIL  %s — input=%q expected=(tier=%s rc=%d) got=(tier=%s rc=%d)\n' \
      "$name" "$input" "$expected_tier" "$expected_rc" "$got" "$rc"
  fi
}

printf '== classify-task-tier tests ==\n'

# --- Prefix-based defaults (chore/docs/test/fix/feat/perf/sec/refactor/ci) -

assert_classify "chore(deps) → haiku"                   "chore(deps): bump vite to 7.3.2"                  haiku  0
assert_classify "chore(adr) rename → haiku"             "chore(adr): rename ADR-001 to ADR-007"            haiku  0
assert_classify "chore(scripts) → haiku"                "chore(scripts): tidy up coverage helpers"         haiku  0
assert_classify "docs(initiatives) → haiku"             "docs(initiatives): status header batch"           haiku  0
assert_classify "docs(adr) → sonnet (design)"           "docs(adr): ADR-008 outreach gate redesign"        sonnet 0
assert_classify "docs(strategy) → sonnet (vision)"      "docs(strategy): autonomous dev north star"        sonnet 0
assert_classify "test(contract) → haiku"                "test(contract): snapshot adjustment for /v1/foo"  haiku  0
assert_classify "test(audit) → haiku"                   "test(audit): bump slog ratchet baseline"          haiku  0
assert_classify "test(unit) → haiku (default)"          "test(unit): coverage for parsePrefix"             haiku  0
assert_classify "test(integration) → sonnet"            "test(integration): Postgres + relay round-trip"   sonnet 0
assert_classify "test(e2e) → sonnet"                    "test(e2e): Playwright operator approval flow"     sonnet 0
assert_classify "fix(test) → haiku"                     "fix(test): repair flaky retry helper"             haiku  0
assert_classify "fix(sender) → sonnet (production)"     "fix(sender): handle 421 throttle response"        sonnet 0
assert_classify "feat(bff) → sonnet"                    "feat(bff): wire reply approval endpoint"          sonnet 0
assert_classify "perf(sender) → sonnet"                 "perf(sender): batch SMTP flush"                   sonnet 0
assert_classify "sec(privacy) → sonnet"                 "sec(privacy): enforce HMAC on relay handshake"    sonnet 0
assert_classify "ci(workflow) → haiku"                  "ci(workflow): cache pnpm store"                   haiku  0
assert_classify "audit(inventory) → haiku default"      "audit(inventory): scan dead code in services/"    haiku  0
assert_classify "refactor default → sonnet"             "refactor(api): split contacts package"            sonnet 0

# --- Override keywords (haiku triggers) ---------------------------------

assert_classify "cleanup keyword overrides feat"        "feat(sender): cleanup duplicate enforce gate"     haiku  0
assert_classify "drift keyword overrides docs"          "docs(claude): fix CLAUDE.md drift"                haiku  0
assert_classify "sweep keyword overrides refactor"      "refactor(slog): audit sweep across services"      haiku  0
assert_classify "rebaseline overrides test"             "test(unit): rebaseline mutation snapshots"        haiku  0
assert_classify "lint overrides chore"                  "chore(repo): lint shell scripts"                  haiku  0

# --- Override keywords (sonnet triggers) --------------------------------

assert_classify "wire keyword overrides chore"          "chore(infra): wire telemetry pipeline"            sonnet 0
assert_classify "security keyword overrides docs"       "docs(playbooks): security incident response"     sonnet 0
assert_classify "crypto keyword overrides chore"        "chore(deps): bump crypto library"                 sonnet 0
assert_classify "lock keyword overrides fix(test)"      "fix(test): lock contention in race harness"      sonnet 0
assert_classify "auth keyword overrides chore"          "chore(scripts): rotate auth tokens"               sonnet 0

# --- Opus triggers (rare) -----------------------------------------------

assert_classify "monolith split → opus"                 "refactor(arch): monolith split for outreach"      opus   0
assert_classify "architectural revision → opus"         "feat(arch): architectural revision of relay"      opus   0

# --- Edge cases ---------------------------------------------------------

assert_classify "empty input → exit 1"                  ""                                                 ""     1
assert_classify "unknown prefix → exit 1"               "wat(foo): random text without known prefix"       ""     1
assert_classify "no prefix structure → exit 1"          "just some random text"                            ""     1

# --- Argument-mode invocation (covers stdin path implicitly above) -----

GOT=$("$CLASSIFY" "feat(bff): wire something" 2>/dev/null)
if [ "$GOT" = "sonnet" ]; then
  PASS=$((PASS+1))
  printf '  PASS  argv-mode invocation\n'
else
  FAIL=$((FAIL+1))
  printf '  FAIL  argv-mode invocation: got=%s\n' "$GOT"
fi

# --- Multi-word arg (bash splits into multiple positionals) -------------

GOT=$("$CLASSIFY" chore deps bump vite 2>/dev/null)
# "chore deps bump vite" — no colon — falls through to unknown prefix path.
if [ -z "$GOT" ]; then
  PASS=$((PASS+1))
  printf '  PASS  multi-word no-colon → unable to classify\n'
else
  FAIL=$((FAIL+1))
  printf '  FAIL  multi-word no-colon: got=%s\n' "$GOT"
fi

# --- Help flag returns exit 2 -------------------------------------------

set +e
"$CLASSIFY" --help >/dev/null 2>&1
RC=$?
set -e 2>/dev/null || true
if [ "$RC" = 2 ]; then
  PASS=$((PASS+1))
  printf '  PASS  --help exits 2\n'
else
  FAIL=$((FAIL+1))
  printf '  FAIL  --help exit code: got=%d\n' "$RC"
fi

# --- Summary ------------------------------------------------------------

printf '\n=== SUMMARY === pass=%d fail=%d total=%d\n' "$PASS" "$FAIL" "$((PASS+FAIL))"

if [ "$FAIL" -gt 0 ]; then
  printf '\nFAILURES:%b\n' "$FAIL_DETAIL"
  exit 1
fi
exit 0
