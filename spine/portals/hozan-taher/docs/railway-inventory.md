# Railway inventory — `garaaage-mcp` (production)

> Mapped 2026-06 (Produkční raketa deep-inventory). Source: `railway list` +
> `railway status --json` on the `garaaage-mcp` project, env `production`.
> Read-only snapshot — no secrets here (use `railway variables` locally; never
> paste values per `feedback_no_pii_in_commands`).
>
> **Scope guard (`project_railway_db_scope` T0):** this workspace mixes services
> from several projects. Only the rows marked **OURS** belong to hozan-taher.
> Never touch the others.

## Services (17)

| Service | Role | Ours? | Notes |
|---|---|---|---|
| `outreach-db` | PROD Postgres (outreach data) | ✅ OURS | `junction.proxy.rlwy.net:54755`; the dashboard's `DATABASE_URL`. 16 GB. |
| `anti-trace-relay` | SMTP/IMAP egress relay (Mullvad SOCKS) | ✅ OURS | `anti-trace-relay-production-a706.up.railway.app`. All egress goes here. |
| `machinery-outreach` | Go runner — 24/7-critical crons | ✅ OURS | IMAP poll, bounce flip/throttle/rate-monitor, mailbox healing, greylist retry (Z3). |
| `ollama` | Local LLM inference | ✅ OURS | `ollama-production-51cd.up.railway.app`, model **llama3.2:3b**. The dashboard's `OLLAMA_URL`. **See finding #1.** |
| `rozpor-worker` | Rozporuj PDF generator (BullMQ) | ✅ OURS | worker.md subsystem. |
| `garaaage-scrapers` | Contact-data scrapers | ✅ OURS | scrapers.md (dormant). |
| `garaaage-db-prod` | Garaaage app PROD Postgres | ✅ OURS | separate from outreach-db. |
| `garaaage-db-test` | Garaaage test Postgres | ✅ OURS | |
| `garaaage-redis` | Redis (BullMQ / cache) | ✅ OURS | |
| `garaaage-grafana` | Grafana dashboards | ✅ OURS | paired with `loki`. |
| `loki` | Log aggregation | ✅ OURS | |
| `privacy-gateway` | Privacy/unsubscribe gateway | ✅ OURS | |
| `typesense` | Search index | ⚠️ verify | confirm owner before touching. |
| `searxng` | Meta-search | ⚠️ verify | likely a different project. |
| `Redis` | generic Redis | ⚠️ verify | un-namespaced — confirm owner. |
| `Postgres` | generic Postgres | ⚠️ verify | un-namespaced — likely NOT ours (scope guard). |
| `outreach-dashboard` | — | ❌ ZOMBIE | **See finding #2.** |

## Findings

### #1 — Ollama is available; it was never "down", just cold-loading

The LLM second-stage classifier (`classifyReplyWithLLM`) + the on-demand
vehicle extractor (`ollamaVehicleExtract`) both call `OLLAMA_URL`, which is
configured in the dashboard `.env` and points at this `ollama` service
(llama3.2:3b, reachable, `/api/tags` OK).

Earlier ticks reported "Ollama down" — that was a measurement error (checking
`localhost:11434`, which has no local Ollama). The real path is the Railway
service. The remaining problem was **cold-load**: the client sent no
`keep_alive`, so the model unloaded after every request (~3.4 s reload + ~10 s
inference → 17-20 s/call → most cron calls hit the 20 s timeout and silently
fell back to regex). Fixed 2026-06 by adding `keep_alive` (model now stays
resident, `load_duration` 3.4 s → 0.2 s, warm calls ~9-15 s, no timeouts;
verified live: regex `null` → `ollama_v1` classification).

### #2 — `outreach-dashboard` Railway service contradicts the local-only rule

HARD RULE `feedback_outreach_dashboard_local_only` (v3, 2026-05-14) states the
whole dashboard (UI + BFF + crons) runs **only** on the operator's Mac and the
Railway service was torn down. Yet a service named `outreach-dashboard` still
exists in this project. Either it is a stale/zombie shell left after the
tear-down, or the rule is out of date.

**Action: operator decision required** — do not auto-delete (destructive, and
it contradicts a standing rule). If confirmed zombie, remove it and update the
memory; if it is intentionally back, update the HARD RULE. Surfaced, not acted
on.
