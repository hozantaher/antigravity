---
name: start-task
description: Pre-task discovery ritual — loads /discover output then forces an Echo Checklist before any pipeline-touching code change.
---

# /start-task <subsystem> <task-description>

Hard procedural gate before any code change touching a subsystem with a published map. Runs `/discover <subsystem>` first, then prompts the agent (me) to fill an Echo Checklist demonstrating I understood the canonical state before coding.

## Usage

```
/start-task anti-trace "add new send_event observability metric"
/start-task imap-inbound "extend reply classifier with new label"
```

## What it does

1. Invokes `/discover <subsystem>` (composes its output verbatim).
2. Appends the Echo Checklist template — empty, for me to fill.
3. The skill blocks coding until the checklist is filled. (Convention: I MUST output the filled checklist as my next chat response before any tool calls that write/edit code.)

## Echo Checklist template

```
=== Pre-task Discovery: <subsystem> ===
[discovery output above]

=== Echo Checklist (FILL BEFORE CODING) ===
- Files I will touch: <list of file paths>
- Pipeline steps affected: <numbered citation from MAP, e.g. "G7 PreSendHook + G10 antiTrace.Send">
- Bypass risks audited: <yes/no/list — if any path could circumvent a gate, list it>
- MAP/memory citations: <list of MAP doc commit SHA + memory tags consulted>
- Tests I will write: <list of test cases with target file path>
- Audit ratchets I will not break: <list of audit_test.go files in scope>
```

## When to skip

- Trivial doc-only edits (typo fix, one-line clarification in CLAUDE.md)
- Test-only changes that don't touch production code paths
- Pure dependency bumps (Renovate / Dependabot)

For everything else: invoke this skill.

## Implementation

```bash
SUBSYSTEM="$1"
TASK="$2"
if [ -z "$SUBSYSTEM" ] || [ -z "$TASK" ]; then
  echo "Usage: /start-task <subsystem> <task-description>"
  echo ""
  echo "Available subsystems:"
  ls docs/subsystem-maps/*.md 2>/dev/null | sed 's|docs/subsystem-maps/|- |' | sed 's|.md||'
  exit 1
fi

# Compose /discover output
bash .claude/skills/discover.sh "$SUBSYSTEM" 2>/dev/null || \
  echo "(discover skill not yet wired — falling back to manual map read)"

cat <<'EOF'

=== Echo Checklist (FILL BEFORE CODING) ===

Task: $TASK
Subsystem: $SUBSYSTEM

- Files I will touch: 
- Pipeline steps affected: 
- Bypass risks audited: 
- MAP/memory citations: 
- Tests I will write: 
- Audit ratchets I will not break: 

(Fill ALL fields above as your next response. No code changes until filled.)
EOF
```

## Why this exists

Recurring AI failure mode: spawn an agent without complete subsystem context → agent builds bypass → silent production regression. Cf. 2026-05-01 anonymity-test incident (issue #552, #553), 6h debugging traced to architectural bypass.

The Echo Checklist is the discipline gate. Without filling it, code changes proceed on incomplete model. With it, the AI is forced to articulate understanding before writing — surfaces gaps early.

See `docs/initiatives/2026-05-01-codebase-awareness-discipline.md` (CAD-A2, issue #561).
