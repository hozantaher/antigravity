# Sprint 7 Local Plan

## Theme

Local operator experience.

## Objective

Improve day-to-day local development and inspection without depending on a real SMTP or IMAP provider.

## Why This Sprint Exists

The current project is strong on backend capability, but live provider verification is still external.

That means the best local continuation work is:

- better local operator visibility
- faster read-model inspection
- less manual stitching across endpoints

## Scope

Initial scope:

- add a top-level local operator overview endpoint
- expose aggregate counts across aliases, submissions, relay attempts, inbox, identity links, and audit
- keep the response tenant-scoped and read-only
- avoid adding a UI or broad admin platform

## First Delivered Slice

Delivered in the first slice of this sprint:

- `GET /v1/dashboard`
- `GET /ui` as a local shell over operator and intake read models, timelines, detail loaders, queue actions, and saved local filters
- `POST /v1/intake/submissions` as a separate local secure-intake surface
- `GET /v1/intake/dashboard` as an intake-scoped operator overview
- intake-specific sanitizer policy levels with `standard` and `strict`
- intake-owned read paths:
  - `GET /v1/intake/submissions/{id}`
  - `GET /v1/intake/submissions/{id}/timeline`

Current purpose of that endpoint:

- one fast local operator overview
- one place to confirm whether the backend looks healthy and populated
- one place to inspect recent channel context before opening more specific timelines

## Non-Goals

Not part of Sprint 7:

- provider-backed verification itself
- broad admin UI
- mutable operator workflows
- new product claims or new transport modes

## Recommended Next Steps

After the dashboard slice, the next local-only options are:

1. add small dashboard filters or recent-item views only if they clearly reduce operator friction
2. add a lightweight local UI over the frozen read models
3. move to database-backed persistence if local JSON snapshots become the bottleneck

## Success Criteria

- local operator can understand system state without opening multiple endpoints manually
- the new surface is additive and does not destabilize the frozen contracts
- local development gains value even while provider-backed release verification stays blocked
