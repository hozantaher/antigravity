#!/usr/bin/env bash
set -euo pipefail

# prune-merged-worktrees.sh — Remove agent worktrees whose PRs have merged.
#
# Usage:
#   ./scripts/operator/prune-merged-worktrees.sh           # dry-run (safe default)
#   ./scripts/operator/prune-merged-worktrees.sh --auto    # auto-remove without confirmation
#
# Features:
#   - Extracts branch name from worktree
#   - Checks if PR merged via gh pr list --state=closed
#   - Filters to agent-* worktrees only (protects main, wm/development, wm/tests)
#   - Outputs count + list of removed worktrees
#   - Appends JSONL audit record to docs/audits/worktree-prune.jsonl

readonly SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
readonly REPO_ROOT="$(cd "${SCRIPT_DIR}/../../" && pwd)"
readonly DRY_RUN="${1:-"--dry-run"}"
readonly AUTO_MODE="$([[ "$DRY_RUN" == "--auto" ]] && echo true || echo false)"

# ANSI colors for output
readonly RED='\033[0;31m'
readonly GREEN='\033[0;32m'
readonly YELLOW='\033[1;33m'
readonly NC='\033[0m' # No Color

# Track removals for audit log
declare -a REMOVED_PATHS=()
declare -a MERGED_BRANCHES=()

log_info() {
    echo -e "${GREEN}[INFO]${NC} $*" >&2
}

log_warn() {
    echo -e "${YELLOW}[WARN]${NC} $*" >&2
}

log_error() {
    echo -e "${RED}[ERROR]${NC} $*" >&2
}

# Check if branch has a merged PR
is_pr_merged() {
    local branch="$1"

    # Query gh for closed PRs (merged or closed) with matching head branch
    local result
    result=$(gh pr list --head "$branch" --state=closed --json mergedAt --limit=1 2>/dev/null || echo "[]")

    # If result is non-empty and has mergedAt field with non-null value, it's merged
    if [[ "$result" != "[]" ]]; then
        local merged_at
        merged_at=$(echo "$result" | grep -o '"mergedAt":"[^"]*"' | head -1)
        [[ -n "$merged_at" ]] && return 0
    fi

    return 1
}

# Check if worktree is protected (should not be removed)
is_protected_worktree() {
    local path="$1"
    local branch="$2"

    # Infrastructure branches
    if [[ "$branch" == "main" ]] || \
       [[ "$branch" == "wm/development" ]] || \
       [[ "$branch" == "wm/tests" ]]; then
        return 0
    fi

    # Infrastructure paths (main repo, dev, tests)
    if [[ "$path" == "$REPO_ROOT" ]] || \
       [[ "$path" == "${REPO_ROOT}-dev" ]] || \
       [[ "$path" == "${REPO_ROOT}-tests" ]]; then
        return 0
    fi

    return 1
}

# Extract branch name from worktree path
get_branch_from_worktree() {
    local path="$1"

    # Parse branch from git worktree porcelain format
    # Expected: "branch refs/heads/<branch>"
    git -C "$REPO_ROOT" worktree list --porcelain | \
        awk -v p="$path" '
            BEGIN { in_worktree = 0 }
            /^worktree / {
                if ($2 == p) in_worktree = 1
                else in_worktree = 0
            }
            in_worktree && /^branch / {
                # Extract everything after "refs/heads/"
                line = $0
                if (match(line, /refs\/heads\/(.*)/)) {
                    print substr(line, RSTART + 11)
                }
                exit
            }
        '
}

# Remove a single worktree
remove_worktree() {
    local path="$1"
    local branch="$2"

    if [[ "$AUTO_MODE" == "true" ]]; then
        log_info "Removing: $path (branch: $branch)"
        git -C "$REPO_ROOT" worktree remove "$path" 2>/dev/null || \
            log_warn "Failed to remove $path (may be in use)"
    else
        log_info "[DRY-RUN] Would remove: $path (branch: $branch)"
    fi

    REMOVED_PATHS+=("$path")
    MERGED_BRANCHES+=("$branch")
}

main() {
    cd "$REPO_ROOT"

    if [[ "$DRY_RUN" == "--dry-run" ]]; then
        log_info "Running in DRY-RUN mode (no worktrees will be removed)"
    else
        log_warn "Running in AUTO mode (worktrees will be removed without confirmation)"
    fi

    log_info "Scanning worktrees for merged PRs..."

    local total_worktrees=0
    local eligible_count=0

    # Parse worktree list and check each one
    while IFS= read -r line; do
        if [[ "$line" =~ ^worktree ]]; then
            path="${line#worktree }"
            ((total_worktrees++))

            # Get branch for this worktree
            branch=$(get_branch_from_worktree "$path")

            if [[ -z "$branch" ]]; then
                log_warn "Could not determine branch for: $path (skipping)"
                continue
            fi

            # Skip protected worktrees
            if is_protected_worktree "$path" "$branch"; then
                log_info "Skipping protected worktree: $path (branch: $branch)"
                continue
            fi

            # Skip if not an agent worktree
            if [[ ! "$path" =~ agent-[a-f0-9] ]]; then
                log_info "Skipping non-agent worktree: $path (branch: $branch)"
                continue
            fi

            # Check if PR is merged
            if is_pr_merged "$branch"; then
                ((eligible_count++))
                remove_worktree "$path" "$branch"
            else
                log_info "Keeping: $path (branch: $branch) — PR not merged or no PR found"
            fi
        fi
    done < <(git worktree list --porcelain)

    # Summary
    echo ""
    log_info "===== SUMMARY ====="
    log_info "Total worktrees scanned: $total_worktrees"
    log_info "Eligible for removal (PR merged): $eligible_count"

    if [[ ${#REMOVED_PATHS[@]} -gt 0 ]]; then
        echo ""
        log_info "Removed paths:"
        printf '  %s\n' "${REMOVED_PATHS[@]}"
        echo ""
        log_info "Removed branches:"
        printf '  %s\n' "${MERGED_BRANCHES[@]}"
    else
        log_info "No worktrees removed."
    fi

    # Append audit record
    if [[ "$AUTO_MODE" == "true" ]] && [[ ${#REMOVED_PATHS[@]} -gt 0 ]]; then
        append_audit_record
    fi
}

append_audit_record() {
    local timestamp
    timestamp=$(date -u +"%Y-%m-%dT%H:%M:%SZ")
    local audit_file="${REPO_ROOT}/docs/audits/worktree-prune.jsonl"

    # Create audit file if it doesn't exist
    if [[ ! -f "$audit_file" ]]; then
        mkdir -p "$(dirname "$audit_file")"
        touch "$audit_file"
    fi

    # Build JSON record
    local paths_json
    paths_json=$(printf '%s\n' "${REMOVED_PATHS[@]}" | jq -R . | jq -s . 2>/dev/null || echo '[]')

    local record
    record=$(jq -n \
        --arg ts "$timestamp" \
        --argjson count "${#REMOVED_PATHS[@]}" \
        --argjson paths "$paths_json" \
        '{timestamp: $ts, count: $count, paths: $paths}')

    echo "$record" >> "$audit_file"
    log_info "Audit record appended to: $audit_file"
}

main "$@"
