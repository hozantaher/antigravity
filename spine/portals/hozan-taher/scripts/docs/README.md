# Documentation Verification Scripts

This directory contains automated verification scripts that ensure CLAUDE.md and subsystem maps reference paths that actually exist. These scripts prevent documentation drift and catch stale references before they block developers.

## Scripts

### verify-claude-md.sh

Verifies that all file path references in CLAUDE.md files exist on disk.

**What it does:**
- Walks every `**/CLAUDE.md` in the repo
- Extracts file path references from markdown links `[text](path)` and inline backticks `` `path` ``
- Ignores code fence blocks (treated as examples)
- Checks against a whitelist of valid path prefixes (services/, apps/, scripts/, docs/, modules/, .claude/)
- Skips URLs and invalid paths

**Exit codes:**
- 0 — all references valid
- 1 — broken reference found
- 2 — no CLAUDE.md files found

**Usage:**
```bash
bash scripts/docs/verify-claude-md.sh
REPO_ROOT=/path/to/repo bash scripts/docs/verify-claude-md.sh
VERBOSE=1 bash scripts/docs/verify-claude-md.sh
```

### verify-subsystem-maps.sh

Verifies that file path references in subsystem maps (`docs/subsystem-maps/*.md`) exist.

**What it does:**
- Walks `docs/subsystem-maps/*.md`
- Extracts file path references (same as verify-claude-md.sh)
- For symbol references like `` `services/campaigns/sender/engine.go:Run` ``, performs best-effort grep verification (non-fatal warnings)
- Ignores code fences and URLs

**Exit codes:**
- 0 — all file references valid (symbol warnings are non-fatal)
- 1 — broken file reference found
- 2 — no map files found

**Usage:**
```bash
bash scripts/docs/verify-subsystem-maps.sh
VERBOSE=1 bash scripts/docs/verify-subsystem-maps.sh
```

## Common Issues

### False Positives

The scripts use heuristics to avoid false positives:
- Only check paths starting with valid prefixes or ending with .md/.go/.ts/.js/.sh
- Strip trailing punctuation and URL anchors
- Skip code fences and URLs
- Whitelist: services/, apps/, scripts/, docs/, modules/, .claude/

### Stale References

When a file is deleted or moved, update the reference to point to the new location or remove it entirely.

## Design Goals

1. **Zero false positives** — only flag actual broken references
2. **Fast** — walks repo once, ~100ms
3. **Developer-friendly** — clear file:line error messages
4. **Maintainable** — simple bash, no external dependencies
