# Final Stabilization — Day-End Plan 2026-05-03 (round 4)

**Status:** active
**Vlastník:** Chat A (engineering)
**Datum založení:** 2026-05-03
**Datum uzavření:** —
**Trigger:** Čtvrtý cyklus reindex + deep inventory + Plan v jednom session-dni. Po 30+ PRs mergnutých dnes a 94 commitech na main je platforma v silně refaktorovaném stavu. Pět paralelních inventory agentů ve v3 round odhalilo dvě nové regrese audit ratchetů (relay/transport race flake + common/humanize diacritics zero-prob bug), čtyři open PRs k mergi, branch sprawl 264 (+11 vs v2), tři kritické P1 launch gaty stále nevyřešené (#586 BFF preflight, #585 GDPR template UnsubURL, #584 smtp probe auth header) a server.js pořád na 73 inline routes s top doménou suppression API. Tento plán je doslova „end of day" sweep — zavřít regresi, mergnout zbývající PRs, dotáhnout drobné hygiene a flagnout co zbývá pro operatérovo ráno.

## Kontext

Stávající stav po čtvrté inventuře. server.js je 6619 LoC, 73 inline routes, 21 mounter modulů kompletně wired bez orphaned imports nebo missing files (ověřeno filesystem audit per memory `feedback_verify_filesystem_before_doc_claim`). Top remaining inline domény: suppression API (potřeba T0 priority extract — žádný stub neexistuje), threads (5 routes), diagnostics, anti-trace, categories. Audit ratchety mají 21 z 23 GREEN at baseline 0, dvě new regrese od dnešní noci jsou:

První regrese je `TestRotatingProxyTransport_InFlightRefreshGuard` v `features/outreach/relay/internal/transport` — race condition flake při paralelním refresh proxy poolu. Tento test prochází na single-threaded run ale failuje s `-race` flag. Memory `project_egress_canonical` (T1) říká že proxy pool rotation je hot path, takže race fix má ne-trivial blast radius.

Druhá regrese je `TestDiacriticsAudit_ZeroProbDisablesRestore` v `features/outreach/campaigns/render/humanize/diacritics_audit_test.go` — zero-probability flag nedělá disable na diacritics restore krok. Logic bug v render layer, ne v testu. Subsystem map `content-render.md` je relevantní (pravě dnes vytvořený memory `project_content_render_pipeline` T1).

Čtyři open PRs jsou: #116 Mailbox↔Campaigns cross-link S4 (5 dní starý, čeká review), #626 wgsocks WG UDP listen-port pin (2 dny), plus drobnosti od dnešních paralelních agentů. Žádný není destructive ale #116 vyžaduje review-style triage.

Backlog má 42 open issues (+12 vs v2 round), 0 P0, 17 P1, 16 P2. Růst je systematický — automation pohon vytváří issues pro initiative tasks. Tři P1 issues blokují první ostrou kampaň (Sprint A6): #586 BFF preflight gate red, #585 GDPR template missing `{{.UnsubURL}}`, #584 SMTP probe auth header bug. Všechny tři jsou pre-existing z 2026-05-01 launch verification + dnešní L1.2 verify potvrdil že stále aktivní (operator-side data fix needed pro password rotace + template edit).

Session-day metriky: 94 commits na main today, 6 issues closed, server.js -888 LoC, 2 incidents recovered (PR #661 mass-revert, PR #666 broken imports), 4 initiative docs created. Memory entries +4 (railway DB scope, deadcode -test flag, cherry-pick stale base danger, verify filesystem before doc claim, content render pipeline = celkem 5).

Branch sprawl je 264 remote branches (+11 vs v2 — agent fleet generuje branches rychleji než cleanup), 24 worktrees s 15 locked (active agent fleet mid-execution).

## Cíle

První cíl je opravit dvě nové ratchet regrese — relay race flake a diacritics zero-prob bug. Bez fix žije ratchet tree s degraded signal a budoucí PRs mohou maskovat další regrese.

Druhý cíl je dokončit merge sweep čtyř open PRs. PR #116 je nejstarší (5 dní), zaslouží explicit review-or-close decision aby nepřispíval k dlouhodobému branch sprawl.

Třetí cíl je vyřešit aspoň jedno z P1 launch gates (#584 smtp probe auth) které je čistě code-side fix bez nutnosti operator data action. #585 a #586 vyžadují operator action (template UI edit + BFF running), takže jsou explicit out of scope dnes.

Čtvrtý cíl je extract suppression API z server.js inline routes. Suppression je T0-relevant code path (memory `project_two_suppression_tables` + `feedback_anti_trace_full_stack`) a zaslouží svůj mounter module per discipline.

Pátý cíl je drobný branch hygiene — identifikovat top 10 jasně orphan branches (no PR + > 14d untouched + automation-generated agent branches) a navrhnout batch prune. Operator gate na actual delete.

## Plán (sprinty)

### Sprint F1 — Fix 2 ratchet regrese (1 sezení) {#sprint-f1}

Cíl je obnovit baseline 0 na obou nových regresích. Dva paralelní agenti, různá doména, žádný server.js conflict.

F1.1 opraví relay/transport race flake. Agent přečte `features/outreach/relay/internal/transport/proxy_pool*.go` a najde `TestRotatingProxyTransport_InFlightRefreshGuard`. Failure pattern je race-detector triggered. Likely fix: add proper sync.Mutex around pool refresh + guard double-refresh. Test pass with `go test -race -run InFlightRefreshGuard` opakovaně 5×. Memory `project_egress_canonical` cross-ref pro context.

F1.2 opraví diacritics zero-prob bug. Agent přečte `features/outreach/campaigns/render/humanize/diacritics*.go` a najde proč zero probability nedělá skip restore step. Likely fix: explicit early return when prob == 0 nebo proper conditional check before restore call. Test pass + ≥10 test cases (memory `feedback_extreme_testing` T0). Memory `project_content_render_pipeline` T1 pro context.

DoD F1: oba ratchety GREEN, žádný regression v ostatních ratchetech, oba PR mergnuté.

### Sprint F2 — Open PRs merge sweep (1 sezení) {#sprint-f2}

Cíl je vyčistit open PR queue. Single agent, sequential.

F2.1 — review #116 (Mailbox↔Campaigns cross-link S4). Agent čte PR diff + verify žádný conflict s recent server.js mergi. Pokud lze admin-merge bez conflicts, merge. Pokud má conflict, rebase + push.

F2.2 — verify #626 (wgsocks listen-port pin). Tento už proběhl jako PR #628 (verified merged). Pokud #626 je duplicitní, close as superseded.

F2.3 — drobnější open PRs (od dnešních inventory agentů #678/#679/#680/#681) — sequentially admin-merge.

DoD F2: 4 → 0-1 open PRs.

### Sprint F3 — Suppression API extract (1 sezení) {#sprint-f3}

Cíl je extract /api/suppression* + /api/suppressions* inline routes z server.js. Per inventory v3, top remaining inline domain. Per memory `project_two_suppression_tables` (T1) — UNION discipline důležitá.

F3.1 inventura — count routes:
```
grep -nE "^app\.(get|post|put|delete|patch).*'/api/suppression" features/platform/outreach-dashboard/server.js
```

F3.2 extract — vytvořit `src/server-routes/suppression.js` factory `mountSuppressionRoutes`. Preserve UNION discipline (`outreach_suppressions` + `suppression_list` reads via `lower(trim(email))`). Contract tests `tests/contract/bff-suppression-d3-extract.contract.test.ts` s 10+ cases including UNION read on contact lookup.

F3.3 verify — dashboard test pass, server.js LoC delta visible. Pre-push diff stat MUST show only 3 files (per `feedback_cherry_pick_stale_base_danger` discipline).

DoD F3: suppression routes wired, server.js -200+ LoC.

### Sprint F4 — P1 launch blocker #584 fix (1 sezení) {#sprint-f4}

Cíl je opravit jediný non-operator P1 launch gate — #584 smtp probe auth header + body validation.

F4.1 — read issue #584 + recent verify-launch failures. Identify exact request shape mismatch (Authorization Bearer + body schema).

F4.2 — fix v `features/outreach/relay/web/probe.go` nebo wherever probe handler je. Plus update `scripts/verify-launch.mjs` if request side má bug. Symmetric fix tak aby probe-side accepting + verify-side sending matchují.

F4.3 — re-run `pnpm verify:launch` lokálně (pokud BFF available) nebo aspoň contract test pass. Issue #584 close-out s comment + reference fix PR.

DoD F4: #584 closed, verify-launch gate=smtp_probe GREEN.

### Sprint F5 — Branch hygiene candidate identification (1 sezení, soft) {#sprint-f5}

Cíl je read-only identify top 10-20 orphan branches pro operator review. Žádný actual delete bez explicit consent (operator-gated per `feedback_critical_pushback`).

F5.1 — list branches without open PR + > 14d untouched:
```
for branch in $(git branch -r | grep -v HEAD); do
  has_pr=$(gh pr list --state=all --head $(echo $branch | sed 's|origin/||') --limit 1 --json number | jq length)
  last_commit=$(git log -1 --format="%cr" $branch 2>/dev/null)
  if [ "$has_pr" = "0" ] && echo "$last_commit" | grep -qE "(week|month|year)s? ago"; then
    echo "$branch — $last_commit (no PR)"
  fi
done
```

F5.2 — categorize: `agent/*` + `dependabot/*` (auto-prune candidates), `feat/*` + `release/*` (operator review needed), `chore/*` + `docs/*` (likely ok to prune).

F5.3 — output `reports/branch-prune-candidates-2026-05-03.md` s 3 batch lists. Operator approves batches sequentially.

DoD F5: report committed, žádný actual branch delete (operator gate).

## Pořadí a paralelismus

F1 (ratchet regrese) je dva nezávislí agenti — různé services, žádný conflict. Spawn paralelně.

F2 (PR merge) je sequential — single agent, hodně závisí na repo state.

F3 (suppression extract) je single agent — server.js refaktor, per dnešní lekce NE paralelní. Po dokončení F1 + F2 (free state).

F4 (P1 fix) je single agent — relay code change.

F5 (branch hygiene) je single Haiku agent — read-only listing.

Doporučené pořadí: F1 + F4 paralelně (různé services) → F2 sweep → F3 (server.js work) → F5 (read-only inventory listing).

## Open questions

První otázka je rozsah F2.1 #116 review. PR je 5 dní starý — může mít conflicts s recent server.js D2.x extract. Pokud massively conflicts, lepší close-as-stale + ask author to rebase. Per memory `feedback_pr_stack_topo_order`.

Druhá je suppression API scope. F3 extract by mohl bundlovat plus `/api/suppressions` (plural) + `/api/suppression-list` aliases. Větší scope = větší blast risk. Default: jen primary `/api/suppression` routes, plural varianty defer.

Třetí je timing F4 vs operator availability. #584 je code fix ale verify-launch end-to-end vyžaduje BFF running locally. Pokud operator BFF spustí, můžeme verify; jinak jen contract test pass.

## Cross-references

- [`docs/initiatives/2026-05-03-deep-inventory-action-plan.md`](2026-05-03-deep-inventory-action-plan.md) — D-sprint plan (D1-D5 partially executed)
- [`docs/initiatives/2026-05-03-post-d2-recovery-action-plan.md`](2026-05-03-post-d2-recovery-action-plan.md) — E-sprint recovery plan (E1+E4.1 done)
- [`docs/initiatives/2026-05-03-launch-readiness-and-scaling.md`](2026-05-03-launch-readiness-and-scaling.md) — L-sprint launch staircase (gated)
- Memory: `project_egress_canonical` (F1.1 context), `project_content_render_pipeline` (F1.2 context, dnes vytvořený), `project_two_suppression_tables` (F3 UNION discipline), `feedback_cherry_pick_stale_base_danger` + `feedback_verify_filesystem_before_doc_claim` (F3 anti-contamination), `feedback_critical_pushback` (F5 operator-gate respect)
