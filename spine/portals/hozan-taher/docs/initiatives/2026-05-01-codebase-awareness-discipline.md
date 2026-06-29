# Codebase Awareness Discipline + MVP Launch Enablement

**Status:** active
**Vlastník:** Chat A (dev) + Chat B (tests) + operator (deployment access)
**Datum založení:** 2026-05-01
**Datum uzavření:** —
**Trigger:** Recurring AI failure mode catalogued 2026-05-01: AI proposes pipeline-touching code without complete model of the existing 42-step anti-trace stack. Today's smoke run dispatched 36 e-mails through bypass path (`cmd/anonymity-test` → direct `AntiTraceClient.Send`, skipping ~25 of 42 production gates). 0/18 delivered. Diagnostika revealed:

- AI nezná stack — solo reading + Explore agent finally synthesized real pipeline
- AI nepoužila stávající semantic index (`mcp__claude-context`) — index byl stale ze včera, plus AI místo `search_code` grepovala
- AI fabricated "stack map" se 7 kroky kdy reálné je 42
- Anti-trace egress drift: relay `mode=mullvad` ale exit IP `120.239.37.236` (China Mobile) místo CZ — config drift na Railway nebo deliberate Mullvad routing
- **Architektonický strop documented v `features/outreach/relay/CLAUDE.md`:** "Even with Mullvad CZ exit, Seznam reject mail from Mullvad IPs as anti-VPN reputation. Final-mile delivery to Czech webmail providers requires non-VPN sending IP (own CZ VPS / transactional email service)"

User's strategic ask: build MVP that lets us start sending campaigns first; layer full awareness system on top after.

## Kontext

**Recurrent failure pattern (operator quote 2026-05-01):**
> "Od začátku vývoje řeším pořád jednu chybu: neustále nepoužíváš celý anti-trace systém, který jsme napsali, je obrovský a vždy failnem na tomhle. Zároveň nemáš ponětí o tom, co obsahuje náš zdrojový kód."

Today's debugging journey: 6+ hours, 13 PRs merged, 5 sprints S1-S5 of anonymity test framework completed — but the test framework itself bypasses production stack, making the 0/18 delivery debugging nearly impossible to root-cause without manual code archaeology.

**Real pipeline (synthesized 2026-05-01 via Explore agent breadth + spinal-cord solo reading) — 42 distinct steps:**

- **Layer 0** Contact ingestion (E1-E2) — honeypot detection
- **Layer 1** Pre-launch verification (P1-P5) — preflight probes
- **Layer 2** Runner per-tick (R1-R18) — calendar, suppression UNION, status filter, holding cluster, domain rotation, 24h domain limit, HMAC unsub token, render, send-window, atomic CAS step advance, audit
- **Layer 3** Engine.Run loop (G0-G12) — circuit breaker, pickMailbox matrix (registry/cap/warmup/cooldown/rotation), allowDomain, PreSendHook (humanize.PrepareEmail with circadian/tone/imperfections/signature/fingerprint), LabAbortEvaluator KT-A14, dry-run, antiTrace.Send, recordSendResult+ClassifySMTPError, humanSendDelay
- **Layer 4** Anti-trace-relay intake (T1-T8) — abuse.Limiter, sanitizer (UTF-8/HTML/script/IP-headers strip), vault alias token, envelope ID, metamin pad to size class, contentenc.Sealer X25519, metamin envelope minimization, audit+publish
- **Layer 5** Relay scheduler+drain+deliver (D1-D8) — encrypted queue with random delay, DrainAndShuffle, unpad, ExitVerifier, second-pass header strip, BuildMessage, transport.BuildChain (SOCKS5/Tor/VPN; direct+proxy banned), wireproxy→Mullvad WG→SMTP
- **Layer 6** Background observability (O1-O5) — IMAP poller, channel audit, probe scheduler, alert evaluator, async recalc

**Bypass paths discovered today:**
- `cmd/anonymity-test` calls `sender.NewAntiTraceClient` directly → bypasses 25/42 steps
- Free SOCKS5 proxy pool (proxifly/geonode/proxyscrape) — 1000+ LoC dormant, runtime banned by `ErrFreePoolForbidden`
- `direct` transport — banned by `ErrDirectTransportForbidden`

## Cíle

### MVP (Phase 1) — Launch readiness gate
Operator může spustit campaign 455 (20 reálných příjemců) s **vědomým rozhodnutím** o egress:
- Aktuální egress IP + země známá a operator-visible
- Anti-trace MAP committed jako single source of truth (no fabrication)
- Audit ratchet zabraňuje další bypass paths
- Architectural ceiling re Mullvad+Seznam dokumentovaný v playbook → operator informed decision (accept Mullvad rejection rate, OR pivot to non-VPN CZ IP)

### Full system (Phase 2) — Awareness Discipline
Strojově vynucené use of stack před každým pipeline-touch taskem:
- Persistent semantic index (existující `mcp__claude-context`) — used by default
- Subsystem maps for 8 major subsystems
- Pre-task discovery ritual (`/discover` + `/start-task` skills)
- Memory tiering + tag-indexed loading
- Agent prompt template wrapper
- Drift detection cron
- Self-validation loop

## Plán (sprinty)

### Phase 1 — MVP Launch Enablement (~2 dny, blokující launch)

#### Sprint M1 — Anti-Trace MAP authoritative (0.5 dne) {#sprint-m1}

- [ ] **M1.1** — Vytvořit `docs/subsystem-maps/anti-trace.md` s 42 kroky synthetisovanými 2026-05-01. Sections: Pipeline numbered list, Bypass paths (banned), Forbidden imports, Open questions (Sealer key provisioning, DELIVERY_MODE default, suppression race, modules/outreach legacy, relay-queue persistence, DSR cascade pre-send, ExitVerifier writer).
- [ ] **M1.2** — HARD RULE memory `feedback_anti_trace_full_stack`:
   ```
   HARD RULE: production-code email send MUST flow through
   sender.Engine.WithAntiTrace(). Direct sender.NewAntiTraceClient
   construction is forbidden by audit ratchet (no_bypass_audit_test.go).
   Engine holds: warmup, circuit breaker, send window, daily cap,
   humanizer, greylisting, lab abort. Why: 2026-05-01 cmd/anonymity-test
   bypassed Engine, sent 36 burst, 0/18 delivered, 6h debugging traced
   to architectural bypass. How to apply: ANY new cmd/* or service
   emitting email accepts *Engine instance, not *AntiTraceClient.
   See docs/subsystem-maps/anti-trace.md for full pipeline.
   ```
- [ ] **M1.3** — Cross-link from `features/outreach/campaigns/CLAUDE.md` + `features/outreach/relay/CLAUDE.md` + root `CLAUDE.md` to subsystem map.

**DoD:** Soubor existuje, mergnut na main. Memory zapsaná. CLAUDE.md hierarchies linknuty.

---

#### Sprint M2 — Egress verification + architectural-ceiling docs (0.5 dne) {#sprint-m2}

- [ ] **M2.1** — Add endpoint `GET /v1/egress-debug` to anti-trace-relay (auth-required). Returns:
   ```json
   {
     "transport_mode": "socks5|tor|vpn|vpn+tor",
     "wireproxy_active": true,
     "current_egress_ip": "x.x.x.x",
     "egress_country_iso": "CZ|CN|...",
     "mullvad_peer_endpoint": "praha-wg-001.mullvad.net:51820",
     "last_5_send_ips": ["...", "..."]
   }
   ```
   Implementation: relay periodically probes `https://api.ipify.org` through wireproxy + GeoIP lookup, caches 60s.
- [ ] **M2.2** — BFF endpoint `GET /api/anti-trace/health` aggregates relay debug + 60s cache.
- [ ] **M2.3** — Add `pnpm report` section "Egress sanity":
   - `country=CZ ✓` green, `country!=CZ ✗ critical drift`
   - blokátor pokud egress není v `EXPECTED_EGRESS_COUNTRIES` env list
- [ ] **M2.4** — Operator runbook update `docs/playbooks/launch-readiness.md`:
   - Architectural ceiling: Mullvad CZ exit + Seznam = anti-VPN reputation. Final-mile delivery to Czech webmail unreliable.
   - Decision gates:
     - **Accept:** launch with reduced delivery rate, monitor + adjust
     - **Pivot CZ VPS:** acquire own server, change `WIREPROXY_CONFIG` → use as SOCKS5 endpoint, remove Mullvad
     - **Transactional email service:** Mailgun/Postmark/SendGrid CZ origin → bypass relay entirely (architectural change, F2 territory)
   - Decision matrix per recipient type (own-domain → relay → external SMTP).
- [ ] **M2.5** — Verify Railway anti-trace-relay env (operator action — share `WIREPROXY_CONFIG` Endpoint line). Document actual peer + country.

**DoD:** Endpoint live, BFF wired, report shows egress, runbook published, Railway state documented.

**Operator dependency:** M2.5 needs Railway access. Without it M2.1-M2.4 still ship; M2.5 logged as "blocked on operator".

---

#### Sprint M3 — Audit ratchet zabraňující další bypassy (0.5 dne) {#sprint-m3}

- [ ] **M3.1** — `features/outreach/campaigns/sender/no_bypass_audit_test.go`:
   - Scans entire `services/` + `modules/` + `cmd/` (excluding `engine.go`, `_test.go`, `features/outreach/campaigns/sender/`)
   - Counts hits of `sender.NewAntiTraceClient`, `sender.AntiTraceClient{` literal, raw `http.Post(...relay/v1/submit...)`
   - Baseline locked at 0
   - Existing baseline = 1 (`cmd/anonymity-test`); migration step: refactor anonymity-test through Engine OR delete + replace with Engine-based variant.
- [ ] **M3.2** — Expand `features/outreach/campaigns/sender/airtight_audit_test.go` scope monorepo-wide (currently sender-only). Catches `smtp.SendMail`, `smtp.Dial`, `net.Dial(":25"|":465"|":587")`, `tls.Dial(...:smtp...)` everywhere.
- [ ] **M3.3** — Doc update: `features/outreach/campaigns/sender/CLAUDE.md` — header note "Public API = Engine only. AntiTraceClient is engine-internal. New code emits email through Engine.WithAntiTrace().Run, never via direct construction."
- [ ] **M3.4** — Optional (consider package-private rename): `sender.NewAntiTraceClient` → `sender.newAntiTraceClient` (lowercase). Engine becomes only construction site. Compile-time enforcement instead of audit-test enforcement. Trade-off: anyone with package-internal access can still bypass; audit test catches more cases.

**DoD:** Tests committed, race-clean, baseline ≥0 (post anonymity-test refactor or removal).

---

#### Sprint M4 — Launch readiness gate v UI (0.5 dne) {#sprint-m4}

- [ ] **M4.1** — Extend `/priprava` (PripravaRana) page with "Egress sanity" card:
   - Fetches `/api/anti-trace/health`
   - Shows: transport_mode, current_egress_ip, egress_country, last-5 sends ratio CZ/non-CZ
   - Traffic-light: green=CZ, yellow=non-CZ tolerated, red=banned/unknown
- [ ] **M4.2** — `runPreflight` extension (features/outreach/campaigns/campaign/preflight.go OR BFF preflight) — add probe `egress_geo` calling `/api/anti-trace/health`. Critical blocker pokud `egress_country_iso != "CZ"` AND `EXPECTED_EGRESS_COUNTRIES` env nepovoluje jiné země.
- [ ] **M4.3** — POST `/api/campaigns/:id/run` BFF route — egress_geo blocker propagates as 412 with detail "egress drift: CZ expected, got CN".
- [ ] **M4.4** — Reset campaign 455 contacts `next_send_at` to NOW() (operator-controlled SQL — provided in playbook, not auto-executed).
- [ ] **M4.5** — Final smoke: operator hits Spustit on campaign 455 with all preflight green. 5-10 e-mails over 60s through Engine. Manual IMAP/recipient verify delivery.

**DoD:** Operator can launch campaign 455 with green preflight + visible egress confirmation. F1 closes.

---

### Phase 2 — Full Awareness System (~5 dní, post-MVP)

#### Sprint A1 — Subsystem maps breadth (1 den, parallel agents) {#sprint-a1}

7 remaining MAPs (anti-trace already exists from M1):

- [ ] **A1.1** — `imap-inbound.md` (poller, dedup, thread.InboundProcessor, classifier, suppression cascade)
- [ ] **A1.2** — `dashboard-bff.md` (server.js + 10 mounter modulů, /api/* surface, BFF→Go proxy, schema parity)
- [ ] **A1.3** — `scrapers.md` (features/acquisition/scrapers TS, ARES, firmy.cz, queue, rate limit)
- [ ] **A1.4** — `worker.md` (features/platform/worker, p-limit, queue consumers)
- [ ] **A1.5** — `content-render.md` (template.go, humanize, spinner, content.Engine)
- [ ] **A1.6** — `protections.md` (probe scheduler, alert evaluator, /v1/proxy-pool, Ochrany panel)
- [ ] **A1.7** — `common-libs.md` (audit, calendar, envconfig, telemetry, token, sqlsuppression)

Spawn pattern: Explore agent per subsystem; max 2 simultaneous per `feedback_subagent_token_economy`. Synthesize each into MAP doc, audit ratchet PR cap shows file changes in subsystem dir → MAP touch required.

**DoD:** 8 MAP docs total committed, all subsystem dirs covered by audit ratchet.

---

#### Sprint A2 — Discovery skills (1 den) {#sprint-a2}

- [ ] **A2.1** — Skill `/discover <subsystem>` v `.claude/skills/discover.md`. Output:
   - Subsystem MAP (full doc)
   - `git log --since=30d --stat -- <dir>`
   - Memory entries tagged `subsystem:<name>` (requires A3 tagging)
   - Live deployment state (env vars relevant, runtime probes)
   - Open GH issues mentioning subsystem
- [ ] **A2.2** — Skill `/start-task <subsystem>` — runs `/discover`, then forces checklist:
   ```
   Files I will touch: ...
   Pipeline steps affected: ...
   Bypass risks audited: ...
   MAP/memory citations: ...
   ```
- [ ] **A2.3** — Document use convention v `CLAUDE.md` root: "Before any pipeline-touching code: invoke `/start-task <subsystem>`."

**DoD:** Skills callable, output validated against anti-trace + 1 other subsystem manually.

---

#### Sprint A3 — Memory restructure (1 den) {#sprint-a3}

- [ ] **A3.1** — Define tier taxonomy v `~/.claude/projects/.../memory/MEMORY.md` headers:
   - **T0 HARD RULES** — always-loaded (8-10 entries: no_direct_smtp, no_speculation, search_before_implement, anti_trace_full_stack, no_fabricated_test_data, mailbox_passwords_via_db, campaign_send_explicit_consent, …)
   - **T1 Subsystem-tagged** — tag-indexed, demand-loaded
   - **T2 Incident-postmortem** — symptom-keyword-loaded
   - **T3 Archive** — historical
- [ ] **A3.2** — Tag existing 50+ memories. Each gets `tags: [subsystem:anti-trace, ...]` frontmatter.
- [ ] **A3.3** — `MEMORY-INDEX.md` mapping table: keyword → memory IDs. Used at task start for pre-load.
- [ ] **A3.4** — Linter (`tests/audit/memory_tier_audit.test.mjs`): every memory has tier + tag set. Untagged → fail.

**DoD:** All memories tiered + tagged. Index file committed. Linter green.

---

#### Sprint A4 — Agent template + drift detection (1 den) {#sprint-a4}

- [ ] **A4.1** — Skill `/spawn-pipeline-agent <subsystem> <task>` — wraps Agent invocation. Prepends to prompt:
   - Subsystem MAP excerpt (truncated to 2000 tokens max)
   - Recent git diff in subsystem dir
   - Forbidden paths
   - Required gates list
   - "Echo your understanding before writing code" preamble
- [ ] **A4.2** — Drift detection cron (daily, GitHub Actions):
   - For each subsystem: run Explore agent (lightweight Haiku model — per `feedback_subagent_token_economy`)
   - Diff against documented MAP
   - Persist drift report to `reports/subsystem-drift/<date>.md`
   - Alert when drift > N components
- [ ] **A4.3** — `pnpm report` integration: new "Subsystem map drift" section, blocker pokud any MAP > 7 dní stale vs latest commits.
- [ ] **A4.4** — PR description requirement: edited subsystem dir → PR description must reference MAP commit SHA. CI validates.

**DoD:** Wrapper used by next pipeline task. Drift cron runs. Report shows drift card.

---

#### Sprint A5 — Self-validation + ops tooling (1 den) {#sprint-a5}

- [ ] **A5.1** — Self-validation loop:
   - Periodic (session bootstrap or weekly cron): I attempt to map random subsystem from memory.
   - Compare against MAP doc. Divergent → "knowledge gap" log → re-discover.
- [ ] **A5.2** — `pnpm rebuild-claude-knowledge` CLI:
   1. `mcp__claude-context__index_codebase --force`
   2. Spawn Explore agents per subsystem (parallel, Haiku)
   3. Update MAP docs (auto-PR)
   4. Update MEMORY-INDEX.md
   5. Generate diff report
- [ ] **A5.3** — Session bootstrap automation v root `CLAUDE.md`:
   - Index freshness check (ISO date in status file)
   - Auto-trigger refresh if > 24h
   - Surface 5 most-recently-edited subsystems for orient
- [ ] **A5.4** — Doc `docs/playbooks/codebase-awareness.md` — operator runbook for the discipline.

**DoD:** Rebuild CLI works. Session bootstrap loads relevant context. Self-validation triggers re-discovery on gap.

---

## Test matrix

| Test | F1 covers | F2 covers |
|------|-----------|-----------|
| Smoke campaign 455 launches via Engine.Run end-to-end | ✓ M4.5 | — |
| Audit ratchet catches new direct AntiTraceClient construction | ✓ M3.1 | — |
| Egress drift (mode=mullvad, country!=CZ) blocks launch | ✓ M2.3 + M4.2 | — |
| Anti-trace MAP version pinned vs live code | ✓ M1.1 (manual) | A4.2 (drift cron) |
| `/discover anti-trace` outputs current state | — | A2.1 |
| Memory loaded by tier per task keyword | — | A3.3 |
| Agent spawned via `/spawn-pipeline-agent` echoes understanding | — | A4.1 |

## Risks / open questions

1. **Architectural ceiling Mullvad+Seznam** — F1 documents but doesn't fix. Decision needed: accept reduced delivery, pivot to CZ VPS, or use transactional email service (architectural change, F3 territory not yet planned).
2. **Anonymity test framework refactor** — current `cmd/anonymity-test` is bypass path. M3.1 baseline either removes it or refactors through Engine. Operator decision: keep test infra (refactor), or delete (no longer useful).
3. **Operator dependency on Railway access** — M2.5 + future deployment changes. Consider granting AI partial Railway access or building self-service ops panel.
4. **Index API rate limits** — `mcp__claude-context__index_codebase --force` timed out 15s on first attempt 2026-05-01. Need verification it completes within reasonable window for daily cron (A4.2 + A5.2).
5. **Subsystem boundary precision** — some files cross subsystems (e.g. `common/calendar` used by both runner and bff). Audit ratchet must permit edits without forcing all maps; criterion = "subsystem owns file" not "any subsystem touches file".

## Blokátory

- **Phase 1 M2.5** waiting on operator: share Railway WIREPROXY_CONFIG Endpoint line.
- **Phase 1 M4.4** waiting on operator: explicit go-ahead for next_send_at SQL reset on campaign 455.
- **Phase 2 A4.2** index reliability: needs successful re-index test before cron commit.

## Cross-references

- Synthesized pipeline: this initiative §Kontext + chat 2026-05-01
- Existing initiative `2026-05-01-cross-mailbox-anonymity-test.md` — anonymity test framework (bypass path identified by M3.1)
- Memory `feedback_search_before_implement` — pre-existed but not enforced; M1 tier-0 promotion enforces
- Memory `seznam_proxy_geo_mismatch` — architectural ceiling; M2.4 surfaces in playbook
- Memory `egress_canonical` — Mullvad-only canonical; M1 MAP cites
- Memory `feedback_subagent_token_economy` — A1 + A4 spawn patterns
- ADR-005 airtight — M3 ratchet expansion

## Log

- **2026-05-01 ~15:00** — Initiative founded post-debug session. Trigger: 0/18 delivery + recursive AI failure mode (designing systems without reading codebase).
