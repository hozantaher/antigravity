# Relay Attempts Contract Freeze

## Purpose

This document freezes the first public read contract for `relay_attempts`.

It exists to make relay lifecycle visible without introducing a new public write surface.

## Scope

Frozen in this document:

- `GET /v1/relay-attempts`
- `GET /v1/relay-attempts/{id}`
- list filter behavior
- current auth and error behavior

Not frozen yet:

- relay-attempt retry actions
- relay-attempt update or delete actions
- operator-only mutation endpoints

## Authentication

All relay-attempt endpoints require bearer-token authentication.

Unauthorized response:

```json
{"error":"unauthorized"}
```

## `GET /v1/relay-attempts`

Purpose:

- list relay attempts visible to the authenticated actor's tenant

Current rules:

- supports optional `status=<sent|failed>` filtering
- supports optional `submission_id=<value>` exact-match filtering
- supports optional `limit=<positive integer>` truncation
- invalid `status` returns `400`
- invalid `limit` returns `400`

Success:

- `200 OK`

Response:

```json
{
  "summary": {
    "attempt_count": 1,
    "failed_count": 1,
    "retryable_count": 1,
    "terminal_count": 0,
    "latest_failed_at": "2026-04-03T12:05:00Z"
  },
  "relay_attempts": [
    {
      "tenant_id": "tenant-dev",
      "actor_id": "user-dev",
      "id": "rly_123",
      "submission_id": "sub_123",
      "alias_id": "alias_123",
      "provider": "smtp",
      "status": "failed",
      "failure_class": "timeout",
      "failure_disposition": "retryable",
      "failure_reason": "dial tcp timeout",
      "created_at": "2026-04-03T12:05:00Z"
    }
  ]
}
```

Current rules:

- `summary` is a derived convenience view over the returned relay attempts

## `GET /v1/relay-attempts/{id}`

Purpose:

- fetch one relay attempt by id

Current rules:

- missing attempt returns `404`
- cross-tenant access is hidden as `404`

Success:

- `200 OK`

Errors:

- `401 Unauthorized`
- `404 Not Found`
- `405 Method Not Allowed`
- `500 Internal Server Error`

Current error shaping rule:

- `500` responses use the generic payload `{"error":"internal server error"}`

Not-found response:

```json
{"error":"relay attempt not found"}
```

## Model Field Freeze

```json
{
  "tenant_id": "string",
  "actor_id": "string",
  "id": "string",
  "submission_id": "string",
  "alias_id": "string",
  "provider": "string",
  "status": "sent|failed",
  "failure_class": "string",
  "failure_disposition": "retryable|terminal",
  "failure_reason": "string",
  "created_at": "RFC3339 timestamp"
}
```
