# Privacy Gateway API Contract Freeze

## Purpose

This document freezes the HTTP contract for the MVP release of the privacy gateway service.

The goal is stability, not completeness. During MVP, contract changes should be additive only unless this document is explicitly revised.

## Scope

Frozen for MVP:

- authentication shape
- endpoint paths and methods
- current success and error envelopes
- core request and response payload fields
- current behavior for `record-only` mode and opt-in IMAP sync

Not frozen beyond MVP:

- internal persistence format
- provider-specific SMTP and IMAP behavior
- non-breaking additive response fields

## Authentication

All `/v1/*` endpoints require bearer-token authentication.

Request header:

```http
Authorization: Bearer <token>
```

Current unauthorized response:

```json
{"error":"unauthorized"}
```

Status code:

- `401 Unauthorized`

`GET /healthz` is intentionally unauthenticated.

## Common Response Rules

- Success responses are JSON.
- Error responses currently use the envelope `{"error":"<message>"}`.
- `500` responses now intentionally return the generic payload `{"error":"internal server error"}`.
- JSON request bodies reject unknown fields.
- Oversized JSON request bodies return `413`.
- Invalid JSON request bodies return `400`.

## Endpoint Freeze

### `GET /healthz`

Purpose:

- basic process health check

Success:

- `200 OK`

Response:

```json
{"status":"ok"}
```

### `GET /v1/dashboard`

Purpose:

- return one tenant-scoped operator overview across the main local read models

Success:

- `200 OK`

Response:

```json
{
  "summary": {
    "alias_count": 2,
    "channel_count": 2,
    "submission_count": 2,
    "failed_submission_count": 0,
    "inbox_count": 1,
    "relay_attempt_count": 1,
    "failed_relay_attempt_count": 1,
    "active_identity_link_count": 1,
    "audit_event_count": 3
  },
  "problem_channels": [
    {
      "alias": {
        "id": "al_123",
        "email": "support-123@test.local"
      },
      "latest_submission_status": "sanitized",
      "latest_failure_disposition": "retryable"
    }
  ],
  "recent_submissions": [
    {
      "id": "sub_123",
      "channel_id": "al_123",
      "status": "accepted",
      "created_at": "2026-04-04T10:00:00Z"
    }
  ],
  "channels": [
    {
      "alias": {
        "id": "al_123",
        "email": "support-123@test.local"
      },
      "submission_count": 1,
      "inbox_count": 1,
      "relay_attempt_count": 1,
      "latest_submission_status": "sanitized"
    }
  ]
}
```

Current rules:

- the overview is read-only
- counts are tenant-scoped
- supports optional query params:
  - `problem_only=true|false`
  - `problem_limit=<positive integer>`
  - `recent_limit=<positive integer>`
- `problem_channels` is a lightweight operator triage view and may grow additively
- `recent_submissions` is a lightweight recent activity view and may grow additively
- `problem_only=true` narrows the `channels` list to problem channels only
- `channels` reuses the existing channel summary shape
- additive summary fields are allowed if they do not break existing keys

Errors:

- `401 Unauthorized`
- `400 Bad Request` for invalid filters
- `405 Method Not Allowed`
- `500 Internal Server Error`

### `POST /v1/intake/submissions`

Purpose:

- accept privacy-first submissions through a dedicated secure intake authenticator

Success:

- `201 Created`

Current rules:

- uses `INTAKE_API_TOKEN` instead of the default dev actor token
- returns the same sanitized submission shape as `POST /v1/submissions`
- defaults the submission to `intake_channel=secure_web_intake`
- supports `sanitizer_profile=standard|strict`
- `standard` is the default when omitted
- `strict` blocks attachments and explicit recipients at intake time
- returns `501` when intake auth is not configured

Errors:

- `400 Bad Request`
- `401 Unauthorized`
- `405 Method Not Allowed`
- `500 Internal Server Error`
- `501 Not Implemented`

### `GET /v1/intake/dashboard`

Purpose:

- return one intake-actor-scoped overview across intake submissions

Success:

- `200 OK`

Current rules:

- uses the dedicated intake authenticator
- supports optional query params:
  - `metadata_profile`
  - `problem_limit=<positive integer>`
  - `recent_limit=<positive integer>`
- returns:
  - `summary`
  - `strict_profile_count`
  - `problem_submissions`
  - `recent_submissions`
- `problem_submissions` is a lightweight intake triage view and may grow additively
- `recent_submissions` is a lightweight recent activity view and may grow additively
- submission cards may include additive `available_actions` hints for operator workflows
- submission cards may include additive `action_targets` path hints for those actions
- returns `501` when intake auth is not configured

Errors:

- `401 Unauthorized`
- `400 Bad Request` for invalid filters
- `405 Method Not Allowed`
- `500 Internal Server Error`
- `501 Not Implemented`

### `GET /v1/intake/queue`

Purpose:

- return intake-owned queue candidates for store-and-forward relay work

Success:

- `200 OK`

Current rules:

- uses the dedicated intake authenticator
- supports optional query params:
  - `metadata_profile`
  - `retryable_only=true|false`
  - `limit=<positive integer>`
- returns:
  - `summary`
  - `submissions`
- `submissions` reuse the intake dashboard card shape, including additive action hints
- `summary` includes:
  - `queue_count`
  - `retryable_failed_count`
  - `strict_profile_count`
- returns `501` when intake auth is not configured

Errors:

- `401 Unauthorized`
- `400 Bad Request` for invalid filters
- `405 Method Not Allowed`
- `500 Internal Server Error`
- `501 Not Implemented`

### `GET /v1/intake/submissions/{id}`

Purpose:

- return one intake-owned submission for the authenticated intake actor

Success:

- `200 OK`

Current rules:

- uses the dedicated intake authenticator
- only returns submissions owned by the authenticated intake actor
- returns `404` for unknown submissions and for submissions owned by another actor
- returns `501` when intake auth is not configured

Errors:

- `401 Unauthorized`
- `404 Not Found`
- `405 Method Not Allowed`
- `500 Internal Server Error`
- `501 Not Implemented`

### `POST /v1/intake/submissions/{id}/queue`

Purpose:

- queue one intake-owned submission for internal store-and-forward relay

Success:

- `200 OK`

Current rules:

- uses the dedicated intake authenticator
- only queues submissions owned by the authenticated intake actor
- returns `404` for unknown submissions and for submissions owned by another actor
- returns `409` when the submission cannot be queued from its current state
- returns `501` when intake auth is not configured

Errors:

- `401 Unauthorized`
- `404 Not Found`
- `405 Method Not Allowed`
- `409 Conflict`
- `500 Internal Server Error`
- `501 Not Implemented`

### `POST /v1/intake/submissions/{id}/release`

Purpose:

- release one intake-owned queued submission back into relay-ready flow

Success:

- `200 OK`

Current rules:

- uses the dedicated intake authenticator
- only releases submissions owned by the authenticated intake actor
- returns `404` for unknown submissions and for submissions owned by another actor
- returns `409` when the submission cannot be released from its current state
- returns `501` when intake auth is not configured

Errors:

- `401 Unauthorized`
- `404 Not Found`
- `405 Method Not Allowed`
- `409 Conflict`
- `500 Internal Server Error`
- `501 Not Implemented`

### `POST /v1/intake/submissions/{id}/relay`

Purpose:

- relay one intake-owned submission through the native submission path

Success:

- `200 OK`

Current rules:

- uses the dedicated intake authenticator
- only relays submissions owned by the authenticated intake actor
- requires the submission channel to resolve to an owned alias
- allowed for `accepted`, `sanitized`, `queued`, and retryable `failed` submissions
- a relay failure still returns the updated submission resource, typically in `failed` state
- returns `404` for unknown submissions and for submissions owned by another actor
- returns `409` when the submission is not relay-capable in its current state or its channel is not relay-capable
- returns `501` when intake auth is not configured

Errors:

- `401 Unauthorized`
- `404 Not Found`
- `405 Method Not Allowed`
- `409 Conflict`
- `500 Internal Server Error`
- `501 Not Implemented`

### `GET /v1/intake/submissions/{id}/timeline`

Purpose:

- return one intake-owned submission together with its actor-scoped relay and audit trail

Success:

- `200 OK`

Current rules:

- uses the dedicated intake authenticator
- reuses the submission timeline response shape:
  - `summary`
  - `submission`
  - `relay_attempts`
  - `audit_events`
- only returns submissions owned by the authenticated intake actor
- audit events are filtered to the actor-scoped intake view
- returns `404` for unknown submissions and for submissions owned by another actor
- returns `501` when intake auth is not configured

Errors:

- `401 Unauthorized`
- `404 Not Found`
- `405 Method Not Allowed`
- `500 Internal Server Error`
- `501 Not Implemented`

### `GET /v1/intake/timeline`

Purpose:

- list submissions visible to the authenticated intake actor

Success:

- `200 OK`

Current rules:

- uses the dedicated intake authenticator
- supports optional filters:
  - `status`
  - `channel`
  - `metadata_profile`
  - `delivery_boundary`
  - `limit`
- returns:
  - `summary`
  - `entries`
  - `total`
  - `showing`
- `summary` is a lightweight intake triage view and may grow additively
- entry objects now include `metadata_profile`
- returns `501` when intake auth is not configured

Errors:

- `401 Unauthorized`
- `405 Method Not Allowed`
- `500 Internal Server Error`
- `501 Not Implemented`

### `GET /v1/relay-queue`

Purpose:

- expose the internal store-and-forward queue view for privacy-first submissions

Success:

- `200 OK`

Response:

```json
{
  "summary": {
    "queue_count": 1,
    "retryable_failed_count": 1
  },
  "submissions": [
    {
      "id": "sub_123",
      "channel_id": "channel-1",
      "intake_channel": "secure_web_intake",
      "metadata_profile": "minimized",
      "content_protection": "encrypted_at_rest",
      "delivery_boundary": "internal_store_and_forward",
      "status": "failed",
      "relay_failure_disposition": "retryable"
    }
  ]
}
```

Current rules:

- queue membership includes `accepted`, `queued`, and `sanitized` submissions
- retryable `failed` submissions also remain visible in the queue view
- `relayed` and `blocked` submissions are not part of the queue

Errors:

- `401 Unauthorized`
- `405 Method Not Allowed`
- `500 Internal Server Error`

### `POST /v1/submissions/{id}/queue`

Purpose:

- move one submission into the internal store-and-forward queue

Success:

- `200 OK`

Current rules:

- allowed for `accepted`, `sanitized`, and retryable `failed` submissions
- returns `409` when the current state cannot be queued

Errors:

- `401 Unauthorized`
- `404 Not Found`
- `405 Method Not Allowed`
- `409 Conflict`
- `500 Internal Server Error`

### `POST /v1/submissions/{id}/release`

Purpose:

- release one queued submission back to the relay-ready state without claiming final delivery

Success:

- `200 OK`

Current rules:

- allowed only for `queued` submissions
- released submissions return to `sanitized`
- returns `409` when the current state cannot be released

Errors:

- `401 Unauthorized`
- `404 Not Found`
- `405 Method Not Allowed`
- `409 Conflict`
- `500 Internal Server Error`

### `POST /v1/submissions/{id}/relay`

Purpose:

- relay one submission through the native submission path

Success:

- `200 OK`

Current rules:

- requires the submission channel to resolve to an owned alias
- allowed for `accepted`, `sanitized`, `queued`, and retryable `failed` submissions
- a relay failure still returns the updated submission resource, typically in `failed` state
- returns `409` when the submission is not relay-capable in its current state or its channel is not relay-capable

Errors:

- `401 Unauthorized`
- `404 Not Found`
- `405 Method Not Allowed`
- `409 Conflict`
- `500 Internal Server Error`

### `GET /v1/aliases`

Purpose:

- list aliases owned by the authenticated actor

Success:

- `200 OK`

Response:

```json
{
  "aliases": [
    {
      "id": "al_123",
      "user_id": "user-dev",
      "tenant_id": "tenant-dev",
      "email": "support-123@test.local",
      "label": "support",
      "created_at": "2026-04-03T01:06:12Z"
    }
  ]
}
```

Errors:

- `401 Unauthorized`
- `405 Method Not Allowed`
- `500 Internal Server Error`

### `GET /v1/aliases/{id}/timeline`

Purpose:

- fetch one alias as a channel timeline across submissions, inbound messages, relay attempts, and audit events

Success:

- `200 OK`

Errors:

- `401 Unauthorized`
- `404 Not Found`
- `405 Method Not Allowed`
- `500 Internal Server Error`

### `POST /v1/aliases`

Purpose:

- create one alias for the authenticated actor

Request body:

```json
{
  "label": "support"
}
```

Success:

- `201 Created`

Response:

```json
{
  "id": "al_123",
  "user_id": "user-dev",
  "tenant_id": "tenant-dev",
  "email": "support-123@test.local",
  "label": "support",
  "created_at": "2026-04-03T01:06:12Z"
}
```

Errors:

- `400 Bad Request`
- `401 Unauthorized`
- `405 Method Not Allowed`
- `413 Request Entity Too Large`
- `500 Internal Server Error`

### `POST /v1/messages`

Purpose:

- submit one outbound plain-text message through an owned alias

Request body:

```json
{
  "alias_id": "al_123",
  "to": ["recipient@example.com"],
  "subject": "Hello",
  "text_body": "Privacy-preserving hello.",
  "html_body": ""
}
```

Frozen MVP rules:

- `text_body` is the supported outbound body
- HTML passthrough is not supported in MVP
- alias ownership is enforced
- invalid subject values, including header-injection patterns, are rejected

Success:

- `202 Accepted`

Response:

```json
{
  "id": "msg_123",
  "alias_id": "al_123",
  "user_id": "user-dev",
  "tenant_id": "tenant-dev",
  "sender": "support-123@test.local",
  "to": ["recipient@example.com"],
  "subject": "Hello",
  "text_body": "Privacy-preserving hello.",
  "created_at": "2026-04-03T01:06:43Z"
}
```

Errors:

- `400 Bad Request`
- `401 Unauthorized`
- `403 Forbidden`
- `405 Method Not Allowed`
- `413 Request Entity Too Large`
- `500 Internal Server Error`

### `GET /v1/messages/outbox`

Purpose:

- list outbound message records for the authenticated actor

Success:

- `200 OK`

Response:

```json
{
  "messages": [
    {
      "id": "msg_123",
      "alias_id": "al_123",
      "user_id": "user-dev",
      "tenant_id": "tenant-dev",
      "sender": "support-123@test.local",
      "to": ["recipient@example.com"],
      "subject": "Hello",
      "text_body": "Privacy-preserving hello.",
      "created_at": "2026-04-03T01:06:43Z"
    }
  ]
}
```

Errors:

- `401 Unauthorized`
- `405 Method Not Allowed`
- `500 Internal Server Error`

### `GET /v1/messages/inbox`

Purpose:

- list normalized inbound message records for the authenticated actor

Success:

- `200 OK`

Response:

```json
{
  "messages": [
    {
      "id": "in_123",
      "user_id": "user-dev",
      "tenant_id": "tenant-dev",
      "alias_email": "support-123@test.local",
      "alias_id": "al_123",
      "submission_id": "sub_123",
      "from": "sender@example.com",
      "to": ["support-123@test.local"],
      "subject": "Inbound",
      "text_body": "Normalized message body.",
      "attachments": [
        {
          "filename": "invoice.pdf",
          "content_type": "application/pdf",
          "disposition": "attachment",
          "size_bytes": 1024,
          "policy_action": "metadata_only",
          "policy_reason": "allowed_document"
        }
      ],
      "attachment_count": 1,
      "received_at": "2026-04-03T01:10:00Z",
      "provider_uid": "42"
    }
  ]
}
```

Frozen MVP rules:

- inbox returns normalized text, not full MIME reconstruction
- attachment content is not served by the API
- only attachment metadata and policy outcome fields are exposed
- `alias_id` is filled only when inbound correlation can confidently match an owned alias
- `submission_id` is filled only when alias, sender, and normalized subject all match a known submission
- when inbox storage is not initialized, the endpoint still returns `200` with an empty `messages` array

Errors:

- `401 Unauthorized`
- `405 Method Not Allowed`
- `500 Internal Server Error`

### `POST /v1/messages/inbox/sync`

Purpose:

- trigger an explicit inbound IMAP sync for the authenticated actor

Success:

- `202 Accepted`

Response:

```json
{
  "synced": 3
}
```

Frozen MVP rules:

- sync is explicit, not webhook-driven
- when IMAP is not configured, the endpoint returns `501`
- first sync may backfill recent messages
- later syncs may resume incrementally from the stored provider cursor

Errors:

- `401 Unauthorized`
- `405 Method Not Allowed`
- `501 Not Implemented`
- `500 Internal Server Error`

Current not-configured response:

```json
{"error":"imap sync is not configured"}
```

### `GET /v1/messages/inbox/{id}/timeline`

Purpose:

- fetch one inbox message together with any linked submission, relay attempts, and audit events

Success:

- `200 OK`

Response:

```json
{
  "summary": {
    "has_submission_link": true,
    "latest_status": "failed",
    "attempt_count": 1,
    "audit_event_count": 2,
    "latest_failure_class": "timeout",
    "latest_failure_disposition": "retryable",
    "latest_activity_at": "2026-04-03T12:10:00Z"
  },
  "message": {
    "id": "imap_42",
    "alias_id": "al_123",
    "submission_id": "sub_123",
    "received_at": "2026-04-03T12:10:00Z"
  },
  "submission": {
    "id": "sub_123",
    "status": "failed"
  },
  "relay_attempts": [
    {
      "id": "rly_123",
      "submission_id": "sub_123",
      "status": "failed"
    }
  ],
  "audit_events": [
    {
      "id": "aud_123",
      "event_type": "relay_attempt_created",
      "created_at": "2026-04-03T12:05:00Z"
    }
  ]
}
```

Current rules:

- missing inbox message returns `404`
- `message` is always present on success
- `submission` is `null` when no safe link exists
- relay attempts and audit events are returned only for linked submissions
- `summary` is a derived convenience view over the returned message and any linked records

Errors:

- `401 Unauthorized`
- `404 Not Found`
- `405 Method Not Allowed`
- `500 Internal Server Error`

### `GET /v1/aliases/{id}/timeline`

Purpose:

- fetch one alias as a channel timeline across submissions, inbound messages, relay attempts, and audit events

Success:

- `200 OK`

Response:

```json
{
  "summary": {
    "submission_count": 1,
    "inbox_count": 1,
    "relay_attempt_count": 1,
    "audit_event_count": 2,
    "latest_failure_class": "timeout",
    "latest_failure_disposition": "retryable",
    "latest_activity_at": "2026-04-03T12:10:00Z"
  },
  "alias": {
    "id": "al_123",
    "email": "support-123@test.local"
  },
  "submissions": [
    {
      "id": "sub_123",
      "channel_id": "al_123"
    }
  ],
  "inbox_messages": [
    {
      "id": "imap_42",
      "alias_id": "al_123",
      "submission_id": "sub_123"
    }
  ],
  "relay_attempts": [
    {
      "id": "rly_123",
      "alias_id": "al_123",
      "submission_id": "sub_123"
    }
  ],
  "audit_events": [
    {
      "id": "aud_123",
      "event_type": "relay_attempt_created"
    }
  ]
}
```

Current rules:

- missing or foreign alias returns `404`
- `alias` is always present on success
- submissions are matched by `channel_id == alias.id`
- inbox messages are matched by `alias_id` or fallback `alias_email`
- relay attempts are matched by `alias_id` and linked submission ids
- audit events are matched conservatively through `alias_id`, `channel_id`, or linked submission ids

### `GET /v1/channels`

Purpose:

- list channel-level summaries for all aliases owned by the authenticated actor

Success:

- `200 OK`

Response:

```json
{
  "channels": [
    {
      "alias": {
        "id": "al_123",
        "email": "support-123@test.local"
      },
      "submission_count": 1,
      "inbox_count": 1,
      "relay_attempt_count": 1,
      "latest_submission_status": "failed",
      "latest_inbound_at": "2026-04-03T12:10:00Z",
      "latest_activity_at": "2026-04-03T12:10:00Z",
      "latest_failure_class": "timeout",
      "latest_failure_disposition": "retryable"
    }
  ]
}
```

Current rules:

- every owned alias appears once in the feed, even when counts are zero
- submission counts are matched by `channel_id == alias.id`
- inbox counts are matched by `alias_id` or fallback `alias_email`
- relay attempt counts are matched by `alias_id` and linked submission ids
- `latest_*` fields are omitted when no matching activity exists
- optional filters:
  - `has_inbox=true|false`
  - `has_failures=true|false`
  - `has_relay_attempts=true|false`
  - `latest_submission_status=accepted|queued|sanitized|relayed|failed|blocked`

Errors:

- `400 Bad Request`
- `401 Unauthorized`
- `405 Method Not Allowed`
- `500 Internal Server Error`

## Model Field Freeze

### Alias

```json
{
  "id": "string",
  "user_id": "string",
  "tenant_id": "string",
  "email": "string",
  "label": "string",
  "created_at": "RFC3339 timestamp"
}
```

### MessageRecord

```json
{
  "id": "string",
  "alias_id": "string",
  "user_id": "string",
  "tenant_id": "string",
  "sender": "string",
  "to": ["string"],
  "subject": "string",
  "text_body": "string",
  "created_at": "RFC3339 timestamp"
}
```

### InboxMessage

```json
{
  "id": "string",
  "user_id": "string",
  "tenant_id": "string",
  "alias_email": "string",
  "alias_id": "string",
  "submission_id": "string",
  "from": "string",
  "to": ["string"],
  "subject": "string",
  "text_body": "string",
  "attachments": [
    {
      "filename": "string",
      "content_type": "string",
      "disposition": "string",
      "size_bytes": 0,
      "policy_action": "string",
      "policy_reason": "string"
    }
  ],
  "attachment_count": 0,
  "received_at": "RFC3339 timestamp",
  "provider_uid": "string"
}
```

## Compatibility Rules

During MVP:

- existing endpoint paths and methods must not change
- existing top-level response fields must not be renamed or removed
- existing error envelope shape must not change from `{"error":"..."}`
- new fields may be added only when they do not break existing clients

Any non-additive API change requires:

- an explicit update to this document
- a README update if client usage changes
- a fresh verification pass for the affected flow
