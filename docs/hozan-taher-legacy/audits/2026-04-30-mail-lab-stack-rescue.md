# Mail Lab + mail-client Stack Rescue Analysis

**Date:** 2026-04-30
**Author:** stack-rescue analyst (read-only diagnostic)
**Status:** ANALYSIS ONLY — no recovery executed; orchestrator decides next.

> **Update during analysis:** While this report was being written, the
> orchestrator independently merged 8 PRs into `main` cleanly via correct
> base re-targeting: `#210` (S1.1 schema), `#229` (S1.2 IMAP fetch),
> `#230` (S1.3 MIME parser), `#234` (S2.1 BFF threads), `#240` (S3.1 SSE
> stream), `#220` (ML1.1 docker-mailserver foundation), `#237` (ML4.2
> DNS_RESOLVER override), plus initiative docs `#211`, `#212`, `#192`,
> `#191`. These are now reachable from `origin/main` and remove their
> branches from the rescue scope. The orphan-MERGED list (`#246` `#248`
> `#250` `#252` `#254` `#257` `#261` `#262` `#242` `#244`) is unchanged —
> those squash shas remain orphans. Branch-ahead counts vs `main` are
> unchanged for every stack tip because the new clean merges came in via
> different squash shas. The rescue still has to recover the orphan
> merges' content. The doc body below reflects state before this update;
> the recommendation in Section 4 is unaffected.

## Incident summary

On 2026-04-30 the orchestrator admin-merged 10 stack PRs with `--delete-branch`
without verifying that each PR's `base` was `main`. The merges flipped to
GitHub state `MERGED`, but the squashed content actually landed on the
*stack-parent* feature branches (e.g. `feat/ml1.3-mail-lab-roundcube`,
`feat/ml2.7-operator-reset`, `feat/ml5.1-orchestrator-evaluate-hook`),
**not on `main`**.

Affected (state=MERGED, content NOT reachable from `origin/main`):

| PR  | Head                                | Base (was)                              | Squash sha  |
| --- | ----------------------------------- | --------------------------------------- | ----------- |
| 246 | feat/ml2.1-multi-provider           | feat/ml1.3-mail-lab-roundcube           | `58ff0af5`  |
| 248 | feat/ml2.2-profile-rules            | feat/ml1.5-mail-lab-api                 | `ce269a49`  |
| 250 | feat/ml2.4-profile-dsn              | feat/ml2.3-profile-verdict              | `ec9732c0`  |
| 254 | feat/ml2.6-quota-tracker            | feat/ml3.3-evaluate-combined            | `7cde6a84`  |
| 257 | feat/ml3.1-bounce-delivery          | feat/ml2.7-operator-reset               | `53b0b061`  |
| 252 | feat/ml3.2-greylist-tracker         | feat/ml2.5-rate-tracker                 | `65defd8a`  |
| 262 | feat/ml3.4-toxiproxy-chaos          | feat/ml6.1-mail-lab-ci                  | `b2e480a2`  |
| 261 | feat/ml6.1-mail-lab-ci              | feat/ml5.1-orchestrator-evaluate-hook   | `a604c193`  |
| 242 | feat/s3.3-threaddetail-sse          | feat/s2.3-threaddetail-render           | `3457e5c7`  |
| 244 | feat/s3.5-threaddetail-formdata     | feat/s3.4-outbound-multipart            | `56b31393`  |

All 10 squash shas are confirmed `ORPHAN` (not ancestors of `origin/main`).

## Section 1 — Stack inventory

19 `feat/ml*` and `feat/s3*` branches still exist on remote. Per-branch
commit count vs `origin/main` (highest-yield first):

| Branch                                       | Commits ahead | Files in diff | +Insertions | Tip-commit summary                                    |
| -------------------------------------------- | ------------- | ------------- | ----------- | ----------------------------------------------------- |
| `feat/ml5.1-orchestrator-evaluate-hook`      | **16**        | **54**        | **8 986**   | `a604c193` ML6.1 mail-lab CI workflow (#261)          |
| `feat/ml5.1-maillab-go-client`               | 15            | 47            | 7 943       | `f302a020` ML5.0 self-review HIGH fixes               |
| `feat/ml2.7-operator-reset`                  | 13            | 45            | 7 118       | `53b0b061` ML3.1 bounce delivery (#257)               |
| `feat/ml3.3-evaluate-combined`               | 11            | 42            | 5 979       | `7cde6a84` ML2.6 quota tracker (#254)                 |
| `feat/ml2.5-rate-tracker`                    | 9             | 38            | 4 887       | `db8f6841` ML2.5 rate-limit tracker                   |
| `feat/ml2.3-profile-verdict`                 | 7             | 34            | 3 685       | `b6038d46` ML2.3 profile verdict + /check             |
| `feat/ml4-monorepo-wiring`                   | 7             | 32            | 2 821       | (ML4 monorepo wiring)                                 |
| `feat/ml1.3-mail-lab-roundcube`              | 7             | 30            | 2 810       | (ML1.3 Roundcube)                                     |
| `feat/ml1.6-mail-lab-bootstrap`              | 5             | 26            | 2 348       | ML1.6 bootstrap workflow                              |
| `feat/ml1.5-mail-lab-api`                    | 5             | 29            | 2 453       | ML1.5 Go REST admin API                               |
| `feat/s3.4-outbound-multipart`               | 6             | 12            | 1 728       | `56b31393` S3.5 ThreadDetail FormData (#244)          |
| `feat/s3.2-orchestrator-notify`              | 3             | 17            | 1 616       | S3.2 pg_notify('thread_inbound')                      |
| `feat/ml1.4-mail-lab-dkim`                   | 3             | 14            | 955         | ML1.4 DKIM key generation                             |
| `feat/ml1.2-mail-lab-dns`                    | 2             | 6             | 590         | ML1.2 unbound DNS                                     |
| `feat/s3.1-sse-thread-stream`                | 1             | 2             | 377         | S3.1 SSE /api/threads/stream                          |
| `feat/ml4.2-orchestrator-dns-resolver`       | 1             | 4             | 227         | ML4.2 DNS_RESOLVER env override                       |
| `feat/ml1.1-mail-lab-foundation`             | 1             | 4             | 336         | ML1.1 docker-mailserver foundation                    |
| `feat/ml4.3-ml4.5-wiring`                    | 0             | —             | —           | (parity with main)                                    |
| `feat/s3.6-playwright-e2e`                   | 0             | —             | —           | (parity with main)                                    |

### Containment map (ml stack)

`feat/ml5.1-orchestrator-evaluate-hook` is the top of the ML stack but is
**not** a strict superset of every sibling branch. Sub-branches that are
ancestors of the tip:

- `feat/ml1.1-mail-lab-foundation` IN tip
- `feat/ml1.2-mail-lab-dns` IN tip
- `feat/ml1.4-mail-lab-dkim` IN tip
- `feat/ml1.3-mail-lab-roundcube` NOT in tip (parallel branch line)
- `feat/ml1.5-mail-lab-api` NOT in tip
- `feat/ml1.6-mail-lab-bootstrap` NOT in tip
- `feat/ml2.3-profile-verdict` NOT in tip
- `feat/ml2.5-rate-tracker` NOT in tip
- `feat/ml2.7-operator-reset` NOT in tip
- `feat/ml3.3-evaluate-combined` NOT in tip
- `feat/ml4-monorepo-wiring` NOT in tip
- `feat/ml4.2-orchestrator-dns-resolver` NOT in tip
- `feat/ml4.3-ml4.5-wiring` NOT in tip
- `feat/ml5.1-maillab-go-client` NOT in tip

The tip carries the most *recent* squashed work (ML2.x, ML3.x via squash
PR-merges into intermediate branches), but several intermediate branches
(`ml1.3`, `ml1.5`, `ml1.6`, `ml4*`) hold parallel content that the tip
never absorbed.

### Containment map (s3 stack)

`feat/s3.4-outbound-multipart` (with the S3.5 squash on top) carries:

- `feat/s2.1-bff-threads-render` IN s3.4
- `feat/s2.2-bff-attachment-streaming` IN s3.4
- All S1.x branches (`s1.1` … `s1.6`) NOT in s3.4
- `feat/s2.3-threaddetail-render` NOT in s3.4 (S2.3 squash IS in s3.4 via
  `833ee8e4` from PR #201, but the branch itself diverges)
- `feat/s2.4-replies-cleanup` NOT in s3.4
- `feat/s2.5-xss-perf-suite` NOT in s3.4

`feat/s3.4` therefore covers most of the post-merge S2 + S3 content but
is **not** a complete carrier for the S1 schema/IMAP/MIME work.

## Section 2 — What's already on `main`

Re-checked `git merge-base --is-ancestor <sha> origin/main` for every
suspect commit. Only the following ML/mail-lab content is reachable from
`main` today:

- `8b8a4b4c` — `feat(KT-A14): wire labhook into Engine.Run + airtight LAB_ONLY gate (#326)`
  - This squash-merge cherry-picked the *content* of:
    - `features/platform/common/maillabclient/client.go` (with HIGH fixes from #258 — **newer than what's on the stack tip**)
    - `features/platform/common/maillabclient/client_test.go`
    - `features/inbound/orchestrator/labhook/labhook.go`
    - `features/inbound/orchestrator/labhook/labhook_test.go`
    - `features/outreach/campaigns/sender/engine_labhook_test.go`
- `0f80eead` — admin-merge audit log
- `11add70a` — KT-A2-A4 gate prep (most recent main HEAD)

Nothing else from the ML stack is on `main`. Specifically, **all of the
following directories do NOT exist on `main`**:

- `features/platform/mail-lab-api/` (entire Go REST admin API service)
- `infra/mail-lab/` (DKIM keys, unbound DNS config, postfix accounts)
- `infra/docker/mail-lab.yml` + `infra/docker/mail-lab-chaos.yml`
- `scripts/mail-lab/`
- `.github/workflows/mail-lab-ci.yml`

The previously-orphaned squash-merge commits referenced in the affected
list (e.g. `58ff0af5`, `ce269a49`, `7cde6a84`, `53b0b061`, `65defd8a`,
`b2e480a2`, `a604c193`, etc.) are reachable from the stack-parent
branches **but not from `main`**, confirming the incident summary.

### Important nuance — labhook duplication risk

`features/inbound/orchestrator/labhook/labhook.go` is byte-identical between
`origin/main` and `origin/feat/ml5.1-orchestrator-evaluate-hook` — no
merge cost there.

`features/platform/common/maillabclient/client.go` **differs** (53 diff lines).
`origin/main` is 477 lines (newer, has #258 self-review HIGH fixes:
`errBodyMaxBytes` cap, `truncate()`, `io.LimitReader`, body drain).
The stack tip is 447 lines (older, pre-#258). Any rescue strategy must
keep the `main` version, not overwrite with the stack version.

## Section 3 — Recovery options

### Option A — Single consolidated PR

**Approach:** Open `chore/stack-rescue-mail-lab` from `origin/main`, then
land the union of stack content as one or two squash commits:

1. Take the diff `origin/main..origin/feat/ml5.1-orchestrator-evaluate-hook`
   restricted to paths NOT already on `main` (`features/platform/mail-lab-api/`,
   `infra/mail-lab/`, `infra/docker/mail-lab*.yml`, `scripts/mail-lab/`,
   `.github/workflows/mail-lab-ci.yml`, `go.work` line for mail-lab-api).
2. Apply on top of `main`. Skip overlapping-but-older `features/platform/common/maillabclient/client.go`
   to preserve #258 fixes.
3. Manually reconcile content from sibling branches NOT in tip:
   `ml1.3-mail-lab-roundcube`, `ml1.5-mail-lab-api`, `ml1.6-mail-lab-bootstrap`,
   `ml4-monorepo-wiring`, `ml4.2-orchestrator-dns-resolver`,
   `ml4.3-ml4.5-wiring`. Each carries unique files (Roundcube docker compose
   service, ML4.x dashboard wiring, monorepo go.work edits).
4. Same exercise for s3 stack: cherry-pick S1.1–S1.6 schema + parser,
   then S2.3–S2.5, then S3.1–S3.5 from `feat/s3.4-outbound-multipart`.
5. Open one consolidated PR (or two: `chore/stack-rescue-mail-lab` +
   `chore/stack-rescue-mail-client`).

**Effort:** 4–8 hours wall clock. Conflict-prone because (a) `client.go`
needs the main version preserved while orchestrator/labhook stays in
sync, (b) sibling-branch reconciliation requires opening 6+ branch diffs
and manually staging, (c) test runs against newly-imported
`mail-lab-api` will need `go.work` member added + `go mod tidy`.

**Pros:** Single gate, single review, single CI run. Eliminates 19
branches in one stroke.

**Cons:** Loses per-PR review history. One reviewer must approve a
~9 000-line diff. Bisect-hostile if a regression slips in. Drops the
implicit dependency ordering that the original stack encoded.

### Option B — Re-create individual PRs

**Approach:** For every stack-parent branch that still has unique
content, re-target its PR base to `main` and re-merge serially.

Open PRs that need re-targeting (from `gh pr list --state=open`):

ML stack (open):
- `#220` `feat/ml1.1-mail-lab-foundation` → already base=main, MERGEABLE
- `#221` `feat/ml1.2-mail-lab-dns` → base=`feat/ml1.1-mail-lab-foundation`
- `#222` `feat/ml1.4-mail-lab-dkim` → base=`feat/ml1.2-mail-lab-dns`
- `#223` `feat/ml1.5-mail-lab-api` → base=`feat/ml1.4-mail-lab-dkim`
- `#224` `feat/ml1.6-mail-lab-bootstrap` → base=`feat/ml1.5-mail-lab-api`
- `#225` `feat/ml1.3-mail-lab-roundcube` → base=`feat/ml1.6-mail-lab-bootstrap`
- `#228` `feat/ml4-monorepo-wiring` → base=`feat/ml1.3-mail-lab-roundcube`
- `#237` `feat/ml4.2-orchestrator-dns-resolver` → base=main, MERGEABLE

s3 stack (open):
- `#240` `feat/s3.1-sse-thread-stream` → base=main, MERGEABLE
- `#243` `feat/s3.4-outbound-multipart` → base=main, MERGEABLE
- `#241` `feat/s3.2-orchestrator-notify` → base=`feat/s1.4-recordinbound-full-persist`
- `#229` `feat/s1.2-imap-full-rfc822`, `#230` `feat/s1.3-mime-parser`,
  `#231–#239` (s1.4 through s2.5) — all stacked on each other.
- `#234` `feat/s2.1-bff-threads-render` base=main; `#235`+`#236` chain
  through s2.

The orphaned-but-MERGED PRs (`#246`, `#248`, `#250`, `#252`, `#254`,
`#257`, `#261`, `#262`, `#242`, `#244`) cannot be re-merged — GitHub
considers them already merged and the head branches are deleted. To
recover their content, new PRs would have to be opened FROM the stack-parent
branches (which still carry the squashed content) or from manual cherry-picks.

**Effort:** 16–24 hours wall clock. Each re-target requires updating
base via `gh pr edit --base main`, rebasing the head branch onto `main`
(which usually conflicts because of the now-orphaned squash commits
upstream), running CI per PR, reviewing per PR. Roughly 18 active PR
flows in flight.

**Pros:** Preserves per-PR review history, atomic landing, bisect-friendly.
Each commit on `main` keeps its original PR URL and discussion.

**Cons:** Highest operator cost. Rebase pain is real — many of the
intermediate branches were squash-merged into each other, so a rebase
onto `main` produces "empty commit" warnings or conflicts that have to
be resolved by hand. Easy to drop content during rebase. CI cost ≈ 18×
the cost of Option A.

### Option C — Abandon stack

**Approach:** Decide that the mail-lab work is no longer needed in the
shape it was built (e.g. KT-A14 already established the labhook + client
on `main` and the operator-practice initiative satisfies the testing
goal). Then:

1. Close all 19 open PRs in the stack with comment "superseded by KT-A14
   + operator-practice OP1/OP2; stack abandoned 2026-04-30".
2. Leave the 19 remote branches in place (they hold history but become
   eligible for cleanup later).
3. Document the decision in an ADR + the operator-practice initiative.

**Effort:** 1–2 hours wall clock for decision + close + ADR.

**Pros:** Lowest cost. Forces an explicit business decision instead of
sunk-cost rescue. Clears 19 stale PRs from review queue.

**Cons:** Loses ~9 000 lines of working code (mail-lab-api Go service,
profile rules, DSN synthesizer, rate/quota/greylist trackers,
multi-provider DNS, DKIM tooling, CI workflow). Operator-practice and
labhook give us *some* of the value (LAB_ONLY gate, evaluate hook), but
not the full virtual-providers-with-real-Postfix-Dovecot-Rspamd
test bed. If a future initiative reintroduces Mail Lab, that work has to
be redone.

### Effort matrix

| Option | Wall-clock | CI cost | Risk of regression | Review-history preserved |
| ------ | ---------- | ------- | ------------------ | ------------------------- |
| A      | 4–8h       | 1×      | medium             | no                        |
| B      | 16–24h     | 18×     | high (rebase drift)| yes                       |
| C      | 1–2h       | 0×      | low                | n/a                       |

## Section 4 — Recommended path

**Recommendation: Option A — single consolidated PR** (pending orchestrator
review).

Rationale:

1. The work is genuinely valuable — `features/platform/mail-lab-api/` is 8 986
   lines of working Go (handlers, profile rules, DSN, greylist, quota,
   rate-limit, bounce delivery, evaluate combined). Option C throws
   that away.
2. Option B's per-PR rebase cost is dominated by the fact that
   intermediate branches were squashed into each other in the orphan
   merges, so rebasing each head onto `main` will drop content unless
   each rebase is resolved by hand. That's ~18 conflict-resolution
   sessions. Net wall-clock + CI cost exceeds Option A by 3–5×.
3. The "lost review history" cost of Option A is real but mitigated:
   each squash-PR description (`#246`, `#248`, `#250`, …) is preserved
   on GitHub even though those PRs are MERGED-but-orphaned. The
   consolidated PR can link them: "this PR re-lands content from #246
   #248 #250 #252 #254 #257 #261 #262, plus open PRs #220 #221 #222
   #223 #224 #225 #228 #237 #240 #243".
4. The stack-tip `feat/ml5.1-orchestrator-evaluate-hook` already carries
   most of the ML2/ML3 squashed work (visible via
   `git log origin/main..origin/feat/ml5.1-orchestrator-evaluate-hook`),
   so the heavy lifting is "diff against main + reconcile sibling
   branches". The reconciliation set is finite: `ml1.3`, `ml1.5`,
   `ml1.6`, `ml4*` for the ML side; `s1.x`, `s2.3`, `s2.4`, `s2.5` for
   the s3 side.
5. The labhook/maillabclient nuance (main has the newer #258 fixes) is
   tractable in Option A — the rescue PR explicitly skips
   `features/platform/common/maillabclient/` and `features/inbound/orchestrator/labhook/`
   from the import. In Option B, every dependent branch's rebase has to
   re-discover this conflict independently.

### Suggested execution outline (NOT executed by this analysis)

1. Branch `chore/stack-rescue-mail-lab` from `origin/main`.
2. Apply, in this order:
   - `infra/mail-lab/` + `infra/docker/mail-lab*.yml` (foundation, DNS,
     DKIM, Roundcube, multi-provider) — comes from sibling reconciliation
     of `feat/ml1.1-mail-lab-foundation`, `feat/ml1.2-mail-lab-dns`,
     `feat/ml1.3-mail-lab-roundcube`, `feat/ml1.4-mail-lab-dkim`, plus
     ML2.1 multi-provider squash.
   - `features/platform/mail-lab-api/` (handlers, profile rules, evaluator,
     DSN, greylist, quota, ratelimit, bounce, reset) — from
     `feat/ml5.1-orchestrator-evaluate-hook` minus the parts already on
     main.
   - `scripts/mail-lab/` (bootstrap, init-dkim, chaos, test_ml*).
   - `.github/workflows/mail-lab-ci.yml` (ML6.1).
   - ML4.x wiring: `features/platform/outreach-dashboard` `.env.lab`, dashboard wiring,
     `go.work` member additions.
   - Skip: `features/platform/common/maillabclient/` and
     `features/inbound/orchestrator/labhook/` (already on main, newer).
3. Verify locally: `go work sync && go test ./features/platform/mail-lab-api/...`,
   `go test ./features/inbound/orchestrator/...`, dashboard `pnpm build`.
4. Open a separate `chore/stack-rescue-mail-client` PR from `main` for
   the s3 + s1 + s2 work, applying:
   - `feat/s1.1` migration + `feat/s1.2` IMAP fetch + `feat/s1.3` parser
     + `feat/s1.4` persist + `feat/s1.5` integration test + `feat/s1.6`
     DSR cascade.
   - `feat/s2.1`–`feat/s2.5` BFF + UI work.
   - `feat/s3.1`–`feat/s3.5` SSE + notify + multipart + ThreadDetail FormData.
5. After rescue PRs land on `main`, the orphaned MERGED PRs and remote
   branches can be marked `Closed (superseded by stack-rescue PR #XXX)`
   and the branches deleted in a separate cleanup pass.

### Hard-rule reminders

- This document is read-only diagnostic.
- No remote branches were deleted.
- No PRs were closed.
- No PR base was changed.
- No force-push performed.
- The orchestrator owns the next step.
