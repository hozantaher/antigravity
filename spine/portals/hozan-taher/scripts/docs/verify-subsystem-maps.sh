#!/usr/bin/env bash
# scripts/docs/verify-subsystem-maps.sh
#
# Verify that file path references in subsystem maps (docs/subsystem-maps/*.md) exist.
#
# Extracts file path references from:
#   - Markdown links: [text](features/outreach/campaigns/sender/engine.go)
#   - Inline backticks: `features/outreach/campaigns/sender/engine.go`
#   - Code fence blocks (NOT checked — treated as examples)
#
# Also attempts best-effort verification of symbol references (e.g., sender.NewAntiTraceClient,
# Engine.Run). If file exists, tries grep; if symbol not found, warns (non-fatal).
#
# Exit codes:
#   0 — all file references valid (symbol warnings are non-fatal)
#   1 — broken file reference found
#   2 — no map files found
#
# Usage:
#   bash scripts/docs/verify-subsystem-maps.sh
#   REPO_ROOT=/path/to/repo bash scripts/docs/verify-subsystem-maps.sh

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
symbol_warnings=0
found_any=0

# Find all subsystem maps (excluding .claude/worktrees which are ephemeral)
while IFS= read -r map_file; do
  [ -e "$map_file" ] || continue
  # Skip worktree directories (ephemeral)
  if [[ "$map_file" =~ \.claude/worktrees ]]; then
    continue
  fi
  found_any=1

  if [ "$VERBOSE" -eq 1 ]; then
    echo "Checking: $map_file"
  fi

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
          echo "BROKEN: $map_file:$line_num: $path_only does not exist"
          broken_count=$((broken_count + 1))
        else
          valid_count=$((valid_count + 1))
        fi
      fi
    done

    # Extract paths from inline backticks: `path/to/file.ext`
    while [[ "$line" =~ \`([^\`]+)\` ]]; do
      path="${BASH_REMATCH[1]}"
      line="${line#*"${BASH_REMATCH[0]}"}"

      # Check if looks like a file path with optional symbol
      if [[ "$path" =~ ^(services|apps|scripts|docs|modules|\.claude)/ ]]; then
        # Split on : to separate file from symbol reference
        file_part=$(echo "$path" | cut -d':' -f1)
        symbol_part=$(echo "$path" | cut -d':' -f2- -s)

        # Skip URLs
        if [[ "$file_part" =~ ^http:// ]] || [[ "$file_part" =~ ^https:// ]]; then
          continue
        fi

        # Strip leading ./
        file_part="${file_part#./}"
        file_part="${file_part%[,;:.)]}"

        # Verify file exists
        if [ ! -e "$file_part" ]; then
          echo "BROKEN: $map_file:$line_num: $file_part does not exist"
          broken_count=$((broken_count + 1))
        else
          valid_count=$((valid_count + 1))

          # If symbol reference exists, try best-effort grep
          if [ -n "$symbol_part" ]; then
            symbol_part="${symbol_part%[,;:.)]}"
            # Best effort: grep for the symbol (may have false negatives due to formatting)
            if ! grep -q "$symbol_part" "$file_part" 2>/dev/null; then
              if [ "$VERBOSE" -eq 1 ]; then
                echo "WARNING: $map_file:$line_num: Symbol '$symbol_part' not found in $file_part (may be a false positive)"
              fi
              symbol_warnings=$((symbol_warnings + 1))
            fi
          fi
        fi
      fi
    done
  done < "$map_file"
done < <(find ./docs/subsystem-maps -name "*.md" -type f 2>/dev/null | sort)

if [ "$found_any" -eq 0 ]; then
  echo "ERROR: No subsystem maps found in docs/subsystem-maps/"
  exit 2
fi

if [ "$broken_count" -gt 0 ]; then
  echo ""
  echo "VERIFICATION FAILED: $broken_count broken reference(s), $valid_count valid"
  exit 1
fi

if [ "$symbol_warnings" -gt 0 ] && [ "$VERBOSE" -eq 1 ]; then
  echo "Note: $symbol_warnings symbol reference(s) could not be verified (non-fatal)"
fi

echo "VERIFIED: $valid_count file reference(s) valid (0 broken)"
exit 0
