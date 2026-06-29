# Weekly Rollup {{WEEK}}

**Dates:** {{START_DATE}} .. {{END_DATE}}
**Generated:** {{GENERATED_AT}}
**Author:** {{AUTHOR}}

> Runbook: [`docs/playbooks/WEEKLY-ROLLUP.md`](../playbooks/WEEKLY-ROLLUP.md).
> Template je autofill-friendly — placeholdery `{{...}}` plní `scripts/weekly-rollup.sh`.
> Reviewer musí dopsat analýzu (Notable, Blockers, Next week focus, Audit delta interpretace).

## Merged PRs

| # | Title | Author | LoC (+/−) | Tests added |
|---|---|---|---|---|
{{MERGED_PRS_ROWS}}

**Total merged:** {{MERGED_COUNT}}

## Open PRs aging > 3 days

| # | Age (days) | Status | Blocker |
|---|---|---|---|
{{OPEN_PRS_ROWS}}

**Total open:** {{OPEN_COUNT}}

## Commits on main

**Count:** {{COMMITS_COUNT}}

**Notable:** _(reviewer fills in — what changes stood out?)_

{{COMMITS_SAMPLE}}

## CI pass rate

| Metric | This week | Last week | Trend |
|---|---|---|---|
| Green runs | {{CI_GREEN}} | _(fill in)_ | _(↑/↓/=)_ |
| Total runs | {{CI_TOTAL}} | _(fill in)_ | _(↑/↓/=)_ |
| Pass rate | {{CI_PASS_RATE}} % | _(fill in)_ | _(↑/↓/=)_ |

## Issues opened / closed

| Metric | Count |
|---|---|
| Opened | {{ISSUES_OPENED}} |
| Closed | {{ISSUES_CLOSED}} |
| Net delta | {{ISSUES_DELTA}} |

## Audit debt delta

Data z `memory/project_*_quality_debt.md` head diff vs last week.

| Service | HIGH opened | HIGH closed | Net Δ | Interpretace |
|---|---|---|---|---|
| outreach-dashboard | | | | _(roste / drží / klesá?)_ |
| outreach (Go) | | | | |
| anti-trace-relay | | | | |
| worker | | | | |
| scrapers | | | | |
| mcp | | | | |

**Total Δ (HIGH):** _(fill in)_ — **target: ≤ 0** (konsolidace)

## Tasks completed

Reference na task IDs (P0/P1/P2/M0/M1 z initiatives):

- [ ] {{TASK_ID}} — {{TASK_TITLE}}

## Blockers / risks this week

_(reviewer fills in — co příští týden hrozí? co čeká na decision?)_

- …

## Next week focus

_(3–5 bullet items, conkrétní priorities)_

1. …
2. …
3. …

## Notes

_(freeform — pattern observations, anomálie, cokoliv, co nepatří nikam jinam)_

---

**Reviewed:** {{REVIEWED_AT}}
**Next rollup:** {{NEXT_FRIDAY}}
