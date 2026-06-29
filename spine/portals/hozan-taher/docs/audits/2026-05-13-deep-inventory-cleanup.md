# Deep Inventory + Cleanup Proposals — 2026-05-13

**Status:** Draft  
**Date:** 2026-05-13  
**Trigger:** Manual operator audit request — all 12 categories

---

## Executive Summary

| Category | Findings | High (safe to drop) | Needs review |
|----------|----------|---------------------|--------------|
| 1. Dead Go code | 3 | 1 | 2 |
| 2. Dead JS code | 3 | 1 | 2 |
| 3. Orphan migrations | 2 | 0 | 2 |
| 4. Duplicate/competing features | 2 | 0 | 2 |
| 5. Stale operator_settings | 0 | — | — |
| 6. Closed initiatives not in archive | 18 | 18 | 0 |
| 7. Deprecated endpoints | 3 | 1 | 2 |
| 8. Test files for deleted features | 1 | 0 | 1 |
| 9. Unused npm dependencies | N/A | — | — |
| 10. Old worktrees (locked/prunable) | 5 prunable | 5 | 0 |
| 11. Orphan branches | ~770 worktree-agent + ~130 named local | 770+ | ~100 |
| 12. Stale GitHub issues | 0 (>30d) | — | — |

**Total findings: 37 (excluding branch mass-cleanup)**  
**High priority (safe to drop): 26**  
**Needs review: 11**

---

## 1. Dead Go Code

`deadcode` was not installed at audit time. Analysis is based on code-search.

- [ ] **`DeriveX25519KeyPair` in `features/outreach/relay/internal/amnesic/receive.go:230`** — marked `(LEGACY)` in its own docstring. Per `features/outreach/relay/ADR-003.md:39`, it is used as backward-compat fallback for pre-epoch messages via `receive.go:56`. Has test coverage in `amnesic_coverage_test.go` + `derive_property_test.go`. **Risk: remove only after epoch cutover is confirmed complete. Keep until epoch-key rotation is verified PROD-only.** (Effort: needs epoch audit first)

- [ ] **Legacy SOCKS5 probe branch in `features/outreach/relay/web/probe.go:997`** — comment reads "deprecated for probing." Active code path: only reached when `VERIFY_VIA_DIRECT_EGRESS=false`. The env toggle keeps this branch alive for backward compat. **Risk: low, but branch is reachable. Document removal gate.** (Effort: 10 min to document; removal after `VERIFY_VIA_DIRECT_EGRESS=true` is stable default)

- [ ] **`features/platform/operator-practice/`** — only file is `no_raw_imap_socket_test.go` + `go.mod`. No production code. The Go module exists solely for audit ratchet enforcement. This is intentional (confirmed by file structure), NOT dead code. **No action needed.**

**Deadcode tool note:** Run `deadcode -test ./...` per service once installed to surface symbol-level dead code. Prior audit `docs/audits/2026-05-05-go-library-deadcode.md` has last known results.

---

## 2. Dead JS/TS Code

- [ ] **`features/platform/outreach-dashboard/src/routes/__tests__/replies.routes.test.js`** — imports `'../replies.js'` via dynamic `import('../replies.js')` at lines 17 and 25. The file `features/platform/outreach-dashboard/src/routes/replies.js` does NOT exist (merged into `src/server-routes/replies.js` in Sprint G7/#1241). The test therefore always fails or is silently skipped. **Action: delete this test file or migrate assertions to the server-routes test.** (Effort: 15 min)

- [ ] **`features/platform/outreach-dashboard/src/routes/` directory** — contains only the orphan test above. No production JS files. Directory itself is empty post-G7 merge. **Action: delete after resolving item above.** (Effort: 2 min)

- [ ] **`garaaage_url` legacy field alias in `features/platform/outreach-dashboard/src/server-routes/replies.js:488-489`** — accepts `garaaage_url` in POST body as fallback for `crm_url`. UI pages (`Replies.jsx`, components/) do not call `/api/replies/:id/forward-to-garaaage` or send `garaaage_url`. Dashboard CLAUDE.md marks this deprecated 2026-08. **Action: safe to keep until 2026-08 deadline; no active callers found in UI. Flag for removal at Sprint AL+2.** (Effort: 5 min when removal date reached)

---

## 3. Orphan Migrations

Migration numbering gaps identified in `scripts/migrations/`:

- [ ] **Gap at `069_`** — sequence jumps from `068_legacy_users_and_blacklist.sql` to `070_drop_dead_mailboxes.sql`. No `069_*.sql` file exists locally. This may be a migration that was applied to PROD and later deleted from repo, or simply never existed. **Action: query PROD `schema_migrations` table to confirm whether a `069_` entry exists. If yes, create a stub file. If no, document the deliberate skip.** (Effort: 5 min query + 10 min stub if needed)

- [ ] **Gap at `089_`** — sequence jumps from `088_fix_aggregate_cap_semantics.sql` to `090_replace_mailboxes_fresh_seznam.sql`. No `089_*.sql` file exists locally. Same risk as `069_`. **Action: same as above.** (Effort: 5 min)

**Note:** All other migration numbers 000–108 are sequential modulo these two gaps. Per `feedback_verify_select_after_migration` HARD RULE, PROD state must be verified before any action.

---

## 4. Duplicate or Competing Features

- [ ] **`proxy_url` column still in active code despite migration 077 deprecation** — `features/outreach/mailboxes/mailbox/postgres.go` (lines 51, 267, 275, 318, 325, 405), `features/outreach/mailboxes/mailbox/mailbox.go:94`, `features/outreach/mailboxes/watchdog/daemon.go:340,343,355,504`, `features/platform/common/config/config.go:69`, `features/outreach/relay/web/probe.go:379,418,419,455` all still reference `proxy_url`. Migration 077 added a deprecation COMMENT but explicitly did NOT drop the column. **Action: plan a `078b_` or `109_drop_proxy_url.sql` migration after verifying zero writes via observability. Dashboard `MailboxDrawer.jsx` + `mailboxUtils.js` + BFF `mailboxes.js` also still send the field.** (Effort: 1h audit + migration + test)

- [ ] **Dual context endpoints** — `GET /api/threads/:id/context` and `GET /api/replies/:id/context` both mount the same `contextHandler` (`replies.js:620-622`). Comment says "Frontend should migrate to this path" (KT-A13). No tracking of which clients still use the old `/api/threads/` path. **Action: grep frontend call sites; if all on `/api/replies/`, deprecate `/api/threads/:id/context` endpoint.** (Effort: 15 min grep + 30 min removal)

---

## 5. Stale Config / operator_settings Keys

No findings. `features/platform/common/operatorconfig/` loads all keys from `operator_settings` table at runtime. Cross-referencing all keys requires a PROD `SELECT key FROM operator_settings` query (read-only, operator can run from dashboard). **Action: defer to operator — run query and cross-ref against code usages in `features/outreach/campaigns/sender/lia_scope.go`, `features/outreach/campaigns/content/humanlike_score.go`, and BFF `operatorSettings.js`.** No dead keys confirmed without PROD data.

---

## 6. Closed/Archived Initiatives Not in docs/archive/

`docs/archive/` has 13 files. `docs/initiatives/` has 18 files with `Status: Archived` or `Status: Superseded`. None of the 18 are in `docs/archive/`. Per `feedback_initiative_status_required` HARD RULE, Closed/Superseded must move to archive.

Files to move (all verified present in `docs/initiatives/`):

- [ ] `2026-04-21-outreach-dashboard-quality-refactor.md` (Archived)
- [ ] `2026-04-22-discipline-and-domain-migration.md` (Archived)
- [ ] `2026-04-22-send-pipeline-unblock.md` (Archived)
- [ ] `2026-04-23-plan-v2.md` (Archived)
- [ ] `2026-04-25-brownfield-pass-v3.md` (Archived)
- [ ] `2026-04-25-garaaage-launch-plan-v4.md` (Archived)
- [ ] `2026-04-26-comprehensive-testing-self-healing.md` (Archived)
- [ ] `2026-04-27-adversarial-fixes.md` (Superseded)
- [ ] `2026-04-27-autonomous-ops-handoff.md` (Superseded)
- [ ] `2026-04-27-autonomous-ops.md` (Superseded)
- [ ] `2026-04-27-comprehensive-fixes.md` (Superseded)
- [ ] `2026-04-27-first-send-mvp.md` (Superseded)
- [ ] `2026-04-27-gap-closure-plan.md` (Superseded)
- [ ] `2026-04-27-launch-fasttrack.md` (Superseded)
- [ ] `2026-04-27-launch-readiness.md` (Superseded)
- [ ] `2026-04-27-llm-reply-classifier.md` (Superseded)
- [ ] `2026-04-27-test-suite-recovery.md` (Superseded)
- [ ] `2026-05-04-master-merge-and-rollout.md` (Superseded — confirmed via grep)

**Action: `git mv docs/initiatives/<file> docs/archive/` for all 18. Low risk, single PR.** (Effort: 10 min)

**Additional: 4 non-dated initiative files with no Status header:**

- `docs/initiatives/SPRINT-1-closeout.md` — no Status header (has body content from 2026-04-23)
- `docs/initiatives/SPRINT-1-details.md` — no Status header
- `docs/initiatives/SPRINT-1-FINAL.md` — no Status header
- `docs/initiatives/SPRINT-2-kickoff.md` — no Status header (2026-04-30)
- `docs/initiatives/M6-M7-EXECUTION-PLAN.md` — no Status header (2026-04-23)
- `docs/initiatives/TEST-COVERAGE-MATRIX.md` — no Status header (2026-04-23)

**Action: Add `**Status:** Archived` header + move to archive.** (Effort: 15 min)

---

## 7. Deprecated Endpoints

- [ ] **`POST /api/replies/:id/forward-to-garaaage`** in `features/platform/outreach-dashboard/src/server-routes/replies.js:526` — comment at line 485 confirms Sprint AL backward-compat alias. CLAUDE.md marks it deprecated 2026-08. Zero callers found in `src/pages/` or `src/components/`. **Action: Remove after 2026-08-01. Track via GH issue.** (Effort: 10 min when date reached)

- [ ] **Legacy SOCKS5 probe branch** in `features/outreach/relay/web/probe.go:997` — see section 1 above. Code path active only when `VERIFY_VIA_DIRECT_EGRESS=false`. Not a no-op. **Risk: medium.** (Effort: needs PROD env audit)

- [ ] **`GET /api/threads/:id/context`** — dual with `GET /api/replies/:id/context` (same handler, KT-A13 alias per `replies.js:621`). Original path is soft-deprecated pending frontend migration. **Action: grep frontend usage, then gate removal.** (Effort: 30 min)

---

## 8. Test Files for Deleted Features

- [ ] **`features/platform/outreach-dashboard/src/routes/__tests__/replies.routes.test.js`** — imports `../replies.js` which does not exist (merged in G7). Test 5 cases (T-0322–T-0326) reference a router factory pattern that no longer matches the server-routes architecture. **Action: Delete file, or extract valid contract assertions to `tests/contract/`.** (Effort: 30 min to audit which assertions are still valid)

---

## 9. Unused npm Dependencies

Dashboard (`features/platform/outreach-dashboard/package.json`) production dependencies are minimal (8 packages: `@sentry/node`, `busboy`, `cors`, `exceljs`, `express`, `express-fileupload`, `isomorphic-dompurify`, `pg`, `socks`). All are verifiably in use:
- `socks` — `dialIMAPViaSOCKS5` in `src/lib/imapUtils.js`
- `exceljs` — CRM XLSX import
- `isomorphic-dompurify` — HTML sanitization (`feat/dompurify-html-render` branch)
- `busboy` / `express-fileupload` — attachment endpoints

**No unused production deps found in dashboard.** Dev deps not audited (large surface, low risk). Services with own `package.json` (scrapers, worker, mcp, mailboxes/ui, campaigns/ui) not audited individually — each has own lockfile per `project_dockerized_lockfiles.md`.

---

## 10. Old Worktrees (Locked / Prunable)

5 worktrees are `prunable` (gitdir points to non-existent location):

- [ ] `/Users/messingtomas/Documents/Projekty/hozan-taher/.claude/worktrees/aw7-5-greylist` — branch `feat/aw7-5-relay-greylist-auto-retry`
- [ ] `/Users/messingtomas/Documents/Projekty/hozan-taher/.claude/worktrees/envconfig-b2` — branch `feat/cad-tier3-envconfig-b2`
- [ ] `/Users/messingtomas/Documents/Projekty/hozan-taher/.claude/worktrees/kt-a9-1` — branch `feat/kt-a9-1-enrichment-cutover`
- [ ] `/Users/messingtomas/Documents/Projekty/hozan-taher/.claude/worktrees/kt-b10` — branch `test/kt-b10-load-1000-replies`
- [ ] `/Users/messingtomas/Documents/Projekty/hozan-taher/.claude/worktrees/kt-b14` (at `/Users/messingtomas/Documents/Projekty/Hozan-Taher/...`) — branch `test/kt-b14-replies-deep-v1`

**Per `feedback_kill_procs_with_worktree` HARD RULE:** removal requires killing associated processes first.  
**Action:**
```bash
git worktree prune   # removes prunable worktrees (safe, gitdir already gone)
```
This is safe — `prunable` means the gitdir is already gone; `prune` just removes the stale metadata. No `pkill` needed since the directories do not exist. (Effort: 1 min)

16 worktrees are `locked` (active agent sessions with pid 26135, 44821, 67215). Do NOT remove while those pids are alive.

---

## 11. Orphan Branches

Total branches: 1,707.

**Category A: worktree-agent-* branches (~241 local)**  
Branches named `worktree-agent-<hash>` are created automatically by the agent worktree system. They accumulate permanently. None have remote tracking. Per current convention, these are safe to delete after verifying they are not active worktrees.

- [ ] **Action: after all agent sessions complete, run:**  
  ```bash
  git branch | grep "worktree-agent-" | xargs git branch -d 2>/dev/null || true
  # Use -D for any that are unmerged but confirmed obsolete
  ```
  (Effort: 5 min; risk: LOW — all are auto-generated session artifacts)

**Category B: Named local branches (~773 total - worktree-agent)**  
Of these, branches with last commit before 2026-04-29 (~35 branches identified by sampling) are clearly pre-launch stale. Examples:
- `feat/ml1.2-mail-lab-dns` (2026-04-29)
- `feat/sprint-b1-2-mailboxes-migrate` (2026-04-29)
- `refactor/extract-companies-routes-v2` (2026-05-01)
- All `chore/cad-map-drift-*-2026-05-03` and `*-2026-05-04` batches

- [ ] **Action: identify branches merged into `main` and bulk-delete:**  
  ```bash
  git branch --merged main | grep -v "^\*\|main\|wm/development\|wm/tests" | xargs git branch -d
  ```
  (Effort: 10 min; risk: LOW for `--merged` only)

- [ ] **Action: `audit/*` branch family (~17 branches)** — all pre-launch investigation branches. Last commits 2026-04-30 to 2026-05-05. Safe to delete after confirming findings were recorded in `docs/audits/`. (Effort: 15 min verification)

**Remote branches:** 700 on origin. No remote cleanup recommended without operator explicit consent (requires `git push origin --delete`).

---

## 12. GitHub Issues (Stale >30 Days)

Query `gh issue list --state=open` returned no issues with `updatedAt` older than 30 days from 2026-05-13 (i.e., before 2026-04-13). **No stale-close candidates found.**

---

## Recommended Order

1. **`git worktree prune`** — 1 min, zero risk (Section 10)
2. **Move 18+ Archived/Superseded initiatives to `docs/archive/`** — 10 min, zero risk (Section 6)
3. **Delete `features/platform/outreach-dashboard/src/routes/__tests__/replies.routes.test.js`** + `src/routes/` dir — 30 min, LOW risk (Sections 2 + 8)
4. **Delete `worktree-agent-*` local branches** (after active sessions end) — 5 min, LOW risk (Section 11A)
5. **Plan `proxy_url` column drop migration** (`109_drop_proxy_url.sql`) — 1h, MEDIUM risk; requires PROD write-zero verification (Section 4)
6. **Document migration gaps 069/089** — 10 min, informational (Section 3)
7. **`/api/threads/:id/context` deprecation** — 30 min + frontend grep, LOW risk (Sections 4 + 7)
8. **Bulk-delete merged local branches** — 15 min, LOW risk (Section 11B)

---

## Risk Register

| Risk | Item | Mitigation |
|------|------|-----------|
| `DeriveX25519KeyPair` removal breaks pre-epoch message decryption | Section 1 | Only remove after confirming all PROD messages use epoch-key rotation |
| `proxy_url` drop breaks any unknown consumer | Section 4 | Audit `features/outreach/relay/web/probe.go:418` — probe endpoint still accepts `proxy_url` in request body; that is an API contract, not DB column |
| `worktree-agent-*` branch with un-pushed commits deleted | Section 11A | Use `-d` (not `-D`) first; review any error output |
| `SPRINT-1*` / `M6-M7*` initiative files moved while referenced by other docs | Section 6 | `grep -r "SPRINT-1-closeout\|M6-M7" docs/` before moving |
