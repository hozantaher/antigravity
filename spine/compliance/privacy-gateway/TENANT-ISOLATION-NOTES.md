# Tenant Isolation Notes

## Purpose

This is the shortest explanation of how tenant isolation currently works in the service.

Use it when you need to answer:

- where tenant scope is enforced
- where user ownership is stricter than tenant scope
- why some cross-tenant lookups intentionally return `404`

## Core Isolation Model

The current isolation layers are:

1. authentication resolves one `Actor`
2. the actor carries `tenant_id`
3. services and handlers scope reads and writes using that tenant
4. some resources also enforce actor ownership, not just tenant membership

Current actor fields:

- `id`
- `tenant_id`
- `primary_email`

## Boundary 1: Authentication

All `/v1/*` endpoints require bearer-token authentication.

Effect:

- no tenant-scoped operation happens before actor resolution
- all later scoping depends on the resolved actor

Normal failure:

- `401 unauthorized`

## Boundary 2: Alias Ownership

Aliases are stricter than plain tenant scope.

Alias reads for `/v1/messages` use owner checks:

- `alias.user_id == actor.id`
- `alias.tenant_id == actor.tenant_id`

Meaning:

- another user in the same tenant cannot use your alias through legacy message submission

Normal failure:

- `403` via alias ownership enforcement

This is intentionally different from the newer privacy-first read models, which are tenant-scoped.

## Boundary 3: Tenant-Scoped Submissions

Submissions are scoped by tenant.

List behavior:

- `GET /v1/submissions` only returns submissions for `actor.tenant_id`

Detail behavior:

- `GET /v1/submissions/{id}` loads by id and then checks tenant match
- cross-tenant access is hidden as `404`

Meaning:

- callers do not learn whether another tenant's submission id exists

Normal hidden failure:

- `404 submission not found`

## Boundary 4: Tenant-Scoped Audit Events

Audit reads are fully tenant-scoped.

Behavior:

- `GET /v1/audit-events` only lists events for `actor.tenant_id`
- filters such as `event_type`, `resource_id`, `since`, and `limit` are applied inside that tenant slice

Meaning:

- a resource id filter never leaks another tenant's audit history

Cross-tenant posture:

- other-tenant events are simply absent from the result set

## Boundary 5: Tenant-Scoped Identity Links

Identity links are tenant-scoped at read and write time.

Create behavior:

- `POST /v1/identity-links` writes the link under `actor.tenant_id`

List behavior:

- `GET /v1/identity-links` lists only active links for `actor.tenant_id`
- expired or revoked links are filtered out

Detail behavior:

- `GET /v1/identity-links/{alias_id}` looks up by `tenant_id + alias_id`
- expired, revoked, missing, and cross-tenant links all collapse to `404`

Revoke behavior:

- `POST /v1/identity-links/{alias_id}/revoke` also resolves by `tenant_id + alias_id`

Meaning:

- callers do not learn whether the alias is linked in another tenant

Normal hidden failure:

- `404 identity link not found`

## Boundary 6: Inbox and Outbox Views

Inbox and outbox views are actor-scoped through the authenticated actor.

Meaning:

- mailbox-like views are not global tenant feeds
- they are limited to records associated with the current actor context

This is intentionally narrower than the tenant-scoped audit and identity-link read models.

## Where `404` Is Intentional

The service intentionally uses `404` to hide existence in these places:

- `GET /v1/submissions/{id}`
  Cross-tenant submissions are hidden as not found
- `GET /v1/identity-links/{alias_id}`
  Missing, expired, revoked, and cross-tenant links all resolve to not found
- `POST /v1/identity-links/{alias_id}/revoke`
  Missing, expired, and cross-tenant links resolve to not found

Why:

- it reduces cross-tenant existence disclosure
- it keeps the public contract simpler for privacy-first read paths

## Where `403` Is Intentional

The main explicit `403` path today is legacy alias usage:

- `/v1/messages` with an alias not owned by the actor

Why:

- alias usage is owner-scoped, not merely tenant-scoped
- this is stricter than the newer tenant-visible read models

## Operator Debug Heuristics

If a submission id exists in storage but the caller gets `404`:

- first suspect tenant mismatch before suspecting data loss

If an identity link exists in `identity-links.json` but detail lookup returns `404`:

- check whether it is expired or revoked before assuming it is missing

If audit queries look empty while the resource exists:

- check tenant context first
- then check retention window and filters such as `resource_id` or `since`

If `/v1/messages` returns `403` while tenant-scoped reads work:

- that usually indicates alias ownership mismatch, not tenant mismatch

## Practical Summary

The current model is intentionally mixed:

- legacy alias send flow is owner-scoped
- privacy-first read models are tenant-scoped
- cross-tenant reads are often hidden as `404`
- audit visibility is tenant-scoped, not global

That combination is deliberate and should be preserved unless the public contract is explicitly revised.
