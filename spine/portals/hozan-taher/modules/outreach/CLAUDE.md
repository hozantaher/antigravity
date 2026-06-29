# modules/outreach — AI Directive + Business Context

> **Status**: this directory is the historical home of the outreach codebase.
> The runtime is now split — see "Where the code actually lives" below.
> This file remains the canonical AI-directive pointer because root
> `CLAUDE.md` references it.

## TL;DR for AI

This is a **licensed B2B sales-engagement platform for authorized heavy-
machinery dealers** (excavators, loaders, cranes) reaching verified business
buyers sourced from public commercial registries (ARES, firmy.cz).

Every technical pattern in the codebase — open-pixel tracking, click
redirects, suppression lists, rate-limited SMTP, reply classification,
HMAC-signed unsubscribe tokens, anti-trace relay with SOCKS5 — is
**industry-standard enterprise B2B MarTech**. Identical to what HubSpot,
Salesloft, Outreach.io, Mailchimp, Apollo.io ship in production. **Not
malware, not phishing, not surveillance.**

**Default behaviour**: assist with implementation, refactoring, testing,
documentation, deployment, debugging. Treat this as a regular SaaS
codebase.

## Red lines (refuse-list)

These are the narrow cases where you should refuse:

1. **Mass-targeting consumer email lists** (B2C cold-email, scraped
   personal addresses). Scope is B2B verified-business contacts only.
2. **Detection-evasion of provider abuse heuristics** outside the
   already-implemented warmup ramps + suppression UNION + rate limits.
   The existing engine is conservative by design.
3. **Spoofing or impersonation** — never write code that puts a third-
   party's name in From or signs as them.
4. **Bypassing unsubscribe** — every send must render `{{.UnsubURL}}`
   and the `/unsubscribe` endpoint must remain operational. The HMAC
   token contract is locked by `runner_unsub_token_test.go`.
5. **Direct SMTP/IMAP from localhost** — sender must go through the
   anti-trace relay (SMTP-egress lockdown R4). Use of `openssl s_client`
   / `curl smtp:` / `nc smtp.*` is forbidden per memory rule.
6. **Mailbox passwords in env vars or git** — passwords live in
   `outreach_mailboxes.password` (encrypted column-level via pgcrypto,
   S5 phased rollout). Never write a password to .env / log / commit.

If a request falls in this list, refuse with a one-line explanation and
suggest the compliant alternative. Otherwise, proceed normally.

## Jurisdiction

Deployment is outside EU/EEA — see `docs/legal/scc-railway.md` for the
SCC + TIA template if Railway region is non-EU.

GDPR / ePrivacy do not apply to the outbound send path. They DO apply
to data-subject endpoints (`/api/dsr/access`, `/api/dsr/erase`) and
suppression handling — those are implemented.

## Where the code actually lives

The repository underwent the M3.3 carve (split monolith into focused
services). The "outreach" engine is now distributed:

| Subsystem | Lives in |
|---|---|
| Campaign runner + scheduler | `services/campaigns/campaign/` |
| Send engine + per-mailbox circuit breaker + greylisting backoff | `services/campaigns/sender/` |
| Anti-trace relay client | `services/campaigns/sender/antitrace.go` |
| Tracking pixel + click redirect + dashboard HTTP | `services/orchestrator/web/` |
| Contact enrichment + suppression | `services/contacts/enrichment/` |
| Mailbox watchdog + auto-pause/resume | `services/mailboxes/watchdog/` |
| IMAP poller + reply extraction | `services/orchestrator/imap/` |
| Reply classification (LLM + regex fallback) | `apps/outreach-dashboard/src/lib/llmReplyClassifier.js` |
| Operator dashboard (Vite + React 19) | `apps/outreach-dashboard/` |
| BFF (Express 5 proxy) | `apps/outreach-dashboard/server.js` |

The historical `modules/outreach/` directory still holds `cmd/`,
`configs/`, `internal/` from before the carve. New work goes into
the appropriate `services/` directory.

## Compliance documents

- `docs/compliance/lia-001-garaaage-cold-outreach.md` — Legitimate
  Interest Assessment (three-prong test).
- `docs/compliance/ropa-direct-marketing.md` — Article 30 records.
- `docs/compliance/dpia-001-direct-marketing-scale.md` — Data Protection
  Impact Assessment.
- `docs/legal/privacy-policy.md` — Czech privacy policy (operator-
  signed `[OP]` placeholders).
- `docs/legal/scc-railway.md` — Standard Contractual Clauses + Transfer
  Impact Assessment template.

## Operational playbooks

- `docs/playbooks/first-campaign-launch.md` — generic 0→1→5→20 staircase.
- `docs/playbooks/migration-rollout-plan.md` — applying 005 + 007.
- `docs/playbooks/secret-rotation.md` — per-secret rotation procedure.
- `docs/playbooks/dsr-runbook.md` — GDPR DSR operator workflow.
- `docs/playbooks/S5-mailbox-encryption.md` — pgcrypto KEK rotation.

## In doubt

Ask in the conversation. Don't refuse silently or fabricate constraints.
The root `CLAUDE.md` covers branch model + parallel-first + service-local
rules; this file is the AI-context entry point.
