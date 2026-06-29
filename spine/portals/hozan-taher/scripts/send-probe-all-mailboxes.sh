#!/usr/bin/env bash
# send-probe-all-mailboxes.sh — SEND-S2 automation
#
# For each Seznam mailbox in DB, probe SMTP AUTH via prod anti-trace-relay
# /v1/auth-check. If AUTH succeeds, reset circuit state (status=active,
# circuit_opened_at=NULL, auth_fail_count=0).
#
# Pre-requisites:
#  - DATABASE_URL env (prod outreach DB via Railway TCP proxy)
#  - ANTI_TRACE_RELAY_URL env (https://anti-trace-relay-production-*.up.railway.app)
#  - ANTI_TRACE_RELAY_TOKEN env (bearer from Railway env)
#
# Usage:
#   bash scripts/send-probe-all-mailboxes.sh [--dry-run]
#
# --dry-run: read DB + relay only, no UPDATE. Safe to run anytime.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
ENV_FILE="$REPO_DIR/features/platform/outreach-dashboard/.env"

DRY_RUN=0
if [[ "${1:-}" == "--dry-run" ]]; then
  DRY_RUN=1
fi

# Load env from local .env if present
if [[ -f "$ENV_FILE" ]]; then
  # shellcheck disable=SC2046
  export $(grep -vE '^#|^$' "$ENV_FILE" | xargs -I{} echo {})
fi

: "${DATABASE_URL:?need DATABASE_URL}"
: "${ANTI_TRACE_RELAY_URL:?need ANTI_TRACE_RELAY_URL}"
: "${ANTI_TRACE_RELAY_TOKEN:?need ANTI_TRACE_RELAY_TOKEN}"

echo "→ SEND-S2 probe (DRY_RUN=$DRY_RUN)"
echo "  Relay: $ANTI_TRACE_RELAY_URL"
echo

# Fetch mailboxes via Node+pg (pg package available in features/platform/outreach-dashboard/node_modules)
MAILBOXES_JSON=$(cd "$REPO_DIR/features/platform/outreach-dashboard" && node --env-file=.env -e '
const pg = await import("pg");
const p = new pg.default.Pool({connectionString: process.env.DATABASE_URL});
const rows = (await p.query(
  `SELECT id, from_address, smtp_username, smtp_host, smtp_port, password,
          status, consecutive_bounces, auth_fail_count
   FROM outreach_mailboxes
   ORDER BY id`
)).rows;
console.log(JSON.stringify(rows));
await p.end();
')

COUNT=$(echo "$MAILBOXES_JSON" | node -e 'let d="";process.stdin.on("data",c=>d+=c);process.stdin.on("end",()=>console.log(JSON.parse(d).length))')
echo "Mailboxes: $COUNT"
echo

OK_COUNT=0
FAIL_COUNT=0

# Loop over mailboxes via node (array indexing + JSON in bash is fragile)
RESULTS=$(cd "$REPO_DIR/features/platform/outreach-dashboard" && node --env-file=.env <<EOF
const rows = $MAILBOXES_JSON;
const relayUrl = process.env.ANTI_TRACE_RELAY_URL;
const token = process.env.ANTI_TRACE_RELAY_TOKEN;

async function probe(mb) {
  const res = await fetch(relayUrl + "/v1/auth-check", {
    method: "POST",
    headers: { "Authorization": "Bearer " + token, "Content-Type": "application/json" },
    body: JSON.stringify({
      smtp_host: mb.smtp_host || "smtp.seznam.cz",
      smtp_port: mb.smtp_port || 465,
      smtp_username: mb.smtp_username || mb.from_address,
      password: mb.password || ""
    }),
  });
  return await res.json();
}

const out = [];
for (const mb of rows) {
  try {
    const r = await probe(mb);
    const smtpAuth = (r.steps || []).find(s => s.name === "smtp_auth");
    const authOk = smtpAuth ? smtpAuth.ok : r.ok;
    out.push({ id: mb.id, from: mb.from_address, ok: !!authOk, error: r.error || (smtpAuth ? smtpAuth.msg : null), status: mb.status });
  } catch (e) {
    out.push({ id: mb.id, from: mb.from_address, ok: false, error: e.message, status: mb.status });
  }
}
console.log(JSON.stringify(out));
EOF
)

echo "$RESULTS" | node -e '
let d="";process.stdin.on("data",c=>d+=c);process.stdin.on("end",()=>{
  const rows = JSON.parse(d);
  for (const r of rows) {
    const marker = r.ok ? "✓" : "✗";
    console.log(`  ${marker} mb=${r.id} ${r.from} [${r.status}] ${r.ok ? "AUTH OK" : "FAIL: " + (r.error||"?")}`);
  }
})'
echo

# Reset circuit for OK mailboxes (unless --dry-run)
if [[ $DRY_RUN -eq 0 ]]; then
  OK_IDS=$(echo "$RESULTS" | node -e 'let d="";process.stdin.on("data",c=>d+=c);process.stdin.on("end",()=>{
    const rows = JSON.parse(d);
    console.log(rows.filter(r=>r.ok).map(r=>r.id).join(","));
  })')
  if [[ -n "$OK_IDS" ]]; then
    echo "→ reset circuit for mb IN ($OK_IDS)"
    (cd "$REPO_DIR/features/platform/outreach-dashboard" && node --env-file=.env -e "
      const pg = await import('pg');
      const p = new pg.default.Pool({connectionString: process.env.DATABASE_URL});
      const ids = '$OK_IDS'.split(',').map(n=>parseInt(n,10));
      const r = await p.query(
        \`UPDATE outreach_mailboxes
         SET status = 'active',
             status_reason = NULL,
             circuit_opened_at = NULL,
             auth_fail_count = 0,
             auth_fail_at = NULL
         WHERE id = ANY(\$1::int[])
         RETURNING id, status\`,
        [ids]
      );
      console.log('  updated:', JSON.stringify(r.rows));
      await p.end();
    ")
  else
    echo "→ no OK mailboxes to reset"
  fi
else
  echo "→ DRY_RUN: skipping circuit reset"
fi

echo
echo "SEND-S2 done."
