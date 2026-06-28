# Operator Practice — operator runbook

**Status:** living document — kept in sync as Operator Practice initiative
(`docs/initiatives/2026-04-30-operator-practice.md`) ships sprints.

**Audience:** operator (Tomáš + future onboarding hires) wanting to
practice the daily inbox triage / classify / reply loop without using
prod data or sending real campaigns.

## TL;DR

```bash
# 1. Boot Mail Lab (one-time per session)
bash scripts/mail-lab/up.sh

# 2. Seed 10 placeholder replies into your operator inbox
bash scripts/mail-lab/seed-replies.sh 10 op@gmail.lab --password labpass

# 3. Open dashboard, click Replies, classify
open http://localhost:5175/replies
```

That's the loop. Everything below is detail + alternatives.

## Why practice mode exists

Production daily ops:
- you craft a campaign, hit send
- replies trickle back over hours/days
- you triage (interested / not / OOO / wrong-person / spam)
- LLM classifier helps; you override when it's wrong
- you draft a follow-up reply

You can't iterate this loop fast on prod (real prospects, real
suppression risk, real days of waiting). Practice mode replays
anonymized real replies into a lab inbox so the same UI, classifier,
and SSE push pipeline run against a deterministic synthetic timeline.

See `feedback_operator_focus` memory for the pivot decision.

## Prerequisites

| Component | How to confirm | If missing |
|---|---|---|
| Docker daemon running | `docker ps` returns 0 | Start Docker Desktop |
| Mail Lab compose file | `infra/docker/mail-lab.yml` present | PR #220 not merged yet — clone branch |
| Lab IMAP port mapped | `lsof -i :25993` after `up.sh` | Check `docker compose ps mail-lab-seznam` |
| Operator mailbox provisioned | `bash scripts/mail-lab/seed.sh` ran once | Re-run seed; account list lives in `mail-lab-api` |
| Dashboard running | `pnpm -C features/platform/outreach-dashboard dev` returns 200 on :5175 | Start with `pnpm dev` |

## Daily training routine

### Setup (once per day, ~30s)

```bash
bash scripts/mail-lab/up.sh
bash scripts/mail-lab/seed-replies.sh 25 op@gmail.lab --password labpass
```

### Practice (5–15 min)

1. Open dashboard `/replies`
2. Top of list shows newest threads (SSE just pushed them)
3. Click thread → ThreadDetail renders sanitized HTML + attachment chips
4. LLM auto-classification badge top-right
5. Override if wrong: keyboard shortcut **i** (interested), **n** (not), **o** (OOO), **w** (wrong-person), **s** (spam)
6. Draft reply (template button or custom)
7. Send (lab routes to lab — no prod traffic)

### Review (after session, 1 min)

```bash
# How many you classified this session, with median latency
node scripts/operator-practice/session-stats.mjs --since 1h
```

(Will print: `28 threads / 6:42 elapsed / 14s median / 18% LLM override`.
This script ships with **OP3.3** — until then, manual count.)

### Reset between scenarios

```bash
bash scripts/mail-lab/clear-inbox.sh op@gmail.lab
```

(OP2.4 — until then, restart the lab: `bash scripts/mail-lab/up.sh --clean`.)

## Sprint-aware feature map

| Feature | Sprint | Available? | Workaround until then |
|---|---|---|---|
| Inject N replies | OP1.3 | ✅ PR #264 | — |
| Time-accelerated arrival curve | OP2.1–2.3 | pending | Run injector multiple times manually |
| Workflow timer (per-thread) | OP3.1 | pending | `time` the dashboard click in your head |
| LLM override capture | OP3.2 | pending | — (LLM classifier works; just no capture) |
| Daily stats panel | OP3.3 | pending | Count manually |
| Practice-mode toggle (separate analytics) | OP3.4 | pending | All events go to prod analytics — be careful |
| Confusion matrix | OP4.3 | pending | — |
| Edge case discovery | OP4.4 | pending | — |
| End-to-end Playwright | OP5.1 | pending | Manual click-through |

## Fixtures: where the seeded replies come from

Today (until OP1.2 anonymizer lands):

```
tests/fixtures/operator-replies/_placeholders/
├── placeholder-001-interested.eml
├── placeholder-002-not-interested.eml
├── placeholder-003-ooo.eml
├── placeholder-004-wrong-person.eml
├── placeholder-005-spam.eml
└── placeholder-006-ambiguous.eml
```

These are **infrastructure-only** — every file carries
`X-Lab-Source: placeholder-infrastructure-test`. They prove the pipe
works but carry no semantic truth (don't trust your "accuracy" score
when running against placeholders).

After OP1.2 lands:

```
tests/fixtures/operator-replies/
├── interested/<real-anonymized>.eml
├── not-interested/...
└── ...
```

Run `seed-replies.sh ... --source real-anonymized` to filter to real.

## Troubleshooting

### "no fixtures matched category=ALL source=placeholder"

The `_placeholders/` directory may be empty or files may be missing the
`X-Lab-Source` header. Check `tests/fixtures/operator-replies/_placeholders/`
contains `.eml` files with the placeholder marker.

### "IMAP connect ECONNREFUSED"

Lab not running. `bash scripts/mail-lab/up.sh` then retry.

### "LOGIN BAD" / "auth failed"

Operator mailbox not provisioned in lab. Confirm:

```bash
curl -H "X-Lab-Api-Key: dev-only" http://localhost:8090/v1/mailbox/op@gmail.lab
```

If 404, create:

```bash
curl -X POST -H "X-Lab-Api-Key: dev-only" -H "Content-Type: application/json" \
  -d '{"address":"op@gmail.lab","password":"labpass"}' \
  http://localhost:8090/v1/mailbox
```

### Dashboard doesn't show new threads

- SSE not connected: check browser DevTools Network → look for `/api/threads/stream` EventSource
- Orchestrator IMAP poll not running: needs `--lab-mode` flag (post mail-client-fidelity stack landing)
- Polling interval too slow: orchestrator polls every 30s by default; nudge with `IMAP_POLL_INTERVAL=5s` env

### LLM classifier returns garbage

- Ollama not running locally: `ollama serve` (default mode)
- Wrong model: check `OLLAMA_MODEL` env (default per `2026-04-27-llm-reply-classifier.md`)
- Real fix: edge cases feed back via OP4.4 → prompt tuning iteration

## Airtight workflow — safe dev start

Per [ADR-005](../decisions/ADR-005-airtight-dev-env.md), když pracuješ
proti send pipeline (features/outreach/campaigns/sender/engine.go), dev terminál
explicit zapne kill switch:

```bash
# 1. Boot Mail Lab (jednorázově per session)
bash scripts/mail-lab/up.sh

# 2. Activate airtight gate — engine refuses real SMTP dial
export LAB_ONLY=1
export TRANSPORT_MODE=lab

# 3. Boot orchestrator / dashboard
pnpm dev
# nebo
go run features/inbound/orchestrator/cmd/orchestrator/main.go
```

**Co se stane při typo:**

- `LAB_ONLY=1` + `TRANSPORT_MODE=proxy` → engine init `log.Fatal`
  s exitem 47 a zprávou `airtight: refusing real SMTP dial under
  LAB_ONLY=1 (mode=proxy)`. Není silent fallback.
- `TRANSPORT_MODE=direct` → exit 48 (per `feedback_no_direct_transport`).
- Unknown `TRANSPORT_MODE` (e.g. `tor`, `vpn`) → exit 48.

**Production deploy** nikdy `LAB_ONLY` nesettuje; `TRANSPORT_MODE=proxy`
(Mullvad wireproxy) je default. Pokud Sentry alert
`OUTREACH_BOOT_FAILURE airtight_refusal` zazněl v prod, někdo omylem
přidal `LAB_ONLY=1` do Railway env → unset + redeploy.

**Reverting back to production-shape dev** (testovat real SMTP path):

```bash
unset LAB_ONLY
export TRANSPORT_MODE=proxy
# Pozor: per feedback_campaign_send a feedback_no_direct_smtp pořád
# nesmíš spustit real send bez explicit consent.
```

## Hard rules — do not break

| # | Rule | Source |
|---|---|---|
| 1 | NEVER use practice mode credentials in prod | `feedback_campaign_send` |
| 2 | NEVER add fabricated/Faker test data to fixtures | `feedback_no_fabricated_test_data` |
| 3 | NEVER push real PII to fixtures (run anonymizer first) | GDPR Art. 6/1/f |
| 4 | NEVER bypass `--source real-anonymized` filter for "real practice" runs | OP1.2 contract |
| 5 | Practice events flag separately from prod analytics | OP3.4 toggle |
| 6 | NEVER unset `LAB_ONLY=1` mid-iteration without TRANSPORT_MODE check | ADR-005 §D3 |
| 7 | NEVER add new `net.Dial`/`smtp.Dial` outside lab-mode gate without `// airtight-allowed:` annotation | ADR-005 §D4 |

## Related docs

- Initiative: `docs/initiatives/2026-04-30-operator-practice.md`
- Mail Lab foundation: `docs/initiatives/2026-04-29-mail-lab.md` (issue #212)
- LLM Reply Classifier: `docs/initiatives/2026-04-27-llm-reply-classifier.md`
- Mail Client Fidelity: `docs/initiatives/2026-XX-mail-client-fidelity.md` (issue #192)
- Memory: `feedback_operator_focus.md`
