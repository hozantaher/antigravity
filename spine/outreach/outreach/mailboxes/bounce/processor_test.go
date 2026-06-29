package bounce

import (
	"database/sql"
	"testing"
)

// ── Mock DB ──

type mockResult struct{ affected int64 }
func (m mockResult) LastInsertId() (int64, error) { return 0, nil }
func (m mockResult) RowsAffected() (int64, error) { return m.affected, nil }

type mockDB struct {
	execErr error
}

func (m *mockDB) QueryRow(_ string, _ ...any) *sql.Row { return nil }
func (m *mockDB) Exec(_ string, _ ...any) (sql.Result, error) {
	if m.execErr != nil { return nil, m.execErr }
	return mockResult{affected: 1}, nil
}

// ── ClassifyBounce (pure function — comprehensive) ──

func TestClassifyBounce_Hard_Codes(t *testing.T) {
	codes := []string{"550", "551", "552", "553", "554"}
	for _, code := range codes {
		got := ClassifyBounce(code, "some error")
		if got != BounceHard { t.Errorf("ClassifyBounce(%s, ...) = %s, want hard", code, got) }
	}
}

func TestClassifyBounce_Hard_Keywords(t *testing.T) {
	keywords := []string{
		"user unknown", "mailbox not found", "no such user",
		"does not exist", "invalid recipient", "rejected",
		"address rejected", "undeliverable", "permanent",
	}
	for _, kw := range keywords {
		got := ClassifyBounce("500", kw)
		if got != BounceHard { t.Errorf("ClassifyBounce(500, %q) = %s, want hard", kw, got) }
	}
}

func TestClassifyBounce_Soft(t *testing.T) {
	cases := []struct{ code, msg string }{
		{"421", "try again later"}, {"450", "mailbox busy"},
		{"452", "insufficient storage"}, {"422", "connection timed out"},
		{"400", "general failure"}, {"431", "server busy"},
	}
	for _, tc := range cases {
		got := ClassifyBounce(tc.code, tc.msg)
		if got != BounceSoft { t.Errorf("ClassifyBounce(%s, %q) = %s, want soft", tc.code, tc.msg, got) }
	}
}

func TestClassifyBounce_Complaint(t *testing.T) {
	keywords := []string{"complaint", "spam", "abuse", "junk",
		"SPAM complaint", "Abuse Report", "Junk mail filter"}
	for _, kw := range keywords {
		got := ClassifyBounce("550", kw)
		if got != BounceComplaint { t.Errorf("ClassifyBounce(550, %q) = %s, want complaint", kw, got) }
	}
}

func TestClassifyBounce_ComplaintOverridesHard(t *testing.T) {
	if ClassifyBounce("550", "spam abuse") != BounceComplaint {
		t.Error("complaint should override hard bounce code")
	}
}

func TestClassifyBounce_CaseInsensitive(t *testing.T) {
	if ClassifyBounce("550", "USER UNKNOWN") != BounceHard { t.Error("not case-insensitive") }
	if ClassifyBounce("550", "SPAM") != BounceComplaint { t.Error("not case-insensitive complaint") }
}

func TestClassifyBounce_EmptyMessage(t *testing.T) {
	// 5xx code with empty message → hard bounce (code match)
	if ClassifyBounce("550", "") != BounceHard { t.Error("550 with empty msg should be hard") }
}

func TestClassifyBounce_Non5xxCode(t *testing.T) {
	if ClassifyBounce("400", "random error") != BounceSoft { t.Error("4xx should be soft") }
}

func TestClassifyBounce_EmptyCode(t *testing.T) {
	if ClassifyBounce("", "random error") != BounceSoft { t.Error("empty code should default to soft") }
}

// ── Type Constants ──

func TestBounceType_Constants(t *testing.T) {
	if BounceHard != "hard" { t.Error("hard") }
	if BounceSoft != "soft" { t.Error("soft") }
	if BounceComplaint != "complaint" { t.Error("complaint") }
}

// ── Event Struct ──

func TestEvent_Struct(t *testing.T) {
	e := Event{OriginalMessageID: "abc@f.cz", Type: BounceHard, Code: "550", Reason: "user unknown", RawMessage: "full SMTP"}
	if e.Type != BounceHard { t.Error("type") }
	if e.Code != "550" { t.Error("code") }
	if e.OriginalMessageID != "abc@f.cz" { t.Error("msg id") }
}

func TestEvent_AllBounceTypes(t *testing.T) {
	for _, bt := range []BounceType{BounceHard, BounceSoft, BounceComplaint} {
		e := Event{Type: bt}
		if e.Type != bt { t.Errorf("type mismatch: %s", bt) }
	}
}

// ── Constructor ──

func TestNewProcessor(t *testing.T) {
	p := NewProcessor(&mockDB{})
	if p == nil { t.Fatal("nil") }
}

func TestNewProcessor_NilDB(t *testing.T) {
	p := NewProcessor(nil)
	if p == nil { t.Fatal("nil with nil db") }
}

// ── CheckBlacklist via mockDB — behavior tests ──
// The real DB-backed blacklist tests live in processor_sqlmock_test.go.
// Here we verify non-DB behavior: the constructor stores the DB and the
// type is correct.  We do NOT call CheckBlacklist with the nil-Row mockDB
// because that panics in sql.(*Row).Scan — use sqlmock for that instead.

func TestCheckBlacklist_ProcessorHoldsDB(t *testing.T) {
	mdb := &mockDB{}
	p := NewProcessor(mdb)
	if p.db != mdb {
		t.Error("Processor should hold exactly the DB passed to NewProcessor")
	}
}

// ── ClassifyBounce edge cases ──

func TestClassifyBounce_Subcode_550(t *testing.T) {
	// 5500 starts with "550" → hard
	if ClassifyBounce("5500", "unknown") != BounceHard {
		t.Error("5500 should be hard bounce")
	}
}

func TestClassifyBounce_Complaint_SpamKeyword(t *testing.T) {
	// Complaint overrides everything including hard code
	got := ClassifyBounce("550", "spam complaint received")
	if got != BounceComplaint {
		t.Errorf("complaint keyword wins, got %s", got)
	}
}

func TestClassifyBounce_MixedCaseKeywords(t *testing.T) {
	cases := []struct {
		msg  string
		want BounceType
	}{
		{"User Unknown", BounceHard},
		{"MAILBOX NOT FOUND", BounceHard},
		{"No Such User", BounceHard},
		{"Address Rejected", BounceHard},
	}
	for _, tc := range cases {
		got := ClassifyBounce("500", tc.msg)
		if got != tc.want {
			t.Errorf("ClassifyBounce(500, %q) = %s, want %s", tc.msg, got, tc.want)
		}
	}
}

func TestClassifyBounce_SoftCodes(t *testing.T) {
	softCodes := []string{"421", "450", "451", "452", "422", "400"}
	for _, code := range softCodes {
		got := ClassifyBounce(code, "transient error")
		if got != BounceSoft {
			t.Errorf("ClassifyBounce(%s, ...) = %s, want soft", code, got)
		}
	}
}

func TestClassifyBounce_AllHardKeywords(t *testing.T) {
	hardMessages := []struct {
		code string
		msg  string
	}{
		{"400", "user unknown error"},
		{"400", "mailbox not found here"},
		{"400", "no such user exists"},
		{"400", "does not exist in system"},
		{"400", "invalid recipient address"},
		{"400", "message rejected permanently"},
		{"400", "address rejected by server"},
		{"400", "message is undeliverable"},
		{"400", "permanent delivery failure"},
	}
	for _, tc := range hardMessages {
		got := ClassifyBounce(tc.code, tc.msg)
		if got != BounceHard {
			t.Errorf("ClassifyBounce(%q, %q) = %s, want hard", tc.code, tc.msg, got)
		}
	}
}
