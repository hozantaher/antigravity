# API Error Catalog

## Purpose

This is the shortest operator-facing map of expected API error responses.

Use it when you need to answer:

- which error codes are normal for a given endpoint
- what typically causes a `400`, `404`, `409`, or `501`
- whether a result is a bug or an expected contract outcome

All current error responses use:

```json
{"error":"<message>"}
```

## Global Rules

### `401 Unauthorized`

Typical cause:

- missing bearer token
- invalid bearer token

Expected on:

- all `/v1/*` endpoints

### `400 Bad Request`

Typical cause:

- invalid JSON
- unknown JSON fields
- invalid query parameter value
- validation failure on request body fields

Common examples:

- `limit must be a positive integer`
- `status must be a valid submission status`
- `since must be a valid RFC3339 timestamp`
- `real_identity_ref is invalid`

### `405 Method Not Allowed`

Typical cause:

- endpoint exists, but the HTTP method is not supported

### `413 Request Entity Too Large`

Typical cause:

- JSON body exceeds request size limit

Current scope:

- JSON body endpoints only

### `500 Internal Server Error`

Typical cause:

- storage failure
- runtime dependency failure
- unexpected internal error

This should be treated as a service-side problem, not a caller validation problem.

Current response contract:

- clients receive the generic payload `{"error":"internal server error"}`
- detailed failure context is intended for server-side logs, not API responses

## Health

### `GET /healthz`

Expected errors:

- none in the normal contract

Normal success:

- `200 {"status":"ok"}`

## Aliases

### `GET /v1/aliases`

Expected errors:

- `401` unauthorized
- `405` wrong method
- `500` internal storage failure

### `POST /v1/aliases`

Expected errors:

- `400` invalid JSON
- `401` unauthorized
- `405` wrong method
- `413` oversized JSON
- `500` internal storage failure

## Legacy Messages

### `POST /v1/messages`

Expected errors:

- `400`
  Typical causes:
  invalid JSON, no recipients, too many recipients, empty body, HTML body present, oversized message, invalid subject, invalid recipient
- `401`
  Typical cause:
  unauthorized token
- `403`
  Typical causes:
  alias does not exist for the actor, alias is not owned by the actor
- `405`
  Typical cause:
  wrong method
- `413`
  Typical cause:
  oversized JSON body
- `500`
  Typical causes:
  gateway/storage/internal failure

### `GET /v1/messages/outbox`

Expected errors:

- `401` unauthorized
- `405` wrong method
- `500` outbox storage failure

### `GET /v1/messages/inbox`

Expected errors:

- `401` unauthorized
- `405` wrong method
- `500` inbox storage failure

### `POST /v1/messages/inbox/sync`

Expected errors:

- `401` unauthorized
- `405` wrong method
- `501`
  Typical cause:
  IMAP sync is not configured
- `500`
  Typical cause:
  sync/runtime/provider failure

## Submissions

### `POST /v1/submissions`

Expected errors:

- `400`
  Typical causes:
  missing or invalid `channel_id`, invalid `subject`, empty `text_body`, HTML body present, invalid recipients, too many recipients, invalid attachment metadata, too many attachments
- `401`
  Typical cause:
  unauthorized token
- `405`
  Typical cause:
  wrong method
- `413`
  Typical cause:
  oversized JSON body
- `500`
  Typical causes:
  persistence failure, audit write failure, sanitizer/internal workflow failure

### `GET /v1/submissions`

Expected errors:

- `400`
  Typical causes:
  invalid `status`, invalid `limit`
- `401`
  Typical cause:
  unauthorized token
- `405`
  Typical cause:
  wrong method
- `500`
  Typical causes:
  submission store failure
- `501`
  Typical cause:
  submission service is not configured

### `GET /v1/submissions/{id}`

Expected errors:

- `401`
  Typical cause:
  unauthorized token
- `404`
  Typical causes:
  submission does not exist, submission belongs to another tenant
- `405`
  Typical cause:
  wrong method
- `500`
  Typical causes:
  submission store failure
- `501`
  Typical cause:
  submission service is not configured

## Audit Events

### `GET /v1/audit-events`

Expected errors:

- `400`
  Typical causes:
  invalid `limit`, invalid `since`
- `401`
  Typical cause:
  unauthorized token
- `405`
  Typical cause:
  wrong method
- `500`
  Typical causes:
  audit store failure
- `501`
  Typical cause:
  audit service is not configured

## Identity Links

### `POST /v1/identity-links`

Expected errors:

- `400`
  Typical causes:
  invalid JSON, missing `alias_id`, missing `real_identity_ref`, invalid email in `real_identity_ref`, invalid `purpose`, `expires_at` in the past
- `401`
  Typical cause:
  unauthorized token
- `405`
  Typical cause:
  wrong method
- `413`
  Typical cause:
  oversized JSON body
- `500`
  Typical causes:
  identity-vault persistence failure, audit write failure
- `501`
  Typical cause:
  identity vault is not configured

### `GET /v1/identity-links`

Expected errors:

- `401`
  Typical cause:
  unauthorized token
- `405`
  Typical cause:
  wrong method
- `500`
  Typical causes:
  identity-vault store failure
- `501`
  Typical cause:
  identity vault is not configured

### `GET /v1/identity-links/{alias_id}`

Expected errors:

- `401`
  Typical cause:
  unauthorized token
- `404`
  Typical causes:
  alias has no link, link is expired, link is revoked, link belongs to another tenant
- `405`
  Typical cause:
  wrong method
- `500`
  Typical causes:
  identity-vault store failure
- `501`
  Typical cause:
  identity vault is not configured

### `POST /v1/identity-links/{alias_id}/revoke`

Expected errors:

- `400`
  Typical causes:
  invalid JSON, invalid revoke `reason`
- `401`
  Typical cause:
  unauthorized token
- `404`
  Typical causes:
  alias has no link, link is expired, link belongs to another tenant
- `405`
  Typical cause:
  wrong method
- `409`
  Typical cause:
  link is already revoked
- `500`
  Typical causes:
  identity-vault persistence failure, audit write failure
- `501`
  Typical cause:
  identity vault is not configured

## Operator Notes

Use these heuristics:

- `400` usually means caller input or query shape needs fixing
- `404` on tenant-scoped reads often intentionally hides cross-tenant state
- `409` currently means a legitimate state conflict, not malformed input
- `501` means the feature surface exists, but the runtime dependency is intentionally not enabled
- `500` means stop and inspect logs or storage/runtime dependencies
