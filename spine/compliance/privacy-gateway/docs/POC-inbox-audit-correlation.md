# POC: Inbox-to-Audit Correlation

## Status: Accepted (current implementation sufficient)

## Hypothesis

Tighter alias+sender+subject matching between inbound inbox messages and outbound submissions improves operator decisions by providing richer context in timeline views.

## Scope

- In scope: correlation accuracy between `InboxMessage` and `Submission` during IMAP sync
- In scope: timeline endpoint data quality for operators
- Out of scope: cross-store relational queries (covered by ADR-005)

## Current Implementation

The `ContextResolver` (`internal/inbox/context_resolver.go`) already implements 4-criteria matching:

1. **Alias email match** — `InboxMessage.AliasEmail` == `Alias.Email` (case-insensitive)
2. **Actor ownership** — `Submission.SubmittedBy` == requesting actor
3. **Recipient ↔ Sender** — `InboxMessage.From` is in `Submission.To` array
4. **Normalized subject** — Strips `re:`, `fw:`, `fwd:` prefixes recursively, compares lowercase

This produces `InboxMessage.AliasID` and `InboxMessage.SubmissionID` fields, which the timeline endpoints (`/v1/inbox/{id}/timeline`, `/v1/aliases/{id}/timeline`) use to join across submissions, relay attempts, and audit events at read time.

## Evidence

- 3 existing tests verify positive matching, sender mismatch rejection, and full IMAP sync integration
- The 4-criteria match prevents false positives (different sender, different subject, different alias all correctly reject)
- Timeline endpoints already surface the full chain: inbox message → submission → relay attempts → audit events

## Success Signal

Correlation rate should be high for replies to relayed submissions where the recipient replies with the same subject thread. Current implementation satisfies this.

## Failure Signal

If operators see unlinked inbox messages that should be correlated, the resolver needs enhancement.

## Future Enhancement Path (not blocking)

1. **Message-ID threading** — Store `Message-ID` header on outbound relay, match `In-Reply-To`/`References` headers on inbound. This would correlate even when subjects are edited. Requires adding a `MessageID` field to `model.Submission` and enriching relay attempt records.
2. **Fuzzy subject matching** — Levenshtein distance or token overlap. Risk: false positives in a privacy-sensitive context are worse than missed correlations. Not recommended without explicit operator opt-in.
3. **Temporal proximity** — Weight matches by time distance between submission relay and inbox receipt. Low priority since the 4-criteria match is already precise.

## Decision

**Accepted** — Current 4-criteria matching is sufficient for MVP. The correlation logic is tested, precise, and correctly integrated into IMAP sync and timeline endpoints. Message-ID threading is the most valuable future enhancement but does not block the current release track.
