---
name: discover
description: Load the canonical context for a subsystem before pipeline-touching work — MAP doc, recent git changes, tagged memories, deployment state, open issues.
---

# /discover <subsystem>

Loads the canonical reference state for a subsystem so I (or a spawned agent) does not write code based on a fabricated mental model.

## Usage

```
/discover <subsystem>
```

Where `<subsystem>` is one of: `anti-trace`, `imap-inbound`, `dashboard-bff`, `scrapers`, `worker`, `content-render`, `protections`, `common-libs`.

If the requested name doesn't match an existing map, the skill lists available maps and exits.

## What it does

1. **MAP doc** — outputs full content of `docs/subsystem-maps/<subsystem>.md`. If the file doesn't exist, lists available maps and stops.
2. **Recent changes (30 days)** — `git log --since='30 days ago' --pretty='%h %ad %s' --date=short -- <subsystem-dir>` truncated to last 30 commits. The subsystem-dir mapping:
   - `anti-trace` → `services/campaigns/ services/relay/`
   - `imap-inbound` → `services/orchestrator/imap/`
   - `dashboard-bff` → `apps/outreach-dashboard/server.js apps/outreach-dashboard/src/server-routes/`
   - `scrapers` → `services/scrapers/`
   - `worker` → `services/worker/`
   - `content-render` → `services/campaigns/content/ services/common/humanize/`
   - `protections` → `services/orchestrator/protections/`
   - `common-libs` → `services/common/`
3. **Tagged memories** — lists memory files matching the subsystem tag. Until A3 tier+tag refactor lands, falls back to filename-substring match against `~/.claude/projects/-Users-messingtomas-Documents-Projekty-hozan-taher/memory/*.md`.
4. **Live deployment state** — for the subsystems that have a probe:
   - `anti-trace` → `curl -sS -m 5 http://localhost:18001/api/anti-trace/egress`
   - `dashboard-bff` → `curl -sS -m 5 http://localhost:18001/healthz`
   - `protections` → `curl -sS -m 5 http://localhost:18001/api/protection-matrix`
   - others → skip
5. **Open GH issues** — `gh issue list --search "<subsystem>" --state=open --limit 10 --json number,title`

## Output format

Single markdown document with these sections in order:
- `## Map` — full MAP file content (or "no map yet" + available list)
- `## Recent changes (last 30d)` — commit log
- `## Tagged memories` — file list with one-line descriptions
- `## Deployment state` — live probe output (or "skipped — no probe")
- `## Open issues` — gh json output prettified

## Implementation

The skill is a markdown file Claude Code reads on `/discover`. The bash commands below are what to execute and concatenate into a markdown response:

```bash
SUBSYSTEM="$1"
case "$SUBSYSTEM" in
  anti-trace)       DIRS="services/campaigns services/relay" ;;
  imap-inbound)     DIRS="services/orchestrator/imap" ;;
  dashboard-bff)    DIRS="apps/outreach-dashboard/server.js apps/outreach-dashboard/src/server-routes" ;;
  scrapers)         DIRS="services/scrapers" ;;
  worker)           DIRS="services/worker" ;;
  content-render)   DIRS="services/campaigns/content services/common/humanize" ;;
  protections)      DIRS="services/orchestrator/protections" ;;
  common-libs)      DIRS="services/common" ;;
  *)
    echo "## Unknown subsystem: $SUBSYSTEM"
    echo ""
    echo "Available maps:"
    ls docs/subsystem-maps/*.md 2>/dev/null | sed 's|docs/subsystem-maps/|- |' | sed 's|.md||'
    exit 1
    ;;
esac

MAP_FILE="docs/subsystem-maps/${SUBSYSTEM}.md"
if [ -f "$MAP_FILE" ]; then
  echo "## Map (docs/subsystem-maps/${SUBSYSTEM}.md)"
  cat "$MAP_FILE"
else
  echo "## Map"
  echo "No map yet. Available:"
  ls docs/subsystem-maps/*.md 2>/dev/null | sed 's|docs/subsystem-maps/|- |' | sed 's|.md||'
fi
echo ""
echo "## Recent changes (last 30d)"
git log --since='30 days ago' --pretty='%h %ad %s' --date=short -- $DIRS 2>/dev/null | head -30
echo ""
echo "## Tagged memories"
MEMDIR="$HOME/.claude/projects/-Users-messingtomas-Documents-Projekty-hozan-taher/memory"
if [ -d "$MEMDIR" ]; then
  grep -l "subsystem:${SUBSYSTEM}" "$MEMDIR"/*.md 2>/dev/null | sed 's|.*/||' | head -10
  # Fallback substring match for un-tagged memories (pre-A3)
  ls "$MEMDIR"/*${SUBSYSTEM}*.md 2>/dev/null | sed 's|.*/||' | head -5
fi
echo ""
echo "## Deployment state"
case "$SUBSYSTEM" in
  anti-trace)    curl -sS -m 5 http://localhost:18001/api/anti-trace/egress 2>/dev/null || echo "(BFF not running)" ;;
  dashboard-bff) curl -sS -m 5 http://localhost:18001/healthz 2>/dev/null || echo "(BFF not running)" ;;
  protections)   curl -sS -m 5 http://localhost:18001/api/protection-matrix 2>/dev/null || echo "(BFF not running)" ;;
  *)             echo "(no probe configured for $SUBSYSTEM)" ;;
esac
echo ""
echo "## Open issues"
gh issue list --search "$SUBSYSTEM" --state=open --limit 10 2>/dev/null || echo "(gh not configured)"
```

## Why this exists

Recurring AI failure mode: AI codes pipeline-touching changes without complete model of the subsystem. 2026-05-01 incident — anonymity test framework bypassed `sender.Engine` entirely; 6h debugging traced to architectural bypass. This skill ensures the canonical state is loaded first.

See `docs/initiatives/2026-05-01-codebase-awareness-discipline.md` (CAD-A2, issue #561).
