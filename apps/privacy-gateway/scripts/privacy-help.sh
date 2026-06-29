#!/bin/sh

set -eu

cat <<'EOF'
Privacy Gateway Root Commands

Run from repo root: /Users/messingtomas/Taher/hozan-taher

Stability:
  ./scripts/run-privacy-stability.sh
  ./scripts/run-privacy-stability.sh --strict-rc
  ./scripts/run-privacy-stability.sh --skip-anti-trace

RC readiness / postrun:
  ./scripts/show-privacy-rc-readiness.sh
  ./scripts/show-privacy-rc-readiness.sh --strict
  ./scripts/run-privacy-rc-postrun.sh
  ./scripts/run-privacy-rc-postrun.sh --apply

Fastmail:
  ./scripts/prepare-privacy-fastmail-env.sh ./.env.fastmail.local
  ./scripts/run-privacy-fastmail-assist.sh ./.env.fastmail.local

Tip:
  For service-local commands, see:
  /Users/messingtomas/Taher/hozan-taher/services/privacy-gateway/README.md

Tooling health:
  ./scripts/privacy-self-check.sh
  ./scripts/privacy-self-check.sh --fast
  ./scripts/privacy-self-check.sh --json
  ./scripts/privacy-json-smoke.sh /tmp/privacy-status-snapshots
  ./scripts/privacy-ci.sh /tmp/privacy-status-snapshots
  ./scripts/privacy-ci.sh /tmp/privacy-status-snapshots --json
  ./scripts/privacy-ci.sh /tmp/privacy-status-snapshots --self-check-once --json
  ./scripts/privacy-ci.sh /tmp/privacy-status-snapshots --report-json-path /tmp/privacy-status-report.json --json
  ./scripts/privacy-ci.sh /tmp/privacy-status-snapshots --strict-gate --json
  ./scripts/privacy-ci.sh /tmp/privacy-status-snapshots --require-decision GO --max-blockers 0 --json

Decision support:
  ./scripts/privacy-next-step.sh
  ./scripts/privacy-next-step.sh --json
  ./scripts/privacy-blockers.sh
  ./scripts/privacy-blockers.sh --json

Full status:
  ./scripts/privacy-status.sh
  ./scripts/privacy-status.sh --json
  ./scripts/privacy-capture-status.sh
  ./scripts/privacy-capture-status.sh /tmp/privacy-status-snapshots --skip-self-check
  ./scripts/privacy-capture-status.sh /tmp/privacy-status-snapshots --skip-self-check --json
  ./scripts/privacy-prune-snapshots.sh /tmp/privacy-status-snapshots --keep 20 --dry-run
  ./scripts/privacy-prune-snapshots.sh /tmp/privacy-status-snapshots --keep 20 --dry-run --json
  ./scripts/privacy-compare-snapshots.sh /tmp/privacy-status-snapshots
  ./scripts/privacy-compare-snapshots.sh /tmp/privacy-status-snapshots --json
  ./scripts/privacy-trend.sh /tmp/privacy-status-snapshots --limit 5
  ./scripts/privacy-trend.sh /tmp/privacy-status-snapshots --limit 5 --json
  ./scripts/privacy-refresh.sh /tmp/privacy-status-snapshots
  ./scripts/privacy-refresh.sh /tmp/privacy-status-snapshots --json
  ./scripts/privacy-refresh.sh /tmp/privacy-status-snapshots --prune-keep 20 --prune-dry-run
  ./scripts/privacy-gate.sh --require-state artifacts_ready --max-blockers 6
  ./scripts/privacy-gate.sh --require-state artifacts_ready --max-blockers 6 --json
  ./scripts/privacy-gate.sh --strict-gate --json
  ./scripts/privacy-refresh-gate.sh /tmp/privacy-status-snapshots
  ./scripts/privacy-refresh-gate.sh /tmp/privacy-status-snapshots --json
  ./scripts/privacy-refresh-gate.sh /tmp/privacy-status-snapshots --strict-gate --json
  ./scripts/privacy-refresh-gate.sh /tmp/privacy-status-snapshots --with-self-check
  ./scripts/privacy-refresh-gate.sh /tmp/privacy-status-snapshots --prune-keep 20 --prune-dry-run
  ./scripts/privacy-report.sh /tmp/privacy-status-report.md --snapshot-dir /tmp/privacy-status-snapshots
  ./scripts/privacy-report.sh /tmp/privacy-status-report.json --snapshot-dir /tmp/privacy-status-snapshots --json
  ./scripts/privacy-report.sh /tmp/privacy-status-report.json --snapshot-dir /tmp/privacy-status-snapshots --strict-gate --json
  ./scripts/privacy-ci.sh /tmp/privacy-status-snapshots --with-self-check --prune-keep 20 --prune-dry-run
EOF
