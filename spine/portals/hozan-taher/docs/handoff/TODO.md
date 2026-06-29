# TODO — Hozan Taher kompletní backlog

**Last updated:** 2026-04-30 by Chat A — Operator Practice initiative + OP1 + OP2 sprints complete + earlier Mail Lab work (22 PRs / ~700+ brutal asserts cumulative)

## 🟢 Trigger fráze: **"Pokračujeme."**

Přečti `CLAUDE.md` + tento `TODO.md` + `docs/handoff/BOARD.md`, pracuj autonomně dle `feedback_autonomous_work` (24/7, jen destruktivní ops s confirm).

---

## 🔴 Realita: main je 100+ PRs behind

Last main merge: **#115 (campaign tabs S3, 2026-04-25)**. Žádná z dosavadních initiativ se nedostala do main:

- **0 / 17** Mail Lab PRs merged
- **0 / 17** Mail Client Fidelity PRs merged
- **0 / 30+** UX Redesign PRs merged
- **0 / 23** Quality / hot-fix PRs merged (W1-W4, F1-F5, S-C/S-H sec, CH-1-CH-6)
- **0 / 4** Tooling + chore PRs ze 2026-04-29 (#256, #257, #258, #259)

**Doporučení:** PŘED dalšími nadstavbami doporučuji **landing pass** — squash-merge zdola nahoru aby se stack zúžil. Pokračování v psaní nového kódu na 10+ deep stacku zvyšuje rebase risk geometricky.

**Tooling pro landing pass je hotový** (PR #256): `scripts/ops/{rebase-stack.sh,link-issues.mjs,metrics.mjs}`. 17-deep stack rebase = 1 příkaz po merge bottom PR.

---

## 🔴 V LETU — open PR stacks awaiting merge to main

Stacks listed bottom-up; merge v tomto pořadí.

### A) Mail Lab — full provider front-door API (17 PRs)

Foundation:
| PR | Subject | Base |
|---|---|---|
| #220 | ML1.1 docker-mailserver foundation pro seznam.lab | main |
| #221 | ML1.2 unbound DNS for *.lab zones | #220 |
| #222 | ML1.4 DKIM key generation | #221 |
| #223 | ML1.5 mail-lab-api Go REST skeleton | #222 |
| #224 | ML1.6 + ML1.7 bootstrap workflow + playbook | #223 |
| #225 | ML1.3 Roundcube webmail + hermeticity | #224 |
| #228 | ML4.1 + ML4.4 dashboard .env.lab + DEV-SETUP | #225 |
| #246 | ML2.1 gmail.lab + outlook.lab multi-provider | #225 |
| #247 | ML4.3 + ML4.5 bootstrap flags + test-all wiring | #246 |
| #237 | ML4.2 orchestrator DNS_RESOLVER override | main |

Profile API (autonomní loop iteration 1 — 8 PRs / 193 brutal asserts):
| PR | Subject | Base |
|---|---|---|
| #248 | ML2.2 per-profile rules + override | #223 |
| #249 | ML2.3 profile verdict /check | #248 |
| #250 | ML2.4 RFC3464 DSN /dsn | #249 |
| #251 | ML2.5 sliding-window rate tracker | #250 |
| #252 | ML3.2 triplet greylist tracker | #251 |
| #253 | ML3.3 combined /evaluate pipeline | #252 |
| #254 | ML2.6 quota tracker | #253 |
| #255 | ML2.7 operator full-reset | #254 |

Bounce + client + hook + CI + chaos (iter 2-4 — 5 PRs / 120 brutal asserts):
| PR | Subject | Base |
|---|---|---|
| #257 | ML3.1 bounce delivery via docker exec sendmail | #255 |
| #258 | ML5.0 Go client (features/platform/common/maillabclient) | #257 |
| #260 | ML5.1 labhook pre-send abort hook (100% cover) | #258 |
| #261 | ML6.1 mail-lab CI workflow + 22-assert audit | #260 |
| #262 | ML3.4 toxiproxy chaos overlay + 28-assert audit | #261 |

### B) Mail Client Fidelity (17 PRs, end-to-end inbound + outbound)

Sprint S1 — schema + IMAP + parser + persist:
| PR | Subject | Base |
|---|---|---|
| #210 | S1.1 schema migration (body_html + attachments) | main |
| #229 | S1.2 IMAP full RFC822 fetch | main |
| #230 | S1.3 stdlib MIME parser | main |
| #231 | S1.4 RecordInbound persist + bluemonday sanitize | #230 |
| #232 | S1.5 round-trip integration test | #231 |
| #233 | S1.6 GDPR Art. 17 erasure cascade | #232 |

Sprint S2 — render path:
| PR | Subject | Base |
|---|---|---|
| #234 | S2.1 BFF /api/threads/:id/messages enriched | main |
| #235 | S2.2 BFF attachment streaming endpoint | #234 |
| #236 | S2.3 ThreadDetail HTML render + DOMPurify | #235 |
| #238 | S2.4 drop legacy `body: subject` mapping | #236 |
| #239 | S2.5 XSS + perf regression suite | #238 |

Sprint S3 — realtime + outbound:
| PR | Subject | Base |
|---|---|---|
| #240 | S3.1 SSE /api/threads/stream + PG LISTEN | main |
| #241 | S3.2 orchestrator pg_notify('thread_inbound') | #231 |
| #242 | S3.3 ThreadDetail SSE subscribe + auto-refetch | #236 |
| #243 | S3.4 BFF outbound multipart upload | main |
| #244 | S3.5 ThreadDetail FormData send | #243 |
| #245 | S3.6 Playwright E2E thread-attachment-roundtrip | #244 |

### C) Quality / hot-fix (sec + correctness, 23 PRs ready)

CRITICAL — merge first:
| PR | Subject | Base |
|---|---|---|
| #161 | S-C1 unsubscribe HMAC fail-closed | main |
| #162 | S-C2 orchestrator XFF trusted-proxy gate | main |
| #166 | F1-1 segment placeholder offset bug | main |
| #183 | W2-A relay BuildChain ticker ctx | main |
| #184 | W2-B privacy-gateway constant-time token | main |

HIGH:
| PR | Subject | Base |
|---|---|---|
| #163 | S-H1 BFF strict DSN parser anti-SSRF | main |
| #164 | S-H2 strip err.Error() from HTTP responses | main |
| #165 | S-H3 BFF CSP + cross-origin isolation | main |
| #167 | F1-2 HMAC timing-safe + trust-proxy + limit clamp | main |
| #169 | F2-1 unsubscribe close outreach_threads parity | main |
| #170 | F2-2 DSR drop silent .catch (GDPR Art.17) | main |
| #171 | F2-3 scheduler pin sql.Conn for advisory lock | main |
| #172 | F2-4 BFF→Go AbortSignal/timeout | main |
| #173 | F3-1 mailbox.Backpressure on IMAP-DSN bounces | main |
| #174 | F3-2 /run flips status only | main |
| #175 | F3-3 anti-trace empty envelope_id typed error | main |
| #178 | F5-2 segment pq.Array swap | main |
| #179 | F5-1 remove dead stub handlers | main |
| #185 | W2-D SOCKS5 io.ReadFull | main |
| #186 | W2-E+F relay atomic save + geoip env override | main |
| #187 | W2-G MCP fetch AbortSignal.timeout | main |

MEDIUM:
| PR | Subject | Base |
|---|---|---|
| #168 | F1-3 sql.ErrNoRows → errors.Is sweep | main |
| #176 | F4-1 IMAP bounded FIFO dedupe | main |
| #177 | F4-3 IMAP SEARCH UNSEEN UTC formatting | main |
| #180 | F5-3 auth-matrix doc + ENABLED contract | main |
| #181 | F4-2 IMAP TLS handshake honors ctx | main |
| #182 | W1 telemetry/playbook.go cleanup | main |

PERF + DOCS:
| PR | Subject | Base |
|---|---|---|
| #159 | P-1 BFF /api/dual-axis batched aggregate (-15s) | main |
| #160 | P-2 split @sentry vendor chunk (-150KB) | main |
| #190 | W3 running-tests docs + pnpm test rename | main |
| #191 | W4 DEV-SETUP rewrite | main |
| #149 | Sprint D MEDIUM debt tracker docs | main |
| #158 | Sprint S4 audit-script triage | main |
| #157 | scrapers prune 8 unused deps | main |

### D) Sprint D — quality-debt fixes (3 PRs)
| PR | Subject | Base |
|---|---|---|
| #150 | D-1 worker LLM stream timeout (TDD) | sprint-d-quality-debt |
| #151 | D-2 Firebase upload collision guard | sprint-d1 |
| #152 | D-3 outreach Go ExecContext audit | sprint-d2 |

### E) Sprint F — operator flow (4 PRs)
| PR | Subject | Base |
|---|---|---|
| #148 | F-S1 /companies → /replies deep-link | feat/sprint-f-s1 |
| #147 | F-S2 inline preset launch + Companies wiring | feat/sprint-f-s2 |
| #145 | F-S3 clickable /replies stat strip drill-in | feat/sprint-f-s3 |
| #146 | F-S4 /leads campaign_name → /campaigns/:id link | feat/sprint-f-s4 |

### F) UX Redesign (33 PRs across B/C/F sprints)

UX primitives + page redesigns (#117–#143, #144) + companies polish (#129–#132). Long stack stacked on `feat/ux-redesign-plan-doc` (#133) etc. Merge bottom-up.

Plus:
- Sprint B (density toggle / sticky / sortable / footer): #134-#140
- Sprint C (PageBackHead / TabBar / drawer): #141-#144
- UX F1-F14: #117-#132

### G) Initiative docs (long-lived; can merge anytime)
| PR | Subject |
|---|---|
| #192 | mail-client-fidelity initiative doc |
| #211 | brutal test harness initiative doc |
| #212 | Mail Lab initiative doc |
| #133 | UX redesign plan + sprints |
| #263 | Operator Practice initiative (5 sprints, 19 atomic units) |

### H) Misc / chore
| PR | Subject |
|---|---|
| #100 | monorepo cleanup + anti-speculation purge |
| #95 | dependabot @anthropic-ai/sdk 0.78 → 0.91 (worker) |
| #96 | dependabot dotenv 17.4.0 → 17.4.2 (worker) |
| #97 | dependabot @vitest/coverage-v8 4.1.2 → 4.1.5 (mcp) |
| #98 | dependabot bullmq 5.73 → 5.76.2 (worker) |
| #26 | bottleneck watchdog (oldest open) |
| #116 | S4 Mailbox ↔ Campaigns cross-link |

### J) 2026-04-30 — Operator Practice (OP1 + OP2 sprints, 6 PRs)
| PR | Subject | Sprint |
|---|---|---|
| #263 | Operator Practice initiative doc | — |
| #264 | OP1.1 + OP1.3 — fixture schema + IMAP injector | OP1 |
| #265 | OP1.5 — operator playbook | OP1 |
| #266 | OP1.2 — anonymizer (prod export → fixture) | OP1 |
| #267 | OP1.4 — E2E smoke spec (skip-pattern) | OP1 |
| #268 | OP2.1 + OP2.2 + OP2.4 — time-accelerated replay | OP2 |
| #269 | OP2.3 — SSE delivery verification spec | OP2 |

### I) 2026-04-29 ops + chore (7 PRs, base=main + stack PRs)
| PR | Subject | Base |
|---|---|---|
| #256 | ops tooling — rebase-stack.sh + link-issues.mjs + metrics.mjs | main (off-stack) |
| #259 | flip pnpm test default to full scope (closes #69 #70) | main (off-stack) |
| #257 | ML3.1 — bounce delivery via docker exec sendmail | #255 (stack) |
| #258 | ML5.0 — Go client features/platform/common/maillabclient | #257 (stack) |
| #260 | ML5.1 — labhook pre-send abort hook (100% cover) | #258 (stack) |
| #261 | ML6.1 — mail-lab CI workflow + audit | #260 (stack) |
| #262 | ML3.4 — toxiproxy chaos overlay + control script | #261 (stack) |

---

## 🟡 NEXT WORK — Mail Lab pokračování

### ML3.x — chaos middleware
- ✅ **ML3.1** — bounce delivery via `docker exec sendmail` (PR #257, 20 brutal asserts)
- ✅ **ML3.4** — toxiproxy chaos overlay + chaos.sh control script (PR #262, 28 brutal asserts)

### ML5.x — orchestrator integration
- ✅ **ML5.0** — Go client `features/platform/common/maillabclient` (PR #258, 30 brutal asserts, 78.2% cover)
- ✅ **ML5.1** — labhook standalone package `features/inbound/orchestrator/labhook` (PR #260, 20 brutal asserts, 100% cover)
- **ML5.2** — wire labhook into `features/outreach/campaigns/sender/engine.go` (between PreSendHook and antiTrace.Send). Add `TransportMode string` field to `SendingConfig` (currently doesn't exist). Brutal: ≥10 asserts (skip path bypasses Send, accept proceeds, send_events records verdict). HIGH risk — touches campaign sender hot path.
- **ML5.3** — harness driver pivot: tests/e2e replaces greenmail with mail-lab API
- **ML5.4** — first end-to-end chaos scenario: "rate-exceeded → bounce" full pipeline (Apply override → Evaluate → BuildDSN → deliver → assert in IMAP)

### ML6.x — CI integration
- ✅ **ML6.1** — mail-lab CI workflow + healthcheck + audit (PR #261, 22 brutal asserts)
- **ML6.2** — `pnpm test:mail-lab` cron weekly to detect provider-stack drift (covered by ML6.1's Mon 06:00 schedule; could become standalone monitoring job)

---

## 🟡 NEXT WORK — beyond mail-client-fidelity

After S3.6 merges, all 6 mail-client sprints shipped. Open follow-ups:
- Forward-as-attachment flow (currently inline-only)
- Thread search (FTS on body_text)
- Per-thread label/folder system

---

## 🟢 BACKLOG — by area (issues)

### Quality debt (kind/refactor)
| # | Subject | Status |
|---|---|---|
| #99 | CH-6 dev setup docs rewrite | PR #191 in flight |
| #94 | CH-3 scrapers dep prune (6 unused) | PR #157 in flight |
| #93 | CH-2 telemetry/playbook.go dead funcs (7) | PR #182 in flight |
| #92 | CH-1 BaseScraper extract | open |

### Test infrastructure (S/B/A series — backlog)
- #59-#64 — race-flake repairs (B1-B4 + smoke cleanup)
- #66, #68 — test-all.mjs runner + GH Actions matrix
- #69-#70 — README + CLAUDE.md test docs (PR #190 covers)
- #72-#75 — vitest deps audit, stryker config, playwright webServer
- #77-#82 — audit script triage (PR #158 covers some)
- #83-#85 — test-health weekly cron
- #87 — CLAUDE.md service-local rules update
- #189 — 32 pre-existing test failures (W3 surfaced)

### Bot / automation (Hozan Ops, A-series)
- #27 A1.1 `gh project create "Hozan Ops"`
- #32 A2.1 Sentry → GH native integration (4 projects)
- #45 A4.5 Bot identity (PAT + scopes)
- #48 A5.1 GH Project board view config
- #55 A6.3 default safe tasks for bot
- #56 A6.4 default needs-design tasks
- #57 A6.5 first cron run manual trigger

### Sprint D — needs-design (blocked on stakeholder)
- #153 worker M2 — p-limit cap value
- #154 worker M7 — per-queue rate limiter
- #155 scrapers M2 — robots.txt compliance policy
- #156 scrapers M3 — Redis-backed rate limiter

### Onion / privacy
- #188 W2-C onion v3 hidden service: SHA3-256 vs SHA512/256 (needs-design)

### Relay
- #90 — proxy-mode delivery pipeline reliability bundle (open epic)

### Mail Lab follow-ons (issue tracker)
- #213-#219, #226-#227 — covered by open PRs #220-#247 (auto-close on merge)

### Mail Client Fidelity follow-ons (issue tracker)
- #193-#209 — covered by open PRs #210-#245 (auto-close on merge)

---

## ⚠️ Stuck / blocked

- **13 issues** with `needs-design` label — waiting on user/stakeholder decision before automation safe.
- **PR landing order** — need user green-light to start landing pass (squash-merge order matters for clean history).

---

## 📊 STATS — 2026-04-30 (post 5+ autonomní iterace cumulative)

| Metric | Value |
|---|---|
| Open PRs | ~127 |
| Open issues | 68 |
| Mail Lab profile API tests | 165 |
| Mail Lab Go client tests | 30 (78.2% cover) |
| Mail Lab labhook tests | 20 (100% cover) |
| Mail Lab CI workflow audit | 22 |
| Mail Lab chaos overlay audit | 28 |
| Operator Practice OP1 audit | 84 (25 fixtures + 25 playbook + 34 anonymizer) |
| Operator Practice OP1 E2E (skip-pattern) | 5 tests |
| Operator Practice OP2 audit | 35 + 14 self-tests |
| Operator Practice OP2 E2E (skip-pattern) | 4 tests |
| **Total brutal asserts shipped this run** | **~700+** |
| **Total PRs shipped this run** | **22** |
| Mail Lab stack depth | 20 PRs |
| Operator Practice off-stack PRs | 7 |
| Mail Client stack depth | 17 PRs |
| UX Redesign stack depth | 30+ PRs |
| Quality / hot-fix backlog ready to merge | 23 PRs |
| Ops tooling shipped | 1397 lines (rebase-stack + link-issues + metrics) |
| Issue↔PR auto-links applied | 9 (ML1.1-1.7 + ML4.1 + ML4.4) |
| Last commit on main | 7e6a50cf (2026-04-29 TODO refresh #3) |

---

## 🟢 Konvence

- `feedback_extreme_testing` — ≥10 brutal cases per change ✓
- `feedback_autonomous_work` — 24/7, jen destruktivní ops s confirm ✓
- `feedback_iteration_workflow` — propose → execute → summarize → propose next ✓
- `feedback_long_stacks_ok` — 12+ deep stack akceptován; rebase risk známý ✓
- `feedback_no_speculation` — fakty + RFC citations + interface contract ✓

## 🟢 Branch state — current session

Mail Lab profile-API stack (13 deep, all MERGEABLE proti parent):
```
feat/ml3.4-toxiproxy-chaos (HEAD)              ← #262 ML3.4 chaos overlay
  ↑ feat/ml6.1-mail-lab-ci                       ← #261 ML6.1 CI workflow
  ↑ feat/ml5.1-orchestrator-evaluate-hook        ← #260 ML5.1 labhook
  ↑ feat/ml5.1-maillab-go-client                 ← #258 ML5.0 Go client
  ↑ feat/ml3.1-bounce-delivery                   ← #257 ML3.1 bounce delivery
  ↑ feat/ml2.7-operator-reset                     ← #255 ML2.7 reset
  ↑ feat/ml2.6-quota-tracker                      ← #254 ML2.6 quota
  ↑ feat/ml3.3-evaluate-combined                  ← #253 ML3.3 evaluate
  ↑ feat/ml3.2-greylist-tracker                   ← #252 ML3.2 greylist
  ↑ feat/ml2.5-rate-tracker                       ← #251 ML2.5 rate
  ↑ feat/ml2.4-profile-dsn                        ← #250 ML2.4 DSN
  ↑ feat/ml2.3-profile-verdict                    ← #249 ML2.3 verdict
  ↑ feat/ml2.2-profile-rules                      ← #248 ML2.2 rules
  ↑ feat/ml1.5-mail-lab-api (#223)                ← ML1.5 mail-lab-api foundation
  ↑ ... (4 more ML1.x foundation PRs)
  ↑ origin/main (7e6a50cf — TODO refresh #3)
```

Off-stack base=main (2026-04-29 + 30):
```
feat/ops-tooling-2026-04-29              ← #256 rebase-stack + link-issues + metrics
chore/test-scripts-default-full          ← #259 pnpm test → TEST_SCOPE=all
docs/operator-practice-initiative        ← #263 OP initiative doc
feat/op1.1-op1.3-seed-replies-infra      ← #264 OP1.1 + OP1.3
feat/op1.5-operator-playbook             ← #265 OP1.5 playbook
feat/op1.2-anonymizer                    ← #266 OP1.2 anonymizer
feat/op1.4-e2e-smoke                     ← #267 OP1.4 E2E
feat/op2.1-op2.2-op2.4-replay            ← #268 OP2 batch
feat/op2.3-sse-delivery-spec             ← #269 OP2.3 SSE spec
```

## 🟡 NEXT — autonomous loop iteration 6+

**OP1 + OP2 sprints complete.** Next units gated on either user direction or stack landing.

**OP3 sprint** (workflow measurement) — touches BFF + dashboard + DB schema (4 atomic units, larger blast radius):
- OP3.1 Timer instrumentation (operator_practice_events table + thread open events)
- OP3.2 Override capture (operator_practice_overrides)
- OP3.3 Daily stats panel (dashboard widget)
- OP3.4 Practice mode toggle

**OP4 sprint** (classifier feedback loop) — needs OP3 first.
**OP5 sprint** (E2E + final docs) — needs OP3+OP4.

**Mail Lab follow-on:**
- ML5.2 engine wiring (HIGH risk, campaign sender hot path)
- ML6.2 standalone weekly drift cron (covered by ML6.1 schedule already)

**Recommendation:** OP3 needs user direction on:
- Whether DB schema changes acceptable mid-mail-client-fidelity-stack
- Whether dashboard widget can be added pre-UX-redesign-merge
- Practice-mode toggle UX (header button placement)

Pause autonomous loop, await user input on OP3 strategy.
