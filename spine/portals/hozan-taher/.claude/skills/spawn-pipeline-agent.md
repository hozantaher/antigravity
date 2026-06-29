---
name: spawn-pipeline-agent
description: Wrap Agent invocation with mandatory subsystem context preamble — MAP excerpt, recent git diff, forbidden paths, required gates, echo-understanding gate.
---

# /spawn-pipeline-agent <subsystem> <task>

Hard procedural gate when spawning a background agent for pipeline-touching work. Without this wrapper, agents inherit my incomplete picture of the codebase and produce bypass code (cf. 2026-05-01 anonymity-test incident: 0/18 delivered, 6h debug, root cause = agent prompt missing the 42-step anti-trace MAP).

## Usage

```
/spawn-pipeline-agent anti-trace "add new send_event observability metric"
```

Skill outputs a fully-formed Agent prompt I paste into the `Agent` tool.

## Output template

```
=== Subsystem context: <subsystem> ===

[Excerpt from docs/subsystem-maps/<subsystem>.md, max 2000 tokens — Pipeline numbered list + Bypass paths + Forbidden imports + Required gates sections only]

=== Recent changes (30d) in <subsystem-dir> ===

[git log --since=30d --pretty='%h %ad %s' --date=short -- <subsystem-dir> | head -30]

=== Forbidden paths (verbatim from MAP) ===

[grep "^### Bypass paths" -A 50 docs/subsystem-maps/<subsystem>.md, until next ###]

=== Required gates (verbatim from MAP) ===

[List of gates the task MUST honor — synthesized from MAP's gating column]

=== TASK ===

<task description>

=== Echo your understanding (FILL BEFORE WRITING CODE) ===

Before writing any code, summarize in your first response:
1. Which pipeline steps your change touches (cite step number from MAP, e.g. G7, R12)
2. Which gates apply (e.g. circuit breaker G3, audit G4)
3. How you'll verify gate compliance (test name or audit ratchet file path)
4. What bypass risks exist for this change and how you'll avoid them

Failure to echo this understanding before code edits is a HARD violation
of the CAD discipline (memory feedback_anti_trace_full_stack T0 hard rule).

=== Constraints ===

- Per memory feedback_search_before_implement (T0): use mcp__claude-context__search_code before grep/find when looking up symbols.
- Per memory feedback_extreme_testing (T0): ≥10 test cases per change.
- Per memory feedback_no_speculation (T0): cite file:line, don't invent behavior.
- Branch from current origin/main (NOT stale local main). Verify diff stat <50 files.
- Open PR with title "feat(<subsystem>): <one-line> (#<issue>)". Body: cite MAP commit SHA + initiative doc.
```

## Implementation

```bash
SUBSYSTEM="$1"; shift
TASK="$*"
if [ -z "$SUBSYSTEM" ] || [ -z "$TASK" ]; then
  echo "Usage: /spawn-pipeline-agent <subsystem> <task description>"
  exit 1
fi

MAP="docs/subsystem-maps/${SUBSYSTEM}.md"
if [ ! -f "$MAP" ]; then
  echo "ERROR: no map at $MAP. Available:"
  ls docs/subsystem-maps/*.md 2>/dev/null | sed 's|.*/|  - |' | sed 's|\.md||'
  exit 1
fi

case "$SUBSYSTEM" in
  anti-trace)     DIR="services/campaigns services/relay" ;;
  imap-inbound)   DIR="services/orchestrator/imap" ;;
  dashboard-bff)  DIR="apps/outreach-dashboard/server.js apps/outreach-dashboard/src/server-routes" ;;
  scrapers)       DIR="services/scrapers" ;;
  worker)         DIR="services/worker" ;;
  content-render) DIR="services/campaigns/content services/common/humanize" ;;
  protections)    DIR="services/orchestrator/protections" ;;
  common-libs)    DIR="services/common" ;;
  *)              DIR="" ;;
esac

MAP_SHA=$(git rev-parse "HEAD:$MAP" 2>/dev/null)

cat <<HEAD
=== Subsystem context: $SUBSYSTEM (MAP SHA: $MAP_SHA) ===

HEAD

# MAP excerpt: pipeline + bypass + forbidden sections
awk '/^## Pipeline/,/^## /' "$MAP" | head -200
echo
echo "=== Recent changes (30d) in $SUBSYSTEM ==="
git log --since='30 days ago' --pretty='%h %ad %s' --date=short -- $DIR 2>/dev/null | head -30
echo
echo "=== Forbidden paths ==="
awk '/^## Bypass paths/,/^## /' "$MAP" | head -50
echo
echo "=== TASK ==="
echo "$TASK"
echo
cat <<'TAIL'
=== Echo your understanding (FILL BEFORE WRITING CODE) ===

Before writing any code, summarize in your first response:
1. Which pipeline steps your change touches (cite step number from MAP)
2. Which gates apply
3. How you'll verify gate compliance (test name or audit ratchet path)
4. What bypass risks exist for this change and how you'll avoid them

=== Constraints ===

- mcp__claude-context__search_code BEFORE grep/find for symbol lookups
- ≥10 test cases per change (extreme_testing memory)
- Cite file:line; no fabrication (no_speculation memory)
- Branch from current origin/main; diff stat <50 files
- PR cites MAP commit SHA + initiative doc
TAIL
```

## Why this exists

`feedback_anti_trace_full_stack` HARD RULE: production email send MUST flow through `sender.Engine.WithAntiTrace().Run()`. Direct `AntiTraceClient` construction outside `engine.go` is forbidden by audit ratchet `services/campaigns/sender/no_bypass_audit_test.go` (baseline 1).

When I delegated the anonymity-test task to a background agent without this wrapper, the agent built `cmd/anonymity-test` calling `sender.NewAntiTraceClient` directly — bypassing 25 of 42 gates. This wrapper prevents that recurrence by injecting the canonical context every time.

See:
- `docs/subsystem-maps/anti-trace.md` — the canonical 42-step MAP
- `docs/initiatives/2026-05-01-codebase-awareness-discipline.md` (CAD-A4, issue #563)
- Memory `feedback_subagent_token_economy` — agent fleet pattern + max-2-simultaneous default
