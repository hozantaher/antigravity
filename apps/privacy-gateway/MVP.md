# Privacy-First Communication Gateway MVP

## Product Frame

This MVP is a `privacy-first communication gateway`.

It is not a promise of perfect anonymity, untraceability, or a censorship-resistant mail network.
The MVP goal is narrower and honest:

- minimize unnecessary metadata exposure inside the system boundary
- separate intake, identity, audit, and transport concerns
- provide safe submission, relay, and inbox flows behind a controlled gateway
- enforce conservative defaults for message, identity, and attachment handling

## Target User

Primary user for MVP:

- a developer or small team integrating sensitive communication into an application
- wants safer defaults than direct app-to-SMTP/IMAP wiring
- wants intake, audit, and identity separation before building UI
- accepts an API-first backend before any admin UI exists

## MVP Outcome

By MVP release, one authenticated actor can:

1. create a submission
2. inspect audit events for that submission
3. create and list identity links
4. relay or compatibility-send through the controlled mail path
5. sync and read normalized inbound messages from the API

## In Scope

- authenticated HTTP API
- submission create/list/detail
- audit event listing
- identity link create/list
- alias creation and alias listing
- policy-checked outbound submission
- `record-only` delivery mode for safe local/dev operation
- opt-in SMTP relay mode for outbound delivery
- opt-in IMAP sync for inbound mail
- local inbox and outbox persistence
- encryption at rest for persisted local state
- per-actor IMAP cursoring
- plain-text extraction from common inbound formats
- attachment metadata extraction
- default attachment policy outcomes on inbox records

## Explicitly Out Of Scope

- claims of maximal anonymity or “untraceable email”
- POP3 support
- full MIME reconstruction
- attachment download or attachment rendering
- quarantine workflow
- abuse operations console
- bounce handling and deliverability management
- multi-user admin UI
- provider webhooks
- KMS/HSM-backed production secret management
- distributed anonymizer or mixnet routing

## MVP User Flows

### Flow 1: Submission Intake

- client authenticates with bearer token
- client submits message via `POST /v1/submissions`
- client inspects submission state via `GET /v1/submissions`

### Flow 2: Identity And Audit

- client creates identity link via `POST /v1/identity-links`
- client lists tenant identity links via `GET /v1/identity-links`
- client inspects tenant audit trail via `GET /v1/audit-events`

### Flow 3: Relay And Inbox

- client uses compatibility mail send or relay-backed mode when needed
- client triggers sync via `POST /v1/messages/inbox/sync`
- service fetches newest IMAP messages or resumes from stored cursor
- service normalizes inbound body text
- service stores attachment metadata with policy outcomes
- client reads inbox via `GET /v1/messages/inbox`

## MVP Acceptance Criteria

- submission lifecycle works for one authenticated actor
- identity links and audit events persist across restart
- outbound compatibility submission works in `record-only` mode
- outbound SMTP mode can be configured without changing app logic
- inbound IMAP sync stores readable normalized inbox messages
- inbox sync is incremental after the initial backfill
- persisted state survives service restart
- stored state can be encrypted with `DATA_ENCRYPTION_KEY_B64`
- risky attachment types are not treated as message body content
- tests pass with coverage at or above the current engineering bar

## Security Baseline For MVP

- no raw client access to SMTP, POP3, or IMAP
- no HTML outbound passthrough
- no arbitrary header injection
- no open relay behavior
- no public reverse-lookup workflow in the identity vault
- attachment handling is metadata-first, not content-serving
- secrets come from environment configuration
- conservative attachment policy defaults are enabled

## Post-MVP Candidates

### v1.1

- quarantine queue for blocked attachments
- attachment policy configuration
- message provenance/audit trail
- inbound filtering rules per alias

### v1.2

- richer MIME parsing
- bounce and failure lifecycle
- admin/operator API
- persistent database-backed stores

### v2+

- multi-tenant operational controls
- reputation and abuse controls
- hardened vault/KMS integration
- advanced privacy relay architecture beyond standard email constraints

## Current Build Position

As of now, the codebase is already close to the defined MVP:

- core outbound flow exists
- IMAP inbound flow exists
- cursoring exists
- encryption at rest exists
- attachment metadata and attachment policy exist

The main work remaining after MVP definition should focus on:

- stabilizing the privacy-first core flows
- tightening release criteria
- avoiding scope creep into stronger-anonymity or operator-console work
