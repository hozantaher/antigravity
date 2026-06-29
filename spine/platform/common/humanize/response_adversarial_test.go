package humanize

import (
	"strings"
	"testing"
)

// TestClassifyReply_NBSPEvasionRegression locks the fix for a real evasion
// vulnerability discovered 2026-04-27 during adversarial testing: a recipient
// typing "nemáme zájem" with a non-breaking space (U+00A0) between the two
// words — which Outlook/Word/macOS auto-typography produces — would silently
// skip the negative classifier and route to ReplyInterested (default fallback).
// Result: a clear opt-out generates a fake lead + sales notification.
//
// The fix: normaliseWhitespace() converts NBSP and other unicode whitespace
// to ASCII space before keyword lookup.
func TestClassifyReply_NBSPEvasionRegression(t *testing.T) {
	r := NewResponseEngine()

	cases := map[string]string{
		"NBSP":              "nemáme zájem",
		"narrow no-break":   "nemáme zájem",
		"figure space":      "nemáme zájem",
		"thin space":        "nemáme zájem",
		"zero-width space":  "nemáme​zájem",
		"BOM":               "nemáme" + "\ufeff" + "zájem",
		"tab":               "nemáme\tzájem",
		"NBSP in negative + greeting": "Dobrý den, nemáme zájem.",
		"NBSP in 'odhlásit'":          "prosím odhlásit",
		"NBSP in 'neposílejte'":       "neposí lejte mi nic", // edge: NBSP inside word — won't match keyword (deliberate)
	}

	for name, body := range cases {
		t.Run(name, func(t *testing.T) {
			got := r.ClassifyReply(body)
			// Last case: NBSP INSIDE a keyword token (neposí<NBSP>lejte) — we
			// only normalise whitespace TO regular space, we don't strip
			// embedded chars. So that one falls through to default Interested.
			// All others: must be Negative.
			if name == "NBSP in 'neposílejte'" {
				if got == ReplyNegative {
					t.Logf("(unexpected but acceptable: matched despite embedded NBSP)")
				}
				return
			}
			if got != ReplyNegative {
				t.Errorf("body=%q got=%v want=ReplyNegative — NBSP/whitespace evasion regression!", body, got)
			}
		})
	}
}

// TestClassifyReply_SingularNegativeRegression locks the fix for another bug:
// 1st-person singular Czech ("Nemám zájem", "Nezajímá mě") evaded the
// previously-plural-only "nemáme zájem" keyword. Singular is more common in
// individual B2B replies than plural.
func TestClassifyReply_SingularNegativeRegression(t *testing.T) {
	r := NewResponseEngine()

	cases := map[string]string{
		"singular nemám zájem":            "Nemám zájem.",
		"singular Nezajímá":               "Nezajímá mě to.",
		"nezajímá lowercase":              "nezajímá mě.",
		"nezájem (compact)":               "Nezájem.",
		"with greeting":                   "Dobrý den, nemám zájem o vaše služby.",
		"with negative + later":           "Nemám zájem teď, možná příště.",
	}

	for name, body := range cases {
		t.Run(name, func(t *testing.T) {
			got := r.ClassifyReply(body)
			if got != ReplyNegative {
				t.Errorf("body=%q got=%v want=ReplyNegative — singular form regression!", body, got)
			}
		})
	}
}

// TestClassifyReply_EnglishOOORegression locks the fix for English-language
// auto-replies. Recipients commonly use "I'm on vacation" / "out on annual
// leave" without "out of office", which previously fell through to default
// ReplyInterested → fake lead.
func TestClassifyReply_EnglishOOORegression(t *testing.T) {
	r := NewResponseEngine()

	cases := map[string]string{
		"vacation":               "I am on vacation until April 30.",
		"holiday":                "Currently on holiday, will respond on Monday.",
		"annual leave":           "I am on annual leave this week.",
		"auto-reply":             "This is an auto-reply: I'll be back next week.",
		"automatic reply":        "Automatic reply: limited email access.",
		"mixed Czech+English":    "Dobrý den, I'm on vacation, ozveme se po návratu.",
	}

	for name, body := range cases {
		t.Run(name, func(t *testing.T) {
			got := r.ClassifyReply(body)
			if got != ReplyAutoOOO {
				t.Errorf("body=%q got=%v want=ReplyAutoOOO — English OOO regression!", body, got)
			}
		})
	}
}

// TestClassifyReply_EnglishNegativeAdded — added "unsubscribe", "remove me",
// "not interested" English keywords. Pinning so a future refactor doesn't
// drop them.
func TestClassifyReply_EnglishNegativeAdded(t *testing.T) {
	r := NewResponseEngine()

	cases := []string{
		"Please unsubscribe me from this list.",
		"Remove me, please.",
		"I am not interested, thanks.",
		"Not interested in your offering.",
	}

	for _, c := range cases {
		t.Run(c, func(t *testing.T) {
			got := r.ClassifyReply(c)
			if got != ReplyNegative {
				t.Errorf("body=%q got=%v want=ReplyNegative", c, got)
			}
		})
	}
}

// TestNormaliseWhitespace_Preserves preserves regular text + only converts
// the listed whitespace variants. Critical: we must NOT strip ASCII spaces
// (would break keywords like "nemáme zájem") or alter non-whitespace chars.
func TestNormaliseWhitespace_Preserves(t *testing.T) {
	cases := map[string]string{
		"plain text unchanged":    "hello world",
		"czech diacritics intact": "žluťoučký kůň",
		"emoji intact":            "hello 👋 world",
		"newlines preserved":      "line1\nline2",
		"empty string":            "",
		"single ascii space":      " ",
		// Whitespace variants converted:
		"nbsp converted":      "a b",
		"thin converted":      "a b",
		"zwsp converted":      "a​b",
	}

	wantNormalised := map[string]string{
		"plain text unchanged":    "hello world",
		"czech diacritics intact": "žluťoučký kůň",
		"emoji intact":            "hello 👋 world",
		"newlines preserved":      "line1\nline2",
		"empty string":            "",
		"single ascii space":      " ",
		"nbsp converted":          "a b",
		"thin converted":          "a b",
		"zwsp converted":          "a b",
	}

	for name, in := range cases {
		t.Run(name, func(t *testing.T) {
			got := normaliseWhitespace(in)
			want := wantNormalised[name]
			if got != want {
				t.Errorf("normaliseWhitespace(%q) = %q, want %q", in, got, want)
			}
		})
	}
}

// TestClassifyReply_DoesNotPanicOnExtreme verifies the classifier never
// panics on extreme/adversarial inputs. Property-style.
func TestClassifyReply_DoesNotPanicOnExtreme(t *testing.T) {
	r := NewResponseEngine()

	inputs := []string{
		"",                                   // empty
		strings.Repeat("a", 1_000_000),       // 1 MB body
		"\x00\x00\x00",                       // null bytes
		"\xff\xfe\xfd",                       // invalid UTF-8 prefix
		"a\x00b nechci c\x00",                // null bytes interleaved
		strings.Repeat("nechci ", 100_000),   // many keyword repeats
	}

	for i, in := range inputs {
		func() {
			defer func() {
				if r := recover(); r != nil {
					t.Errorf("case %d: PANIC on input (len=%d): %v", i, len(in), r)
				}
			}()
			_ = r.ClassifyReply(in)
		}()
	}
}
