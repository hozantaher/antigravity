# Submissions Contract Freeze

## Purpose

This document freezes the first public HTTP contract for the new `submissions` resource.

It is intentionally narrower than the full privacy-first pivot vision.
The goal is to stabilize the first additive public API for the new submission model while the legacy `/v1/messages` path still exists.

## Scope

Frozen in this document:

- `POST /v1/submissions`
- `GET /v1/submissions`
- `GET /v1/submissions/{id}`
- `GET /v1/submissions/{id}/timeline`
- request and response payload fields
- `status` filter behavior on list
- `channel_id` filter behavior on list
- `limit` behavior on list
- current auth and error behavior

Not frozen yet:

- relay-attempt endpoints
- audit endpoints
- identity-vault endpoints
- submission update/delete endpoints

## Authentication

All submissions endpoints require bearer-token authentication.

Request header:

```http
Authorization: Bearer <token>
```

Unauthorized response:

```json
{"error":"unauthorized"}
```

Status code:

- `401 Unauthorized`

## Common Response Rules

- Success responses are JSON.
- Error responses use `{"error":"<message>"}`.
- `500` responses now intentionally use `{"error":"internal server error"}`.
- JSON bodies reject unknown fields.
- Invalid JSON returns `400`.
- Oversized JSON returns `413`.

## Endpoint Freeze

### `POST /v1/submissions`

Purpose:

- create a new submission record for the authenticated actor
- run the first public submission sanitization pass before persistence

Request body:

```json
{
  "channel_id": "channel-1",
  "subject": "Hello",
  "text_body": "Body",
  "html_body": "",
  "to": ["recipient@example.com"],
  "attachments": [
    {
      "filename": "note.txt",
      "content_type": "text/plain",
      "size_bytes": 4
    }
  ]
}
```

Current rules:

- `channel_id` is a caller-supplied channel reference
- `channel_id` is trimmed, must not be empty, and must not contain CR/LF
- `subject` and `text_body` are trimmed on create
- public create applies the current submission sanitizer before persistence
- the resulting resource status is currently `sanitized` for accepted MVP submissions
- `subject` must be valid UTF-8 and must not contain CR/LF
- `text_body` is required after trimming
- `html_body` is accepted by shape but rejected in the current MVP flow
- attachments are metadata summaries only
- attachment metadata is trimmed on create
- attachment metadata must be valid UTF-8 and must not contain CR/LF
- attachment `size_bytes` must be zero or greater
- attachments and recipients are each capped by the current submission policy
- successful create records an internal audit event with submission metadata

Success:

- `201 Created`

Response:

```json
{
  "id": "sub_123",
  "tenant_id": "tenant-dev",
  "channel_id": "channel-1",
  "submitted_by": "user-dev",
  "to": ["recipient@example.com"],
  "subject": "Hello",
  "text_body": "Body",
  "attachments_summary": [
    {
      "filename": "note.txt",
      "content_type": "text/plain",
      "size_bytes": 4
    }
  ],
  "status": "sanitized",
  "created_at": "2026-04-03T12:00:00Z"
}
```

Errors:

- `400 Bad Request`
- `401 Unauthorized`
- `405 Method Not Allowed`
- `413 Request Entity Too Large`
- `500 Internal Server Error`

### `POST /v1/submissions/{id}/relay`

Purpose:

- relay one existing submission through the native submission workflow

Current rules:

- requires the submission `channel_id` to resolve to an alias owned by the authenticated actor
- allowed for `accepted`, `sanitized`, `queued`, and retryable `failed` submissions
- successful relay returns the updated submission in `relayed` state
- relay failure still returns the updated submission resource, typically in `failed` state
- returns `409` when the submission has no relay-capable state or no relay-capable alias channel

Success:

- `200 OK`

Errors:

- `401 Unauthorized`
- `404 Not Found`
- `405 Method Not Allowed`
- `409 Conflict`
- `500 Internal Server Error`

### `GET /v1/submissions`

Purpose:

- list submissions visible to the authenticated actor's tenant

Current rules:

- supports optional `limit=<positive integer>` truncation
- supports optional `channel_id=<value>` exact-match filtering
- supports optional `status=<value>` exact-match filtering
- valid `status` values are `accepted`, `queued`, `sanitized`, `relayed`, `failed`, and `blocked`
- invalid `limit` returns `400`
- invalid `status` returns `400`

Success:

- `200 OK`

Response:

```json
{
  "submissions": [
    {
      "id": "sub_123",
      "tenant_id": "tenant-dev",
      "channel_id": "channel-1",
      "submitted_by": "user-dev",
      "source_path": "messages_compat",
      "to": ["recipient@example.com"],
      "subject": "Hello",
      "text_body": "Body",
      "attachments_summary": [],
      "status": "relayed",
      "relay_provider": "smtp",
      "relay_attempt_id": "rly_123",
      "relayed_at": "2026-04-03T12:05:00Z",
      "created_at": "2026-04-03T12:00:00Z"
    }
  ]
}
```

Errors:

- `401 Unauthorized`
- `405 Method Not Allowed`
- `500 Internal Server Error`

### `GET /v1/submissions/{id}`

Purpose:

- fetch one submission resource by id

Success:

- `200 OK`

Response:

```json
{
  "id": "sub_123",
  "tenant_id": "tenant-dev",
  "channel_id": "channel-1",
  "submitted_by": "user-dev",
  "source_path": "messages_compat",
  "to": ["recipient@example.com"],
  "subject": "Hello",
  "text_body": "Body",
  "attachments_summary": [],
  "status": "relayed",
  "relay_provider": "smtp",
  "relay_attempt_id": "rly_123",
  "relayed_at": "2026-04-03T12:05:00Z",
  "created_at": "2026-04-03T12:00:00Z"
}
```

Current rules:

- missing submission returns `404`
- cross-tenant access is hidden as `404`

Errors:

- `401 Unauthorized`
- `404 Not Found`
- `405 Method Not Allowed`
- `500 Internal Server Error`

Not-found response:

```json
{"error":"submission not found"}
```

### `GET /v1/submissions/{id}/timeline`

Purpose:

- fetch one submission together with related relay attempts and audit events

Success:

- `200 OK`

Response:

```json
{
  "summary": {
    "latest_status": "failed",
    "attempt_count": 1,
    "audit_event_count": 2,
    "latest_failure_class": "timeout",
    "latest_failure_disposition": "retryable",
    "latest_activity_at": "2026-04-03T12:05:00Z"
  },
  "submission": {
    "id": "sub_123",
    "tenant_id": "tenant-dev",
    "channel_id": "channel-1",
    "submitted_by": "user-dev",
    "status": "failed",
    "relay_attempt_id": "rly_123",
    "created_at": "2026-04-03T12:00:00Z"
  },
  "relay_attempts": [
    {
      "id": "rly_123",
      "submission_id": "sub_123",
      "status": "failed",
      "failure_class": "timeout",
      "failure_disposition": "retryable",
      "created_at": "2026-04-03T12:05:00Z"
    }
  ],
  "audit_events": [
    {
      "id": "aud_123",
      "event_type": "submission_created",
      "resource_id": "sub_123",
      "created_at": "2026-04-03T12:00:00Z"
    }
  ]
}
```

Current rules:

- missing submission returns `404`
- cross-tenant access is hidden as `404`
- relay attempts are filtered by `submission_id`
- audit events are filtered by `submission_id`
- `summary` is a derived convenience view over the returned submission, relay attempts, and audit events

## Model Field Freeze

### Submission

```json
{
  "id": "string",
  "tenant_id": "string",
  "channel_id": "string",
  "submitted_by": "string",
  "source_path": "string",
  "to": ["string"],
  "subject": "string",
  "text_body": "string",
  "attachments_summary": [
    {
      "filename": "string",
      "content_type": "string",
      "size_bytes": 0
    }
  ],
  "status": "accepted|queued|sanitized|relayed|failed|blocked",
  "relay_provider": "string",
  "relay_attempt_id": "string",
  "relay_failure_class": "string",
  "relay_failure_disposition": "retryable|terminal",
  "relay_failure_reason": "string",
  "failed_at": "RFC3339 timestamp",
  "relayed_at": "RFC3339 timestamp",
  "created_at": "RFC3339 timestamp"
}
```

### CreateSubmissionInput

```json
{
  "channel_id": "string",
  "subject": "string",
  "text_body": "string",
  "html_body": "string",
  "to": ["string"],
  "attachments": [
    {
      "filename": "string",
      "content_type": "string",
      "size_bytes": 0
    }
  ]
}
```

## Compatibility Note

This contract is additive.

The legacy `/v1/messages` flow remains available and is still the compatibility path for the older gateway surface.
The `submissions` resource is the first public step toward the privacy-first pivot.

Current provenance behavior:

- direct `POST /v1/submissions` creates a submission in an intake-owned pre-relay state
- native `POST /v1/submissions/{id}/relay` may later move that submission to `relayed` or `failed`
- the legacy `/v1/messages` compatibility path may later mark a linked submission as `relayed`
- relay provenance is exposed through additive fields such as:
  - `source_path`
  - `relay_provider`
  - `relay_attempt_id`
  - `relayed_at`

## Compatibility Rules

Until this document is revised:

- do not rename or remove existing submission fields
- do not change the current top-level list envelope from `{"submissions":[...]}`
- do not change not-found from `404` with `{"error":"submission not found"}`
- additive fields are allowed only if they do not break existing clients
