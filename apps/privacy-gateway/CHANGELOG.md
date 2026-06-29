# Changelog

All notable changes to the privacy-gateway service.

## [0.1.0] - 2026-04-03

### MVP Release

Privacy-first email relay backend with alias management, sanitization, and operator tooling.
16 packages, Go stdlib only, single binary.

### Added

#### Core Features
- Alias creation and management (random suffix, configurable domain)
- Submission lifecycle (accepted -> sanitized -> relayed/failed/blocked)
- Content and header sanitization (strip fingerprinting metadata)
- Identity vault with encrypted alias-to-identity mappings
- Outbound relay with record-only and SMTP delivery modes
- IMAP inbound sync with cursor-based incremental backfill
- Attachment metadata extraction with policy-based handling

#### Operator Tooling
- Dashboard (channels, submission counts, relay stats)
- Channel timelines (alias -> submissions -> inbox -> relay attempts)
- Submission timelines (lifecycle with relay details)
- Inbox timelines (inbound message with linked context)
- Relay queue visibility
- Audit event listing with tenant-scoped filtering

#### Intake System
- POST /v1/intake/submissions (separate auth, sanitizer profile)
- GET /v1/intake/status (aggregate stats)
- GET /v1/intake/timeline (filtered submission history)

#### Storage and Security
- AES-256-GCM encryption at rest via pluggable codec
- Atomic file writes (temp + rename)
- Activity-driven retention pruning across all stores
- Configurable retention profiles (dev, small-team, privacy-strict)
- Bearer token authentication (separate operator and intake tokens)

#### API (frozen for MVP)
- 20 HTTP endpoints covering aliases, submissions, messages, inbox, audit, identity links, relay attempts, channels, dashboard
- Strict JSON body validation (unknown fields rejected)
- Size limits enforced

#### Deployment
- Record-only mode (safe local development)
- SMTP mode (real outbound delivery)
- IMAP sync mode (incremental inbound)
- Environment-based configuration
- Operator guide and query cookbook

### Verified
- Full test suite across 16 packages
- Local SMTP verification against MailHog (2 messages delivered)
- Privacy headers absent in delivered messages (X-Mailer, X-Originating-IP, User-Agent, X-Forwarded-For)
- Intake endpoint E2E with anti-trace-relay bridge
- Dashboard aggregation correct

### Known Limitations
- File-based storage (not suitable for high-volume production)
- Single static authentication token (JWT/mTLS post-MVP)
- No bounce handling or deliverability tracking
- No admin UI
- Sprint 5 live provider verification pending (Fastmail ready, not executed)
