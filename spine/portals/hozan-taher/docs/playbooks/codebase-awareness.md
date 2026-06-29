# Codebase Awareness — claude-context Semantic Search

## Overview

The `claude-context` MCP tool maintains a semantic code search index of the Hozan Taher monorepo (2500+ files, 42k+ chunks). The index enables fast natural-language search across the entire codebase, supporting code discovery, pattern identification, and architectural understanding.

**Index freshness target:** max 24 hours stale.

## Daily Auto-Reindex Cron

### Setup (One-time, macOS)

Install the launchd plist:

```bash
cp infra/launchd/com.hozan-taher.claude-context-reindex.plist \
   ~/Library/LaunchAgents/com.hozan-taher.claude-context-reindex.plist
launchctl load ~/Library/LaunchAgents/com.hozan-taher.claude-context-reindex.plist
```

### Schedule

- **Time:** Daily 03:00 Prague time (UTC+2 summer, UTC+1 winter)
- **Mechanism:** launchd StartCalendarInterval (macOS native)
- **Script:** `scripts/cron-claude-context-reindex.sh`
- **Logs:** `~/.cache/claude-context-reindex.log` (stdout), `~/.cache/claude-context-reindex-error.log` (stderr)

### Manual Trigger

To reindex immediately (e.g., after bulk file changes):

```bash
scripts/cron-claude-context-reindex.sh
```

Or via operator flow:

```bash
pnpm rebuild-claude-knowledge
```

## Session Bootstrap

At session start, before substantial code changes:

```bash
mcp__claude-context__get_indexing_status /Users/messingtomas/Documents/Projekty/hozan-taher
```

If `last_updated > 24h` ago, the bootstrap sequence calls `mcp__claude-context__index_codebase` automatically (non-blocking).

## Index Coverage

### Included

- All TypeScript/JavaScript (`.ts`, `.tsx`, `.js`, `.mjs`)
- Go (`.go`)
- SQL (`.sql`)
- YAML (`.yml`, `.yaml`)
- Markdown (`.md`)
- JSON, shell, CSS

### Excluded

- `node_modules/`, `.git/`, `dist/`, `build/`, vendor caches
- Binary files, images, video
- `.env*` (secrets)

## Semantic Search Query Patterns

### Code Discovery

```
"find functions that validate email headers"
"list all SMTP delivery handlers"
"where do we store campaign suppression lists"
```

### Pattern Matching

```
"show all uses of AntiTraceClient"
"find SQL SELECT queries that join contacts and campaigns"
"where is the IMAP folder mapping implemented"
```

### Architectural Understanding

```
"what's the flow from anti-trace engine through relay to delivery"
"how does the dashboard proxy requests to the Go backend"
"trace the email rendering pipeline from template to output"
```

## Indexing Statistics

- **Files indexed:** ~2500
- **Chunks created:** ~42.5k
- **Avg chunk size:** ~400 lines (syntax-aware AST splitting)
- **Index size:** ~150 MB
- **Query latency:** <500 ms (cold), <100 ms (warm cache)

## Troubleshooting

### Index out of sync after large commit

Run manual reindex immediately:

```bash
scripts/cron-claude-context-reindex.sh
```

### launchd not triggering (macOS)

Check plist is loaded:

```bash
launchctl list | grep claude-context
```

Reload if needed:

```bash
launchctl unload ~/Library/LaunchAgents/com.hozan-taher.claude-context-reindex.plist
launchctl load ~/Library/LaunchAgents/com.hozan-taher.claude-context-reindex.plist
```

### Search returns stale results

Verify last index time:

```bash
stat -f "%Sm" ~/.cache/claude-context-reindex.log
```

If >24h old, trigger manual reindex.

### cron script logs nothing

Check PATH in plist includes claude binary location:

```bash
which claude  # copy result to plist EnvironmentVariables/PATH
```

## Integration with Session Workflow

The cron is **transparent** — no operator action required post-setup. Session bootstrap automatically checks staleness and triggers reindex if needed. For large refactors or multi-file bulk changes, operator may manually trigger via `pnpm rebuild-claude-knowledge` to accelerate discovery in current session.

## References

- [CLAUDE.md § Session bootstrap](../../CLAUDE.md#session-bootstrap)
- [Project Layout](../../docs/decisions/ADR-001-project-structure.md)
- MCP tool: `mcp__claude-context__index_codebase`, `mcp__claude-context__search_code`, `mcp__claude-context__get_indexing_status`
