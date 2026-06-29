package ares

import (
	"fmt"
	"net/http"
	"strings"
	"testing"
	"time"
)

// ── padICO ──

func TestPadICO_AlreadyEight(t *testing.T) {
	got := padICO("12345678")
	if got != "12345678" {
		t.Errorf("padICO(8-char) = %q, want %q", got, "12345678")
	}
}

func TestPadICO_Short(t *testing.T) {
	got := padICO("1234")
	if got != "00001234" {
		t.Errorf("padICO(4-char) = %q, want %q", got, "00001234")
	}
}

func TestPadICO_Empty(t *testing.T) {
	got := padICO("")
	if got != "00000000" {
		t.Errorf("padICO('') = %q, want %q", got, "00000000")
	}
}

// ── normalizeNACE ──

func TestNormalizeNACE_WithDot(t *testing.T) {
	got := normalizeNACE("68.20")
	if got != "6820" {
		t.Errorf("normalizeNACE = %q, want %q", got, "6820")
	}
}

func TestNormalizeNACE_WithoutDot(t *testing.T) {
	got := normalizeNACE("2899")
	if got != "2899" {
		t.Errorf("normalizeNACE = %q, want %q", got, "2899")
	}
}

func TestNormalizeNACE_Trim(t *testing.T) {
	got := normalizeNACE("  28.99  ")
	if got != "2899" {
		t.Errorf("normalizeNACE(padded) = %q, want %q", got, "2899")
	}
}

// ── resolveColumns ──

func TestResolveColumns_OK(t *testing.T) {
	header := []string{"ICO", "DDATVZN", "NACE", "FORMA", "DDATZAN"}
	cm, err := resolveColumns(header)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if cm.ico != 0 {
		t.Errorf("ico index = %d, want 0", cm.ico)
	}
	if cm.nace != 2 {
		t.Errorf("nace index = %d, want 2", cm.nace)
	}
}

func TestResolveColumns_MissingRequired(t *testing.T) {
	header := []string{"ICO", "DDATVZN"} // missing NACE
	_, err := resolveColumns(header)
	if err == nil {
		t.Fatal("expected error for missing NACE column")
	}
	if !strings.Contains(err.Error(), "NACE") {
		t.Errorf("error should mention NACE: %v", err)
	}
}

func TestResolveColumns_OptionalMissing(t *testing.T) {
	// FORMA and DDATZAN are optional — should resolve with -1 index
	header := []string{"ICO", "DDATVZN", "NACE"}
	cm, err := resolveColumns(header)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if cm.forma != -1 {
		t.Errorf("optional forma should be -1, got %d", cm.forma)
	}
}

// ── extractRow ──

func TestExtractRow_Normal(t *testing.T) {
	m := colMap{ico: 0, ddatvzn: 1, nace: 2, forma: 3, ddatzan: -1}
	record := []string{"12345678", "2020-01-01", "2899", "111"}
	row := extractRow(record, m)
	if row.ICO != "12345678" {
		t.Errorf("ICO = %q, want %q", row.ICO, "12345678")
	}
	if row.NACEPrimary != "2899" {
		t.Errorf("NACEPrimary = %q, want %q", row.NACEPrimary, "2899")
	}
}

func TestExtractRow_MissingOptional(t *testing.T) {
	// ddatzan column index -1 → should return ""
	m := colMap{ico: 0, ddatvzn: 1, nace: 2, forma: -1, ddatzan: -1}
	record := []string{"12345678", "2020-01-01", "2899"}
	row := extractRow(record, m)
	if row.LegalForm != "" {
		t.Errorf("missing forma should be empty, got %q", row.LegalForm)
	}
	if row.DatumZaniku != "" {
		t.Errorf("missing ddatzan should be empty, got %q", row.DatumZaniku)
	}
}

func TestExtractRow_OutOfBounds(t *testing.T) {
	// Column index beyond record length → should return ""
	m := colMap{ico: 0, nace: 10, ddatvzn: 1}
	record := []string{"12345678", "2020-01-01"}
	row := extractRow(record, m)
	if row.NACEPrimary != "" {
		t.Errorf("out-of-bounds nace should be empty, got %q", row.NACEPrimary)
	}
}

// ── FormatRESResult ──

func TestFormatRESResult_Basic(t *testing.T) {
	r := &RESImportResult{Parsed: 100, Updated: 50, NotFound: 10, Skipped: 5, Errors: 1}
	s := FormatRESResult(r, 10*time.Second)
	if !strings.Contains(s, "100") {
		t.Errorf("should contain parsed count: %s", s)
	}
	if !strings.Contains(s, "50") {
		t.Errorf("should contain updated count: %s", s)
	}
}

func TestFormatRESResult_ZeroElapsed(t *testing.T) {
	r := &RESImportResult{Parsed: 0}
	// elapsed = 0 → rate = 0 (guards against division by zero)
	s := FormatRESResult(r, 0)
	if !strings.Contains(s, "0/s") {
		t.Errorf("zero elapsed should show 0/s rate: %s", s)
	}
}

// ── notFoundError ──

func TestNotFoundError_Message(t *testing.T) {
	err := &notFoundError{ico: "12345678"}
	msg := err.Error()
	if !strings.Contains(msg, "12345678") {
		t.Errorf("error message should contain ICO: %q", msg)
	}
	if !strings.Contains(msg, "not found") {
		t.Errorf("error message should mention 'not found': %q", msg)
	}
}

// ── WithHTTPClient (functional option) ──

func TestWithHTTPClient(t *testing.T) {
	custom := &http.Client{}
	c := NewClient(WithHTTPClient(custom))
	if c.client != custom {
		t.Error("http client should be stored via WithHTTPClient option")
	}
}

// ── SyncConfig and SyncResult structs ──

func TestSyncConfig_Defaults(t *testing.T) {
	cfg := SyncConfig{}
	if cfg.BatchSize != 0 { t.Error("zero default") }
	if cfg.Concurrency != 0 { t.Error("zero concurrency") }
	if cfg.DryRun { t.Error("DryRun default false") }
}

func TestSyncConfig_WithValues(t *testing.T) {
	cfg := SyncConfig{BatchSize: 5000, Concurrency: 5, DryRun: true}
	if cfg.BatchSize != 5000 { t.Error("BatchSize") }
	if cfg.Concurrency != 5 { t.Error("Concurrency") }
	if !cfg.DryRun { t.Error("DryRun") }
}

func TestSyncResult_Struct(t *testing.T) {
	r := SyncResult{Total: 1000, Synced: 900, NotFound: 50, Errors: 10, Skipped: 40}
	if r.Total != 1000 { t.Error("Total") }
	if r.Synced != 900 { t.Error("Synced") }
	if r.NotFound != 50 { t.Error("NotFound") }
	if r.Errors != 10 { t.Error("Errors") }
	if r.Skipped != 40 { t.Error("Skipped") }
}

func TestSyncResult_ZeroValues(t *testing.T) {
	r := SyncResult{}
	if r.Total != 0 || r.Synced != 0 || r.NotFound != 0 || r.Errors != 0 || r.Skipped != 0 {
		t.Error("all fields should default to 0")
	}
}

// ── ParseSubject ──

func TestParseSubject_Full(t *testing.T) {
	resp := SubjectResponse{
		ICO:         "27082440",
		CzNace:      []string{"47910", "46510", "26110"},
		DatumVzniku: "2003-08-26",
		PravniForma: "121",
	}
	data := ParseSubject(resp)
	if data.ICO != "27082440" { t.Error("ICO") }
	if len(data.NACECodes) != 3 { t.Errorf("NACECodes: %v", data.NACECodes) }
	if data.NACEPrimary != "47910" { t.Error("NACEPrimary") }
	if data.DatumVzniku != "2003-08-26" { t.Error("DatumVzniku") }
	if data.PravniForma != "121" { t.Error("PravniForma") }
}

func TestParseSubject_NoNACE(t *testing.T) {
	resp := SubjectResponse{ICO: "12345678", CzNace: nil}
	data := ParseSubject(resp)
	if len(data.NACECodes) != 0 { t.Errorf("empty NACECodes: %v", data.NACECodes) }
	if data.NACEPrimary != "" { t.Error("NACEPrimary should be empty with no NACE") }
}

func TestParseSubject_EmptyCzNaceSlice(t *testing.T) {
	resp := SubjectResponse{ICO: "12345678", CzNace: []string{}}
	data := ParseSubject(resp)
	if data.NACEPrimary != "" { t.Error("NACEPrimary should be empty") }
}

func TestParseSubject_SingleNACE(t *testing.T) {
	resp := SubjectResponse{ICO: "99999999", CzNace: []string{"2841"}}
	data := ParseSubject(resp)
	if data.NACEPrimary != "2841" { t.Error("single NACEPrimary") }
}

// ── SubjectData struct ──

func TestSubjectData_Struct(t *testing.T) {
	d := SubjectData{
		ICO:         "12345678",
		NACECodes:   []string{"2841", "2899"},
		NACEPrimary: "2841",
		DatumVzniku: "1990-01-01",
		PravniForma: "112",
	}
	if d.ICO != "12345678" { t.Error("ICO") }
	if d.NACEPrimary != "2841" { t.Error("NACEPrimary") }
	if len(d.NACECodes) != 2 { t.Error("NACECodes") }
}

// ── NewClient options ──

func TestNewClient_Defaults(t *testing.T) {
	c := NewClient()
	if c == nil { t.Fatal("nil client") }
	if c.baseURL != defaultBaseURL { t.Error("default baseURL") }
	if c.rateLimit != defaultRateLimit { t.Error("default rateLimit") }
	if c.client == nil { t.Error("http client nil") }
}

func TestNewClient_WithBaseURL(t *testing.T) {
	c := NewClient(WithBaseURL("https://test.example.com"))
	if c.baseURL != "https://test.example.com" {
		t.Errorf("baseURL = %q", c.baseURL)
	}
}

func TestNewClient_WithRateLimit(t *testing.T) {
	c := NewClient(WithRateLimit(500 * time.Millisecond))
	if c.rateLimit != 500*time.Millisecond {
		t.Errorf("rateLimit = %v", c.rateLimit)
	}
}

func TestNewClient_ZeroRateLimit(t *testing.T) {
	c := NewClient(WithRateLimit(0))
	if c.rateLimit != 0 { t.Error("zero rateLimit") }
}

// ── isNotFound ──

func TestIsNotFound_True(t *testing.T) {
	err := &notFoundError{ico: "12345678"}
	if !isNotFound(err) { t.Error("should be notFound") }
}

func TestIsNotFound_False(t *testing.T) {
	if isNotFound(nil) { t.Error("nil should not be notFound") }
}

func TestIsNotFound_OtherError(t *testing.T) {
	err := fmt.Errorf("connection refused")
	if isNotFound(err) { t.Error("regular error should not be notFound") }
}
