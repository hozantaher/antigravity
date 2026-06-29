package profile

import (
	"strings"
	"sync"
	"testing"
	"time"
)

// ════════════════════════════════════════════════════════════════════════
// Brutal coverage for ML2.4 — RFC3464 DSN synthesizer per profile.
// ════════════════════════════════════════════════════════════════════════

// Helper: load an embedded profile by domain.
func loadProfile(t *testing.T, domain string) *Profile {
	t.Helper()
	r := loadedRegistry(t)
	got, err := r.Get(domain)
	if err != nil {
		t.Fatalf("get %s: %v", domain, err)
	}
	return got.(*Profile)
}

// 1. Accept verdict yields zero DSN (no body).
func TestS24_BuildDSN_AcceptZero(t *testing.T) {
	p := loadProfile(t, "gmail.lab")
	d := BuildDSN(p, DSNEnvelope{OriginalTo: "x@y"}, DecisionAccept, "")
	if d.Body != "" {
		t.Errorf("accept produced body: %q", d.Body)
	}
}

// 2. Reject verdict yields non-empty DSN body.
func TestS24_BuildDSN_RejectHasBody(t *testing.T) {
	p := loadProfile(t, "seznam.lab")
	d := BuildDSN(p, DSNEnvelope{OriginalTo: "x@y", OriginalFrom: "s@z"}, DecisionReject, "test")
	if d.Body == "" {
		t.Error("reject body empty")
	}
}

// 3. Status code copies from profile.bounce_kind_on_reject.
func TestS24_BuildDSN_StatusFromProfile(t *testing.T) {
	cases := []struct {
		domain string
		want   string
	}{
		{"seznam.lab", "5.7.1"},
		{"gmail.lab", "5.7.26"},
		{"outlook.lab", "5.7.606"},
	}
	for _, c := range cases {
		p := loadProfile(t, c.domain)
		d := BuildDSN(p, DSNEnvelope{OriginalTo: "x@y"}, DecisionReject, "test")
		if d.StatusCode != c.want {
			t.Errorf("%s status %q, want %q", c.domain, d.StatusCode, c.want)
		}
	}
}

// 4. Greylist verdict overrides status to 4.7.1 + action=delayed.
func TestS24_BuildDSN_GreylistDelayed(t *testing.T) {
	p := loadProfile(t, "outlook.lab")
	d := BuildDSN(p, DSNEnvelope{OriginalTo: "x@y"}, DecisionGreylist, "delay")
	if d.StatusCode != "4.7.1" {
		t.Errorf("greylist status %q, want 4.7.1", d.StatusCode)
	}
	if d.Action != "delayed" {
		t.Errorf("greylist action %q, want delayed", d.Action)
	}
}

// 5. From header is postmaster@<domain>.
func TestS24_BuildDSN_FromIsPostmaster(t *testing.T) {
	p := loadProfile(t, "seznam.lab")
	d := BuildDSN(p, DSNEnvelope{OriginalTo: "x@y", OriginalFrom: "s@z"}, DecisionReject, "")
	if d.From != "postmaster@seznam.lab" {
		t.Errorf("from %q, want postmaster@seznam.lab", d.From)
	}
}

// 6. To header is the original sender.
func TestS24_BuildDSN_ToIsOriginalFrom(t *testing.T) {
	p := loadProfile(t, "seznam.lab")
	d := BuildDSN(p, DSNEnvelope{OriginalTo: "x@y", OriginalFrom: "s@z"}, DecisionReject, "")
	if d.To != "s@z" {
		t.Errorf("to %q, want s@z", d.To)
	}
}

// 7. Body contains multipart/report Content-Type.
func TestS24_BuildDSN_MultipartReportType(t *testing.T) {
	p := loadProfile(t, "seznam.lab")
	d := BuildDSN(p, DSNEnvelope{OriginalTo: "x@y", OriginalFrom: "s@z"}, DecisionReject, "")
	if !strings.Contains(d.Body, "multipart/report") {
		t.Errorf("body missing multipart/report: %s", d.Body)
	}
	if !strings.Contains(d.Body, "report-type=delivery-status") {
		t.Errorf("body missing report-type=delivery-status")
	}
}

// 8. Body has all three required RFC3464 parts.
func TestS24_BuildDSN_ThreeParts(t *testing.T) {
	p := loadProfile(t, "seznam.lab")
	d := BuildDSN(p, DSNEnvelope{OriginalTo: "x@y", OriginalFrom: "s@z"}, DecisionReject, "")
	for _, part := range []string{
		"text/plain",
		"message/delivery-status",
		"message/rfc822-headers",
	} {
		if !strings.Contains(d.Body, part) {
			t.Errorf("body missing part %q", part)
		}
	}
}

// 9. Body has Reporting-MTA, Final-Recipient, Action, Status fields (RFC3464).
func TestS24_BuildDSN_DeliveryStatusFields(t *testing.T) {
	p := loadProfile(t, "seznam.lab")
	d := BuildDSN(p, DSNEnvelope{OriginalTo: "fail@x", OriginalFrom: "s@z"}, DecisionReject, "test")
	for _, field := range []string{
		"Reporting-MTA: dns; seznam.lab",
		"Final-Recipient: rfc822; fail@x",
		"Action: failed",
		"Status: 5.7.1",
		"Diagnostic-Code: smtp; 5.7.1 test",
	} {
		if !strings.Contains(d.Body, field) {
			t.Errorf("body missing field %q", field)
		}
	}
}

// 10. Empty OriginalTo yields zero DSN (defensive).
func TestS24_BuildDSN_NoRecipient_Zero(t *testing.T) {
	p := loadProfile(t, "seznam.lab")
	d := BuildDSN(p, DSNEnvelope{}, DecisionReject, "")
	if d.Body != "" {
		t.Errorf("missing recipient should yield empty DSN, got body len %d", len(d.Body))
	}
}

// 11. Nil profile yields zero DSN.
func TestS24_BuildDSN_NilProfile_Zero(t *testing.T) {
	d := BuildDSN(nil, DSNEnvelope{OriginalTo: "x@y"}, DecisionReject, "")
	if d.Body != "" {
		t.Error("nil profile should yield empty DSN")
	}
}

// 12. Profile without bounce_kind_on_reject defaults to 5.0.0.
func TestS24_BuildDSN_FallbackStatus(t *testing.T) {
	p := &Profile{Domain: "x.lab"} // no bounce code
	d := BuildDSN(p, DSNEnvelope{OriginalTo: "fail@x"}, DecisionReject, "")
	if d.StatusCode != "5.0.0" {
		t.Errorf("fallback status %q, want 5.0.0", d.StatusCode)
	}
}

// 13. Auto-Submitted: auto-replied header present (loop prevention).
func TestS24_BuildDSN_AutoSubmittedHeader(t *testing.T) {
	p := loadProfile(t, "seznam.lab")
	d := BuildDSN(p, DSNEnvelope{OriginalTo: "x@y"}, DecisionReject, "")
	if !strings.Contains(d.Body, "Auto-Submitted: auto-replied") {
		t.Error("body missing Auto-Submitted header (loop hazard)")
	}
}

// 14. Original Message-ID echoed in rfc822-headers part.
func TestS24_BuildDSN_MessageIDEchoed(t *testing.T) {
	p := loadProfile(t, "seznam.lab")
	d := BuildDSN(p, DSNEnvelope{
		OriginalTo: "x@y",
		MessageID:  "<orig-123@sender>",
	}, DecisionReject, "")
	if !strings.Contains(d.Body, "Message-ID: <orig-123@sender>") {
		t.Errorf("Message-ID not echoed: %s", d.Body)
	}
}

// 15. ArrivalTime defaults to now when zero — Date header non-empty.
func TestS24_BuildDSN_ArrivalTimeFallback(t *testing.T) {
	p := loadProfile(t, "seznam.lab")
	d := BuildDSN(p, DSNEnvelope{OriginalTo: "x@y"}, DecisionReject, "")
	if !strings.Contains(d.Body, "Date: ") {
		t.Errorf("body missing Date header: %s", d.Body)
	}
}

// 16. ArrivalTime explicit echoed in Arrival-Date.
func TestS24_BuildDSN_ArrivalTimeExplicit(t *testing.T) {
	p := loadProfile(t, "seznam.lab")
	when := time.Date(2025, 4, 1, 12, 30, 0, 0, time.UTC)
	d := BuildDSN(p, DSNEnvelope{
		OriginalTo:  "x@y",
		ArrivalTime: when,
	}, DecisionReject, "")
	if !strings.Contains(d.Body, "Arrival-Date: ") {
		t.Errorf("body missing Arrival-Date: %s", d.Body)
	}
}

// 17. Subject differs between failed vs delayed.
func TestS24_BuildDSN_SubjectVariesByAction(t *testing.T) {
	p := loadProfile(t, "outlook.lab")
	failed := BuildDSN(p, DSNEnvelope{OriginalTo: "x@y"}, DecisionReject, "")
	delayed := BuildDSN(p, DSNEnvelope{OriginalTo: "x@y"}, DecisionGreylist, "")
	if failed.Subject == delayed.Subject {
		t.Errorf("subjects identical: %q == %q", failed.Subject, delayed.Subject)
	}
}

// 18. Registry.PreviewDSN integrates Verdict + BuildDSN end-to-end.
func TestS24_PreviewDSN_RejectFlow(t *testing.T) {
	r := loadedRegistry(t)
	dsnAny, decision, err := r.PreviewDSN(
		"seznam.lab",
		map[string]interface{}{"original_to": "fail@seznam.lab", "original_from": "s@z"},
		map[string]interface{}{"size_bytes": float64(99999999), "has_dkim": true, "sender_origin_country": "CZ"},
	)
	if err != nil {
		t.Fatalf("preview: %v", err)
	}
	if decision != "reject" {
		t.Errorf("decision %q, want reject", decision)
	}
	dsn := dsnAny.(*DSN)
	if dsn.StatusCode != "5.7.1" {
		t.Errorf("status %q, want 5.7.1", dsn.StatusCode)
	}
}

// 19. Registry.PreviewDSN unknown domain → ErrUnknownDomain.
func TestS24_PreviewDSN_Unknown_Errors(t *testing.T) {
	r := loadedRegistry(t)
	_, _, err := r.PreviewDSN("never.lab", nil, nil)
	if err != ErrUnknownDomain {
		t.Errorf("got %v, want ErrUnknownDomain", err)
	}
}

// 20. PreviewDSN concurrent calls race-free.
func TestS24_PreviewDSN_ConcurrentSafe(t *testing.T) {
	r := loadedRegistry(t)
	var wg sync.WaitGroup
	for i := 0; i < 50; i++ {
		wg.Add(1)
		go func(i int) {
			defer wg.Done()
			_, _, _ = r.PreviewDSN("gmail.lab",
				map[string]interface{}{"original_to": "x@y"},
				map[string]interface{}{"size_bytes": float64(i * 1024)})
		}(i)
	}
	wg.Wait()
}

// 21. Body uses CRLF line endings (RFC822 canonical).
func TestS24_BuildDSN_CRLFLineEndings(t *testing.T) {
	p := loadProfile(t, "seznam.lab")
	d := BuildDSN(p, DSNEnvelope{OriginalTo: "x@y"}, DecisionReject, "")
	if strings.Contains(d.Body, "\n") && !strings.Contains(d.Body, "\r\n") {
		t.Error("body uses bare LF, want CRLF")
	}
}

// 22. Body has terminating boundary (--boundary--).
func TestS24_BuildDSN_TerminatingBoundary(t *testing.T) {
	p := loadProfile(t, "seznam.lab")
	d := BuildDSN(p, DSNEnvelope{OriginalTo: "x@y"}, DecisionReject, "")
	if !strings.Contains(d.Body, "==BOUNDARY_LAB_DSN==--") {
		t.Errorf("body missing terminating boundary: %s", d.Body)
	}
}
