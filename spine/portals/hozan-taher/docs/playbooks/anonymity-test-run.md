# Anonymity & human-likeness test — operator runbook

End-to-end procedure for the cross-mailbox anonymity test (initiative
[2026-05-01-cross-mailbox-anonymity-test](../initiatives/2026-05-01-cross-mailbox-anonymity-test.md)).

## Prerequisites

- 4 mailboxes are `status='active'` with valid passwords (mazher.a@email.cz, a.mazher@email.cz, b.maarek@email.cz, maarek.b@email.cz).
- Anti-trace-relay is reachable on Railway (the existing campaign runner uses the same client).
- `DATABASE_URL` exported in shell.
- Migrations 021 + 022 applied (verify with `psql -c "SELECT version FROM schema_migrations ORDER BY version DESC LIMIT 5"`).

## End-to-end run (~10 minutes)

### 1. Pause running campaigns first

The test sends 36 e-mails across the 4 mailboxes. Don't run while production campaigns are also dispatching — both compete for the same SMTP rate-limit budget.

```sh
# Pause running campaigns
PGPASSWORD=$DB_PWD psql -h $DB_HOST -p $DB_PORT -U $DB_USER -d $DB_NAME \
  -c "UPDATE campaigns SET status='paused' WHERE status IN ('running','sending');"
```

Note campaign IDs that flipped — you'll resume them in step 5.

### 2. Generate run UUID + dispatch 36 sends

```sh
RUN_ID=$(uuidgen | tr '[:upper:]' '[:lower:]')
echo "Run ID: $RUN_ID"

go build -o ./anonymity-test ./features/inbound/orchestrator/cmd/anonymity-test/
TEMPLATES_DIR=modules/outreach/configs/templates ./anonymity-test --run-id="$RUN_ID"
```

Expect 36 lines like:
```
[anon-test] run=<uuid> pair=mazher.a@email.cz->a.mazher@email.cz tmpl=intro_machinery ok
```
plus a final `36 sent / 0 errors` summary. With default 5s spacing, the loop completes in ~3 min.

### 3. Wait for delivery (~2–5 min)

Seznam typically delivers within 60s but sometimes longer. The harvester polls; you don't need to wait manually before kicking it off.

### 4. Harvest delivered messages from receiver inboxes

```sh
go build -o ./anonymity-harvest ./features/inbound/orchestrator/cmd/anonymity-harvest/
./anonymity-harvest --run-id="$RUN_ID" --max-wait-seconds=300
```

Expects 36 rows in `anonymity_test_messages` for this run-id. The binary exits non-zero with a Sentry warning if delivery is incomplete at the deadline.

```sh
PGPASSWORD=$DB_PWD psql -h $DB_HOST -p $DB_PORT -U $DB_USER -d $DB_NAME \
  -c "SELECT COUNT(*), MIN(harvested_at), MAX(harvested_at)
      FROM anonymity_test_messages WHERE test_run_id='$RUN_ID';"
```

### 5. Resume the campaigns paused in step 1

```sh
PGPASSWORD=$DB_PWD psql -h $DB_HOST -p $DB_PORT -U $DB_USER -d $DB_NAME \
  -c "UPDATE campaigns SET status='running' WHERE id IN (<list>);"
```

### 6. Score (after S3 + S4 land)

```sh
# anonymity scorer (S3)
./anonymity-score --run-id="$RUN_ID"

# human-likeness scorer (S4)
./anonymity-humanlike --run-id="$RUN_ID"
```

Reports written to `reports/anonymity/$RUN_ID/`:
- `scores.json` — per-message anonymity scores + leaks
- `summary.md` — markdown table per (sender, template)
- `humanlike.json` + `humanlike.md` — same but for human-likeness

### 7. Read the report

Open `reports/anonymity/$RUN_ID/summary.md`. Look for:

- Any (sender, template) cell with `anonymity_score < 80` — investigate the listed leaks; common causes:
  - Received chain shows non-Seznam IP → anti-trace-relay isn't masking egress
  - DKIM/SPF/DMARC fail → the FROM address doesn't match Seznam's signed domain
  - Return-Path != From → envelope mismatch (relay misconfig)
- Any template with `humanlike_score < 70` — variance / content / heuristics issues; tune the template or humanizer.

## Cleanup

The harvester moves each consumed message to IMAP folder
`Tested-Anonymity/<run-id>` per receiver inbox, so INBOX stays clean.
Skip the move with `--archive-folder=` (empty string).

## Troubleshooting

| Symptom | Diagnosis | Fix |
|---------|-----------|-----|
| `0 errors` but harvester finds 0 | Seznam rate-limited; messages bounced silently | Wait 1h, re-run with smaller `--mailbox-ids` |
| `template not found` from anonymity-test | `TEMPLATES_DIR` unset or wrong | `export TEMPLATES_DIR=modules/outreach/configs/templates` |
| harvester exits with `gap at deadline` | Delivery took >5 min | Re-run harvest only with longer `--max-wait-seconds=900` |
| anonymity-test fails on first send | Mailbox status non-active or placeholder pwd | `pnpm dev` → /priprava → fix mailbox |

## Cost (~$0.20/run when LLM judge wired up)

S3 + S4 run rule-based scoring locally for free. LLM-as-judge integration
(phase 2) calls Anthropic API once per message — 36 messages × ~$0.005 =
~$0.18. Don't run on every CI cron — once per launch + on-demand only.
