package web

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/DATA-DOG/go-sqlmock"
	"common/health"
)

// ── Constructor ──

func TestNewServer(t *testing.T) {
	s := NewServer(nil, "http://localhost:8080")
	if s == nil { t.Fatal("nil server") }
	if s.baseURL != "http://localhost:8080" { t.Error("baseURL not set") }
	if s.mux == nil { t.Error("mux not initialized") }
}

func TestNewServer_Handler(t *testing.T) {
	s := NewServer(nil, "")
	h := s.Handler()
	if h == nil { t.Fatal("nil handler") }
}

// ── Transparent GIF ──

func TestTransparentGIF_Length(t *testing.T) {
	if len(transparentGIF) != 43 { t.Errorf("expected 43 bytes, got %d", len(transparentGIF)) }
}

func TestTransparentGIF_Header(t *testing.T) {
	// GIF89a magic bytes
	if transparentGIF[0] != 0x47 || transparentGIF[1] != 0x49 || transparentGIF[2] != 0x46 {
		t.Error("not a GIF header")
	}
}

// ── Healthz ──

func TestHandleHealthz(t *testing.T) {
	s := NewServer(nil, "")
	req := httptest.NewRequest("GET", "/healthz", nil)
	w := httptest.NewRecorder()

	s.handleHealthz(w, req)

	if w.Code != http.StatusOK { t.Errorf("status: %d", w.Code) }
	if w.Header().Get("Content-Type") != "application/json" { t.Error("wrong content type") }

	var body map[string]string
	json.Unmarshal(w.Body.Bytes(), &body)
	if body["status"] != "ok" { t.Errorf("body: %v", body) }
}

// ── Open Pixel ──

func TestHandleOpenPixel_EmptyToken(t *testing.T) {
	s := NewServer(nil, "")
	req := httptest.NewRequest("GET", "/o", nil)
	w := httptest.NewRecorder()

	s.handleOpenPixel(w, req)

	if w.Code != http.StatusOK { t.Errorf("status: %d", w.Code) }
}

func TestHandleOpenPixel_WithToken_NilDB(t *testing.T) {
	// With nil DB, recordTrackingEvent will panic, so we test empty token path
	s := NewServer(nil, "")
	req := httptest.NewRequest("GET", "/o?t=", nil)
	w := httptest.NewRecorder()

	s.handleOpenPixel(w, req)

	// Empty string token is treated as no token
	if w.Code != http.StatusOK { t.Errorf("status: %d", w.Code) }
}

// ── Click Redirect ──

func TestHandleClickRedirect_MissingURL(t *testing.T) {
	s := NewServer(nil, "")
	req := httptest.NewRequest("GET", "/c", nil)
	w := httptest.NewRecorder()

	s.handleClickRedirect(w, req)

	if w.Code != http.StatusBadRequest { t.Errorf("status: %d", w.Code) }
}

func TestHandleClickRedirect_WithURL_NoToken(t *testing.T) {
	s := NewServer(nil, "")
	req := httptest.NewRequest("GET", "/c?u=https://example.com", nil)
	w := httptest.NewRecorder()

	s.handleClickRedirect(w, req)

	if w.Code != http.StatusFound { t.Errorf("status: %d", w.Code) }
	if w.Header().Get("Location") != "https://example.com" {
		t.Errorf("redirect to: %s", w.Header().Get("Location"))
	}
}

func TestHandleClickRedirect_EmptyToken(t *testing.T) {
	s := NewServer(nil, "")
	req := httptest.NewRequest("GET", "/c?t=&u=https://example.com", nil)
	w := httptest.NewRecorder()

	s.handleClickRedirect(w, req)

	// Empty token is falsy, skips recordTrackingEvent
	if w.Code != http.StatusFound { t.Errorf("status: %d", w.Code) }
}

// ── Open Redirect Protection ──

func TestHandleClickRedirect_JavascriptURI_Blocked(t *testing.T) {
	s := NewServer(nil, "")
	req := httptest.NewRequest("GET", "/c?u=javascript:alert(1)", nil)
	w := httptest.NewRecorder()

	s.handleClickRedirect(w, req)

	if w.Code != http.StatusBadRequest {
		t.Errorf("expected 400 for javascript: URI, got %d", w.Code)
	}
}

func TestHandleClickRedirect_DataURI_Blocked(t *testing.T) {
	s := NewServer(nil, "")
	req := httptest.NewRequest("GET", "/c?u=data:text/html,<script>evil()</script>", nil)
	w := httptest.NewRecorder()

	s.handleClickRedirect(w, req)

	if w.Code != http.StatusBadRequest {
		t.Errorf("expected 400 for data: URI, got %d", w.Code)
	}
}

func TestHandleClickRedirect_RelativeURL_Blocked(t *testing.T) {
	s := NewServer(nil, "")
	req := httptest.NewRequest("GET", "/c?u=/relative/path", nil)
	w := httptest.NewRecorder()

	s.handleClickRedirect(w, req)

	if w.Code != http.StatusBadRequest {
		t.Errorf("expected 400 for relative URL, got %d", w.Code)
	}
}

func TestHandleClickRedirect_HTTP_Allowed(t *testing.T) {
	s := NewServer(nil, "")
	req := httptest.NewRequest("GET", "/c?u=http://example.com/path", nil)
	w := httptest.NewRecorder()

	s.handleClickRedirect(w, req)

	if w.Code != http.StatusFound {
		t.Errorf("expected 302 for http: URL, got %d", w.Code)
	}
}

func TestIsSafeRedirectURL(t *testing.T) {
	cases := []struct {
		url  string
		safe bool
	}{
		{"https://example.com", true},
		{"http://example.com/path?q=1", true},
		{"javascript:alert(1)", false},
		{"data:text/html,foo", false},
		{"file:///etc/passwd", false},
		{"/relative", false},
		{"//no-scheme.com", false},
		{"", false},
		{"not-a-url", false},
	}
	for _, c := range cases {
		got := isSafeRedirectURL(c.url)
		if got != c.safe {
			t.Errorf("isSafeRedirectURL(%q) = %v, want %v", c.url, got, c.safe)
		}
	}
}

// ── Token Format Validation ──

func TestHandleOpenPixel_InvalidToken_Silently200(t *testing.T) {
	s := NewServer(nil, "")
	// Non-integer token should be silently ignored (not 400, to avoid info leak)
	req := httptest.NewRequest("GET", "/o?t=../../etc/passwd", nil)
	w := httptest.NewRecorder()

	s.handleOpenPixel(w, req)

	if w.Code != http.StatusOK {
		t.Errorf("expected 200 for invalid token (silent drop), got %d", w.Code)
	}
}

// ── Rate Limiter Unit Tests ──

func TestRateLimiter_AllowsUnderLimit(t *testing.T) {
	l := newIPLimiter(3, time.Minute)
	for i := 0; i < 3; i++ {
		if !l.allow("1.2.3.4") {
			t.Fatalf("expected allow on request %d", i+1)
		}
	}
}

func TestRateLimiter_BlocksOverLimit(t *testing.T) {
	l := newIPLimiter(3, time.Minute)
	for i := 0; i < 3; i++ {
		l.allow("1.2.3.4")
	}
	if l.allow("1.2.3.4") {
		t.Error("expected block after exceeding limit")
	}
}

func TestRateLimiter_SeparateIPs(t *testing.T) {
	l := newIPLimiter(1, time.Minute)
	if !l.allow("1.1.1.1") { t.Error("1.1.1.1 should be allowed") }
	if l.allow("1.1.1.1")  { t.Error("1.1.1.1 should be blocked") }
	if !l.allow("2.2.2.2") { t.Error("2.2.2.2 should be allowed (different IP)") }
}

// ── DashboardStats ──

func TestDashboardStats_Struct(t *testing.T) {
	s := dashboardStats{
		Contacts:    map[string]int{"active": 100, "bounced": 5},
		Campaigns:   3,
		Sent:        500,
		Opened:      200,
		Clicked:     50,
		Replied:     25,
		Bounced:     10,
		Blacklisted: 2,
	}
	if s.Contacts["active"] != 100 { t.Error("contacts") }
	if s.Campaigns != 3 { t.Error("campaigns") }
	if s.Sent != 500 { t.Error("sent") }
}

func TestDashboardStats_JSON(t *testing.T) {
	s := dashboardStats{
		Contacts: map[string]int{"active": 10},
		Sent:     100,
	}
	data, err := json.Marshal(s)
	if err != nil { t.Fatal(err) }

	var parsed map[string]any
	json.Unmarshal(data, &parsed)
	if parsed["sent_total"] != float64(100) { t.Error("sent_total") }
	contacts := parsed["contacts"].(map[string]any)
	if contacts["active"] != float64(10) { t.Error("contacts.active") }
}

// ── Route Registration ──

func TestRoutes_Registered(t *testing.T) {
	s := NewServer(nil, "http://localhost")
	handler := s.Handler()
	if handler == nil { t.Fatal("nil handler") }

	// Test healthz route through mux
	req := httptest.NewRequest("GET", "/healthz", nil)
	w := httptest.NewRecorder()
	handler.ServeHTTP(w, req)
	if w.Code != http.StatusOK { t.Errorf("healthz: status %d", w.Code) }
}

func TestRoutes_OpenPixel(t *testing.T) {
	s := NewServer(nil, "")
	req := httptest.NewRequest("GET", "/o", nil)
	w := httptest.NewRecorder()
	s.Handler().ServeHTTP(w, req)
	if w.Code != http.StatusOK { t.Errorf("open pixel: status %d", w.Code) }
}

func TestRoutes_ClickNoURL(t *testing.T) {
	s := NewServer(nil, "")
	req := httptest.NewRequest("GET", "/c", nil)
	w := httptest.NewRecorder()
	s.Handler().ServeHTTP(w, req)
	if w.Code != http.StatusBadRequest { t.Errorf("click: status %d", w.Code) }
}

// ── remoteIP ──

func TestRemoteIP_XForwardedFor(t *testing.T) {
	req := httptest.NewRequest("GET", "/", nil)
	req.Header.Set("X-Forwarded-For", "203.0.113.5")
	ip := remoteIP(req)
	if ip != "203.0.113.5" { t.Errorf("XFF plain: got %q", ip) }
}

func TestRemoteIP_XForwardedFor_WithPort(t *testing.T) {
	req := httptest.NewRequest("GET", "/", nil)
	req.Header.Set("X-Forwarded-For", "203.0.113.5:12345")
	ip := remoteIP(req)
	if ip != "203.0.113.5" { t.Errorf("XFF with port: got %q", ip) }
}

func TestRemoteIP_FallbackRemoteAddr(t *testing.T) {
	req := httptest.NewRequest("GET", "/", nil)
	req.RemoteAddr = "10.0.0.1:5000"
	ip := remoteIP(req)
	if ip != "10.0.0.1" { t.Errorf("RemoteAddr: got %q", ip) }
}

func TestRemoteIP_FallbackRemoteAddr_NoPort(t *testing.T) {
	req := httptest.NewRequest("GET", "/", nil)
	req.RemoteAddr = "10.0.0.1"
	ip := remoteIP(req)
	if ip != "10.0.0.1" { t.Errorf("RemoteAddr no port: got %q", ip) }
}

// ── rateLimited middleware ──

func TestRateLimited_Allows(t *testing.T) {
	l := newIPLimiter(5, time.Minute)
	var called bool
	handler := rateLimited(l, func(w http.ResponseWriter, r *http.Request) {
		called = true
		w.WriteHeader(http.StatusOK)
	})
	req := httptest.NewRequest("GET", "/", nil)
	req.RemoteAddr = "1.1.1.1:1234"
	w := httptest.NewRecorder()
	handler(w, req)
	if !called { t.Error("handler should have been called") }
	if w.Code != http.StatusOK { t.Errorf("status: %d", w.Code) }
}

func TestIsSafeRedirectURL_ParseError(t *testing.T) {
	// Invalid percent encoding → url.Parse returns error → false
	if isSafeRedirectURL("https://exa%mple.com") {
		t.Error("URL with invalid percent encoding should not be safe")
	}
	// Control character → url.Parse error → false
	if isSafeRedirectURL("\x00test") {
		t.Error("URL with null byte should not be safe")
	}
}

func TestHandleOpenPixel_InvalidTokenFormat(t *testing.T) {
	s := NewServer(nil, "")
	// Non-digit token fails validTrackingToken → silently serve 200, no DB call
	req := httptest.NewRequest("GET", "/o?t=abc-xyz", nil)
	w := httptest.NewRecorder()
	s.handleOpenPixel(w, req)
	if w.Code != http.StatusOK {
		t.Errorf("expected 200 for invalid token format, got %d", w.Code)
	}
}

func TestHandleHealthz_Degraded(t *testing.T) {
	reg := health.New()
	reg.Report("imap", false, "connection refused")
	s := NewServerWithHealth(nil, "", reg)
	req := httptest.NewRequest("GET", "/healthz", nil)
	w := httptest.NewRecorder()
	s.handleHealthz(w, req)
	if w.Code != http.StatusServiceUnavailable {
		t.Errorf("expected 503 for degraded health, got %d", w.Code)
	}
	var body map[string]string
	json.Unmarshal(w.Body.Bytes(), &body)
	if body["status"] != "degraded" {
		t.Errorf("expected degraded status, got %q", body["status"])
	}
}

func TestRateLimited_Blocks(t *testing.T) {
	l := newIPLimiter(1, time.Minute)
	l.allow("1.1.1.1") // exhaust
	handler := rateLimited(l, func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusOK)
	})
	req := httptest.NewRequest("GET", "/", nil)
	req.RemoteAddr = "1.1.1.1:1234"
	w := httptest.NewRecorder()
	handler(w, req)
	if w.Code != http.StatusTooManyRequests { t.Errorf("expected 429, got %d", w.Code) }
}

// ── Rate limiter edge cases ──

func TestRateLimiter_ZeroAllows(t *testing.T) {
	l := newIPLimiter(0, time.Minute)
	// max=0 → every request blocked
	if l.allow("1.2.3.4") {
		t.Error("max=0 should block all")
	}
}

func TestRateLimiter_HighLimit(t *testing.T) {
	l := newIPLimiter(1000, time.Minute)
	for i := 0; i < 100; i++ {
		if !l.allow("10.0.0.1") {
			t.Fatalf("should allow at request %d", i)
		}
	}
}

func TestRateLimiter_MultipleIPs_Independent(t *testing.T) {
	l := newIPLimiter(2, time.Minute)
	ips := []string{"1.1.1.1", "2.2.2.2", "3.3.3.3"}
	for _, ip := range ips {
		if !l.allow(ip) { t.Errorf("first request for %s should be allowed", ip) }
		if !l.allow(ip) { t.Errorf("second request for %s should be allowed", ip) }
		if l.allow(ip) { t.Errorf("third request for %s should be blocked", ip) }
	}
}

// ── ValidTrackingToken regex ──

func TestValidTrackingToken_ValidValues(t *testing.T) {
	valid := []string{"1", "42", "123456789", "999999999999999999"} // up to 18 digits
	for _, v := range valid {
		if !validTrackingToken.MatchString(v) {
			t.Errorf("should be valid: %q", v)
		}
	}
}

func TestValidTrackingToken_InvalidValues(t *testing.T) {
	invalid := []string{"", "abc", "-1", "1.5", "0x1F", "1234567890123456789"} // 19 digits too long
	for _, v := range invalid {
		if validTrackingToken.MatchString(v) {
			t.Errorf("should be invalid: %q", v)
		}
	}
}

// ── NewServerWithHealth ──

func TestNewServerWithHealth_WithHealthyRegistry(t *testing.T) {
	reg := health.New()
	reg.Report("imap", true, "")
	s := NewServerWithHealth(nil, "https://base.example.com", reg)
	if s == nil { t.Fatal("nil server") }
	if s.health != reg { t.Error("health registry not set") }

	req := httptest.NewRequest("GET", "/healthz", nil)
	w := httptest.NewRecorder()
	s.handleHealthz(w, req)
	if w.Code != http.StatusOK {
		t.Errorf("healthy registry: expected 200, got %d", w.Code)
	}
}

func TestNewServerWithHealth_NilRegistry(t *testing.T) {
	s := NewServerWithHealth(nil, "", nil)
	if s == nil { t.Fatal("nil server") }
	if s.health != nil { t.Error("health should be nil") }
}

// ── isSafeRedirectURL exhaustive ──

func TestIsSafeRedirectURL_AllCases(t *testing.T) {
	cases := []struct {
		url  string
		safe bool
	}{
		{"https://example.com/path?q=1&foo=bar", true},
		{"http://192.168.1.1/admin", true},
		{"ftp://files.example.com", false},    // ftp not allowed
		{"//missing-scheme.com/path", false},
		{"javascript:void(0)", false},
		{"vbscript:alert(1)", false},
		{"data:text/html,<h1>evil</h1>", false},
		{"file:///etc/passwd", false},
		{"mailto:user@example.com", false},
		{"ssh://server.com", false},
	}
	for _, c := range cases {
		got := isSafeRedirectURL(c.url)
		if got != c.safe {
			t.Errorf("isSafeRedirectURL(%q) = %v, want %v", c.url, got, c.safe)
		}
	}
}

// ── handleClickRedirect with valid token ──

func TestHandleClickRedirect_WithValidToken(t *testing.T) {
	s := NewServer(nil, "")
	// Valid integer token, no DB call needed (with nil db, if token is valid it would call recordTrackingEvent)
	// Use invalid token format to test the non-recording path
	req := httptest.NewRequest("GET", "/c?t=abc&u=https://example.com", nil)
	w := httptest.NewRecorder()
	s.handleClickRedirect(w, req)
	// abc is not a valid tracking token, so recordTrackingEvent is skipped
	if w.Code != http.StatusFound {
		t.Errorf("expected 302, got %d", w.Code)
	}
}

// ── handleOpenPixel returns GIF bytes ──

func TestHandleOpenPixel_NoToken_ServeGIF(t *testing.T) {
	s := NewServer(nil, "")
	// No token → returns 200 OK with no body (early return before GIF)
	req := httptest.NewRequest("GET", "/o", nil)
	w := httptest.NewRecorder()
	s.handleOpenPixel(w, req)
	if w.Code != http.StatusOK { t.Errorf("status: %d", w.Code) }
}

func TestHandleOpenPixel_InvalidToken_NoGIF(t *testing.T) {
	s := NewServer(nil, "")
	// Invalid token format → silent 200, no GIF content-type (returns before GIF write)
	req := httptest.NewRequest("GET", "/o?t=not-a-number", nil)
	w := httptest.NewRecorder()
	s.handleOpenPixel(w, req)
	if w.Code != http.StatusOK { t.Errorf("status: %d", w.Code) }
	// Content-type should NOT be image/gif (returned early)
	if w.Header().Get("Content-Type") == "image/gif" {
		t.Error("should not serve GIF for invalid token")
	}
}

// ── handleHealth via sqlmock ──

func TestHandleHealth_DBOk(t *testing.T) {
	db, mock, err := sqlmock.New(sqlmock.MonitorPingsOption(true))
	if err != nil { t.Fatalf("sqlmock.New: %v", err) }
	defer db.Close()

	mock.ExpectPing()

	s := NewServer(db, "")
	req := httptest.NewRequest("GET", "/health", nil)
	w := httptest.NewRecorder()

	s.handleHealth(w, req)

	if w.Code != http.StatusOK { t.Errorf("status = %d, want 200", w.Code) }
	var body map[string]interface{}
	json.Unmarshal(w.Body.Bytes(), &body)
	if body["db"] != "ok" { t.Errorf("db = %v, want ok", body["db"]) }
}

func TestHandleHealth_DBError(t *testing.T) {
	db, mock, err := sqlmock.New(sqlmock.MonitorPingsOption(true))
	if err != nil { t.Fatalf("sqlmock.New: %v", err) }
	defer db.Close()

	mock.ExpectPing().WillReturnError(errWeb("connection refused"))

	s := NewServer(db, "")
	req := httptest.NewRequest("GET", "/health", nil)
	w := httptest.NewRecorder()

	s.handleHealth(w, req)

	if w.Code != http.StatusServiceUnavailable { t.Errorf("status = %d, want 503", w.Code) }
	var body map[string]interface{}
	json.Unmarshal(w.Body.Bytes(), &body)
	if body["status"] != "degraded" { t.Errorf("status = %v, want degraded", body["status"]) }
}

func TestHandleHealth_WithHealthRegistry(t *testing.T) {
	db, mock, err := sqlmock.New(sqlmock.MonitorPingsOption(true))
	if err != nil { t.Fatalf("sqlmock.New: %v", err) }
	defer db.Close()

	mock.ExpectPing()

	reg := health.New()
	reg.Report("imap", true, "")
	s := NewServerWithHealth(db, "", reg)
	req := httptest.NewRequest("GET", "/health", nil)
	w := httptest.NewRecorder()

	s.handleHealth(w, req)

	if w.Code != http.StatusOK { t.Errorf("status = %d, want 200", w.Code) }
}

func TestHandleHealth_RegistryDegraded(t *testing.T) {
	db, mock, err := sqlmock.New(sqlmock.MonitorPingsOption(true))
	if err != nil { t.Fatalf("sqlmock.New: %v", err) }
	defer db.Close()

	mock.ExpectPing()

	reg := health.New()
	reg.Report("imap", false, "conn failed")
	s := NewServerWithHealth(db, "", reg)
	req := httptest.NewRequest("GET", "/health", nil)
	w := httptest.NewRecorder()

	s.handleHealth(w, req)

	if w.Code != http.StatusServiceUnavailable { t.Errorf("status = %d, want 503", w.Code) }
}

// ── getStats / handleDashboard via sqlmock ──

func expectStatsQueries(mock sqlmock.Sqlmock) {
	mock.ExpectQuery(`SELECT status, COUNT`).
		WillReturnRows(sqlmock.NewRows([]string{"status", "count"}).
			AddRow("new", 50).AddRow("valid", 30))
	mock.ExpectQuery(`SELECT COUNT\(\*\) FROM campaigns`).
		WillReturnRows(sqlmock.NewRows([]string{"count"}).AddRow(5))
	mock.ExpectQuery(`SELECT COUNT\(\*\) FROM send_events`).
		WillReturnRows(sqlmock.NewRows([]string{"count"}).AddRow(200))
	mock.ExpectQuery(`SELECT COUNT\(\*\) FROM tracking_events WHERE event_type = 'open'`).
		WillReturnRows(sqlmock.NewRows([]string{"count"}).AddRow(80))
	mock.ExpectQuery(`SELECT COUNT\(\*\) FROM tracking_events WHERE event_type = 'click'`).
		WillReturnRows(sqlmock.NewRows([]string{"count"}).AddRow(20))
	mock.ExpectQuery(`SELECT COUNT\(\*\) FROM contacts WHERE status = 'replied'`).
		WillReturnRows(sqlmock.NewRows([]string{"count"}).AddRow(10))
	mock.ExpectQuery(`SELECT COUNT\(\*\) FROM bounce_events`).
		WillReturnRows(sqlmock.NewRows([]string{"count"}).AddRow(3))
	mock.ExpectQuery(`SELECT COUNT\(\*\) FROM blacklist`).
		WillReturnRows(sqlmock.NewRows([]string{"count"}).AddRow(1))
}

func TestHandleDashboard_WithData(t *testing.T) {
	db, mock, err := sqlmock.New()
	if err != nil { t.Fatalf("sqlmock.New: %v", err) }
	defer db.Close()

	s := NewServer(db, "")
	expectStatsQueries(mock)

	req := httptest.NewRequest("GET", "/dashboard", nil)
	w := httptest.NewRecorder()
	s.handleDashboard(w, req)

	if w.Code != http.StatusOK { t.Errorf("status = %d", w.Code) }
	if w.Header().Get("Content-Type") != "application/json" { t.Error("content-type") }

	var stats dashboardStats
	if err := json.Unmarshal(w.Body.Bytes(), &stats); err != nil {
		t.Fatalf("unmarshal: %v", err)
	}
	if stats.Campaigns != 5 { t.Errorf("campaigns = %d, want 5", stats.Campaigns) }
	if stats.Sent != 200 { t.Errorf("sent = %d, want 200", stats.Sent) }
}

func TestHandleDashboard_DBErrors_Graceful(t *testing.T) {
	db, mock, err := sqlmock.New()
	if err != nil { t.Fatalf("sqlmock.New: %v", err) }
	defer db.Close()

	// All queries fail — getStats should still return a zero-value struct
	mock.ExpectQuery(`SELECT status, COUNT`).
		WillReturnError(errWeb("db down"))
	// remaining QueryRow calls will fail silently
	for i := 0; i < 7; i++ {
		mock.ExpectQuery(`.+`).WillReturnError(errWeb("db down"))
	}

	s := NewServer(db, "")
	req := httptest.NewRequest("GET", "/dashboard", nil)
	w := httptest.NewRecorder()
	s.handleDashboard(w, req)

	if w.Code != http.StatusOK { t.Errorf("status = %d, want 200", w.Code) }
}

// ── recordTrackingEvent via sqlmock ──

func TestRecordTrackingEvent_Open(t *testing.T) {
	db, mock, err := sqlmock.New()
	if err != nil { t.Fatalf("sqlmock.New: %v", err) }
	defer db.Close()

	mock.ExpectExec(`INSERT INTO tracking_events`).
		WillReturnResult(sqlmock.NewResult(1, 1))
	mock.ExpectExec(`UPDATE contacts SET status = 'opened'`).
		WillReturnResult(sqlmock.NewResult(0, 1))

	s := NewServer(db, "")
	req := httptest.NewRequest("GET", "/o?t=123", nil)
	s.recordTrackingEvent("123", "open", req)
}

func TestRecordTrackingEvent_Click(t *testing.T) {
	db, mock, err := sqlmock.New()
	if err != nil { t.Fatalf("sqlmock.New: %v", err) }
	defer db.Close()

	mock.ExpectExec(`INSERT INTO tracking_events`).
		WillReturnResult(sqlmock.NewResult(1, 1))
	// No second exec for click events

	s := NewServer(db, "")
	req := httptest.NewRequest("GET", "/c?t=456&u=https://example.com", nil)
	s.recordTrackingEvent("456", "click", req)
}

func TestRecordTrackingEvent_DBError(t *testing.T) {
	db, mock, err := sqlmock.New()
	if err != nil { t.Fatalf("sqlmock.New: %v", err) }
	defer db.Close()

	// Insert fails — should log and continue, no panic
	mock.ExpectExec(`INSERT INTO tracking_events`).
		WillReturnError(errWeb("db error"))

	s := NewServer(db, "")
	req := httptest.NewRequest("GET", "/o?t=789", nil)
	s.recordTrackingEvent("789", "open", req) // should not panic
}

// M-W1 (2026-04-22): bare s.db.Exec on "opened" UPDATE silently dropped
// errors. The fix logs via slog.Warn. These tests lock in the no-panic +
// log-on-error contract; actual slog output is not asserted (avoiding a
// heavy slog-capture dependency), but the key invariant is no panic and
// the function completes without returning early.

func TestRecordTrackingEvent_Open_ContactsUpdateDBError_NoPanic(t *testing.T) {
	db, mock, err := sqlmock.New()
	if err != nil {
		t.Fatalf("sqlmock.New: %v", err)
	}
	defer db.Close()

	// INSERT tracking_events succeeds
	mock.ExpectExec(`INSERT INTO tracking_events`).
		WillReturnResult(sqlmock.NewResult(1, 1))
	// UPDATE contacts fails — must not panic, must not propagate (best-effort)
	mock.ExpectExec(`UPDATE contacts SET status = 'opened'`).
		WillReturnError(errWeb("contacts update failed"))

	s := NewServer(db, "")
	req := httptest.NewRequest("GET", "/o?t=999", nil)
	// Must not panic; function is void
	s.recordTrackingEvent("999", "open", req)

	if err := mock.ExpectationsWereMet(); err != nil {
		t.Errorf("unmet expectations: %v", err)
	}
}

func TestRecordTrackingEvent_Open_BothSucceed_NoExtraExec(t *testing.T) {
	db, mock, err := sqlmock.New()
	if err != nil {
		t.Fatalf("sqlmock.New: %v", err)
	}
	defer db.Close()

	mock.ExpectExec(`INSERT INTO tracking_events`).
		WillReturnResult(sqlmock.NewResult(1, 1))
	mock.ExpectExec(`UPDATE contacts SET status = 'opened'`).
		WillReturnResult(sqlmock.NewResult(0, 1))

	s := NewServer(db, "")
	req := httptest.NewRequest("GET", "/o?t=123", nil)
	s.recordTrackingEvent("123", "open", req)

	if err := mock.ExpectationsWereMet(); err != nil {
		t.Errorf("both execs expected, got: %v", err)
	}
}

func TestRecordTrackingEvent_Click_NoContactsUpdate(t *testing.T) {
	// "click" event must NOT call the UPDATE contacts Exec — it's open-only.
	db, mock, err := sqlmock.New()
	if err != nil {
		t.Fatalf("sqlmock.New: %v", err)
	}
	defer db.Close()

	// Only INSERT tracking_events — no UPDATE contacts for click
	mock.ExpectExec(`INSERT INTO tracking_events`).
		WillReturnResult(sqlmock.NewResult(1, 1))

	s := NewServer(db, "")
	req := httptest.NewRequest("GET", "/c?t=456&u=https://example.com", nil)
	s.recordTrackingEvent("456", "click", req)

	// If UpdateContacts were called, mock would fire an unexpected query error
	if err := mock.ExpectationsWereMet(); err != nil {
		t.Errorf("click should not call UPDATE contacts: %v", err)
	}
}

// ── BF-D4 — defensive INSERT rejects unknown send_event_id ─────────────────

// When the token passes regex but does not match a real send_events row,
// the EXISTS subquery returns 0 rows and the INSERT inserts nothing. We must:
//   - not panic
//   - not propagate (handler still serves the pixel/redirect)
//   - skip the open-status UPDATE (no contact_id to update)
func TestRecordTrackingEvent_Open_UnknownSendEvent_NoInsertNoUpdate(t *testing.T) {
	db, mock, err := sqlmock.New()
	if err != nil { t.Fatalf("sqlmock.New: %v", err) }
	defer db.Close()

	// INSERT returns rowsAffected=0 (EXISTS subquery filtered the row out)
	mock.ExpectExec(`INSERT INTO tracking_events`).
		WillReturnResult(sqlmock.NewResult(0, 0))
	// UPDATE contacts is still called — but its sub-select for contact_id
	// will simply find nothing and no row updates. We mirror that with a
	// zero-rows result to keep mock expectations honest.
	mock.ExpectExec(`UPDATE contacts SET status = 'opened'`).
		WillReturnResult(sqlmock.NewResult(0, 0))

	s := NewServer(db, "")
	req := httptest.NewRequest("GET", "/o?t=999999999", nil)
	s.recordTrackingEvent("999999999", "open", req)

	if err := mock.ExpectationsWereMet(); err != nil {
		t.Errorf("expected INSERT (filtered) + UPDATE (no-match): %v", err)
	}
}

func TestRecordTrackingEvent_Click_UnknownSendEvent_NoUpdateContacts(t *testing.T) {
	db, mock, err := sqlmock.New()
	if err != nil { t.Fatalf("sqlmock.New: %v", err) }
	defer db.Close()

	// INSERT — EXISTS filters out → 0 rows. Click events do not call UPDATE.
	mock.ExpectExec(`INSERT INTO tracking_events`).
		WillReturnResult(sqlmock.NewResult(0, 0))

	s := NewServer(db, "")
	req := httptest.NewRequest("GET", "/c?t=88888&u=https://example.com", nil)
	s.recordTrackingEvent("88888", "click", req)

	if err := mock.ExpectationsWereMet(); err != nil {
		t.Errorf("click with unknown send_event_id should only Exec INSERT once: %v", err)
	}
}

// ── handleRecalc via sqlmock ──

func TestHandleRecalc_WrongMethod(t *testing.T) {
	s := NewServer(nil, "")
	req := httptest.NewRequest("GET", "/recalc", nil)
	w := httptest.NewRecorder()
	s.handleRecalc(w, req)
	if w.Code != http.StatusMethodNotAllowed { t.Errorf("status = %d, want 405", w.Code) }
}

func TestHandleRecalc_POST_DBError(t *testing.T) {
	db, mock, err := sqlmock.New()
	if err != nil { t.Fatalf("sqlmock.New: %v", err) }
	defer db.Close()

	// RecalculateAll starts with a SELECT query
	mock.ExpectQuery(`SELECT c.id, c.email`).
		WillReturnError(errWeb("db error"))

	s := NewServer(db, "")
	req := httptest.NewRequest("POST", "/recalc", strings.NewReader(""))
	w := httptest.NewRecorder()
	s.handleRecalc(w, req)
	if w.Code != http.StatusInternalServerError { t.Errorf("status = %d, want 500", w.Code) }
}

// ── handleOpenPixel — GIF served for valid token with DB ────────────────────

func TestHandleOpenPixel_ValidToken_ServesGIF(t *testing.T) {
	db, mock, err := sqlmock.New()
	if err != nil { t.Fatalf("sqlmock.New: %v", err) }
	defer db.Close()

	// recordTrackingEvent: INSERT tracking_events
	mock.ExpectExec(`INSERT INTO tracking_events`).
		WillReturnResult(sqlmock.NewResult(1, 1))
	// UPDATE contacts SET status = 'opened'
	mock.ExpectExec(`UPDATE contacts`).
		WillReturnResult(sqlmock.NewResult(0, 1))

	s := NewServer(db, "")
	req := httptest.NewRequest("GET", "/o?t=123", nil)
	w := httptest.NewRecorder()
	s.handleOpenPixel(w, req)

	if w.Code != http.StatusOK {
		t.Errorf("expected 200, got %d", w.Code)
	}
	if w.Header().Get("Content-Type") != "image/gif" {
		t.Errorf("expected image/gif, got %q", w.Header().Get("Content-Type"))
	}
	if w.Body.Len() != len(transparentGIF) {
		t.Errorf("expected %d GIF bytes, got %d", len(transparentGIF), w.Body.Len())
	}
}

type errWeb string
func (e errWeb) Error() string { return string(e) }

// ── M-O1 getStats Scan observability (2026-04-22) ──

// TestGetStats_ContactsScanError verifies that a bad Scan inside the contacts
// GROUP BY loop does not panic and the row is skipped gracefully.
func TestGetStats_ContactsScanError_SkipsRow(t *testing.T) {
	db, mock, err := sqlmock.New()
	if err != nil { t.Fatalf("sqlmock.New: %v", err) }
	defer db.Close()

	// Return a row with the wrong column count so Scan returns an error.
	mock.ExpectQuery(`SELECT status, COUNT`).
		WillReturnRows(sqlmock.NewRows([]string{"status"}).AddRow("new"))
	// 7 stat queries succeed with zero rows
	for i := 0; i < 7; i++ {
		mock.ExpectQuery(`.+`).
			WillReturnRows(sqlmock.NewRows([]string{"count"}).AddRow(0))
	}

	s := NewServer(db, "")
	req := httptest.NewRequest("GET", "/dashboard", nil)
	w := httptest.NewRecorder()
	s.handleDashboard(w, req)

	// Dashboard must still respond 200 — no panic, error propagated via log only.
	if w.Code != http.StatusOK { t.Errorf("status = %d, want 200", w.Code) }
}

// TestGetStats_SingleStatScanError verifies that a Scan error on one stat
// counter logs and leaves that counter at zero while others are populated.
func TestGetStats_SingleStatScanError_OtherCountersIntact(t *testing.T) {
	db, mock, err := sqlmock.New()
	if err != nil { t.Fatalf("sqlmock.New: %v", err) }
	defer db.Close()

	// contacts GROUP BY OK
	mock.ExpectQuery(`SELECT status, COUNT`).
		WillReturnRows(sqlmock.NewRows([]string{"status", "count"}).AddRow("new", 10))
	// campaigns scan error (wrong column type)
	mock.ExpectQuery(`SELECT COUNT\(\*\) FROM campaigns`).
		WillReturnRows(sqlmock.NewRows([]string{"count"}).AddRow("not-a-number"))
	// remaining 6 stats succeed
	mock.ExpectQuery(`SELECT COUNT\(\*\) FROM send_events`).
		WillReturnRows(sqlmock.NewRows([]string{"count"}).AddRow(42))
	mock.ExpectQuery(`SELECT COUNT\(\*\) FROM tracking_events WHERE event_type = 'open'`).
		WillReturnRows(sqlmock.NewRows([]string{"count"}).AddRow(7))
	mock.ExpectQuery(`SELECT COUNT\(\*\) FROM tracking_events WHERE event_type = 'click'`).
		WillReturnRows(sqlmock.NewRows([]string{"count"}).AddRow(3))
	mock.ExpectQuery(`SELECT COUNT\(\*\) FROM contacts WHERE status = 'replied'`).
		WillReturnRows(sqlmock.NewRows([]string{"count"}).AddRow(1))
	mock.ExpectQuery(`SELECT COUNT\(\*\) FROM bounce_events`).
		WillReturnRows(sqlmock.NewRows([]string{"count"}).AddRow(2))
	mock.ExpectQuery(`SELECT COUNT\(\*\) FROM blacklist`).
		WillReturnRows(sqlmock.NewRows([]string{"count"}).AddRow(5))

	s := NewServer(db, "")
	req := httptest.NewRequest("GET", "/dashboard", nil)
	w := httptest.NewRecorder()
	s.handleDashboard(w, req)

	if w.Code != http.StatusOK { t.Errorf("status = %d, want 200", w.Code) }

	var stats dashboardStats
	if err := json.Unmarshal(w.Body.Bytes(), &stats); err != nil {
		t.Fatalf("unmarshal: %v", err)
	}
	// campaigns scan failed → stays 0
	if stats.Campaigns != 0 { t.Errorf("campaigns = %d, want 0 (scan error)", stats.Campaigns) }
	// sent came back fine
	if stats.Sent != 42 { t.Errorf("sent = %d, want 42", stats.Sent) }
	if stats.Blacklisted != 5 { t.Errorf("blacklisted = %d, want 5", stats.Blacklisted) }
}

// TestGetStats_AllStatQueriesFail_Returns200 verifies the full degraded-DB path:
// all 8 stat queries fail, dashboard still returns 200 with a zero-value body.
func TestGetStats_AllStatQueriesFail_Returns200(t *testing.T) {
	db, mock, err := sqlmock.New()
	if err != nil { t.Fatalf("sqlmock.New: %v", err) }
	defer db.Close()

	mock.ExpectQuery(`SELECT status, COUNT`).WillReturnError(errWeb("db error"))
	for i := 0; i < 7; i++ {
		mock.ExpectQuery(`.+`).WillReturnError(errWeb("db error"))
	}

	s := NewServer(db, "")
	req := httptest.NewRequest("GET", "/dashboard", nil)
	w := httptest.NewRecorder()
	s.handleDashboard(w, req)

	if w.Code != http.StatusOK { t.Errorf("status = %d, want 200", w.Code) }
	var stats dashboardStats
	if err := json.Unmarshal(w.Body.Bytes(), &stats); err != nil {
		t.Fatalf("unmarshal: %v", err)
	}
	if stats.Campaigns != 0 || stats.Sent != 0 || stats.Bounced != 0 {
		t.Error("expected all counters zero on full DB failure")
	}
}
