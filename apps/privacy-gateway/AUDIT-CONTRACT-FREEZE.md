# Audit Events Contract Freeze

## Purpose

This document freezes the first public read-only HTTP contract for tenant audit visibility.

The goal is observability for the privacy-first pivot without adding a public write surface.

## Scope

Frozen in this document:

- `GET /v1/audit-events`
- auth and error behavior
- response envelope and event shape
- `event_type`, `resource_id`, `submission_id`, `limit`, and `since` query parameters
- server-side retention window behavior

Not frozen yet:

- pagination
- audit event detail endpoint
- audit export endpoints

## Authentication

All audit endpoints require bearer-token authentication.

Unauthorized response:

```json
{"error":"unauthorized"}
```

Status code:

- `401 Unauthorized`

## Endpoint Freeze

### `GET /v1/audit-events`

Purpose:

- list audit events visible to the authenticated actor's tenant

Current rules:

- returns only events for the authenticated tenant
- returns events in store order
- supports optional `event_type=<value>` filtering
- supports optional `resource_id=<value>` filtering
- supports optional `submission_id=<value>` filtering
- supports optional `limit=<positive integer>` truncation
- supports optional `since=<RFC3339 timestamp>` filtering
- applies server-side retention before response shaping
- retention enforcement prunes expired persisted audit rows during normal audit activity
- invalid `limit` returns `400`
- invalid `since` returns `400`
- returns `501` when the audit service is not configured
- `500` responses use the generic payload `{"error":"internal server error"}`

Success:

- `200 OK`

Response:

```json
{
  "events": [
    {
      "id": "aud_123",
      "tenant_id": "tenant-dev",
      "actor_id": "user-dev",
      "event_type": "submission_created",
      "resource_id": "sub_123",
      "metadata": {
        "channel_id": "channel-1",
        "submission_status": "sanitized",
        "recipient_count": "1",
        "attachment_count": "0"
      },
      "created_at": "2026-04-03T12:00:00Z"
    }
  ]
}
```

Typical event types now include:

- `submission_created`
- `submission_relayed`
- `submission_relay_failed`
- `relay_attempt_created`
- `identity_link_created`
- `identity_link_revoked`

Errors:

- `400 Bad Request`
- `401 Unauthorized`
- `405 Method Not Allowed`
- `501 Not Implemented`
- `500 Internal Server Error`
