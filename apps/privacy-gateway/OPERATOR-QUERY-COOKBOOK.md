# Operator Query Cookbook

## Purpose

This is the shortest set of copy-paste API queries for common operator and debugging flows.

Use it when you need to:

- inspect current tenant activity
- narrow down submissions by status or channel
- inspect identity-link lifecycle state
- follow audit trails for one resource

All examples assume:

- local base URL: `http://localhost:8080`
- bearer token: `dev-token`

## Submissions

List the current tenant submission feed:

```bash
curl http://localhost:8080/v1/submissions \
  -H "Authorization: Bearer dev-token"
```

List only sanitized submissions:

```bash
curl "http://localhost:8080/v1/submissions?status=sanitized" \
  -H "Authorization: Bearer dev-token"
```

List only relayed submissions:

```bash
curl "http://localhost:8080/v1/submissions?status=relayed" \
  -H "Authorization: Bearer dev-token"
```

List only failed submissions:

```bash
curl "http://localhost:8080/v1/submissions?status=failed" \
  -H "Authorization: Bearer dev-token"
```

List submissions for one channel:

```bash
curl "http://localhost:8080/v1/submissions?channel_id=channel-1" \
  -H "Authorization: Bearer dev-token"
```

List the newest small slice for a quick operator scan:

```bash
curl "http://localhost:8080/v1/submissions?limit=10" \
  -H "Authorization: Bearer dev-token"
```

Combine channel, status, and limit:

```bash
curl "http://localhost:8080/v1/submissions?channel_id=channel-1&status=sanitized&limit=5" \
  -H "Authorization: Bearer dev-token"
```

Fetch one submission by id:

```bash
curl http://localhost:8080/v1/submissions/sub_123 \
  -H "Authorization: Bearer dev-token"
```

Fetch one submission timeline:

```bash
curl http://localhost:8080/v1/submissions/sub_123/timeline \
  -H "Authorization: Bearer dev-token"
```

Fetch one inbox timeline:

```bash
curl http://localhost:8080/v1/messages/inbox/imap_42/timeline \
  -H "Authorization: Bearer dev-token"
```

Fetch one alias/channel timeline:

```bash
curl http://localhost:8080/v1/aliases/al_123/timeline \
  -H "Authorization: Bearer dev-token"
```

List all channel summaries:

```bash
curl http://localhost:8080/v1/channels \
  -H "Authorization: Bearer dev-token"
```

List only channels with inbound replies, relay activity, and a sanitized latest submission:

```bash
curl "http://localhost:8080/v1/channels?has_inbox=true&has_relay_attempts=true&latest_submission_status=sanitized&has_failures=true" \
  -H "Authorization: Bearer dev-token"
```

## Identity Links

List active identity links for the tenant:

```bash
curl http://localhost:8080/v1/identity-links \
  -H "Authorization: Bearer dev-token"
```

List active identity links for one alias:

```bash
curl "http://localhost:8080/v1/identity-links?alias_id=alias-1" \
  -H "Authorization: Bearer dev-token"
```

Fetch one active identity link by alias id:

```bash
curl http://localhost:8080/v1/identity-links/alias-1 \
  -H "Authorization: Bearer dev-token"
```

Create one identity link:

```bash
curl -X POST http://localhost:8080/v1/identity-links \
  -H "Authorization: Bearer dev-token" \
  -H "Content-Type: application/json" \
  -d '{
    "alias_id":"alias-1",
    "real_identity_ref":"user@example.com",
    "purpose":"support",
    "expires_at":"2026-04-10T12:00:00Z"
  }'
```

Revoke one identity link with a governance reason:

```bash
curl -X POST http://localhost:8080/v1/identity-links/alias-1/revoke \
  -H "Authorization: Bearer dev-token" \
  -H "Content-Type: application/json" \
  -d '{
    "reason":"operator_request"
  }'
```

## Audit Events

List the current tenant audit feed:

```bash
curl http://localhost:8080/v1/audit-events \
  -H "Authorization: Bearer dev-token"
```

List only submission creation events:

```bash
curl "http://localhost:8080/v1/audit-events?event_type=submission_created" \
  -H "Authorization: Bearer dev-token"
```

List only identity-link revocation events:

```bash
curl "http://localhost:8080/v1/audit-events?event_type=identity_link_revoked" \
  -H "Authorization: Bearer dev-token"
```

Inspect audit history for one resource id:

```bash
curl "http://localhost:8080/v1/audit-events?resource_id=idl_123" \
  -H "Authorization: Bearer dev-token"
```

Inspect audit history for one submission across related events:

```bash
curl "http://localhost:8080/v1/audit-events?submission_id=sub_123" \
  -H "Authorization: Bearer dev-token"
```

Inspect only recent audit events:

```bash
curl "http://localhost:8080/v1/audit-events?since=2026-04-03T12:00:00Z" \
  -H "Authorization: Bearer dev-token"
```

Inspect a bounded recent audit slice:

```bash
curl "http://localhost:8080/v1/audit-events?event_type=submission_created&limit=10" \
  -H "Authorization: Bearer dev-token"
```

## Relay Attempts

List relay attempts for the tenant:

```bash
curl http://localhost:8080/v1/relay-attempts \
  -H "Authorization: Bearer dev-token"
```

Read relay feed summary quickly:

- inspect `summary.attempt_count`
- inspect `summary.failed_count`
- inspect `summary.retryable_count`
- inspect `summary.terminal_count`

List only failed relay attempts:

```bash
curl "http://localhost:8080/v1/relay-attempts?status=failed" \
  -H "Authorization: Bearer dev-token"
```

List relay attempts for one submission:

```bash
curl "http://localhost:8080/v1/relay-attempts?submission_id=sub_123" \
  -H "Authorization: Bearer dev-token"
```

Fetch one relay attempt by id:

```bash
curl http://localhost:8080/v1/relay-attempts/rly_123 \
  -H "Authorization: Bearer dev-token"
```

## Common Operator Flows

Follow one identity-link lifecycle:

1. `GET /v1/identity-links/{alias_id}`
2. `POST /v1/identity-links/{alias_id}/revoke`
3. `GET /v1/audit-events?resource_id=<identity-link-id>`

Follow one submission lifecycle:

1. `GET /v1/submissions?channel_id=<channel>`
2. `GET /v1/submissions/{id}/timeline`
3. inspect `summary`
4. inspect `relay_attempts`
5. inspect `audit_events`

Review failed relay candidates:

1. `GET /v1/submissions?status=failed&limit=10`
2. `GET /v1/relay-attempts?submission_id=<submission-id>`
3. inspect `failure_class` and `failure_disposition`
4. `GET /v1/audit-events?submission_id=<submission-id>`

Find current work queue candidates:

1. `GET /v1/submissions?status=sanitized&limit=10`
2. `GET /v1/audit-events?event_type=submission_created&limit=10`
