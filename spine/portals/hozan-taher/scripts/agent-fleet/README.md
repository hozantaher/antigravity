# scripts/agent-fleet/

Pre-spawn tooling for agent fleet — deterministic helpers that run before
spawning a sub-agent so the model tier (Haiku / Sonnet / Opus) is chosen
predictably instead of by gut feel.

## Background

Per PR #422 inventory finding: 33 / 60 (55 %) PRs were Haiku-grade tasks
running on Sonnet. Memory rule
`feedback_subagent_token_economy` already said "Haiku for cleanup/drift,
Sonnet for complex feature", but the rule wasn't *procedural* — every
spawn-time decision was manual + biased toward Sonnet (default, "safe").

This directory turns that rule into a CLI tool. North-star aspiration #1
("self-classifying task tier") — first concrete step.

## Tools

### `classify-task-tier.sh`

Reads a conventional-commit-style task title (via stdin or argument)
and prints the recommended model tier (`haiku` / `sonnet` / `opus`) on
stdout. Exit code `0` means classified; `1` means unable to classify
(empty input or unknown prefix); `2` means argument error.

```bash
# stdin
echo "feat(bff): wire reply pipeline" | scripts/agent-fleet/classify-task-tier.sh
# → sonnet

# argument
scripts/agent-fleet/classify-task-tier.sh "chore(deps): bump vite to 7.3.2"
# → haiku

# explain reasoning to stderr
scripts/agent-fleet/classify-task-tier.sh --explain "feat(sender): cleanup duplicate gate"
# stderr: [classify] haiku keyword override matched
# stdout: haiku
```

#### Decision order

1. **Opus triggers** — title contains `cross-cutting refactor`,
   `multi-pass audit`, `architectural revision`, or `monolith split`.
2. **Sonnet triggers** — title contains design / security / concurrency
   keywords (`wire`, `integrate`, `pipeline`, `architecture`, `design`,
   `security`, `auth`, `crypto`, `hmac`, `gdpr cascade`, `vision`,
   `llm`, `inference`, `concurrent`, `race`, `lock`).
3. **Haiku triggers** — title contains mechanical keywords (`cleanup`,
   `drift`, `sweep`, `consolidat`, `dead code`, `orphan`, `bump
   baseline`, `rebaseline`, `snapshot`, `lint`, `format`, `gofmt`,
   `goimports`, `align test`).
4. **Prefix mapping** — see table below.

#### Prefix → tier table

| Prefix                | Tier   | Reason                          |
|-----------------------|--------|---------------------------------|
| `chore(...)`          | haiku  | Mechanical maintenance          |
| `docs(initiatives)`   | haiku  | Pure docs editing               |
| `docs(adr)`           | sonnet | New ADR = design decision       |
| `docs(strategy)`      | sonnet | Vision documents                |
| `docs(...)` other     | haiku  | Default docs editing            |
| `test(contract)`      | haiku  | Snapshot adjustment             |
| `test(audit)`         | haiku  | Ratchet baseline shift          |
| `test(unit)`          | haiku  | Coverage improvement (default)  |
| `test(integration)`   | sonnet | Real external deps              |
| `test(e2e)`           | sonnet | Playwright design               |
| `fix(test)`           | haiku  | Test-only repair                |
| `fix(<modul>)`        | sonnet | Production code change          |
| `feat(...)`           | sonnet | New functionality               |
| `refactor(...)`       | sonnet | Default; mechanical caught by override |
| `perf(...)`           | sonnet | Measurement + optimization      |
| `sec(...)`            | sonnet | Security-critical               |
| `audit(inventory)`    | haiku  | Mechanical scan; deep variants escalate via override |
| `ci(...)`             | haiku  | Mechanical wiring               |

#### Example invocations

| Invocation                                                              | Output  |
|-------------------------------------------------------------------------|---------|
| `classify-task-tier.sh "chore(deps): bump vite"`                        | `haiku` |
| `classify-task-tier.sh "feat(bff): wire reply pipeline"`                | `sonnet`|
| `classify-task-tier.sh "feat(sender): cleanup duplicate gate"`          | `haiku` (override) |
| `classify-task-tier.sh "chore(infra): wire telemetry pipeline"`         | `sonnet` (override) |
| `classify-task-tier.sh "refactor(arch): monolith split for outreach"`   | `opus`  |

### `classify-task-tier.test.sh`

Bash test runner. 37 assertions covering every prefix path, both
override directions, opus triggers, and edge cases (empty input,
unknown prefix, no-colon input, argv vs stdin invocation, `--help`
exit code).

```bash
bash scripts/agent-fleet/classify-task-tier.test.sh
# === SUMMARY === pass=37 fail=0 total=37
```

Exit `0` on full pass, `1` on any failure.

## Recommended workflow

Before `Agent` spawn, run:

```bash
TIER=$(scripts/agent-fleet/classify-task-tier.sh "$PR_TITLE")
# Pass --model "$TIER" do agent harness
```

Or as a manual mental check — pipe the proposed title through the
script, read the output, then explicitly choose the model parameter
in the agent prompt. No more "default Sonnet because safe".

If the prefix isn't in the table → script exits `1` → update the table
in this README **and** the canonical heuristics rule
(`~/.claude/.../memory/feedback_haiku_classifier_heuristics.md`)
before spawning.

## Hard constraints

- Pure bash (3.2+), no node / python / jq dependencies.
- Stdlib only — fits the "no external services" memory rule.
- Czech comments explanatory; English exports / output.
