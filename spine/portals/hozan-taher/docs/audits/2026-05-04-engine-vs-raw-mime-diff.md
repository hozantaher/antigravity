# Engine vs. Raw SMTP MIME Comparison (2026-05-04)

**Context:** Services/relay path A (`/v1/raw-smtp-test`) delivers 1/1 to Seznam CZ from Railway+Mullvad, but Engine.WithAntiTrace path B returns 0/302 from identical egress. This diagnostic identifies MIME transformation candidates triggering Seznam spam-flagging.

**Prior work:** `reports/anti-trace-mime-transformations-2026-05-03.md` enumerated 24 transformations across H1 sprint. Tests I1–I5 probed subsets in isolation; I6 cumulative SAFE-profile test silently failed post-I4 diacritics. This report ranks candidates by evidence and delivery risk.

---

## 1. Headers Added by Engine (NOT in raw_smtp_diag)

### Raw SMTP Path (features/outreach/relay/web/raw_smtp_diag.go)
- **Minimal set:** `From`, `To`, `Subject`, `Date`, `Message-Id`, `MIME-Version`, `Content-Type`, `Content-Transfer-Encoding`
- **No X- headers:** `X-Mailer` absent (raw_smtp_diag intentionally omits to preserve RFC 5322 baseline)
- **No fingerprint:** no `X-Originating-IP`, no `User-Agent`, no server-specific markers

### Engine Path (features/outreach/campaigns/sender + content render)
**Pre-relay headers (template.go + headers.go):**
- `From` → replaced by `BuildFromHeader` (display-name forced if missing, format `"Display Name <email>"`)
- `Message-ID` → replaced by `BuildMessageIDHeader` (HMAC-SHA256 format `<{16hex}.{nanos}@{fqdn}>` when key present)
- `Date` → replaced by `BuildDateHeader` (mailbox TZ, per `BuildDateHeader/loadLocationOrDefault`)
- `Content-Language: cs` added (template.go:130)
- `MIME-Version`, `Content-Type` set by template render (plainToHTML at template.go:136)

**Humanize fingerprint layer (features/platform/common/humanize/fingerprint.go:27–42):**
- `X-Mailer: Seznam.cz` added (headers.go not referenced; humanize layer injects, then engine overrides at G7–G10 per anti-trace.md)
- Additional X-* headers from humanize suppressed by relay T2/D5 (SanitizeIntake strips X-*)

**Engine + relay interaction (features/outreach/campaigns/sender/engine.go:600–620, antitrace.go:97–130):**
- No additional headers injected by Engine itself — it *overrides* humanize values via `applyAnonymityHeaders` before relay submit
- Relay receives clean From/Message-ID/Date + Content-Language + Content-Type

---

## 2. Body Transformations

### Raw SMTP Path
- **text/plain:** verbatim (req.Body, no mutation unless flags set)
- **text/html:** minimal wrapper `<!DOCTYPE html><html><body><p>…</p></body></html>` with:
  - HTML-escape (& < > " ') applied
  - CRLF → `<br/>` conversion
  - Optional span injection (per-line 30% coin flip, font-size ∈ {13,14,15}px) when `spans_inject=true`
  
### Engine Path
**Before relay (template render → humanize):**
1. **Template render** (features/outreach/campaigns/content/template.go):
   - Variable substitution ({{Firma}}, {{Jmeno}}, etc.)
   - Spin syntax resolution ({{choice:a|b|c}})
   - Whitespace trim
   - Body passed as-is to plainToHTML (line 136, no imperfect-layer call)

2. **Humanize fingerprint layer** (features/platform/common/humanize/fingerprint.go:52–86):
   - `WrapBodyHTML`: wraps plain text in `<html><head><meta charset="utf-8"></head><body><div style="font-family: Arial, sans-serif; font-size: 14px;">…</div></body></html>`
   - Per-line random span wrapping (30% coin flip, font-size ∈ {13,14,15}px)
   - Optional redundant `<div>&nbsp;</div>` after empty lines (20% coin flip)

3. **Humanize imperfect layer** (features/platform/common/humanize/imperfect.go:43–65):
   - **Diacritics degradation** (I4 candidate): 40% probability on subject, 85% on greeting, 70% on body progressively declining to 30%
   - Typo injection (0–3 random commas/periods removed)
   - Forgotten-attachment check (not applied to email body, metadata only)

**Net transformation stack:**
- Template vars + spin resolved
- Humanize wraps in `<html><head><meta>…<div style="font-family/font-size">…per-line spans…redundant divs…</div>`
- Diacritics stochastically degraded (multiple runs across subject/greeting/body)
- Typos injected (very low count)

**At relay (antitrace.go → relay T1–T8):**
- Body forwarded with HTML as-is (no further content transformation)
- X-Mailer + other X-* stripped by relay T2/D5
- Message-ID/From/Date overridden by relay per engine-supplied headers

---

## 3. Top-3 Ranked Killer Candidates

### Rank 1: Diacritics Random Degradation (I4 path, 70% prob on body)
**File:** `features/platform/common/humanize/imperfect.go:43–95`  
**Transformation:** `ApplyToBody` rune-by-rune replacement of Czech diacritics (á→a, ř→r, etc.) at 70% base probability, declining to 30% by email end. Per-character independent → mixed-correct-and-degraded paragraphs.

**Evidence:**
- I4 sprint plan flagged as "EXPECTED FAIL — classic machine-translated spam fingerprint"
- I6 cumulative SAFE-profile test included diacritics at full 70% prob → 0/N delivery (silent failure post-I4 conclusion)
- Seznam ML trains on Czech corpus; a paragraph with stochastic diacritics loss (e.g., "vážený" → "vazeny" mid-sentence, others preserved) is a **definitive fingerprint of machine/translation tooling**, not human Czech writing

**Recommended SAFE-profile patch:**
- Disable diacritics degradation entirely in production (set `diacriticsBodyProb=1.0` or skip `ApplyToBody` call when Engine detects production mode)
- Alternative: reduce 70% → 10% and test in production (but low prob still leaves enough variance to trip ML detector)

### Rank 2: HTML Structure Churn (span injection + redundant divs)
**Files:**
- `features/platform/common/humanize/fingerprint.go:67–76` (per-line 30% span inject, fontSize ∈ {13,14,15})
- `features/platform/common/humanize/fingerprint.go:79–81` (20% redundant `<div>&nbsp;</div>` after empty lines)

**Transformation:** Every Engine send produces a new random HTML tree (same sender, same recipient, same day → different span-count and placement). Lists paragraphs with 30% wrapped in `<span style="font-size:Npx">`, odd `<div>&nbsp;</div>` orphans.

**Evidence:**
- I5 sprint tested span injection in isolation (multipart=true + spans_inject=true). Results inconclusive (mixed delivery rates across endpoints).
- Real webmail does emit messy HTML (empirically true), but **consistent per-send variance might trigger rate-based entropy checks** — if relay detects "10 different HTML shapes from one IP in 1 hour", that's a red flag even if each shape looks legitimate in isolation.
- `<div>&nbsp;</div>` orphans after empty lines are NOT standard Outlook/Gmail output; may be a false-signature of generated mail.

**Recommended SAFE-profile patch:**
- Keep static HTML structure (`<div style="font-family/font-size">…content…</div>`) — no per-line spans, no redundant divs
- Alternative: keep span injection but remove the 20% redundant-div logic (fingerprint.go:79–81)

### Rank 3: Display-Name Forced Composition (BuildFromHeader + titleCaseLocalPart)
**File:** `features/outreach/campaigns/sender/headers.go:87–164` (`BuildFromHeader`, `titleCaseLocalPart`)

**Transformation:** If mailbox config has no display_name, Engine derives one from the email local-part (e.g., "a.mazher" → "A. Mazher"). Final From header always includes display-name in quotes if needed.

**Evidence:**
- I1 isolated Message-ID HMAC format; no I-sprint tested From header variance independently
- Raw SMTP sends bare `From: sender@domain.cz` (no display-name). Engine forces `From: "A. Mazher" <sender@domain.cz>`.
- Display-name insertion is legitimate B2B mail pattern (most business senders include names), but **if all 300 sends from Railway have algorithmically-derived names, that's a fingerprint** — a human operator would either set them in the DB or omit them consistently, not generate them on-the-fly.
- Probabilistically low risk vs. diacritics (rank 2: HTML, rank 1: diacritics) — a single canonical display-name per mailbox is less entropy-leaking than 300 random HTML trees.

**Recommended SAFE-profile patch:**
- Require operators to set `outreach_mailboxes.display_name` explicitly; if unset, send bare email address (revert to raw_smtp_diag behavior)
- Alternative: accept empty display_name iff `SkipHumanize=true` in template (compliance/legal notices)

---

## 4. Verification Plan (No Production Sends)

### A. Unit-Test Validation
**Goal:** Confirm each killer candidate in isolation matches raw_smtp_diag baseline behavior.

1. **Diacritics:** Add `TestApplyToBodyNoDiacriticsDegrade` that wires `ImperfectEngine` with `diacriticsBodyProb=1.0` (no degradation). Render same body → compare byte output to raw_smtp_diag with `diacritics_degrade=false`.

2. **HTML spans:** Add `TestWrapBodyHTMLStatic` that modifies `FingerprintEngine.WrapBodyHTML` to omit per-line span injection and redundant divs. Render same body → compare to raw_smtp_diag with `multipart=true, spans_inject=false`.

3. **Display-Name:** Add `TestBuildFromHeaderNoDerive` that calls `BuildFromHeader` with explicit display_name (non-empty) and with empty string. Expect bare email when empty (or error, then patch to suppress the feature).

### B. Golden-File Diff Comparison
1. Run raw_smtp_diag with minimal flags (all false, body="Vážený klient") → capture MIME output.
2. Run engine.Run with analogous SendRequest → capture relay's received MIME (extract from relay logs, or add a diagnostic relay endpoint that echoes MIME).
3. `diff -u` the two MIME bodies. Expected differences:
   - `raw`: no humanize wrapper, plain `<p>Vážený klient</p>`
   - `engine` (baseline): `<html>…<div style="font-family:Arial">…<span style="font-size:14px;">Vážený klient</span>…</div>`
   - `engine` (SAFE patches #1–3 applied): `<html>…<div style="font-family:Arial">…Vazeny klient…</div>` (diacritics + spans off)

### C. Staged Rollout (if patches approved for production)
1. **Feature flag:** Add `SendingConfig.SafeProfileMIME` (bool) or wire via env `SAFE_PROFILE_MIME=1`.
2. **Canary:** Deploy with flag off (current production behavior). After stabilization, enable on 1 mailbox → send 10 test envelopes to seznam.cz → check delivery via raw API.
3. **If canary succeeds:** Gradually roll flag to 10% → 50% → 100% of campaigns; monitor bounce rate + complaint rate per domain.
4. **Revert:** If bounce rate rises >1% or complaints spike, flip flag off; investigate which killer candidate caused regression.

### D. Silent Failure Root Cause (post-I6)
Current mystery: I6 cumulative SAFE-profile test had all flags on (diacritics+humanize_light+multipart+spans_inject) and failed silently. Recommended investigation **outside this report's scope** but necessary for closure:

- Confirm the test actually invoked `applyDiacriticsDegrade` with prob=0.30 (check seed logging, not just flag presence)
- Add a unit test that calls `applyDiacriticsDegrade` on a known Czech string ("Vážený") and verifies degradation occurred (assert that not all runes are preserved)
- Trace the sender/relay handoff: did the relay receive the degraded body, or was it overwritten upstream?

---

## Summary Table

| Candidate | File:Line | Transformation | I-Sprint Test | Risk | Patch |
|---|---|---|---|---|---|
| **Diacritics (I4)** | humanize/imperfect.go:43–95 | 70% → 30% Czech char loss | I4 = FAIL (0/10) | **CRITICAL** | Disable or reduce to <5% prob |
| **HTML Spans** | humanize/fingerprint.go:67–81 | Random 30% per-line wrapping + orphan divs | I5 = mixed | **HIGH** | Static structure, no spans |
| **Display-Name** | sender/headers.go:87–164 | Derive from local-part if unset | none | **MEDIUM** | Require explicit DB value |

