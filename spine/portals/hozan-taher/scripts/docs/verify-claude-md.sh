#!/usr/bin/env bash
# scripts/docs/verify-claude-md.sh
#
# Verify that all file path references in CLAUDE.md files exist on disk.
#
# Walks every **/CLAUDE.md in repo (root + apps/*/CLAUDE.md + services/*/CLAUDE.md).
# Extracts file path references from:
#   - Markdown links: [text](features/outreach/campaigns/sender/engine.go)
#   - Inline backticks: `features/outreach/campaigns/sender/engine.go`
#   - Code fence blocks (are NOT checked — treated as examples)
#
# For each reference, verifies the file exists on disk.
# Outputs: "VERIFIED: N references valid" OR "BROKEN: <file>:<line>: <path> does not exist"
#
# Heuristics to avoid false positives:
#   - Only check paths that start with services/, apps/, scripts/, docs/, modules/, .claude/, or end with .md
#   - Strip leading ./ and trailing punctuation (,,;:.).)
#   - Skip URLs (http://, https://, ftp://)
#   - Skip paths inside code fences (```)
#
# Exit codes:
#   0 — all references valid
#   1 — broken reference found
#   2 — no CLAUDE.md files found
#
# Usage:
#   bash scripts/docs/verify-claude-md.sh
#   REPO_ROOT=/path/to/repo bash scripts/docs/verify-claude-md.sh

set -euo pipefail

REPO_ROOT="${REPO_ROOT:-.}"
VERBOSE="${VERBOSE:-0}"

# Ensure repo root exists
if [ ! -d "$REPO_ROOT" ]; then
  echo "ERROR: REPO_ROOT '$REPO_ROOT' does not exist"
  exit 1
fi

cd "$REPO_ROOT"

broken_count=0
valid_count=0
found_any=0

# Find all CLAUDE.md files (excluding .claude/worktrees which are ephemeral)
while IFS= read -r claude_file; do
  [ -e "$claude_file" ] || continue
  # Skip worktree directories (ephemeral)
  if [[ "$claude_file" =~ \.claude/worktrees ]]; then
    continue
  fi
  found_any=1

  if [ "$VERBOSE" -eq 1 ]; then
    echo "Checking: $claude_file"
  fi

  # Read file line by line
  line_num=0
  in_code_fence=0

  while IFS= read -r line; do
    line_num=$((line_num + 1))

    # Track code fence state
    if [[ "$line" =~ ^'```' ]]; then
      in_code_fence=$((1 - in_code_fence))
      continue
    fi

    # Skip lines inside code fences
    if [ "$in_code_fence" -eq 1 ]; then
      continue
    fi

    # Extract paths from markdown links: [text](path)
    # Match: ](...)
    while [[ "$line" =~ \]\(([^\)]+)\) ]]; do
      path="${BASH_REMATCH[1]}"
      line="${line#*"${BASH_REMATCH[0]}"}"

      # Extract just the path part (skip anchor/query params)
      path_only=$(echo "$path" | cut -d'#' -f1 | cut -d'?' -f1)

      # Check if it looks like a file path (not a URL)
      if [[ "$path_only" =~ ^http:// ]] || [[ "$path_only" =~ ^https:// ]] || [[ "$path_only" =~ ^ftp:// ]]; then
        continue
      fi

      # Strip leading ./
      path_only="${path_only#./}"

      # Check if path should be verified (heuristic)
      if [[ "$path_only" =~ ^(services|apps|scripts|docs|modules|\.claude)/ ]] || [[ "$path_only" =~ \.md$ ]]; then
        # Strip trailing punctuation
        path_only="${path_only%[,;:.)]}"

        # Check if file exists
        if [ ! -e "$path_only" ]; then
          echo "BROKEN: $claude_file:$line_num: $path_only does not exist"
          broken_count=$((broken_count + 1))
        else
          valid_count=$((valid_count + 1))
        fi
      fi
    done

    # Extract paths from inline backticks: `path/to/file.ext`
    # This is more lenient — only match if looks like a path
    while [[ "$line" =~ \`([^\`]+)\` ]]; do
      path="${BASH_REMATCH[1]}"
      line="${line#*"${BASH_REMATCH[0]}"}"

      # Only check if looks like a file path
      if [[ "$path" =~ ^(services|apps|scripts|docs|modules|\.claude)/ ]] || [[ "$path" =~ \.go$ ]] || [[ "$path" =~ \.ts$ ]] || [[ "$path" =~ \.js$ ]] || [[ "$path" =~ \.md$ ]] || [[ "$path" =~ \.sh$ ]]; then
        # Skip URLs
        if [[ "$path" =~ ^http:// ]] || [[ "$path" =~ ^https:// ]]; then
          continue
        fi

        # Strip leading ./
        path="${path#./}"

        # Check if file exists
        if [ ! -e "$path" ]; then
          echo "BROKEN: $claude_file:$line_num: $path does not exist"
          broken_count=$((broken_count + 1))
        else
          valid_count=$((valid_count + 1))
        fi
      fi
    done
  done < "$claude_file"
done < <(find . -name "CLAUDE.md" -type f 2>/dev/null | sort)

if [ "$found_any" -eq 0 ]; then
  echo "ERROR: No CLAUDE.md files found in $REPO_ROOT"
  exit 2
fi

if [ "$broken_count" -gt 0 ]; then
  echo ""
  echo "VERIFICATION FAILED: $broken_count broken reference(s), $valid_count valid"
  exit 1
fi

echo "VERIFIED: $valid_count references valid (0 broken)"
exit 0
