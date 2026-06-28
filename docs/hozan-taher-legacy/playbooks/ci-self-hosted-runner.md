# CI on a self-hosted runner (zero GitHub-Actions cost)

**Problem this solves.** GitHub-hosted runner minutes are billed for private repos
beyond the free quota. When the org's Actions billing lapsed, every check went red
with *"the job was not started because recent account payments have failed or your
spending limit needs to be increased"* — including trivial docs PRs, because the
failure is at the runner-allocation layer, not in the code.

**Fix.** Run all CI on a **self-hosted runner**. Self-hosted minutes are free and do
**not** count against the Actions quota. One always-on box runs the same workflows for
$0. This is the recommended use for *private* repos (the fork-PR security caveat that
makes self-hosted risky applies to *public* repos).

## Setup (once)

1. **Oracle Cloud "Always Free" VM** — Compute → Create Instance:
   - Shape **`VM.Standard.A1.Flex`** (Ampere ARM), image **Ubuntu 24.04**, up to **4 OCPU / 24 GB** (the full free allowance).
   - Add your SSH key. No extra inbound ports needed — the runner dials out to GitHub.
2. **Registration token** — repo Settings → Actions → Runners → *New self-hosted runner* → Linux / **ARM64** → copy the token.
3. **Run the installer** on the box:
   ```bash
   scp scripts/ci/setup-oracle-runner.sh ubuntu@<vm-ip>:~/
   ssh ubuntu@<vm-ip>
   RUNNER_TOKEN=<token> bash setup-oracle-runner.sh
   ```
   The runner appears as **Idle** in Settings → Actions → Runners. It's installed as a
   service, so it survives reboots.

## What changed in the repo

- All workflow jobs were switched from `runs-on: ubuntu-latest` → `runs-on: self-hosted`.
- **`mcp-docker.yml`** ("Build & Push to GHCR") pins `platforms: linux/amd64` — the box is
  ARM64, so it cross-builds amd64 via qemu to keep published images amd64. Only runs on
  `main` push, so the slower qemu build is not on the PR path.
- **`bot-worker.yml`** schedule is **disabled** (it's a stub — the Claude invocation is a
  placeholder). Re-enable the `*/30` cron once the autonomous-fix agent is actually wired.
- `dependabot.yml` was already weekly + grouped; the PR pileup was the billing outage, not config.

## Scaling throughput

One runner executes jobs **serially**. With many PR-triggered jobs this makes a single PR's
full CI slow. To parallelize, register more runners on the same box (the 4-OCPU free shape
handles ~3):

```bash
RUNNER_COUNT=3 bash scripts/ci/setup-oracle-runner.sh
```

## Reusing across repos

Register at **org level** (Org Settings → Actions → Runners) with
`REPO_URL=https://github.com/hozantaher` to serve `hozan-taher`, `properlak`, and
`octavius` from one box. `auction24` lives in a different org and needs its own.

## Verifying ARM compatibility (first run)

Most jobs are Go / Node / bash and run native ARM. Watch the first green run for:
`docker-smoke` builds (native ARM, build-only — fine), `services:` Postgres containers
(arm64 image — fine), and **CodeQL** (`Analyze Go` / `Analyze JS`) which needs the
linux-arm64 CodeQL bundle (supported). If any job assumes amd64 binaries, pin its build
to `linux/amd64` like `mcp-docker.yml`.
