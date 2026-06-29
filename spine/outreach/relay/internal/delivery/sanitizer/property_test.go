package sanitizer

import (
	"relay/internal/model"
	"strings"
	"testing"
	"testing/quick"
	"unicode/utf8"
)

// ---------------------------------------------------------------------------
// Property: SanitizeIntake never panics on arbitrary input
// ---------------------------------------------------------------------------

func TestSanitizeIntake_NeverPanics_Property(t *testing.T) {
	svc := NewService()
	f := func(subject, body string) bool {
		defer func() { recover() }()
		svc.SanitizeIntake(model.IntakeRequest{Subject: subject, Body: body})
		return true
	}
	if err := quick.Check(f, &quick.Config{MaxCount: 500}); err != nil {
		t.Error(err)
	}
}

// ---------------------------------------------------------------------------
// Property: NormalizedSubject length ≤ original subject length (whitespace can only shrink)
// ---------------------------------------------------------------------------

func TestSanitizeIntake_SubjectNeverGrows_Property(t *testing.T) {
	svc := NewService()
	f := func(subject string) bool {
		result := svc.SanitizeIntake(model.IntakeRequest{Subject: subject, Body: "x"})
		return len(result.NormalizedSubject) <= len(subject)
	}
	if err := quick.Check(f, &quick.Config{MaxCount: 500}); err != nil {
		t.Error(err)
	}
}

// ---------------------------------------------------------------------------
// Property: NormalizedBody length ≤ original body length
// ---------------------------------------------------------------------------

func TestSanitizeIntake_BodyNeverGrows_Property(t *testing.T) {
	svc := NewService()
	f := func(body string) bool {
		result := svc.SanitizeIntake(model.IntakeRequest{Subject: "x", Body: body})
		return len(result.NormalizedBody) <= len(body)
	}
	if err := quick.Check(f, &quick.Config{MaxCount: 500}); err != nil {
		t.Error(err)
	}
}

// ---------------------------------------------------------------------------
// Property: Idempotency — sanitizing twice yields the same result as once
// ---------------------------------------------------------------------------

func TestSanitizeIntake_Idempotent_Property(t *testing.T) {
	svc := NewService()
	f := func(subject, body string) bool {
		first := svc.SanitizeIntake(model.IntakeRequest{Subject: subject, Body: body})
		second := svc.SanitizeIntake(model.IntakeRequest{
			Subject: first.NormalizedSubject,
			Body:    first.NormalizedBody,
		})
		return second.NormalizedSubject == first.NormalizedSubject &&
			second.NormalizedBody == first.NormalizedBody &&
			second.Status == first.Status
	}
	if err := quick.Check(f, &quick.Config{MaxCount: 300}); err != nil {
		t.Error(err)
	}
}

// ---------------------------------------------------------------------------
// Property: NormalizedSubject and NormalizedBody are always valid UTF-8
// ---------------------------------------------------------------------------

func TestSanitizeIntake_OutputAlwaysValidUTF8_Property(t *testing.T) {
	svc := NewService()
	f := func(subject, body string) bool {
		result := svc.SanitizeIntake(model.IntakeRequest{Subject: subject, Body: body})
		return utf8.ValidString(result.NormalizedSubject) &&
			utf8.ValidString(result.NormalizedBody)
	}
	if err := quick.Check(f, &quick.Config{MaxCount: 500}); err != nil {
		t.Error(err)
	}
}

// ---------------------------------------------------------------------------
// Property: Status is always one of the known enum values
// ---------------------------------------------------------------------------

func TestSanitizeIntake_StatusAlwaysKnown_Property(t *testing.T) {
	svc := NewService()
	validStatuses := map[string]bool{"clean": true, "blocked": true, "empty": true}
	f := func(subject, body string) bool {
		result := svc.SanitizeIntake(model.IntakeRequest{Subject: subject, Body: body})
		return validStatuses[result.Status]
	}
	if err := quick.Check(f, &quick.Config{MaxCount: 500}); err != nil {
		t.Error(err)
	}
}

// ---------------------------------------------------------------------------
// Property: HasBlockedContent=true implies Status="blocked"
// ---------------------------------------------------------------------------

func TestSanitizeIntake_BlockedContentImpliesStatus_Property(t *testing.T) {
	svc := NewService()
	f := func(subject, body string) bool {
		result := svc.SanitizeIntake(model.IntakeRequest{Subject: subject, Body: body})
		if result.HasBlockedContent {
			return result.Status == "blocked"
		}
		return true
	}
	if err := quick.Check(f, &quick.Config{MaxCount: 500}); err != nil {
		t.Error(err)
	}
}

// ---------------------------------------------------------------------------
// Property: NormalizedBody contains no leading/trailing whitespace
// ---------------------------------------------------------------------------

func TestSanitizeIntake_NoLeadingTrailingWhitespace_Property(t *testing.T) {
	svc := NewService()
	f := func(body string) bool {
		result := svc.SanitizeIntake(model.IntakeRequest{Subject: "x", Body: body})
		s := result.NormalizedBody
		return s == strings.TrimSpace(s)
	}
	if err := quick.Check(f, &quick.Config{MaxCount: 500}); err != nil {
		t.Error(err)
	}
}

// ---------------------------------------------------------------------------
// Monkey: empty inputs → Status="empty", empty outputs
// ---------------------------------------------------------------------------

func TestSanitizeIntake_EmptyBoth_StatusEmpty(t *testing.T) {
	svc := NewService()
	result := svc.SanitizeIntake(model.IntakeRequest{Subject: "", Body: ""})
	if result.Status != "empty" {
		t.Fatalf("expected empty, got %q", result.Status)
	}
	if result.NormalizedSubject != "" {
		t.Fatalf("expected empty subject, got %q", result.NormalizedSubject)
	}
	if result.NormalizedBody != "" {
		t.Fatalf("expected empty body, got %q", result.NormalizedBody)
	}
}

// ---------------------------------------------------------------------------
// Monkey: whitespace-only inputs collapse to empty → Status="empty"
// ---------------------------------------------------------------------------

func TestSanitizeIntake_WhitespaceOnly_StatusEmpty(t *testing.T) {
	svc := NewService()
	for _, ws := range []string{"   ", "\t\t", "\n\n\n", "  \t  \n  "} {
		result := svc.SanitizeIntake(model.IntakeRequest{Subject: ws, Body: ws})
		if result.Status != "empty" {
			t.Fatalf("whitespace %q: expected empty, got %q", ws, result.Status)
		}
	}
}

// ---------------------------------------------------------------------------
// Monkey: javascript: URI triggers blocked
// ---------------------------------------------------------------------------

func TestSanitizeIntake_JavascriptURI_Blocked(t *testing.T) {
	svc := NewService()
	result := svc.SanitizeIntake(model.IntakeRequest{
		Subject: "click",
		Body:    "javascript:alert(1)",
	})
	if result.Status != "blocked" {
		t.Fatalf("expected blocked, got %q", result.Status)
	}
}

// ---------------------------------------------------------------------------
// Monkey: data:text/html URI triggers blocked
// ---------------------------------------------------------------------------

func TestSanitizeIntake_DataTextHTML_Blocked(t *testing.T) {
	svc := NewService()
	result := svc.SanitizeIntake(model.IntakeRequest{
		Subject: "test",
		Body:    "data:text/html,<h1>pwned</h1>",
	})
	if result.Status != "blocked" {
		t.Fatalf("expected blocked, got %q", result.Status)
	}
}

// ---------------------------------------------------------------------------
// Monkey: control characters are stripped from output
// ---------------------------------------------------------------------------

func TestSanitizeIntake_ControlCharsStripped(t *testing.T) {
	svc := NewService()
	// \x00–\x1F excluding \t (0x09) and \n (0x0A) should be stripped
	body := "hello\x00\x01\x02world"
	result := svc.SanitizeIntake(model.IntakeRequest{Subject: "x", Body: body})
	for _, r := range result.NormalizedBody {
		if r < 32 && r != '\n' && r != '\t' {
			t.Fatalf("control char U+%04X found in normalized body", r)
		}
	}
}

// ---------------------------------------------------------------------------
// StripHeaders: property — output never contains more keys than input
// ---------------------------------------------------------------------------

func TestStripHeaders_NeverGrows_Property(t *testing.T) {
	svc := NewService()
	f := func(keys []string) bool {
		headers := make(map[string]string, len(keys))
		for _, k := range keys {
			headers[k] = "value"
		}
		clean := svc.StripHeaders(headers)
		return len(clean) <= len(headers)
	}
	if err := quick.Check(f, &quick.Config{MaxCount: 300}); err != nil {
		t.Error(err)
	}
}

// ---------------------------------------------------------------------------
// StripHeaders: nil input → empty result (no panic)
// ---------------------------------------------------------------------------

func TestStripHeaders_NilInput_NoPanic(t *testing.T) {
	svc := NewService()
	result := svc.StripHeaders(nil)
	if result == nil {
		t.Fatal("expected non-nil map")
	}
	if len(result) != 0 {
		t.Fatalf("expected empty map, got %d entries", len(result))
	}
}

// ---------------------------------------------------------------------------
// Tracking Patterns: containsTrackingPatterns and stripTrackingPatterns
// ---------------------------------------------------------------------------

// Monkey: Pixel tracking patterns detected
func TestContainsTrackingPatterns_PixelTag(t *testing.T) {
	cases := []struct {
		name string
		body string
		want bool
	}{
		{"img 1x1", "<img src=\"http://tracker.com/1x1.gif\">", true},
		{"pixel.gif", "<img src='http://mail.com/pixel.gif'>", true},
		{"track.gif", "<img src=\"http://xyz/track.gif\">", true},
		{"plain text no match", "hello world", false},
		{"utm_source param", "http://example.com?utm_source=email", true},
		{"utm_medium param", "http://example.com?utm_medium=newsletter", true},
		{"utm_campaign param", "http://example.com?utm_campaign=spring", true},
		{"click subdomain", "https://click.tracker.io/open", true},
		{"open.track subdomain", "https://open.track.io/email", true},
		{"beacon pattern", "https://beacon.com/track?id=123", true},
		{"empty string", "", false},
		{"case insensitive", "<IMG SRC=\"HTTP://TRACKER.COM/1X1.GIF\">", true},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			got := containsTrackingPatterns(tc.body)
			if got != tc.want {
				t.Fatalf("body=%q: got %v, want %v", tc.body, got, tc.want)
			}
		})
	}
}

// Property: stripTrackingPatterns output contains no HTML tags
func TestStripTrackingPatterns_NoHTMLTags_Property(t *testing.T) {
	f := func(body string) bool {
		result := stripTrackingPatterns(body)
		// Check for angle brackets indicating HTML tags
		return !strings.Contains(result, "<") && !strings.Contains(result, ">")
	}
	if err := quick.Check(f, &quick.Config{MaxCount: 300}); err != nil {
		t.Error(err)
	}
}

// Monkey: SanitizeIntake with HTML tracking removes and notes "html_stripped"
// (HTML is stripped before tracking pattern detection, so <img> tags are gone
// before containsTrackingPatterns sees them)
func TestSanitizeIntake_HTMLStripppedBeforeTracking(t *testing.T) {
	svc := NewService()
	result := svc.SanitizeIntake(model.IntakeRequest{
		Subject: "test",
		Body:    "Email <img src='http://track/pixel.gif'> opened",
	})
	// HTML is detected and stripped, so we get "html_stripped" note
	found := false
	for _, note := range result.Notes {
		if note == "html_stripped" {
			found = true
			break
		}
	}
	if !found {
		t.Fatalf("expected html_stripped note in %v", result.Notes)
	}
}

// Monkey: SanitizeIntake with non-HTML tracking patterns (utm, beacon, click)
// These are NOT inside HTML tags, so they pass HTML check and reach containsTrackingPatterns
func TestSanitizeIntake_TrackingPatternsDetected(t *testing.T) {
	svc := NewService()
	cases := []struct {
		name      string
		body      string
		wantNote  string
	}{
		{
			"utm_source param",
			"Visit http://example.com?utm_source=email&utm_medium=news",
			"tracking_patterns_removed",
		},
		{
			"beacon URL",
			"tracked https://beacon.io/track?id=123",
			"tracking_patterns_removed",
		},
		{
			"click subdomain",
			"https://click.tracker.io/open",
			"tracking_patterns_removed",
		},
		{
			"open.track subdomain",
			"sent via https://open.track.io/",
			"tracking_patterns_removed",
		},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			result := svc.SanitizeIntake(model.IntakeRequest{
				Subject: "test",
				Body:    tc.body,
			})
			found := false
			for _, note := range result.Notes {
				if note == tc.wantNote {
					found = true
					break
				}
			}
			if !found {
				t.Fatalf("expected note %q in %v", tc.wantNote, result.Notes)
			}
		})
	}
}

// Monkey: stripTrackingPatterns (called after HTML stripping)
// It removes HTML tags that may have slipped through or already been processed.
func TestStripTrackingPatterns_RemovesHTMLTags(t *testing.T) {
	cases := []struct {
		name    string
		input   string
		mustBe  string // exact content after stripping
	}{
		{
			"img tag removed, text preserved",
			"Start <img src='http://pixel.gif'> end",
			"Start  end",
		},
		{
			"multiple tag removal",
			"A<div>B</div>C",
			"ABC",
		},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			result := stripTrackingPatterns(tc.input)
			if result != tc.mustBe {
				t.Fatalf("stripTrackingPatterns(%q) = %q, want %q", tc.input, result, tc.mustBe)
			}
		})
	}
}
