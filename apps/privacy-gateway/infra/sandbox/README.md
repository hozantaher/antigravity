# Claude Sandbox

Isolated execution of Claude Desktop on macOS. Two tiers:

- **sandbox-exec** (default) — native macOS Seatbelt profile. Zero overhead, filesystem + process + network isolation.
- **UTM VM** (`--vm`) — full Ubuntu VM with hardware isolation. For untrusted code execution.

## Quick Start

```bash
# Launch sandboxed Claude Desktop
./launch.sh

# Launch in VM (requires UTM + VM setup)
./launch.sh --vm
```

## What's Blocked

### Filesystem (read denied)
- SSH keys, GPG, AWS/GCP/Azure credentials
- Shell history, package manager credentials
- Browser data, password managers, messaging apps
- Personal directories (Documents, Downloads, Desktop, etc.)
- Other project directories

### Filesystem (write denied)
- All of `~/` except `sandboxed-home/` and system temp dirs

### Process Execution
- `osascript`, `security` (keychain access)
- `ssh`, `scp`, `sftp` and all SSH helpers
- `curl`, `wget`, `nc`, `telnet`, `ftp`
- `pbcopy`, `pbpaste` (clipboard)
- `open` (URL exfiltration)
- Cloud CLIs: `gh`, `aws`, `gcloud`, `az`, `fly`, `railway`, etc.

### Network
- All non-HTTPS traffic blocked (only port 443 + localhost + DNS allowed)
- Note: Host-level filtering not available on macOS 26 (see ADR-002)

## Maintenance

```bash
# Verify sandbox is working
./verify.sh

# Clean caches (preserves auth tokens)
./clean.sh
```

## Architecture Decisions

| Document | Summary |
|----------|---------|
| [ADR-001](ADR-001-isolation-model.md) | sandbox-exec for daily use, VM for untrusted execution |
| [ADR-002](ADR-002-network-strategy.md) | Port-only network filtering (macOS 26 limitation) |
| [ADR-003](ADR-003-sandboxed-home.md) | Persist auth tokens, clean caches on demand |

## VM Setup (Optional)

```bash
cd vm/
./setup-vm.sh    # Downloads Ubuntu image, creates disk + seed ISO
# Then create VM in UTM GUI (see setup-vm.sh output for steps)
./launch.sh      # Or: ../launch.sh --vm
```

VM credentials: `claude` / `claude`

## Files

```
claude-sandbox/
├── launch.sh              # Entry point (sandbox-exec default, --vm for VM)
├── claude-desktop.sb      # Seatbelt sandbox profile
├── atr-test.sb            # Anti-trace-relay test profile
├── verify.sh              # Automated sandbox verification (5 tests)
├── clean.sh               # Cache cleanup (preserves auth)
├── sandboxed-home/        # Isolated user data dir (gitignored)
├── vm/
│   ├── setup-vm.sh        # VM disk + cloud-init setup
│   ├── launch.sh          # VM start via utmctl
│   ├── user-data          # cloud-init config
│   └── meta-data          # cloud-init metadata
├── ADR-001-*.md           # Isolation model decision
├── ADR-002-*.md           # Network strategy decision
├── ADR-003-*.md           # Sandboxed-home lifecycle
├── POC-network-isolation.md  # Network POC (accepted)
└── POC-sandbox-atr.md     # ATR POC (in progress)
```
