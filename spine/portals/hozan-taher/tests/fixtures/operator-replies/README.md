# Operator-replies fixtures

Real anonymized inbound replies used by the **Operator Practice** initiative
(`docs/initiatives/2026-04-30-operator-practice.md`) to seed lab inboxes
for hands-on triage / classify / reply training.

## Hard rule: real anonymized data only

Per memory `feedback_no_fabricated_test_data` — **NEVER** add Faker / fake /
LLM-generated samples here. Every file must originate from a real B2B reply
that's been run through `scripts/operator-practice/anonymize.mjs` (OP1.2 —
forthcoming).

The one exception is `_placeholders/` (see below). Files there are clearly
marked as not-real and exist only for infrastructure plumbing tests.

## Directory layout

```
tests/fixtures/operator-replies/
├── README.md          # this file
├── _placeholders/     # marked-not-real, infra plumbing only
│   └── *.eml
├── interested/        # real anonymized: prospect engaged
├── not-interested/    # real anonymized: explicit refusal
├── ooo/               # real anonymized: out-of-office auto-reply
├── wrong-person/      # real anonymized: forwarded / wrong recipient
├── spam/              # real anonymized: spam-classified
└── ambiguous/         # real anonymized: classifier edge cases
```

## .eml file format

Standard RFC822. Required headers:

| Header | Purpose |
|---|---|
| `From:` | Anonymized sender (use `@anon.lab` domain) |
| `To:` | Operator address (e.g. `op@gmail.lab`) |
| `Subject:` | Original subject, anonymized |
| `Date:` | Original timestamp (ISO 8601 acceptable) |
| `Message-ID:` | Unique per file; can regenerate if missing |
| `X-Lab-Category:` | One of `interested`, `not-interested`, `ooo`, `wrong-person`, `spam`, `ambiguous` (ground truth) |
| `X-Lab-Source:` | `real-anonymized` (real export) or `placeholder-infrastructure-test` |

Body can be `text/plain`, `text/html`, or `multipart/*`. Preserve the
original media-type tree — that's what makes the render-path test honest.

## Adding new fixtures (post-OP1.2)

1. Export real replies from prod orchestrator:
   ```sql
   SELECT thread_id, body_text, body_html, classification, received_at
   FROM outreach_messages
   WHERE direction = 'inbound'
   ORDER BY received_at DESC LIMIT 100;
   ```
2. Run anonymizer (OP1.2):
   ```
   node scripts/operator-practice/anonymize.mjs export.json tests/fixtures/operator-replies/
   ```
3. Manual review — check `out-checklist.md` flagged any leaked PII.
4. Commit only files marked `X-Lab-Source: real-anonymized`.

## Reading fixtures programmatically

`scripts/operator-practice/seed-replies.mjs` walks this tree and pushes
matching `.eml` files into a lab IMAP inbox via APPEND. See its `--help`
for filter flags.

## Why placeholders exist

Per user direction 2026-04-30, the OP1 sprint validates the **infrastructure
pipeline** (anonymizer → IMAP injector → orchestrator poll → dashboard
render) before real exports are available. Placeholders carry zero semantic
truth — they only prove the pipe moves bytes correctly. They live in
`_placeholders/` so audit scripts can grep for "placeholder-infrastructure-test"
and refuse to include them in real training runs.
