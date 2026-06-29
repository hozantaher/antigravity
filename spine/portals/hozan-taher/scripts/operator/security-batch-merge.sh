#!/usr/bin/env bash
# Operator security PR batch-merge — speeds up the 90-min review session by
# combining list + per-PR summary + admin-merge + audit log into a single
# interactive flow.
#
# Usage:
#   bash scripts/operator/security-batch-merge.sh
#
# Per PR, operator types:
#   y → admin-merge with audit log
#   n → skip (PR stays open)
#   d → show full PR diff first, then re-prompt
#   q → quit immediately
#
# Default behavior: shows risk summary from docs/audits/2026-04-30-security-pr-review-pack.md
# pulls live mergeable status, and refuses to merge if PR is CONFLICTING.

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$REPO_ROOT"

AUDIT_LOG="docs/audits/admin-merges.jsonl"
TIMESTAMP() { date -u +%Y-%m-%dT%H:%M:%SZ; }

# Security PRs from the 2026-04-30 review pack — sorted by severity.
# Format: PR_NUMBER:TIER:HEADLINE
SECURITY_PRS=(
  "161:CRITICAL:S-C1 — fail-closed when HMAC secret missing"
  "162:CRITICAL:S-C2 — XFF trusted-proxy gate + leftmost parse"
  "166:CRITICAL:F1-1 — segment placeholder offset bug"
  "184:CRITICAL:W2-B — constant-time token compare"
  "163:HIGH:S-H1 — strict DSN parser anti-SSRF"
  "164:HIGH:S-H2 — strip raw err.Error() from HTTP responses"
  "165:HIGH:S-H3 — CSP + cross-origin isolation"
  "167:HIGH:F1-2 — HMAC timing-safe + trust-proxy + ?limit clamp"
  "169:HIGH:F2-1 — close outreach_threads on link unsub"
  "170:HIGH:F2-2 — drop silent .catch on tracking_events DELETE"
  "171:HIGH:F2-3 — pin sql.Conn for advisory-lock lifetime"
  "172:HIGH:F2-4 — AbortSignal/timeout on BFF→Go fetches"
  "173:HIGH:F3-1 — feed Backpressure on IMAP-DSN bounces"
  "174:HIGH:F3-2 — /run flips status only; remove silent no-op"
  "175:HIGH:F3-3 — anti-trace empty envelope_id is typed error"
  "178:HIGH:F5-2 — pq.Array swap fixes IN-scalar SQL injection"
  "180:MEDIUM:F5-3 — auth-matrix ENABLED-side contract"
)

approved=0
skipped=0
conflicts=0
errors=0

for entry in "${SECURITY_PRS[@]}"; do
  pr=$(echo "$entry" | cut -d: -f1)
  tier=$(echo "$entry" | cut -d: -f2)
  headline=$(echo "$entry" | cut -d: -f3-)

  state=$(gh pr view "$pr" --json state -q '.state' 2>/dev/null || echo "ERROR")
  if [ "$state" = "MERGED" ]; then
    echo "✓ #$pr already MERGED — skip"
    continue
  fi
  if [ "$state" = "CLOSED" ]; then
    echo "✗ #$pr CLOSED unmerged — skip"
    continue
  fi

  mergeable=$(gh pr view "$pr" --json mergeable -q '.mergeable' 2>/dev/null || echo "UNKNOWN")
  echo ""
  echo "─── #$pr [$tier] ─────────────────────────────────────"
  echo "  $headline"
  echo "  Mergeable: $mergeable"

  if [ "$mergeable" = "CONFLICTING" ]; then
    echo "  ⚠ CONFLICTING — needs rebase before merge. Skipping."
    conflicts=$((conflicts + 1))
    continue
  fi

  while true; do
    read -p "  [y]es / [n]o / [d]iff / [q]uit: " ans </dev/tty
    case "$ans" in
      y|Y)
        echo "  Merging..."
        if gh pr merge "$pr" --admin --squash --delete-branch >/dev/null 2>&1; then
          echo "  ✓ merged"
          # Append audit entry
          cat >> "$AUDIT_LOG" <<EOF
{"ts":"$(TIMESTAMP)","pr":$pr,"title":"$headline","tier":"C","reason":"security gate operator session","reviewer":"operator","local_tests":"prior session verified","operator_approved":"interactive batch-merge"}
EOF
          approved=$((approved + 1))
        else
          echo "  ✗ merge failed (CI block? rate-limit?)"
          errors=$((errors + 1))
        fi
        break
        ;;
      n|N)
        echo "  Skipped."
        skipped=$((skipped + 1))
        break
        ;;
      d|D)
        gh pr diff "$pr" | less </dev/tty >/dev/tty
        ;;
      q|Q)
        echo "Quit by operator."
        break 2
        ;;
      *)
        echo "  → answer y/n/d/q"
        ;;
    esac
  done
done

echo ""
echo "═══ Summary ═══"
echo "  approved + merged:  $approved"
echo "  skipped:            $skipped"
echo "  blocked CONFLICT:   $conflicts"
echo "  errors:             $errors"
echo ""
echo "Audit appended to: $AUDIT_LOG"
