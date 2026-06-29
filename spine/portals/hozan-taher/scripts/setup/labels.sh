#!/usr/bin/env bash
# Idempotent GitHub label setup for autonomous-ops backlog model.
# Re-run safely — uses gh label create --force.
#
# Categories:
#   priority/  p0..p3       — score-based, set by reprioritizer
#   kind/      ...          — what type of work
#   area/      ...          — which service / module
#   from/      ...          — signal source
#   automation/ok|blocked|needs-design — bot eligibility allowlist
#   status/    ...          — lifecycle column hint
#
# Colors: hex without leading #.

set -euo pipefail

create() {
  local name="$1" color="$2" desc="$3"
  if gh label create "$name" --color "$color" --description "$desc" --force >/dev/null 2>&1; then
    echo "  ok  $name"
  else
    echo "  FAIL $name"
  fi
}

echo "== priority/ =="
create "priority/p0" "b60205" "Drop everything (blocking launch / prod down)"
create "priority/p1" "d93f0b" "This sprint"
create "priority/p2" "fbca04" "Next sprint"
create "priority/p3" "c2e0c6" "Eventually"

echo "== kind/ =="
create "kind/flake"    "fef2c0" "Non-deterministic test (hides other signal)"
create "kind/bug"      "ee0701" "Production-impacting defect"
create "kind/infra"    "5319e7" "CI / tooling / dev environment"
create "kind/test"     "0e8a16" "Test code or coverage"
create "kind/docs"     "0075ca" "Docs / playbooks / ADRs"
create "kind/refactor" "bfdadc" "No behavior change"
create "kind/dep"      "ededed" "Dependency upgrade / alignment"

echo "== area/ =="
create "area/relay"             "1d76db" "features/outreach/relay (Go)"
create "area/privacy-gateway"   "1d76db" "features/compliance/privacy-gateway (Go)"
create "area/mailboxes"         "1d76db" "features/outreach/mailboxes (Go + UI)"
create "area/contacts"          "1d76db" "features/acquisition/contacts (Go + UI)"
create "area/campaigns"         "1d76db" "features/outreach/campaigns (Go + UI)"
create "area/inbox"             "1d76db" "features/inbound/inbox (Go + UI)"
create "area/orchestrator"      "1d76db" "features/inbound/orchestrator (Go)"
create "area/common"            "1d76db" "features/platform/common (Go shared)"
create "area/dashboard"         "0366d6" "features/platform/outreach-dashboard"
create "area/scrapers"          "0366d6" "features/acquisition/scrapers (TS)"
create "area/mcp"               "0366d6" "features/platform/mcp (TS)"
create "area/worker"            "0366d6" "features/platform/worker (TS)"
create "area/extension"         "0366d6" "apps/extension"
create "area/bff"               "0366d6" "BFF / Express proxy in dashboard"
create "area/test-infra"        "1d76db" "Test runners, CI workflows, coverage tooling"

echo "== from/ =="
create "from/sentry"        "5319e7" "Auto-created by Sentry triage"
create "from/test-fail"     "5319e7" "Auto-created by CI failure triage"
create "from/health-check"  "5319e7" "Auto-created by weekly health monitor"
create "from/manual"        "5319e7" "Created manually by user"
create "from/initiative"    "5319e7" "Backfilled from docs/initiatives task list"

echo "== automation/ =="
create "automation/ok"           "0e8a16" "Bot may pick this up"
create "automation/blocked"      "b60205" "Bot tried and got stuck — needs user"
create "automation/needs-design" "fbca04" "Needs user design before automation safe"
create "automation/bot"          "5319e7" "PR opened by autonomous bot"

echo "== status/ =="
create "status/triaged"      "ededed" "Has priority + area + acceptance criteria"
create "status/in-bot"       "fbca04" "Currently being worked by bot"
create "status/needs-review" "0e8a16" "PR open, awaiting review"
create "status/parked"       "ededed" "Intentionally deferred"

echo
echo "Done. Total labels created/updated: $(gh label list --limit 200 | wc -l | tr -d ' ')"
