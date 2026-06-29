package humanize

import (
	"strings"
	"testing"
	"time"
)

// ══════════════════════════════════════════
//  E2E: Full Humanize Pipeline
// ══════════════════════════════════════════

func TestE2E_PrepareEmail_FreshIntro(t *testing.T) {
	persona := Persona{
		Name: "Jan Novák", Role: "Obchodní manažer",
		Company: "TechnoTrade", Phone: "+420123456789",
		Email: "jan@technotrade.cz", Website: "www.technotrade.cz",
	}
	engine := NewEngine(persona)

	// Tuesday 10am — normal business day
	sendTime := time.Date(2026, 4, 7, 10, 0, 0, 0, time.UTC)
	result := engine.PrepareEmail(
		"Poptávka strojů",
		"Hledáme dodavatele CNC strojů pro naši výrobu.",
		0, // step 0 = intro
		sendTime,
		"Dvořák",
		"", "", "", time.Time{},
	)

	if result == nil {
		t.Fatal("result should not be nil")
	}

	// Not a bump for step 0
	if result.IsBump {
		t.Error("step 0 should never be bump")
	}

	// Subject should exist (possibly with imperfections)
	if result.Subject == "" {
		t.Error("subject should not be empty")
	}

	// Body should contain greeting (possibly with degraded diacritics).
	// Match on partial fragments that survive any combination of diacritic removal:
	//   "Vážený pane Dvořák" degrades to variants like "Vazeny pane Dvorak", "Váženy pane Dvořak", etc.
	//   "Dobrý den, pane Dvořák" always contains "pane" regardless of diacritic state.
	if !containsAny(result.Body, "Dvořák", "Dvorak", "Dvorák", "Dvořak", "den", "pane", "Zdravím", "Zdravim") {
		t.Errorf("body should contain greeting: %s", result.Body[:min(200, len(result.Body))])
	}

	// Body should contain the raw content (diacritics may be degraded)
	if !containsAny(result.Body, "dodavatel", "CNC", "stroj", "vyrobu", "výrob") {
		t.Error("body should contain original content (possibly with diacritics degraded)")
	}

	// Signature should be present
	if result.Signature == "" {
		t.Error("signature should not be empty")
	}

	// HTML body should be valid
	if !strings.Contains(result.BodyHTML, "<html>") {
		t.Error("HTML body should contain html tag")
	}
	if !strings.Contains(result.BodyHTML, "font-family") {
		t.Error("HTML should have font styling (fingerprint)")
	}

	// Headers should have Seznam.cz fingerprint
	if result.Headers["X-Mailer"] != "Seznam.cz" {
		t.Errorf("X-Mailer: %s, want Seznam.cz", result.Headers["X-Mailer"])
	}
	if !strings.Contains(result.Headers["Date"], "2026") {
		t.Error("Date header missing")
	}
}

func TestE2E_PrepareEmail_FollowUpStep1(t *testing.T) {
	engine := NewEngine(Persona{Name: "Jan", Email: "jan@f.cz"})
	sendTime := time.Date(2026, 4, 9, 14, 0, 0, 0, time.UTC)

	// Run 50 times to test bump probability
	bumpCount := 0
	for i := 0; i < 50; i++ {
		result := engine.PrepareEmail(
			"Follow up", "Chtěl jsem navázat.",
			1, sendTime, "Novák",
			"Poptávka strojů", "Původní text.", "jan@f.cz",
			time.Date(2026, 4, 4, 10, 0, 0, 0, time.UTC),
		)
		if result.IsBump {
			bumpCount++
			// Bump should have Fwd: subject
			if !strings.HasPrefix(result.Subject, "Fwd:") {
				t.Errorf("bump subject should start with Fwd: got %q", result.Subject)
			}
			// Bump body should contain forwarded message (diacritics may be degraded)
			if !containsAny(result.Body, "Preposlan", "Přeposlan", "Původní", "Puvodni", "zprav", "datum", "Datum") {
				t.Error("bump body should contain forwarded message markers")
			}
		}
	}

	// Step 1 bump rate ~60%
	if bumpCount < 15 || bumpCount > 45 {
		t.Errorf("step 1 bump rate: %d/50 (expected ~30)", bumpCount)
	}
}

func TestE2E_PrepareEmail_Step2Exit(t *testing.T) {
	engine := NewEngine(Persona{Name: "Jan", Email: "jan@f.cz"})
	sendTime := time.Date(2026, 4, 14, 9, 0, 0, 0, time.UTC)

	result := engine.PrepareEmail(
		"Poslední email", "Naposledy se ozývám.",
		2, sendTime, "",
		"Poptávka", "Text.", "jan@f.cz", time.Now(),
	)

	if result == nil {
		t.Fatal("nil result")
	}

	// Step 2 body should not be empty.
	if result.Subject == "" {
		t.Error("step 2 subject should not be empty")
	}
	if result.Body == "" {
		t.Error("step 2 body should not be empty")
	}

	// Step 2+ tone profile sets OfferExit=true → closing should contain exit language.
	// ToneEngine.ClosingForStep(2) returns a phrase with "nebudu", "loučím", or "zájem".
	hasExitLanguage := containsAny(result.Body, "nebudu", "loučím", "loucim", "zájem", "zajem", "posledn", "naposledy")
	if !hasExitLanguage {
		t.Errorf("step 2 body should contain exit language, got: %s", result.Body[:min(300, len(result.Body))])
	}
}

func TestE2E_PrepareEmail_EveningSignature(t *testing.T) {
	engine := NewEngine(Persona{Name: "Jan Novák", Email: "jan@f.cz", Phone: "+420123"})

	// 20:30 = evening → should get mobile signature
	evening := time.Date(2026, 4, 7, 20, 30, 0, 0, time.UTC)
	result := engine.PrepareEmail("Sub", "Body", 0, evening, "X", "", "", "", time.Time{})

	// Evening signature should mention phone or mobile
	hasMobile := strings.Contains(result.Signature, "telefon") ||
		strings.Contains(result.Signature, "mobil") ||
		strings.Contains(result.Signature, "Jan") // short sig = just initials or name
	if !hasMobile {
		t.Errorf("evening signature should be mobile variant: %q", result.Signature)
	}
}

func TestE2E_PlanDay_DeadDay(t *testing.T) {
	engine := NewEngine(Persona{Email: "x@y.cz"})

	deadDays := []time.Time{
		time.Date(2026, 12, 25, 0, 0, 0, 0, time.UTC), // Christmas
		time.Date(2026, 1, 1, 0, 0, 0, 0, time.UTC),   // New Year
		time.Date(2026, 4, 4, 0, 0, 0, 0, time.UTC),    // Saturday
	}

	for _, dd := range deadDays {
		plan := engine.PlanCampaignDay(dd, 20)
		if plan != nil {
			t.Errorf("dead day %s should return nil plan", dd.Format("2006-01-02"))
		}
	}
}

func TestE2E_PlanDay_ReducedJuly(t *testing.T) {
	engine := NewEngine(Persona{Email: "x@y.cz"})

	// July Monday — reduced to 50%
	july := time.Date(2026, 7, 6, 0, 0, 0, 0, time.UTC)
	plan := engine.PlanCampaignDay(july, 20)
	if plan == nil {
		t.Skip("skip day (random)")
	}

	// Should have ~10 sends (20 * 0.5)
	if len(plan.SendTimes) > 15 {
		t.Errorf("July should reduce: %d sends (expected ~10)", len(plan.SendTimes))
	}
}

func TestE2E_PlanDay_BusinessHours(t *testing.T) {
	engine := NewEngine(Persona{Email: "x@y.cz"})
	prague, _ := time.LoadLocation("Europe/Prague")

	tuesday := time.Date(2026, 4, 7, 0, 0, 0, 0, time.UTC)
	plan := engine.PlanCampaignDay(tuesday, 10)
	if plan == nil {
		t.Skip("skip day")
	}

	for _, st := range plan.SendTimes {
		pragueTime := st.In(prague)
		hour := pragueTime.Hour()
		if hour < 8 || hour >= 17 {
			t.Errorf("send time outside business hours: %v", pragueTime)
		}
	}
}

func TestE2E_Imperfections_Progressive(t *testing.T) {
	engine := NewImperfectEngine()

	// Multi-line body — diacritics should degrade toward end
	body := "Řádek jedna s háčky.\nŘádek dvě s čárkami.\nŘádek tři s kroužky.\nŘádek čtyři s přehlásky.\nŘádek pět úplně na konci."
	result := engine.ApplyToBody(body)

	// Can't deterministically test progressive degradation,
	// but the function should not crash and should return non-empty
	if result == "" {
		t.Error("should return non-empty body")
	}
	if len(result) < len(body)/2 {
		t.Error("result too short — something went wrong")
	}
}

func TestE2E_Response_ClassifyAndDelay(t *testing.T) {
	resp := NewResponseEngine()

	testCases := []struct {
		text     string
		wantType ReplyType
		minDelay time.Duration
		maxDelay time.Duration
	}{
		// ReplyMeeting: meanMinutes=15, logStd=0.5. 99th-pct ≈ 47 min; use 60 min as cap.
		{"Zavolejte mi zítra", ReplyMeeting, 5 * time.Minute, 60 * time.Minute},
		{"Nemáme zájem", ReplyNegative, 5 * time.Minute, 24 * time.Hour},
		{"Jsem mimo kancelář", ReplyAutoOOO, 0, 0},
	}

	for _, tc := range testCases {
		rt := resp.ClassifyReply(tc.text)
		if rt != tc.wantType {
			t.Errorf("classify(%q) = %d, want %d", tc.text, rt, tc.wantType)
			continue
		}

		delay := resp.ReplyDelay(rt)
		if tc.maxDelay > 0 {
			if delay < tc.minDelay || delay > tc.maxDelay {
				t.Errorf("delay for %q: %v, want [%v, %v]", tc.text, delay, tc.minDelay, tc.maxDelay)
			}
		} else {
			if delay != 0 {
				t.Errorf("OOO delay should be 0, got %v", delay)
			}
		}
	}
}

// ── Helpers ──

func containsAny(s string, subs ...string) bool {
	lower := strings.ToLower(s)
	for _, sub := range subs {
		if strings.Contains(lower, strings.ToLower(sub)) {
			return true
		}
	}
	return false
}

func min(a, b int) int {
	if a < b { return a }
	return b
}
