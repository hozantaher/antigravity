# Fastmail Dry-Run Commands

## Goal

This is the copy-paste command set for a first Fastmail dry run.

Before running:

- fill in [FASTMAIL.env.example](/Users/messingtomas/Taher/hozan-taher/services/privacy-gateway/FASTMAIL.env.example)
- or, preferably, fill in [.env.fastmail.local.example](/Users/messingtomas/Taher/hozan-taher/services/privacy-gateway/.env.fastmail.local.example) and save it as `.env.fastmail.local`
- or use [prepare-fastmail-env.sh](/Users/messingtomas/Taher/hozan-taher/services/privacy-gateway/scripts/prepare-fastmail-env.sh) to generate `.env.fastmail.local` from the 4 real values you actually need
- save your real values into a local env file such as `.env.fastmail.local`
- do not commit that local file
- make sure `IMAP_TIMEOUT_SECONDS` is present and positive
- run the preflight checker:

```bash
./scripts/prepare-fastmail-env.sh ./.env.fastmail.local
./scripts/check-fastmail-env.sh ./.env.fastmail.local
```

Non-interactive variant (CI or copy-paste reproducibility):

```bash
./scripts/prepare-fastmail-env.sh ./.env.fastmail.local your-domain.example fastmail-user@your-domain.example recipient@your-domain.example your-fastmail-app-password
./scripts/check-fastmail-env.sh ./.env.fastmail.local
```

Note:

- if `ALIAS_DOMAIN` is omitted, `prepare-fastmail-env.sh` derives it from the gateway email domain

## Shortest End-To-End Shape

If you want the most compressed operator path, use this sequence:

```bash
./scripts/start-live-run.sh ./.env.fastmail.local
```

Then do the actual provider-backed SMTP/IMAP steps from the run sheet.

After the live checks are done:

```bash
./scripts/run-live-postcheck.sh
./scripts/stop-live-run.sh
```

Single assisted entrypoint:

```bash
./scripts/fastmail-live-assist.sh ./.env.fastmail.local
```

Assisted entrypoint with RC post-run workflow:

```bash
RUN_RC_POSTRUN=true ./scripts/fastmail-live-assist.sh ./.env.fastmail.local
```

Apply variant (updates canonical RC docs with backups):

```bash
RUN_RC_POSTRUN=true RC_POSTRUN_APPLY=true ./scripts/fastmail-live-assist.sh ./.env.fastmail.local
```

Postcheck defaults:

- if `ARTIFACT_DIR` is not provided, `run-live-postcheck.sh` reuses the last run path saved by `start-live-run.sh`
- if no last-run marker exists, postcheck falls back to a fresh artifact directory
- if `ENV_FILE` is not provided and `./.env.fastmail.local` exists, postcheck auto-loads it
- if `API_TOKEN` is not explicitly set, postcheck uses `DEV_API_TOKEN` from the loaded env file, then falls back to `dev-token`

## 1. Start The Service

From [services/privacy-gateway](/Users/messingtomas/Taher/hozan-taher/services/privacy-gateway):

```bash
set -a
source ./.env.fastmail.local
set +a
go run ./cmd/privacy-gateway
```

Open a second terminal in the same directory for the API calls below.

Shortest startup path:

```bash
./scripts/start-live-run.sh ./.env.fastmail.local
```

To stop the background service later:

```bash
./scripts/stop-live-run.sh
```

If you want to stop a specific old run explicitly, you can still pass:

```bash
./scripts/stop-live-run.sh ./artifacts/<run-dir>
```

## 2. Health Check

```bash
curl http://localhost:8080/healthz
```

## 3. Create Alias

```bash
curl -X POST http://localhost:8080/v1/aliases \
  -H "Authorization: Bearer ${DEV_API_TOKEN}" \
  -H "Content-Type: application/json" \
  -d '{"label":"support"}'
```

Save the returned `id` as `ALIAS_ID`.

## 4. List Aliases

```bash
curl http://localhost:8080/v1/aliases \
  -H "Authorization: Bearer ${DEV_API_TOKEN}"
```

## 5. Create Native Submission

Replace `REPLACE_ALIAS_ID` and `recipient@example.com`.

```bash
curl -X POST http://localhost:8080/v1/submissions \
  -H "Authorization: Bearer ${DEV_API_TOKEN}" \
  -H "Content-Type: application/json" \
  -d '{
    "channel_id":"REPLACE_ALIAS_ID",
    "to":["recipient@example.com"],
    "subject":"PG FASTMAIL SMTP LIVE 1",
    "text_body":"Fastmail outbound verification body."
  }'
```

Save the returned submission `id`.

## 6. Relay Native Submission

Replace `REPLACE_SUBMISSION_ID`.

```bash
curl -X POST http://localhost:8080/v1/submissions/REPLACE_SUBMISSION_ID/relay \
  -H "Authorization: Bearer ${DEV_API_TOKEN}"
```

## 7. Inspect Native Submission

```bash
curl http://localhost:8080/v1/submissions/REPLACE_SUBMISSION_ID \
  -H "Authorization: Bearer ${DEV_API_TOKEN}"
```

## 8. Legacy Compatibility Fallback

Use this only if you intentionally want to exercise the legacy bridge.

Replace `REPLACE_ALIAS_ID` and `recipient@example.com`.

```bash
curl -X POST http://localhost:8080/v1/messages \
  -H "Authorization: Bearer ${DEV_API_TOKEN}" \
  -H "Content-Type: application/json" \
  -d '{
    "alias_id":"REPLACE_ALIAS_ID",
    "to":["recipient@example.com"],
    "subject":"PG FASTMAIL SMTP LIVE 1",
    "text_body":"Fastmail outbound verification body."
  }'
```

## 9. Inspect Outbox

```bash
curl http://localhost:8080/v1/messages/outbox \
  -H "Authorization: Bearer ${DEV_API_TOKEN}"
```

## 10. Trigger IMAP Sync

Run this after placing or sending the test message into the IMAP mailbox.

```bash
curl -X POST http://localhost:8080/v1/messages/inbox/sync \
  -H "Authorization: Bearer ${DEV_API_TOKEN}"
```

## 11. Inspect Inbox

```bash
curl http://localhost:8080/v1/messages/inbox \
  -H "Authorization: Bearer ${DEV_API_TOKEN}"
```

## 12. Restart Persistence Check

Stop the first process, start it again with the same env file, then run:

```bash
curl http://localhost:8080/v1/aliases \
  -H "Authorization: Bearer ${DEV_API_TOKEN}"
```

```bash
curl http://localhost:8080/v1/submissions/REPLACE_SUBMISSION_ID \
  -H "Authorization: Bearer ${DEV_API_TOKEN}"
```

```bash
curl http://localhost:8080/v1/messages/outbox \
  -H "Authorization: Bearer ${DEV_API_TOKEN}"
```

```bash
curl http://localhost:8080/v1/messages/inbox \
  -H "Authorization: Bearer ${DEV_API_TOKEN}"
```

## 13. Incremental Sync Check

After placing one additional inbound message in the mailbox:

```bash
curl -X POST http://localhost:8080/v1/messages/inbox/sync \
  -H "Authorization: Bearer ${DEV_API_TOKEN}"
```

```bash
curl http://localhost:8080/v1/messages/inbox \
  -H "Authorization: Bearer ${DEV_API_TOKEN}"
```

## 14. Capture Final Results

Use:

- [FASTMAIL-RUN-SHEET.md](/Users/messingtomas/Taher/hozan-taher/services/privacy-gateway/FASTMAIL-RUN-SHEET.md)
- [LIVE-VERIFICATION-REPORT-TEMPLATE.md](/Users/messingtomas/Taher/hozan-taher/services/privacy-gateway/LIVE-VERIFICATION-REPORT-TEMPLATE.md)
- [collect-live-evidence.sh](/Users/messingtomas/Taher/hozan-taher/services/privacy-gateway/scripts/collect-live-evidence.sh)
- [verify-read-models.sh](/Users/messingtomas/Taher/hozan-taher/services/privacy-gateway/scripts/verify-read-models.sh)
- [bootstrap-live-report.sh](/Users/messingtomas/Taher/hozan-taher/services/privacy-gateway/scripts/bootstrap-live-report.sh)
- [run-live-postcheck.sh](/Users/messingtomas/Taher/hozan-taher/services/privacy-gateway/scripts/run-live-postcheck.sh)
- [stop-live-run.sh](/Users/messingtomas/Taher/hozan-taher/services/privacy-gateway/scripts/stop-live-run.sh)
- [start-live-run.sh](/Users/messingtomas/Taher/hozan-taher/services/privacy-gateway/scripts/start-live-run.sh)
- [fastmail-live-assist.sh](/Users/messingtomas/Taher/hozan-taher/services/privacy-gateway/scripts/fastmail-live-assist.sh)

to record the result and decide whether the run passed.

The evidence helper now captures native submission artifacts as well, including:

- `submissions.json`
- `submission.json`
- `submission-timeline.json`

Shortest post-run path:

```bash
./scripts/run-live-postcheck.sh
```

RC decision helper from generated report:

```bash
./scripts/show-rc-readiness.sh
./scripts/run-rc-postrun-workflow.sh ./artifacts/<run-dir>/live-verification-report.md ./artifacts/<run-dir>
./scripts/check-live-artifact-set.sh ./artifacts/<run-dir>
./scripts/prepare-rc-update-summary.sh ./artifacts/<run-dir>/live-verification-report.md
./scripts/prepare-rc-doc-sync-draft.sh ./artifacts/<run-dir>/rc-update-summary.md
./scripts/apply-rc-doc-sync-draft.sh ./artifacts/<run-dir>
./scripts/check-rc-doc-consistency.sh
```

Optional explicit env file:

```bash
ENV_FILE=./.env.fastmail.local ./scripts/run-live-postcheck.sh
```

Optional intake coverage in postcheck:

- if `INTAKE_API_TOKEN` is set, the postcheck also verifies:
  - `GET /v1/intake/dashboard`
  - `GET /v1/intake/queue`
  - `GET /v1/intake/submissions/{id}`
  - `GET /v1/intake/submissions/{id}/timeline`

- if `INTAKE_API_TOKEN` is not set, intake checks are skipped and operator-side checks still run.
- if `INTAKE_API_TOKEN` is set, evidence collection also includes:
  - `intake-dashboard.json`
  - `intake-queue.json`
  - `intake-submission.json`
  - `intake-submission-timeline.json`

Helper script env behavior:

- `run-live-postcheck.sh`, `verify-read-models.sh`, and `collect-live-evidence.sh` auto-load `./.env.fastmail.local` when present (or `ENV_FILE=...`)
- token resolution order is `API_TOKEN` -> `DEV_API_TOKEN` -> `dev-token`
