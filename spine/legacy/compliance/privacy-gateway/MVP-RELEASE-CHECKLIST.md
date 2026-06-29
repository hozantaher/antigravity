# Privacy Gateway MVP Release Checklist

## How To Use This Checklist

Status meanings:

- `DONE` means implemented and already represented in the current build
- `PARTIAL` means present but still needs release hardening or explicit verification
- `BLOCKER` means must be completed before calling the service MVP-ready

This checklist is intentionally scoped to the MVP defined in [MVP.md](/Users/messingtomas/Taher/hozan-taher/services/privacy-gateway/MVP.md).

## Product Scope

- `DONE` Product is framed as a `privacy-preserving email gateway API`, not a maximal-anonymity system.
- `DONE` MVP user flows are defined for alias setup, outbound send, and inbound sync/read.
- `DONE` Post-MVP work is separated from MVP scope.

## Flow 1: Alias Setup

- `DONE` Authenticated alias creation via `POST /v1/aliases`
- `DONE` Authenticated alias listing via `GET /v1/aliases`
- `DONE` Alias ownership is scoped to actor/tenant in the current model
- `PARTIAL` API error envelope and contract should be frozen for first external integrator use

## Flow 2: Outbound Send

- `DONE` Native outbound submission create via `POST /v1/submissions`
- `DONE` Native outbound relay via `POST /v1/submissions/{id}/relay`
- `DONE` Legacy compatibility send via `POST /v1/messages`
- `DONE` Alias ownership checks
- `DONE` Recipient count, body size, and subject validation
- `DONE` Header-injection protection for subject handling
- `DONE` `record-only` mode for safe local/dev operation
- `DONE` SMTP mode wiring for relay-backed environments
- `DONE` Native submission detail and timeline reads
- `DONE` Outbox listing via `GET /v1/messages/outbox` (`legacy compat`)
- `PARTIAL` Live relay verification against a real SMTP environment is still needed
- `DONE` A short operator runbook exists for SMTP env setup and sender-domain constraints
- `DONE` A live verification plan exists for provider-backed SMTP validation

## Flow 3: Inbound Sync And Read

- `DONE` Inbox listing via `GET /v1/messages/inbox`
- `DONE` IMAP sync trigger via `POST /v1/messages/inbox/sync`
- `DONE` Incremental IMAP cursoring per actor
- `DONE` Persistent inbox storage across restart
- `DONE` Plain-text extraction from common inbound formats
- `DONE` Attachment metadata extraction
- `DONE` Attachment policy outcomes on inbox records
- `PARTIAL` Live IMAP verification against a real mailbox environment is still needed
- `PARTIAL` Current parsing is intentionally MVP-grade and should be documented as such for early users
- `DONE` A short operator runbook exists for IMAP env setup and sync expectations
- `DONE` A live verification plan exists for provider-backed IMAP validation

## Persistence And Safety

- `DONE` Local file-backed persistence for aliases, outbox, inbox, and IMAP cursor state
- `DONE` Atomic writes with restrictive file and directory permissions
- `DONE` Encryption at rest with `DATA_ENCRYPTION_KEY_B64`
- `DONE` Attachment metadata is stored separately from message body text
- `DONE` High-risk attachment types are marked `blocked`
- `PARTIAL` No database-backed persistence yet; acceptable for MVP, but the limitation should be explicit

## Security Baseline

- `DONE` No raw SMTP/IMAP/POP3 access exposed to clients
- `DONE` No HTML outbound passthrough
- `DONE` No open relay behavior in the current API path
- `DONE` Secrets are configuration-driven rather than hardcoded
- `DONE` Conservative attachment policy defaults exist
- `PARTIAL` No quarantine workflow exists; acceptable because it is explicitly post-MVP, but blocked artifacts are only represented as metadata today

## QA And Verification

- `DONE` Unit/integration test suite is green
- `DONE` Coverage is above the current project threshold
- `PARTIAL` End-to-end verification with a real SMTP relay and a real IMAP mailbox remains outstanding
- `DONE` A scripted manual smoke test exists for the 3 MVP flows

## Documentation

- `DONE` README describes current service behavior
- `DONE` MVP scope is documented
- `DONE` README links to the release checklist for operator use
- `DONE` A minimal first-deploy/operator guide exists for `record-only`, `smtp`, and `imap`

## MVP Release Decision

Current position:

- core product scope: `DONE`
- core implementation: `DONE`
- release hardening: `PARTIAL`
- release blockers: only live provider verification remains

The service is close to MVP-complete in code, but not yet release-ready.

## Immediate Next Actions

1. Verify native submission create + relay once against real provider SMTP infrastructure.
2. Verify inbound IMAP once against real provider infrastructure.
3. Freeze the first release candidate after those live checks pass.

After those items, the project should be in a credible position for an MVP release candidate.
