#!/bin/bash
#
# envconfig-count.sh — Authoritative os.Getenv violation counter
#
# Scans services/*/*.go (recursively) for bare os.Getenv calls, excluding:
#   - *_test.go files
#   - features/platform/common/envconfig/ (package itself)
#   - Lines marked with `// envconfig-allowed: <reason>` comment
#
# METHODOLOGY:
#   1. Find all .go files in services/ (not tests, not envconfig pkg itself)
#   2. For each file, grep for os.Getenv pattern
#   3. Cross-check against comment annotations (lines above/same-line)
#   4. Count violations as single authoritative baseline
#
# Output modes:
#   --total         Include *_test.go files (for CI/pre-merge visibility)
#   --per-package   Show top 10 packages by violation count
#   (default)       Count non-test violations only
#
# Exit code: 0 (success), 1 (CLI error)

set -e

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
SERVICES_ROOT="${REPO_ROOT}/services"

if [[ ! -d "$SERVICES_ROOT" ]]; then
  echo "ERROR: services/ not found at $SERVICES_ROOT" >&2
  exit 1
fi

MODE="default"
INCLUDE_TESTS=0

while [[ $# -gt 0 ]]; do
  case "$1" in
    --total)
      INCLUDE_TESTS=1
      shift
      ;;
    --per-package)
      MODE="per-package"
      shift
      ;;
    --help)
      cat <<EOF
usage: envconfig-count.sh [--total] [--per-package]

Counts bare os.Getenv calls in services/*/*.go (non-test by default).

Options:
  --total         Include *_test.go files in count
  --per-package   Show top 10 packages by violation count instead of total

Default: Print total violation count (non-test files only).
EOF
      exit 0
      ;;
    *)
      echo "ERROR: unknown option '$1'" >&2
      exit 1
      ;;
  esac
done

# Temporary files for caching
TMP_VIOLATIONS=$(mktemp)
TMP_ANNOTATIONS=$(mktemp)
trap "rm -f $TMP_VIOLATIONS $TMP_ANNOTATIONS" EXIT

# Step 1: Find all potential .go files
# Exclude vendor, .git, node_modules, and optionally *_test.go
find_go_files() {
  if [[ $INCLUDE_TESTS -eq 1 ]]; then
    find "$SERVICES_ROOT" \
      -type f -name "*.go" \
      ! -path "*/vendor/*" \
      ! -path "*/.git/*" \
      ! -path "*/node_modules/*" \
      ! -path "*/common/envconfig/*"
  else
    find "$SERVICES_ROOT" \
      -type f -name "*.go" \
      ! -path "*/vendor/*" \
      ! -path "*/.git/*" \
      ! -path "*/node_modules/*" \
      ! -path "*/common/envconfig/*" \
      ! -name "*_test.go"
  fi
}

# Step 2: For each file, find os.Getenv calls and their line numbers
# Format: file:line:call
# Exclude lines that are comments (// or /* */)
extract_violations() {
  local file="$1"
  grep -n "os\.Getenv" "$file" 2>/dev/null | grep -v "^\s*//\|^\s*/\*" | grep -v "^\s*\*" || true
}

# Step 3: Check if a line has envconfig-allowed annotation
# Annotations can be:
#   - Same line trailing: ... // envconfig-allowed: reason
#   - 1-3 lines above: // envconfig-allowed: reason
has_allowed_annotation() {
  local file="$1"
  local line="$2"

  # Check same line
  if sed -n "${line}p" "$file" | grep -q "envconfig-allowed"; then
    return 0
  fi

  # Check 1-3 lines above
  for delta in 1 2 3; do
    check_line=$((line - delta))
    if [[ $check_line -gt 0 ]]; then
      if sed -n "${check_line}p" "$file" | grep -q "envconfig-allowed"; then
        return 0
      fi
    fi
  done

  return 1
}

# Main scan
echo "Scanning $SERVICES_ROOT for os.Getenv violations..." >&2

while IFS= read -r file; do
  while IFS=: read -r line_num rest; do
    if [[ -z "$line_num" ]]; then continue; fi

    if ! has_allowed_annotation "$file" "$line_num"; then
      # Normalize to relative path
      rel_path="${file#$SERVICES_ROOT/}"
      echo "$rel_path:$line_num"
    fi
  done < <(extract_violations "$file")
done < <(find_go_files) | sort > "$TMP_VIOLATIONS"

# Count violations
total_violations=$(wc -l < "$TMP_VIOLATIONS")

if [[ "$MODE" == "per-package" ]]; then
  # Extract package (first component after services/)
  # Format: services/PKG/SUBPKG/file.go:line → group by PKG/SUBPKG
  cut -d: -f1 "$TMP_VIOLATIONS" | sed 's|^[^/]*/||' | sed 's|/[^/]*$||' | sort | uniq -c | sort -rn | head -10 | \
    awk '{printf "%-40s %3d violations\n", $2, $1}'
else
  echo "$total_violations"
fi
