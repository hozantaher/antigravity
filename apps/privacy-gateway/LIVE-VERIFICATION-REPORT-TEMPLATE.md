# Privacy Gateway Live Verification Report

## Run Metadata

This is the canonical reporting template for provider-backed verification results.

Use it as the base report shape even when the first run is Fastmail-specific.

- Provider:
- Date:
- Operator:
- Environment:
- Service version or commit:

## Configuration Summary

- `ALIAS_DOMAIN`:
- `DATA_DIR`:
- encryption at rest enabled: `yes/no`
- outbound mode:
- SMTP host:
- IMAP host:

Sensitive values such as passwords and app tokens should not be pasted into this report.

## Verification Scope

This run covered:

- alias setup
- native submission create and relay
- inbound IMAP plain-text sync
- inbound attachment metadata sync
- restart persistence
- incremental sync

## Results

### 1. Health Check

- status:
- notes:

### 2. Alias Flow

- alias created:
- alias listed after creation:
- alias domain correct:
- notes:

### 3. Native Submission Relay Verification

- submission create returned `201`:
- submission relay action accepted:
- submission status after relay:
- outbox recorded relayed message when expected:
- real recipient mailbox received message:
- sender/domain behavior acceptable:
- notes:

### 4. IMAP Plain-Text Verification

- sync API returned `202`:
- inbox stored plain-text message:
- normalized `text_body` acceptable:
- IMAP cursor advanced:
- notes:

### 5. IMAP Attachment Verification

- attachment message appeared in inbox:
- text body excluded attachment payload:
- attachment metadata present:
- attachment policy outcome present:
- result acceptable:
- notes:

### 6. Restart Persistence Verification

- aliases survived restart:
- outbox survived restart:
- inbox survived restart:
- encrypted state reopened successfully:
- notes:

### 7. Incremental Sync Verification

- new message appeared after second sync:
- old messages were not duplicated unexpectedly:
- cursor advanced again:
- notes:

## Evidence Collected

- health response:
- alias response:
- submissions list excerpt:
- submission detail excerpt:
- submission timeline excerpt:
- outbox excerpt:
- inbox excerpt for plain-text message:
- inbox excerpt for attachment message:
- mailbox confirmation:
- cursor evidence:
- restart evidence:

## Issues Found

List any issues found during the run:

1.
2.
3.

## Provider-Specific Caveats

- 

## Overall Decision

- native submission relay verification: `PASS/FAIL`
- inbound IMAP verification: `PASS/FAIL`
- restart persistence: `PASS/FAIL`
- incremental sync: `PASS/FAIL`
- overall live verification: `PASS/FAIL`

## Release Recommendation

Choose one:

- release candidate can be frozen now
- release candidate can be frozen after minor fixes
- do not freeze release candidate yet

## Follow-Up Actions

1.
2.
3.
