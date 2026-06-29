# Git Boundary

## Purpose

Keep the privacy gateway commit surface focused on source code, stable docs, and reusable example configuration.

## Commit This

- Go source under `cmd/` and `internal/`
- stable product and operator docs in the service root
- ADRs and other durable notes under `docs/`
- reusable scripts under `scripts/`
- tracked example env files such as `.env.fastmail.local.example` and `.env.profile.*.example`

## Do Not Commit This

- local secret-bearing env files:
  - `.env.fastmail.local`
  - `.env.record-only.local`
- generated evidence and runtime outputs:
  - `artifacts/`
  - `cover.out`
  - `data-local/`
  - `data-record-only-test/`
  - other `data*/` runtime directories

## Practical Rule

When preparing a commit, treat `services/privacy-gateway` as the product boundary, then exclude local runtime state and secrets inside that boundary.

## Current Repository Reality

The root repository still tracks only a small setup subset, while most product files are currently untracked from the root view.

That means:

- `git status` at the root can look noisier than the real code delta
- service-local hygiene matters before the first broad product commit
- the next clean git step should be an intentional first add/stage of the product files, not a blind `git add .`
