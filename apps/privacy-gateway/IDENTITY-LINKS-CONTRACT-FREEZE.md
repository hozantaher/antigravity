# Identity Links Contract Freeze

## Purpose

This document freezes the first public read-only HTTP contract for tenant-scoped identity-link visibility.

The goal is to expose the persisted identity-vault read model without adding a public write surface.

## Scope

Frozen in this document:

- `POST /v1/identity-links`
- `GET /v1/identity-links`
- `GET /v1/identity-links/{alias_id}`
- `POST /v1/identity-links/{alias_id}/revoke`
- auth and error behavior
- response envelope and resource shape

Not frozen yet:

- identity-link update endpoints beyond revoke
- reverse-lookup workflows

## Authentication

All identity-link endpoints require bearer-token authentication.

Unauthorized response:

```json
{"error":"unauthorized"}
```

Status code:

- `401 Unauthorized`

## Endpoint Freeze

### `POST /v1/identity-links`

Purpose:

- create a tenant-scoped identity link for one alias

Current rules:

- `alias_id` is required
- `real_identity_ref` is required and must be a valid email address
- `purpose` is trimmed and must not contain invalid UTF-8 or CR/LF
- `expires_at` is optional
- `expires_at`, when set, must be in the future
- successful create persists the link in the identity vault
- successful create records an internal `identity_link_created` audit event when audit is configured

Request body:

```json
{
  "alias_id": "al_123",
  "real_identity_ref": "user@example.com",
  "purpose": "support",
  "expires_at": "2026-04-10T12:00:00Z"
}
```

Success:

- `201 Created`

Response:

```json
{
  "id": "idl_123",
  "tenant_id": "tenant-dev",
  "alias_id": "al_123",
  "real_identity_ref": "user@example.com",
  "purpose": "support",
  "created_at": "2026-04-03T12:00:00Z",
  "expires_at": "2026-04-10T12:00:00Z"
}
```

### `GET /v1/identity-links`

Purpose:

- list identity links visible to the authenticated actor's tenant

Current rules:

- returns only identity links for the authenticated tenant
- excludes expired or revoked links
- supports optional `alias_id=<value>` exact-match filtering
- returns `501` when the identity vault is not configured

Success:

- `200 OK`

Response:

```json
{
  "identity_links": [
    {
      "id": "idl_123",
      "tenant_id": "tenant-dev",
      "alias_id": "al_123",
      "real_identity_ref": "user@example.com",
      "purpose": "support",
      "created_at": "2026-04-03T12:00:00Z",
      "expires_at": "2026-04-10T12:00:00Z"
    }
  ]
}
```

### `GET /v1/identity-links/{alias_id}`

Purpose:

- fetch one identity link by alias id within the authenticated tenant

Current rules:

- lookup is tenant-scoped
- expired or revoked links return `404`
- missing link returns `404`
- cross-tenant access is hidden as `404`

Success:

- `200 OK`

Response:

```json
{
  "id": "idl_123",
  "tenant_id": "tenant-dev",
  "alias_id": "al_123",
  "real_identity_ref": "user@example.com",
  "purpose": "support",
  "created_at": "2026-04-03T12:00:00Z",
  "expires_at": "2026-04-10T12:00:00Z"
}
```

### `POST /v1/identity-links/{alias_id}/revoke`

Purpose:

- revoke one active identity link by alias id within the authenticated tenant

Current rules:

- revoke is tenant-scoped
- request body is optional
- optional `reason` is trimmed and must not contain invalid UTF-8 or CR/LF
- missing or expired link returns `404`
- already revoked link returns `409`
- successful revoke records an internal `identity_link_revoked` audit event when audit is configured

Optional request body:

```json
{
  "reason": "operator_request"
}
```

Success:

- `200 OK`

Response:

```json
{
  "id": "idl_123",
  "tenant_id": "tenant-dev",
  "alias_id": "al_123",
  "real_identity_ref": "user@example.com",
  "purpose": "support",
  "created_at": "2026-04-03T12:00:00Z",
  "expires_at": "2026-04-10T12:00:00Z",
  "revoked_at": "2026-04-03T13:00:00Z"
}
```

Errors:

- `400 Bad Request`
- `401 Unauthorized`
- `404 Not Found`
- `409 Conflict`
- `405 Method Not Allowed`
- `501 Not Implemented`
- `500 Internal Server Error`

Current error shaping rule:

- `500` responses use the generic payload `{"error":"internal server error"}`
