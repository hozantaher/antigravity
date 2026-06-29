#!/usr/bin/env bash
# ADR auto-suggest — per north-star aspirace #8.
#
# Scans a PR diff for architectural patterns that historically warrant an
# ADR (per docs/decisions/README.md). When triggered, prints comment-ready
# markdown with a fill-in-the-blank ADR template snippet.
#
# Heuristics (see classify_signals below):
#   H1. New service directory — `services/<new>/` appears in diff
#   H2. New ADR-keyword commit — "design", "architecture", "ADR" in commit
#       message subject, OR explicit `Decision:` body trailer.
#   H3. New schema migration — `scripts/migrations/NNN_*.sql` added
#   H4. New top-level package — `packages/<new>/` or `modules/<new>/`
#   H5. Breaking-contract trailer — `Breaks-Contract:` trailer present
#   H6. Auth / security file added — new file under
#       `services/*/internal/auth/` or `services/*/internal/security/`
#   H7. Boot env-config schema added — `envconfig.Required(` introduced in
#       a new `cmd/<svc>/main.go`
#   H8. New CI workflow — `.github/workflows/<new>.yml` added
#
# Output:
#   stdout: comment-ready markdown (PR comment payload).
#   exit 0 = no architectural pattern detected (no comment).
#   exit 10 = pattern detected; comment payload printed on stdout.
#   exit 1+ = error (missing tools, etc.).
#
# Usage:
#   bash scripts/audit/adr-suggest.sh                # diff vs origin/main
#   bash scripts/audit/adr-suggest.sh --base main    # explicit base
#   bash scripts/audit/adr-suggest.sh --range A..B   # explicit range
#   bash scripts/audit/adr-suggest.sh --pr 442       # gh pr view + diff
#
# Reference:
#   .github/workflows/adr-auto-suggest.yml — CI invocation
#   docs/decisions/README.md — ADR format
#   docs/playbooks/adr-auto-suggest.md — operator runbook
#   project_autonomous_dev_north_star aspirace #8

set -euo pipefail

# ---- args ----------------------------------------------------------------

BASE="origin/main"
RANGE=""
PR_NUMBER=""

while [[ $# -gt 0 ]]; do
  case "$1" in
    --base)
      shift
      BASE="$1"
      shift
      ;;
    --range)
      shift
      RANGE="$1"
      shift
      ;;
    --pr)
      shift
      PR_NUMBER="$1"
      shift
      ;;
    -h|--help)
      sed -n '2,33p' "$0"
      exit 0
      ;;
    *)
      echo "unknown arg: $1" >&2
      exit 64
      ;;
  esac
done

# ---- gather diff inputs --------------------------------------------------

# CHANGED_FILES — newline-separated list of paths in the diff (added/modified).
# COMMIT_MSGS — concatenated commit subjects + bodies in the range.
# DIFF_BODY — full unified diff (used for content-pattern matches).
CHANGED_FILES=""
COMMIT_MSGS=""
DIFF_BODY=""

if [[ -n "$PR_NUMBER" ]]; then
  if ! command -v gh >/dev/null 2>&1; then
    echo "gh required for --pr mode" >&2
    exit 2
  fi
  CHANGED_FILES=$(gh pr diff "$PR_NUMBER" --name-only 2>/dev/null || true)
  COMMIT_MSGS=$(gh pr view "$PR_NUMBER" --json commits 2>/dev/null \
    | jq -r '.commits[].messageHeadline + "\n" + (.commits[].messageBody // "")' \
    2>/dev/null || true)
  DIFF_BODY=$(gh pr diff "$PR_NUMBER" 2>/dev/null || true)
else
  if [[ -n "$RANGE" ]]; then
    REF="$RANGE"
  else
    REF="${BASE}...HEAD"
  fi
  CHANGED_FILES=$(git diff --name-only "$REF" 2>/dev/null || true)
  COMMIT_MSGS=$(git log --format='%s%n%b' "$REF" 2>/dev/null || true)
  DIFF_BODY=$(git diff "$REF" 2>/dev/null || true)
fi

if [[ -z "$CHANGED_FILES" ]]; then
  echo "no changes in range" >&2
  exit 0
fi

# ---- heuristics ----------------------------------------------------------

# Each detector echoes a triggered-signal token (one per line) when it fires.
# The aggregator collects them and renders a single comment.

detect_h1_new_service() {
  # New `services/<new>/` directory: a top-level dir under services/ that
  # didn't previously exist. Heuristic: at least one *new* file path matches
  # `services/<name>/...` AND `git ls-tree origin/main` does not contain
  # that directory.
  local hits=""
  while IFS= read -r path; do
    [[ -z "$path" ]] && continue
    [[ "$path" =~ ^services/([^/]+)/ ]] || continue
    local svc="${BASH_REMATCH[1]}"
    # Check if dir existed on base.
    if ! git ls-tree -d --name-only "$BASE" "services/${svc}" >/dev/null 2>&1; then
      hits+="services/${svc}\n"
    fi
  done <<< "$CHANGED_FILES"
  printf '%b' "$hits" | sort -u
}

detect_h2_adr_keyword_commit() {
  # Commit subject/body contains "design", "architecture", "ADR", or
  # explicit `Decision:` trailer. Case-insensitive.
  if echo "$COMMIT_MSGS" | grep -qiE '\b(design|architecture|adr-?[0-9]+|decision:)\b'; then
    echo "adr-keyword-commit"
  fi
}

detect_h3_new_migration() {
  # New `scripts/migrations/NNN_*.sql` file added.
  echo "$CHANGED_FILES" | grep -E '^scripts/migrations/[0-9]+_.*\.sql$' || true
}

detect_h4_new_package() {
  # New top-level dir under packages/ or modules/.
  local hits=""
  while IFS= read -r path; do
    [[ -z "$path" ]] && continue
    [[ "$path" =~ ^(packages|modules)/([^/]+)/ ]] || continue
    local root="${BASH_REMATCH[1]}"
    local name="${BASH_REMATCH[2]}"
    if ! git ls-tree -d --name-only "$BASE" "${root}/${name}" >/dev/null 2>&1; then
      hits+="${root}/${name}\n"
    fi
  done <<< "$CHANGED_FILES"
  printf '%b' "$hits" | sort -u
}

detect_h5_breaks_contract() {
  # `Breaks-Contract:` trailer in any commit body.
  if echo "$COMMIT_MSGS" | grep -qE '^Breaks-Contract:'; then
    echo "breaks-contract"
  fi
}

detect_h6_auth_security_file() {
  # New file path under services/*/internal/{auth,security}/.
  local hits=""
  while IFS= read -r path; do
    [[ "$path" =~ ^services/[^/]+/internal/(auth|security)/ ]] || continue
    # Was the file present on base?
    if ! git cat-file -e "${BASE}:${path}" 2>/dev/null; then
      hits+="${path}\n"
    fi
  done <<< "$CHANGED_FILES"
  printf '%b' "$hits" | sort -u
}

detect_h7_envconfig_required() {
  # `envconfig.Required(` introduced in a new cmd/<svc>/main.go.
  # Look for "+envconfig.Required(" added lines in cmd/*/main.go diffs.
  local hits=""
  while IFS= read -r path; do
    [[ "$path" =~ /cmd/[^/]+/main\.go$ ]] || continue
    # Was there an addition of envconfig.Required( in this file's diff?
    if echo "$DIFF_BODY" | grep -E "^\+.*envconfig\.Required\(" \
        | grep -q "" 2>/dev/null; then
      hits+="${path}\n"
    fi
  done <<< "$CHANGED_FILES"
  printf '%b' "$hits" | sort -u
}

detect_h8_new_workflow() {
  # New CI workflow file.
  local hits=""
  while IFS= read -r path; do
    [[ "$path" =~ ^\.github/workflows/.*\.ya?ml$ ]] || continue
    if ! git cat-file -e "${BASE}:${path}" 2>/dev/null; then
      hits+="${path}\n"
    fi
  done <<< "$CHANGED_FILES"
  printf '%b' "$hits" | sort -u
}

# ---- aggregate -----------------------------------------------------------

H1=$(detect_h1_new_service || true)
H2=$(detect_h2_adr_keyword_commit || true)
H3=$(detect_h3_new_migration || true)
H4=$(detect_h4_new_package || true)
H5=$(detect_h5_breaks_contract || true)
H6=$(detect_h6_auth_security_file || true)
H7=$(detect_h7_envconfig_required || true)
H8=$(detect_h8_new_workflow || true)

TRIGGERED=()
[[ -n "$H1" ]] && TRIGGERED+=("H1: new service directory")
[[ -n "$H2" ]] && TRIGGERED+=("H2: ADR-keyword commit message")
[[ -n "$H3" ]] && TRIGGERED+=("H3: new schema migration")
[[ -n "$H4" ]] && TRIGGERED+=("H4: new top-level package or module")
[[ -n "$H5" ]] && TRIGGERED+=("H5: Breaks-Contract trailer")
[[ -n "$H6" ]] && TRIGGERED+=("H6: auth/security file added")
[[ -n "$H7" ]] && TRIGGERED+=("H7: envconfig.Required schema in new cmd/main.go")
[[ -n "$H8" ]] && TRIGGERED+=("H8: new CI workflow")

if [[ ${#TRIGGERED[@]} -eq 0 ]]; then
  exit 0
fi

# ---- next ADR number -----------------------------------------------------

next_adr_number() {
  local highest=0
  while IFS= read -r f; do
    [[ "$f" =~ ADR-([0-9]+)- ]] || continue
    local n=$((10#${BASH_REMATCH[1]}))
    (( n > highest )) && highest="$n"
  done < <(find docs/decisions -maxdepth 1 -name 'ADR-*.md' -type f 2>/dev/null)
  printf 'ADR-%03d' $((highest + 1))
}

NEXT_ADR=$(next_adr_number)

# ---- render comment ------------------------------------------------------

cat <<EOF
## Architectural pattern detected — consider adding an ADR

This PR matches one or more heuristics that historically warrant an
[Architecture Decision Record](../tree/main/docs/decisions). Reviewer +
author should answer: **is this a long-lived architectural choice that a
future maintainer will need context on?**

### Triggered heuristics

EOF
for sig in "${TRIGGERED[@]}"; do
  echo "- ${sig}"
done

cat <<'EOF'

### Detected paths

EOF

[[ -n "$H1" ]] && { echo "- New service directories:"; printf '  - %s\n' $H1; }
[[ -n "$H3" ]] && { echo "- New migrations:"; printf '  - %s\n' $H3; }
[[ -n "$H4" ]] && { echo "- New packages/modules:"; printf '  - %s\n' $H4; }
[[ -n "$H6" ]] && { echo "- Auth/security files:"; printf '  - %s\n' $H6; }
[[ -n "$H7" ]] && { echo "- Boot env-config schemas:"; printf '  - %s\n' $H7; }
[[ -n "$H8" ]] && { echo "- New workflows:"; printf '  - %s\n' $H8; }

cat <<EOF

### Suggested ADR template

Save as \`docs/decisions/${NEXT_ADR}-<slug>.md\`:

\`\`\`markdown
# ${NEXT_ADR} — <Title>

**Status:** Proposed
**Date:** $(date -u +%Y-%m-%d)
**Supersedes:** —

## Kontext

Co řešíme, proč teď, jaké síly působí.

## Rozhodnutí

Jedna věta: "Zavádíme X."

## Důsledky

- Pozitivní: ...
- Negativní: ...
- Neutrální: ...

## Alternativy zvažované

- Alt 1 — proč ne
- Alt 2 — proč ne
\`\`\`

### Skip if not architectural

If this PR is a refactor, bug fix, or library swap inside a single module,
no ADR is needed — see \`docs/decisions/README.md\` ("Kdy NE psát ADR").
Reply with \`/skip-adr <reason>\` to acknowledge.

---

_Auto-generated by \`scripts/audit/adr-suggest.sh\` via
\`.github/workflows/adr-auto-suggest.yml\`. Heuristic; not a merge gate._
EOF

exit 10
