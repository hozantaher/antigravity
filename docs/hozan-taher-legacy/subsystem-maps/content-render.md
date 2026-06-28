# Subsystem Map — Email Rendering Pipeline

**Version:** 2026-05-01
**Owner:** features/outreach/campaigns/content + features/platform/common/humanize
**Last verified:** 2026-05-01 via deep-read of content/template.go, content/spin.go, common/humanize/engine.go

This document is the canonical map of the email rendering pipeline: from raw template + contact variables to a humanized, ready-to-send `RenderedEmail`. Any code that renders campaign templates or applies humanization MUST flow through this stack.

> **Mandatory read:** before any code change in `features/outreach/campaigns/content/`, `features/platform/common/humanize/`, or any template file. The `SkipHumanize` flag is a single-point bypass — see Forbidden Bypasses.

## Components

| Component | File | Role |
|-----------|------|------|
| `Engine` struct | `features/outreach/campaigns/content/template.go:55` | Template renderer — loads .tmpl files, resolves spintax, substitutes vars |
| `Engine.Render` | `features/outreach/campaigns/content/template.go:72` | Main entry: path-traversal guard → load → detect humanize-off → extract subjects → seed → spin → substitution → headers |
| `detectHumanizeOff` | `features/outreach/campaigns/content/template.go:147` | Scans for `{{/* humanize: off */}}` marker; sets `SkipHumanize` flag |
| `ResolveSpin` | `features/outreach/campaigns/content/spin.go:12` | Recursive `{a|b|c}` resolver with nested spin support |
| `TemplateVars` | `features/outreach/campaigns/content/template.go:29` | Contact variable bag: Firma, Jmeno, Prijmeni, Region, ICO, Podpis, UnsubURL, Extra |
| `RenderedEmail` | `features/outreach/campaigns/content/template.go:41` | Render output: Subject, BodyPlain, BodyHTML, Headers, SkipHumanize |
| `humanize.Engine` | `features/platform/common/humanize/engine.go:7` | Master orchestrator: Circadian, Imperfect, Tone, Calendar, Fingerprint, Signature, Bump, Response |
| `humanize.Engine.PrepareEmail` | `features/platform/common/humanize/engine.go:83` | Entry point: Bump/Fresh decision → tone greetings/closings → imperfections → signature → fingerprint headers |
| `BumpEngine.WrapAsForward` | `features/platform/common/humanize/bump.go` (not read; cited by engine.go:97) | Wraps step N as "Re: / Fw:" with quoted original |
| `ImperfectEngine` | `features/platform/common/humanize/imperfect.go` (not read) | Introduces controlled typos, casual phrasing |
| `ToneEngine` | `features/platform/common/humanize/tone.go` (not read) | Greeting/closing variations per step |
| `FingerprintEngine` | `features/platform/common/humanize/fingerprint.go` (not read) | Message-ID, Date, X-Mailer headers modeled on CZ webmail |
| `SignatureEngine` | `features/platform/common/humanize/signature.go` (not read) | Persona signature block |
| `CircadianEngine` | `features/platform/common/humanize/circadian.go` (not read) | Time-of-day send scheduling |

## Render pipeline (Engine.Render)

| # | Step | File:Line | Notes |
|---|------|-----------|-------|
| T1 | `validTemplateName` guard | `template.go:80` | Allowlist `[a-z0-9_-]`, max 64 chars; blocks path-traversal |
| T2 | `os.ReadFile(templatesDir/name.tmpl)` | `template.go:85` | Error → propagated to caller |
| T3 | `detectHumanizeOff(content)` → sets `skipHumanize` | `template.go:96` | Scans `{{/* humanize: off/false/no/0 */}}` at any line |
| T4 | `extractSubjects` — parses `{{/* subject: ... */}}` comments | `template.go:99` | First `{{/* subject:` comment wins; default "Poptávka" if none |
| T5 | `removeSubjectComments` + `removeDirectiveComments` | `template.go:100-101` | Strips marker comments so they never appear in body |
| T6 | `deterministicSeed(contactID, step)` | `template.go:104` | SHA256(contactID:step) → deterministic int64 seed |
| T7 | Subject spin/select | `template.go:107-109` | Multiple subjects → `seed % len(subjects)`-th subject |
| T8 | Signature selection | `template.go:112-115` | Round-robins `e.signatures` via `seed % len(signatures)` |
| T9 | `substituteVars(body, vars)` | `template.go:121` | Replaces `{{firma}}`, `{{jmeno}}`, etc.; resolves `{{if .Jmeno}}…{{end}}` blocks |
| T10 | `ResolveSpin(body, seed)` | `template.go:124` | Innermost-first recursive `{a|b|c}` resolution |
| T11 | `plainToHTML(body)` | `template.go:129` | Minimal HTML wrap: escape + `<p>` paragraph split |
| T12 | `Content-Language: cs` header | `template.go:130` | Fixed outbound language header |
| T13 | Return `RenderedEmail{..., SkipHumanize: skipHumanize}` | `template.go:133` | |

## Humanize pipeline (humanize.Engine.PrepareEmail)

Called from `features/outreach/campaigns/sender/engine.go:413-415` (G7) as the PreSendHook. **Skipped when `RenderedEmail.SkipHumanize == true`.**

| # | Step | File:Line | Notes |
|---|------|-----------|-------|
| H1 | `BumpEngine.ShouldUseBump(step)` | `engine.go:95` | step > 0 → may wrap as forward/reply |
| H2 | If bump: `BumpEngine.WrapAsForward` | `engine.go:97` | Injects quoted original; sets `IsBump=true` |
| H3 | If fresh: `ToneEngine.GreetingForStep` + `ToneEngine.ClosingForStep` | `engine.go:99-102` | Step-aware greeting/closing; wraps around rawBody |
| H4 | `ImperfectEngine.ApplyToSubject` + `ApplyToBody` | `engine.go:106-107` | Occasional typos, casual phrasing |
| H5 | `SignatureEngine.Select(sendTime)` + `Render` | `engine.go:111-112` | Time-of-day signature variant |
| H6 | `FingerprintEngine.MessageID` + `Headers` | `engine.go:118-119` | CZ webmail-modeled headers: Date, Message-ID, X-Mailer |
| H7 | `FingerprintEngine.WrapBodyHTML` | `engine.go:120` | Minimal HTML wrap matching CZ webmail patterns |
| H8 | Return `HumanizedEmail{..., SendAt, IsBump}` | `engine.go:122` | Caller merges back into the send request |

## TemplateVars fields

| Field | Source | Usage |
|-------|--------|-------|
| `Firma` | contact company name | `{{firma}}` / `{{.Firma}}` |
| `Jmeno` | contact first name | `{{jmeno}}` / `{{.Jmeno}}` |
| `Prijmeni` | contact last name | `{{prijmeni}}` / `{{.Prijmeni}}` |
| `Region` | contact region | `{{region}}` / `{{.Region}}` |
| `ICO` | company ICO | `{{ico}}` / `{{.ICO}}` |
| `Podpis` | sender signature block | `{{podpis}}` / `{{.Podpis}}` |
| `UnsubURL` | full unsubscribe URL (HMAC token) | `{{unsuburl}}` / `{{.UnsubURL}}` |

`UnsubURL` is injected by `runner.go` at `features/outreach/campaigns/campaign/runner.go` using `token.BuildUnsubToken`. Source: anti-trace map step R12.

## Spintax format

```
{option1|option2|option3}
{We {buy|purchase}|We're looking to {acquire|buy}}   ← nested supported
```

Resolution is innermost-first, deterministic per `(contactID, step)` pair. Source: `features/outreach/campaigns/content/spin.go:12-38`

## `SkipHumanize` flag

Set in template file via:
```
{{/* humanize: off */}}
```
or `humanize: false`, `humanize: no`, `humanize: 0`.

Effect: `humanize.Engine.PrepareEmail` is **not called** in sender engine step G7 (`engine.go:413-415`). The rendered body is delivered verbatim. Designed for legal/compliance notices where tone modifications are inappropriate.

## Public API consumed by

| Consumer | Entry point |
|----------|-------------|
| `features/outreach/campaigns/campaign/runner.go:328` | `content.Engine.Render(...)` — step R13 in anti-trace map |
| `features/outreach/campaigns/sender/engine.go:413` | `humanize.Engine.PrepareEmail(...)` — step G7 in anti-trace map |
| BFF `src/server-routes/campaigns.js` | GET `/api/campaigns/:id/email-quality` reads rendered sample |
| `src/server-routes/templatePreview.js` | Template preview endpoint |
| `features/outreach/campaigns/campaign/preflight.go:219` | P3: render with neutral vars to catch spintax errors at preflight |

## Forbidden bypasses

| Bypass | Why banned |
|--------|-----------|
| `SkipHumanize = true` from new production templates | Bypasses entire G7 humanize layer; documented in anti-trace map; requires operator review of each template that sets the marker |
| Calling `ResolveSpin` with non-deterministic seed (e.g. `rand.Int63()`) | Breaks auditability — same contact+step must produce same variant for debugging |
| Calling `substituteVars` with unsanitized user content in `Extra` map | `Extra` map values are substituted without escaping; XSS risk if rendered in HTML |

## Open questions (unresolved as of 2026-05-01)

1. **`Extra` map substitution** — `TemplateVars.Extra` is defined but `substituteVars` does not iterate it (only hardcoded keys). What is its intended use?
2. **`humanize.NewEngine(persona)` wiring** — where is the `Persona` object constructed in orchestrator/main.go? Persona determines signature content. Not traced.
3. **Template directory path** — `Engine.Render` uses `templatesDir` from `NewEngine` constructor. What path is passed at boot? Likely `configs/templates/` relative to service working dir.

## Cross-references

- Anti-trace map steps R13 (render) and G7 (humanize)
- Memory: `feedback_anti_trace_full_stack` — SkipHumanize is a tracked bypass
- `features/outreach/campaigns/CLAUDE.md` — content package overview
- Initiative: `docs/initiatives/2026-05-01-codebase-awareness-discipline.md`
- Issue: #560
