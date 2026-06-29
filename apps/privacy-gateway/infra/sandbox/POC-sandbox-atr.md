# POC: Sandbox Environment for Anti-Trace-Relay Testing

## Status: In Progress

## Hypothesis

The macOS sandbox-exec environment can serve as a practical integration testing environment for anti-trace-relay (ATR), providing filesystem isolation that validates ATR's zero-state-on-device claims without requiring a full VM.

## Context

ATR's amnesic CLI client claims to leave zero traces on the device after execution. Currently this is validated through code review and unit tests, but not through environmental testing. A sandbox environment could:

1. Provide a clean filesystem scope where ATR runs
2. Verify no files persist after ATR process exits
3. Test the bridge→privacy-gateway flow in isolation
4. Validate that ATR's content sanitizer works under sandbox restrictions

Per ADR-001, sandbox-exec is the primary daily driver and VM is for untrusted execution. ATR testing fits the sandbox tier -- it's our own code, not untrusted input.

## Scope

**In scope:**
- Creating an ATR-specific sandbox profile (`atr-test.sb`)
- Running ATR binary inside sandbox with write isolation
- Verifying zero-state-on-device after process exit
- Testing bridge→localhost privacy-gateway connectivity

**Out of scope:**
- Full deaddrop testing (requires VM or dedicated network)
- Direct SMTP testing (requires real provider)
- Constant-rate emission testing (requires long-running process)

## Test Plan

### Phase 1: ATR sandbox profile

Create `claude-sandbox/atr-test.sb`:

```scheme
(version 1)
(allow default)

;; ATR write isolation: only /tmp allowed
(deny file-write* (subpath (param "HOME")))
(allow file-write*
    (subpath "/private/tmp/atr-test")
    (subpath "/private/var/folders")
)

;; Block all credential access
(deny file-read*
    (subpath (string-append (param "HOME") "/.ssh"))
    (subpath (string-append (param "HOME") "/.gnupg"))
    (subpath (string-append (param "HOME") "/.aws"))
)

;; Allow network only to localhost (bridge→PG)
(deny network-outbound)
(allow network-outbound (remote tcp "localhost:*"))
(allow network-outbound (remote tcp "127.0.0.1:*"))
(allow network-outbound (remote unix-socket))
```

### Phase 2: Zero-state verification

```bash
# 1. Create clean test directory
mkdir -p /tmp/atr-test

# 2. Run ATR submit in sandbox
sandbox-exec -f atr-test.sb -D HOME="$HOME" \
    ./anti-trace-relay submit \
    --relay http://localhost:8080 \
    --recipient-key "test-hex-key" \
    --message "test message"

# 3. Check for residual files
find /tmp/atr-test -type f  # Should be empty
find /tmp -name "*atr*" -o -name "*trace*"  # Should be empty
ls -la /tmp/atr-test/  # Should be empty or not exist
```

### Phase 3: Bridge connectivity test

```bash
# 1. Start privacy-gateway on localhost:8080
cd services/privacy-gateway && go run ./cmd/privacy-gateway/ &
PG_PID=$!

# 2. Run ATR bridge submit in sandbox
sandbox-exec -f atr-test.sb -D HOME="$HOME" \
    ./anti-trace-relay submit \
    --mode bridge \
    --relay http://localhost:8080 \
    --message "bridge test"

# 3. Verify submission arrived in PG
curl -s http://localhost:8080/v1/intake/dashboard

# 4. Cleanup
kill $PG_PID
```

### Phase 4: Sandbox escape attempts

Verify sandbox prevents:

```bash
# Should fail: write to home directory
sandbox-exec -f atr-test.sb -D HOME="$HOME" \
    bash -c 'echo "leak" > ~/test-leak.txt'

# Should fail: read SSH keys
sandbox-exec -f atr-test.sb -D HOME="$HOME" \
    bash -c 'cat ~/.ssh/id_ed25519'

# Should fail: network to external host
sandbox-exec -f atr-test.sb -D HOME="$HOME" \
    bash -c 'curl https://example.com'
```

## Success Signal

- ATR binary runs successfully inside sandbox
- Zero files remain after process exits
- Bridge→PG flow works through localhost
- Sandbox prevents credential access and external network
- All Phase 4 escape attempts fail as expected

## Failure Signal

- ATR binary requires filesystem writes that sandbox blocks (e.g., temp key derivation files)
- X25519 key operations fail under sandbox restrictions
- localhost networking doesn't work reliably in sandbox
- ATR process hangs or crashes due to sandbox signal handling differences

## Sandbox Profile

`claude-sandbox/atr-test.sb` implements a deny-default Seatbelt profile tailored to ATR:

- **Filesystem reads**: system libraries, `/usr/local/bin`, `/opt/homebrew/bin`, SSL certs only. All reads from `/Users` are blocked unless explicitly allowed.
- **Filesystem writes**: only `/tmp/atr-test`. Writes to `/Users` and `/var/folders` are explicitly denied.
- **Credential blocking**: explicit deny rules for `.ssh`, `.gnupg`, `.aws`, `.kube`, `.docker`, cloud-provider CLIs (gh, gcloud, railway, fly, op, azure), package manager credentials, shell history, and Claude config files.
- **Network**: deny all outbound by default; allow only TCP to `localhost:*` and `127.0.0.1:*`. Inbound on localhost is allowed for the bridge→PG test flow.
- **Process execution**: only `/bin/sh` and `/usr/bin/env` permitted.

The profile uses `(deny default)` at the top — unlike `claude-desktop.sb` which uses `(allow default)` and selectively denies. This is intentional: ATR must earn every permission rather than inheriting broad access.

## Verification Steps

### Prerequisites

```bash
mkdir -p /tmp/atr-test
```

### Step 1 — Basic execution

```bash
sandbox-exec -f claude-sandbox/atr-test.sb ./anti-trace-relay --help
```

Expected: binary prints help and exits 0. Any crash here indicates a missing system-library read rule.

### Step 2 — Zero-state check after submission

```bash
sandbox-exec -f claude-sandbox/atr-test.sb \
    ./anti-trace-relay submit \
    --relay http://localhost:8080 \
    --recipient-key "test-hex-key" \
    --message "test message"

ls /tmp/atr-test      # Should be empty or contain only ATR queue files
find /Users/messingtomas -newer /tmp/atr-test -type f 2>/dev/null
# Should print nothing — no files written to home
```

### Step 3 — Confirm external network is blocked

```bash
# Should exit non-zero and print a sandbox violation
sandbox-exec -f claude-sandbox/atr-test.sb \
    /bin/sh -c 'exec 3<>/dev/tcp/example.com/443; echo $?'
```

### Step 4 — Confirm credential reads are blocked

```bash
# Should print "Operation not permitted" or similar
sandbox-exec -f claude-sandbox/atr-test.sb \
    /bin/sh -c 'cat /Users/messingtomas/.ssh/id_ed25519'

sandbox-exec -f claude-sandbox/atr-test.sb \
    /bin/sh -c 'cat /Users/messingtomas/.aws/credentials'
```

### Step 5 — Bridge→PG flow

```bash
# Terminal A: start privacy-gateway
cd services/privacy-gateway && go run ./cmd/privacy-gateway/

# Terminal B: run ATR in sandbox
sandbox-exec -f claude-sandbox/atr-test.sb \
    ./anti-trace-relay submit \
    --mode bridge \
    --relay http://localhost:8080 \
    --message "bridge test"

# Verify submission arrived
curl -s http://localhost:8080/v1/intake/dashboard
```

## Known Constraints

- **ATR binary path**: profile allows reads from `/usr/local/bin` and `/opt/homebrew/bin`. If ATR binary lives elsewhere (e.g. `./anti-trace-relay` in repo root), add `(allow file-read* (literal "/Users/messingtomas/Taher/anti-trace-relay"))` or equivalent.
- **Go runtime temp files**: Go may write to `/var/folders` for its own temp use. If ATR crashes with a runtime error about temp dirs, add `(allow file-write* (subpath "/var/folders"))` and note the relaxation.
- **Unix domain sockets**: not currently allowed. If ATR or PG uses Unix sockets for IPC, add `(allow network-outbound (remote unix-socket))`.
- **Credential deny list is conservative**: paths listed cover the most common stores. Expand as new paths are discovered during testing — update both `atr-test.sb` and this doc.
- **`sandbox-exec` deprecation warning**: macOS may warn that `sandbox-exec` is deprecated on recent OS versions. It still functions as of macOS 15; revisit if behaviour changes in a future release.

## Evidence

*To be filled after testing.*

## Decision

*To be determined after testing.*

**Possible outcomes:**
- **accepted** -> ATR sandbox profile becomes standard integration test environment
- **rejected** -> ATR testing requires VM (filesystem operations incompatible with sandbox)
- **deferred** -> Needs ATR binary changes to support sandboxed execution
