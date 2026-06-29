// Adversarial reply corpus tests (KT-B7).
//
// Goal: surface every NBSP / ZWSP / BOM / RTL-override / 8bit-non-UTF8 /
// quoted-printable-undecoded / base64-in-text-plain / DOCTYPE-script /
// nested-quote / RFC-2047-encoded-subject input that could panic the
// classifier or the MIME parser, or break the Normalize → Classification
// contract that downstream UI consumers rely on.
//
// Hard rules honoured (per task spec + memory `feedback_no_fabricated_test_data`):
//
//   - The .eml fixtures in testdata/adversarial/ are real-shape RFC822
//     messages. The adversarial bytes (NBSP/ZWSP/RTL/8-bit) are the
//     content under test, not fabricated business records.
//   - No DB is mocked here — the inbox/reply package's normaliser is
//     pure. Where MIME parsing is exercised we use orchestrator/mime
//     directly, again pure.
//
// Scope (matches KT-B7 issue #316 acceptance ≥10 cases):
//
//  1. Whitespace variants — NBSP (U+00A0), em space (U+2003), narrow
//     no-break (U+202F), zero-width space (U+200B).
//  2. RTL / Bidi — Hebrew + Arabic mid-message + RTL override (U+202E).
//  3. Encoding edges — 8-bit non-UTF8 bytes (latin-2 + invalid prefix),
//     leading BOM in body and subject.
//  4. Email artefacts — quoted-printable not decoded by upstream,
//     base64 in text/plain.
//  5. Long content — 1MB body (synthetic — see Test 5 inline note).
//  6. HTML edges — unclosed tags, nested DOCTYPE, <script>, @import.
//  7. Empty paths — empty body, only-whitespace, only-signature.
//  8. Auto-reply — Out-of-Office (X-Auto-Response-Suppress / X-Autoreply).
//  9. Reply chain — 50+ levels of "> " quote nesting.
//
// 10. Subject edges — empty, 1000-char, RFC 2047 encoded-word mix.
//
// Plus property-style guards:
//   - 1000 random inputs in <10s — bounds the worst-case classify cost.
//   - io.LimitReader on 10 MB body — proves the parser respects upstream
//     IMAP size cap (mail-client S1.2 maxMailSizeBytes).
//   - Normalize never panics on raw byte garbage.
//   - Classifier output ∈ ValidClasses ∪ {ClassUnknown} for every input.
package reply

import (
	"bytes"
	"io"
	"math/rand"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"common/humanize"
	"orchestrator/mime"
)

// ── corpus loader ────────────────────────────────────────────────────────

// loadCorpus reads every *.eml in testdata/adversarial. The fixtures are
// stored on disk with LF line endings for editor sanity; we rewrite to
// CRLF on load so the parser sees what a real IMAP server would deliver.
//
// Returns the fixture name → raw bytes mapping.
func loadCorpus(t *testing.T) map[string][]byte {
	t.Helper()
	dir := filepath.Join("testdata", "adversarial")
	entries, err := os.ReadDir(dir)
	if err != nil {
		t.Fatalf("read corpus dir %s: %v", dir, err)
	}
	out := make(map[string][]byte, len(entries))
	for _, e := range entries {
		if e.IsDir() || !strings.HasSuffix(e.Name(), ".eml") {
			continue
		}
		raw, err := os.ReadFile(filepath.Join(dir, e.Name()))
		if err != nil {
			t.Fatalf("read fixture %s: %v", e.Name(), err)
		}
		out[e.Name()] = bytes.ReplaceAll(raw, []byte("\n"), []byte("\r\n"))
	}
	if len(out) < 10 {
		t.Fatalf("KT-B7 contract: corpus must have ≥10 fixtures, got %d", len(out))
	}
	return out
}

// ── Test 1: corpus parse smoke — every fixture must parse without panic ─

// Each fixture round-trips through orchestrator/mime.Parse without
// panicking. Errors are tolerated (the parser is conservative — it
// returns a partial *ParsedMessage + error on malformed input). What we
// catch here is panics, which would crash the IMAP poller goroutine.
func TestAdversarial_CorpusParsesWithoutPanic(t *testing.T) {
	corpus := loadCorpus(t)
	for name, raw := range corpus {
		t.Run(name, func(t *testing.T) {
			defer func() {
				if r := recover(); r != nil {
					t.Fatalf("PANIC parsing %s: %v\n--- raw ---\n%s", name, r, hexHead(raw, 256))
				}
			}()
			parsed, err := mime.Parse(raw)
			// Partial result is acceptable; a nil parsed with no body is
			// only acceptable when err != nil.
			if parsed == nil && err == nil {
				t.Fatalf("%s: nil parsed without error", name)
			}
		})
	}
}

// ── Test 2: classifier survives every adversarial body ─────────────────

// For each fixture, parse → classify body → verify the verdict is one
// of the closed humanize.ReplyType set. The exact label is not asserted
// (some adversarial inputs are deliberately ambiguous); we lock the
// invariant that the classifier never produces an out-of-band value
// and never panics.
func TestAdversarial_ClassifierReturnsValidCategory(t *testing.T) {
	corpus := loadCorpus(t)
	r := humanize.NewResponseEngine()

	for name, raw := range corpus {
		t.Run(name, func(t *testing.T) {
			parsed, _ := mime.Parse(raw)
			body := ""
			if parsed != nil {
				body = parsed.BodyPlain
				if body == "" {
					body = parsed.BodyHTML
				}
			}

			defer func() {
				if r := recover(); r != nil {
					t.Fatalf("PANIC classifying %s: %v", name, r)
				}
			}()
			rt := r.ClassifyReply(body)
			if !validReplyType(rt) {
				t.Fatalf("%s: classifier returned out-of-band ReplyType=%v", name, rt)
			}
		})
	}
}

// ── Test 3: Normalize survives raw adversarial bytes ───────────────────

// The reply.Normalize function is the LLM-output sanitiser. It takes
// arbitrary strings (including LLM hallucinations) and maps them to
// the closed Classification enum. Every adversarial fixture body is
// also a valid input here — Normalize must never panic and must always
// return a member of ValidClasses ∪ {ClassUnknown}.
func TestAdversarial_NormalizeOnCorpusBodies(t *testing.T) {
	corpus := loadCorpus(t)
	for name, raw := range corpus {
		t.Run(name, func(t *testing.T) {
			parsed, _ := mime.Parse(raw)
			body := ""
			if parsed != nil {
				body = parsed.BodyPlain + parsed.BodyHTML
			}
			// Also stress-test with the raw bytes — Normalize must
			// tolerate non-UTF-8, NUL bytes, etc.
			inputs := []string{body, string(raw)}
			for _, in := range inputs {
				defer func() {
					if r := recover(); r != nil {
						t.Fatalf("PANIC normalising %s: %v", name, r)
					}
				}()
				got := Normalize(in)
				if !ValidClasses[got] && got != ClassUnknown {
					t.Fatalf("%s: Normalize produced out-of-enum %q", name, got)
				}
			}
		})
	}
}

// ── Test 4: Normalize is deterministic on every corpus body ────────────

// Two calls on the same input must yield the same Classification. This
// pins the deterministic-classification contract documented in
// services/inbox/CLAUDE.md ("same body → same label").
func TestAdversarial_NormalizeDeterministic(t *testing.T) {
	corpus := loadCorpus(t)
	for name, raw := range corpus {
		t.Run(name, func(t *testing.T) {
			parsed, _ := mime.Parse(raw)
			body := ""
			if parsed != nil {
				body = parsed.BodyPlain
			}
			a := Normalize(body)
			b := Normalize(body)
			if a != b {
				t.Fatalf("%s: Normalize non-deterministic: %q vs %q", name, a, b)
			}
		})
	}
}

// ── Test 5: 1MB body — classifier completes well under timeout ─────────

// Synthetic 1MB body (per task spec). This is *not* fabricated business
// content per the no-fabricated-test-data rule — it's a stress payload
// whose only purpose is to bound the classifier's worst-case cost.
//
// Acceptance: 1MB classify finishes in under 2 seconds on a developer
// machine. Slack budget so CI fluctuation doesn't flake.
func TestAdversarial_OneMBBodyIsBounded(t *testing.T) {
	body := strings.Repeat("nemáme zájem o vaši nabídku. ", 1<<15) // ~1MB UTF-8
	if len(body) < 1_000_000 {
		t.Fatalf("test setup: want ≥1MB, got %d", len(body))
	}
	r := humanize.NewResponseEngine()
	start := time.Now()
	rt := r.ClassifyReply(body)
	elapsed := time.Since(start)
	if elapsed > 2*time.Second {
		t.Fatalf("classify of 1MB body took %v, want <2s", elapsed)
	}
	if !validReplyType(rt) {
		t.Fatalf("1MB body classified as out-of-band %v", rt)
	}
}

// ── Test 6: 1000 random inputs in <10 seconds ──────────────────────────

// Property-style: classify 1000 deterministically-seeded random byte
// strings, each up to 4KB. Must complete in <10s and never panic.
// Fixed seed → deterministic CI behaviour.
func TestAdversarial_ThousandRandomInputs(t *testing.T) {
	const N = 1000
	rng := rand.New(rand.NewSource(42))
	r := humanize.NewResponseEngine()

	start := time.Now()
	for i := 0; i < N; i++ {
		size := rng.Intn(4096) + 1
		buf := make([]byte, size)
		if _, err := rng.Read(buf); err != nil {
			t.Fatalf("rng read: %v", err)
		}
		func() {
			defer func() {
				if rec := recover(); rec != nil {
					t.Fatalf("panic on random input #%d (len=%d): %v", i, size, rec)
				}
			}()
			rt := r.ClassifyReply(string(buf))
			if !validReplyType(rt) {
				t.Fatalf("random input #%d → out-of-band ReplyType=%v", i, rt)
			}
			_ = Normalize(string(buf))
		}()
	}
	elapsed := time.Since(start)
	if elapsed > 10*time.Second {
		t.Fatalf("%d random classifications took %v, want <10s", N, elapsed)
	}
}

// ── Test 7: io.LimitReader caps a 10MB body ────────────────────────────

// Verifies that wrapping a huge byte stream in io.LimitReader (the
// pattern the IMAP poller uses via maxMailSizeBytes) reads exactly the
// configured cap without OOM and that mime.Parse on the truncated
// bytes still returns without panic. This pins the upstream defence
// against a malicious sender flooding the parser.
func TestAdversarial_LimitReaderCapsTenMB(t *testing.T) {
	const cap10MB = 10 * 1024 * 1024
	huge := bytes.Repeat([]byte("A"), 20*1024*1024)
	header := []byte("From: a@b\r\nSubject: x\r\nMessage-ID: <huge@x>\r\n" +
		"Content-Type: text/plain\r\n\r\n")
	stream := io.MultiReader(bytes.NewReader(header), bytes.NewReader(huge))
	limited := io.LimitReader(stream, cap10MB)

	got, err := io.ReadAll(limited)
	if err != nil {
		t.Fatalf("read capped stream: %v", err)
	}
	if len(got) != cap10MB {
		t.Fatalf("LimitReader cap broken: got %d bytes, want %d", len(got), cap10MB)
	}

	defer func() {
		if r := recover(); r != nil {
			t.Fatalf("PANIC parsing 10MB capped stream: %v", r)
		}
	}()
	parsed, _ := mime.Parse(got)
	// We don't care what fields were populated — just that the parser
	// didn't panic and returned something.
	_ = parsed
}

// ── Test 8: Normalize preserves Classification round-trip ──────────────

// For every member of the closed enum, Normalize(string(c)) == c.
// This locks the contract that Normalize is the identity on its image
// — a regression here would silently drop categories from the dashboard.
func TestAdversarial_NormalizeRoundTripOnEnum(t *testing.T) {
	for c := range ValidClasses {
		got := Normalize(string(c))
		if got != c {
			t.Fatalf("round-trip broken: Normalize(%q) = %q", c, got)
		}
	}
	// And ClassUnknown is the documented fallback for arbitrary input.
	for _, in := range []string{"", " ", "POSITIVE", "yes", "\x00", "\xff\xfe"} {
		if Normalize(in) != ClassUnknown {
			t.Fatalf("Normalize(%q) should be ClassUnknown", in)
		}
	}
}

// ── Test 9: per-fixture targeted assertions ────────────────────────────

// Locks specific known-good behaviour that the corpus was designed to
// verify. Anything that fails here means a real-world adversarial input
// has regressed the classifier.
func TestAdversarial_FixtureSpecificBehaviour(t *testing.T) {
	corpus := loadCorpus(t)
	r := humanize.NewResponseEngine()

	cases := []struct {
		fixture string
		check   func(t *testing.T, parsed *mime.ParsedMessage, rt humanize.ReplyType)
	}{
		{
			fixture: "whitespace-variants.eml",
			check: func(t *testing.T, parsed *mime.ParsedMessage, rt humanize.ReplyType) {
				// All whitespace-variant lines spell "nemáme zájem" with
				// adversarial separators. After whitespace normalisation
				// the keyword classifier MUST flag this as Negative.
				// Regression in normaliseWhitespace would surface here.
				if rt != humanize.ReplyNegative {
					t.Fatalf("NBSP/ZWSP/em-space evasion regression: rt=%v body=%q", rt, parsed.BodyPlain)
				}
			},
		},
		{
			fixture: "out-of-office.eml",
			check: func(t *testing.T, parsed *mime.ParsedMessage, rt humanize.ReplyType) {
				if rt != humanize.ReplyAutoOOO {
					t.Fatalf("OOO header+body misclassified as %v", rt)
				}
			},
		},
		{
			fixture: "rtl-bidi.eml",
			check: func(t *testing.T, parsed *mime.ParsedMessage, rt humanize.ReplyType) {
				// Body contains "Not interested." — must classify as
				// negative regardless of the Hebrew/Arabic/RTL noise.
				if rt != humanize.ReplyNegative {
					t.Fatalf("RTL bidi prefix broke negative detection: rt=%v", rt)
				}
			},
		},
		{
			fixture: "deep-quote-chain.eml",
			check: func(t *testing.T, parsed *mime.ParsedMessage, rt humanize.ReplyType) {
				// 55-level quote chain. Classifier must complete + return
				// a valid value; we don't pin the exact label.
				if !validReplyType(rt) {
					t.Fatalf("deep quote produced invalid rt=%v", rt)
				}
			},
		},
		{
			fixture: "html-edge.eml",
			check: func(t *testing.T, parsed *mime.ParsedMessage, rt humanize.ReplyType) {
				// HTML body with <script>, @import, nested DOCTYPE,
				// unclosed tags. Parser must not panic; classifier
				// must stay in the closed set. Sanitisation is a
				// separate sprint (S1.4 bluemonday) — not in scope here.
				if !validReplyType(rt) {
					t.Fatalf("html-edge produced invalid rt=%v", rt)
				}
			},
		},
		{
			fixture: "long-subject.eml",
			check: func(t *testing.T, parsed *mime.ParsedMessage, rt humanize.ReplyType) {
				if got := parsed.Headers.Get("Subject"); len(got) < 1000 {
					t.Fatalf("long subject truncated: len=%d", len(got))
				}
			},
		},
		{
			fixture: "empty-subject.eml",
			check: func(t *testing.T, parsed *mime.ParsedMessage, rt humanize.ReplyType) {
				if got := parsed.Headers.Get("Subject"); got != "" {
					t.Fatalf("empty subject lost emptiness: %q", got)
				}
			},
		},
		{
			fixture: "rfc2047-encoded-subject.eml",
			check: func(t *testing.T, parsed *mime.ParsedMessage, rt humanize.ReplyType) {
				// Headers.Get returns the raw =?utf-8?B?...?= form. The
				// parser does NOT decode subject — only filename params
				// (decodeRFC2047 in mime/parser.go). Lock that contract:
				// callers that want a decoded subject must call
				// stdmime.WordDecoder explicitly.
				got := parsed.Headers.Get("Subject")
				if !strings.Contains(got, "=?utf-8?B?") {
					t.Fatalf("subject contract drift: %q", got)
				}
			},
		},
	}

	for _, c := range cases {
		t.Run(c.fixture, func(t *testing.T) {
			raw, ok := corpus[c.fixture]
			if !ok {
				t.Fatalf("missing fixture %s", c.fixture)
			}
			parsed, err := mime.Parse(raw)
			if err != nil && parsed == nil {
				t.Fatalf("parse %s: %v", c.fixture, err)
			}
			body := ""
			if parsed != nil {
				body = parsed.BodyPlain
				if body == "" {
					body = parsed.BodyHTML
				}
			}
			rt := r.ClassifyReply(body)
			c.check(t, parsed, rt)
		})
	}
}

// ── Test 10: Message-ID + thread-anchor preservation through parse ─────

// Per task spec: "Normalizer preserves message ID + thread ID". The
// inbox/reply Normalize doesn't touch Message-ID — that lives in the
// MIME parser headers. This test verifies the headers survive the
// parse path for every fixture, which is the upstream pre-condition
// for thread.matchToThread (services/orchestrator/thread/inbound.go).
func TestAdversarial_MessageIDPreservedThroughParse(t *testing.T) {
	corpus := loadCorpus(t)
	for name, raw := range corpus {
		t.Run(name, func(t *testing.T) {
			parsed, err := mime.Parse(raw)
			if err != nil && parsed == nil {
				t.Fatalf("parse %s: %v", name, err)
			}
			if parsed == nil {
				t.Fatalf("nil parsed for %s", name)
			}
			id := parsed.Headers.Get("Message-ID")
			if id == "" {
				t.Fatalf("%s: Message-ID lost through parse", name)
			}
			if !strings.Contains(id, "@") {
				t.Fatalf("%s: malformed Message-ID %q", name, id)
			}
		})
	}
}

// ── Test 11: random parse fuzz for 30s budget, no panic ────────────────

// Mutates each fixture by flipping random bytes and re-parses. Bounded
// budget (200 mutations) — any panic surfaces immediately. Catches
// e.g. mime.ParseMediaType on a Content-Type header where bit-flip
// corrupted the boundary parameter.
func TestAdversarial_BitFlipMutationsNoPanic(t *testing.T) {
	corpus := loadCorpus(t)
	rng := rand.New(rand.NewSource(7))

	for name, raw := range corpus {
		t.Run(name, func(t *testing.T) {
			for i := 0; i < 200; i++ {
				mutated := append([]byte(nil), raw...)
				if len(mutated) == 0 {
					continue
				}
				idx := rng.Intn(len(mutated))
				mutated[idx] ^= byte(rng.Intn(256))
				func() {
					defer func() {
						if r := recover(); r != nil {
							t.Fatalf("panic on %s mutation #%d at byte %d: %v",
								name, i, idx, r)
						}
					}()
					_, _ = mime.Parse(mutated)
				}()
			}
		})
	}
}

// ── helpers ────────────────────────────────────────────────────────────

// validReplyType returns true iff rt is a member of the closed
// humanize.ReplyType enum used by the inbound processor.
func validReplyType(rt humanize.ReplyType) bool {
	switch rt {
	case humanize.ReplyInterested,
		humanize.ReplyMeeting,
		humanize.ReplyLater,
		humanize.ReplyObjection,
		humanize.ReplyNegative,
		humanize.ReplyAutoOOO:
		return true
	}
	return false
}

// hexHead returns at most n bytes of b as a hex+printable preview, for
// failure messages on opaque adversarial input.
func hexHead(b []byte, n int) string {
	if len(b) > n {
		b = b[:n]
	}
	var sb strings.Builder
	for _, by := range b {
		if by >= 0x20 && by < 0x7f {
			sb.WriteByte(by)
		} else {
			sb.WriteString(".")
		}
	}
	return sb.String()
}
