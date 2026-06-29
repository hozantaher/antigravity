# Fastmail Go / No-Go Preflight

## Goal

Make one fast decision before the first real Fastmail verification run:

- `GO`
- or `NO-GO`

## Go Rule

You are `GO` only if every item below is true.

## 1. Config Ready

- `.env.fastmail.local` exists
- `./scripts/check-fastmail-env.sh ./.env.fastmail.local` passes
- no `REPLACE_...` placeholder remains
- the same `DATA_ENCRYPTION_KEY_B64` will be reused for the restart check

## 2. Provider Ready

- Fastmail app password exists
- app password is for mail access
- SMTP mailbox is reachable
- IMAP mailbox is reachable
- recipient mailbox is reachable for manual confirmation

## 3. Run Assets Open

- [FASTMAIL-RUN-SHEET.md](/Users/messingtomas/Taher/hozan-taher/services/privacy-gateway/FASTMAIL-RUN-SHEET.md) is open
- [FASTMAIL-LIVE-REPORT-DRAFT.md](/Users/messingtomas/Taher/hozan-taher/services/privacy-gateway/FASTMAIL-LIVE-REPORT-DRAFT.md) is open
- [SPRINT-5-EXECUTION-CHECKLIST.md](/Users/messingtomas/Taher/hozan-taher/services/privacy-gateway/SPRINT-5-EXECUTION-CHECKLIST.md) is open

## 4. Test Identities Known

- you know which mailbox will receive `PG FASTMAIL SMTP LIVE 1`
- you know which mailbox is used for IMAP sync
- you know which alias domain you are verifying
- you know which alias id you will use after creation

## 5. Runtime Ready

- current local build is the intended release candidate
- the service starts cleanly with the Fastmail env file
- `/healthz` returns `200`

## 6. Read-Model Verification Ready

- after the run you are prepared to verify:
  - `/v1/messages/inbox/{id}/timeline`
  - `/v1/aliases/{id}/timeline`
  - `/v1/channels`

## Decision

### `GO`

All six sections above are true.

### `NO-GO`

Choose `NO-GO` immediately if any of these are true:

- env checker fails
- app password is still uncertain
- mailbox roles are still ambiguous
- the service does not start cleanly
- you are not ready to capture evidence during the run

## Immediate Next Command Set

If `GO`, proceed with:

```bash
./scripts/check-fastmail-env.sh ./.env.fastmail.local
set -a
source ./.env.fastmail.local
set +a
go run ./cmd/privacy-gateway
```
