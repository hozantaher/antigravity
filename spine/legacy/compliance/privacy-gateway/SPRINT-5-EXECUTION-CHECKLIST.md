# Sprint 5 Execution Checklist

## Goal

Complete the first real provider-backed verification run for the privacy-first communication gateway.

## Definition Of Done

- real SMTP verification: `PASS`
- real IMAP verification: `PASS`
- restart persistence verification: `PASS`
- incremental sync verification: `PASS`
- privacy-first read-model verification: `PASS`
- live report updated
- RC decision can be rechecked

## Pre-Run

- confirm provider credentials exist
- confirm `.env` is prepared
- confirm operator uses the latest run sheet
- confirm current build is the intended candidate

## Run

1. start service against real provider config
2. verify `/healthz`
3. create alias
4. verify outbound SMTP through native submission create + relay
5. verify inbound plain-text IMAP
6. verify inbound attachment metadata IMAP
7. verify restart persistence
8. verify incremental sync
9. verify:
   - `/v1/messages/inbox/{id}/timeline`
   - `/v1/aliases/{id}/timeline`
   - `/v1/channels`
   - or run `scripts/verify-read-models.sh`, which can auto-discover the active alias and latest related IDs
   - if `INTAKE_API_TOKEN` is set, intake read-model checks also run during postcheck

## Capture

- live report draft updated
- relevant excerpts copied
- provider caveats recorded

## Exit

- update RC snapshot
- update RC decision memo if needed
- decide `GO` or `NO-GO`

## Shortest Helper Sequence

Use this compressed sequence when the real provider env is ready:

1. `./scripts/start-live-run.sh ./.env.fastmail.local`
2. perform the SMTP and IMAP checks from the run sheet
3. `./scripts/run-live-postcheck.sh`
4. `./scripts/stop-live-run.sh`

Assisted variant:

1. `./scripts/fastmail-live-assist.sh ./.env.fastmail.local`
