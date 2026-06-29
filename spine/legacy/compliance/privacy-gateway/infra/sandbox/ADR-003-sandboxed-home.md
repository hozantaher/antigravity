# ADR-003: Sandboxed-Home Lifecycle

## Status: accepted

## Context

Claude Desktop stores its state in `--user-data-dir` (Electron/Chromium convention). The sandbox directs this to `sandboxed-home/claude-data/`. This directory grows over time with caches, crash reports, and GPU shader caches. Auth tokens live in `Local Storage/` and must be preserved.

## Decision

**Persist `Local Storage/` and config files. Clean caches on demand via `clean.sh`. No auto-cleanup.**

### Directory layout

```
sandboxed-home/claude-data/
├── Local Storage/          # Auth tokens — PRESERVE
├── config.json             # App config — PRESERVE
├── claude_desktop_config.json  # MCP/plugin config — PRESERVE
├── Cookies                 # Session cookies — PRESERVE
├── Preferences             # App preferences — PRESERVE
├── Cache/                  # HTTP cache — CLEANABLE
├── Code Cache/             # V8 compiled code — CLEANABLE
├── blob_storage/           # Blob data — CLEANABLE
├── vm_bundles/             # VM data (stale) — CLEANABLE
├── Crashpad/               # Crash reports — CLEANABLE
├── DawnGraphiteCache/      # GPU cache — CLEANABLE
├── DawnWebGPUCache/        # GPU cache — CLEANABLE
├── GPUCache/               # GPU cache — CLEANABLE
├── sentry/                 # Error reporting — CLEANABLE
└── ...
```

### Cleanup rules

1. `clean.sh` removes all CLEANABLE directories
2. Auth tokens (`Local Storage/`) are never touched
3. No automatic cleanup — user decides when to clean
4. `.gitignore` excludes `sandboxed-home/` from version control

## Alternatives Considered

1. **Auto-cleanup on launch** — rejected because: unexpected data loss if new important dirs appear
2. **Ephemeral home (fresh each launch)** — rejected because: forces re-login every time
3. **Symlink auth to stable location** — rejected because: adds complexity, Electron may not follow symlinks reliably

## Consequences

1. Disk usage grows without explicit cleanup
2. `clean.sh` must be updated when Chromium adds new cache directories
3. Auth survives across sessions without re-login
