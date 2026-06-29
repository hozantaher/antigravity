package mailbox

import (
	"fmt"
	"strings"
	"testing"
)

// Extends the existing single-case TestMailbox_Validate in mailbox_test.go
// with an exhaustive field-mutation matrix, port-boundary matrix, and
// address-format edge cases. Each invalid-field case is its own sub-test
// so coverage shows exactly which branch flipped.

func baseValid() Mailbox {
	cap_ := 100
	return Mailbox{
		FromAddress:      "jan@sender.test",
		DisplayName:      "Jan Novák",
		SMTPHost:         "smtp.sender.test",
		SMTPPort:         587,
		IMAPHost:         "imap.sender.test",
		IMAPPort:         993,
		DailyCapOverride: &cap_,
		TZ:               "Europe/Prague",
		Locale:           "cs-CZ",
		Status:           StatusActive,
	}
}

func TestMailbox_Validate_HappyPath(t *testing.T) {
	if err := baseValid().Validate(); err != nil {
		t.Fatalf("baseline should validate clean, got %v", err)
	}
}

func TestMailbox_Validate_FromAddressMustExist(t *testing.T) {
	cases := []string{"", " ", "   ", "\t", "\n"}
	for _, addr := range cases {
		t.Run(fmt.Sprintf("addr=%q", addr), func(t *testing.T) {
			m := baseValid()
			m.FromAddress = addr
			if err := m.Validate(); err == nil {
				t.Errorf("empty-ish FromAddress should fail: %q", addr)
			}
		})
	}
}

func TestMailbox_Validate_FromAddressMustBeNormalised(t *testing.T) {
	cases := []string{
		"JAN@sender.test",
		"Jan@Sender.Test",
		" jan@sender.test",
		"jan@sender.test ",
		"JAN@SENDER.TEST",
	}
	for _, addr := range cases {
		t.Run(addr, func(t *testing.T) {
			m := baseValid()
			m.FromAddress = addr
			err := m.Validate()
			if err == nil {
				t.Errorf("non-canonical address should fail: %q", addr)
			}
			if err != nil && !strings.Contains(err.Error(), "lower-cased and trimmed") {
				t.Errorf("error message should mention normalisation: %v", err)
			}
		})
	}
}

func TestMailbox_Validate_DisplayNameRequired(t *testing.T) {
	cases := []string{"", " ", "\t", "\n", "   "}
	for _, v := range cases {
		t.Run(fmt.Sprintf("display=%q", v), func(t *testing.T) {
			m := baseValid()
			m.DisplayName = v
			if err := m.Validate(); err == nil {
				t.Errorf("empty DisplayName should fail: %q", v)
			}
		})
	}
}

func TestMailbox_Validate_SMTPHostRequired(t *testing.T) {
	cases := []string{"", " ", "\t"}
	for _, v := range cases {
		t.Run(fmt.Sprintf("smtp_host=%q", v), func(t *testing.T) {
			m := baseValid()
			m.SMTPHost = v
			if err := m.Validate(); err == nil {
				t.Errorf("empty SMTPHost should fail: %q", v)
			}
		})
	}
}

func TestMailbox_Validate_SMTPPortBoundaries(t *testing.T) {
	cases := []struct {
		port int
		ok   bool
	}{
		{-1, false},
		{0, false},
		{1, true},
		{25, true},
		{465, true},
		{587, true},
		{2525, true},
		{8080, true},
		{65534, true},
		{65535, true},
		{65536, false},
		{99999, false},
	}
	for _, c := range cases {
		t.Run(fmt.Sprintf("port=%d", c.port), func(t *testing.T) {
			m := baseValid()
			m.SMTPPort = c.port
			err := m.Validate()
			if c.ok && err != nil {
				t.Errorf("port %d should be accepted: %v", c.port, err)
			}
			if !c.ok && err == nil {
				t.Errorf("port %d should be rejected", c.port)
			}
		})
	}
}

func TestMailbox_Validate_IMAPPortRequiresHost(t *testing.T) {
	// IMAPPort is ignored if IMAPHost is empty (optional IMAP).
	m := baseValid()
	m.IMAPHost = ""
	m.IMAPPort = 0
	if err := m.Validate(); err != nil {
		t.Errorf("IMAP disabled (empty host) should accept IMAPPort=0, got %v", err)
	}
	m.IMAPPort = -999
	if err := m.Validate(); err != nil {
		t.Errorf("IMAP disabled should ignore IMAPPort: %v", err)
	}
}

func TestMailbox_Validate_IMAPPortBoundaries_HostSet(t *testing.T) {
	cases := []struct {
		port int
		ok   bool
	}{
		{-1, false},
		{0, false},
		{1, true},
		{143, true},
		{993, true},
		{65535, true},
		{65536, false},
	}
	for _, c := range cases {
		t.Run(fmt.Sprintf("port=%d", c.port), func(t *testing.T) {
			m := baseValid()
			m.IMAPHost = "imap.sender.test"
			m.IMAPPort = c.port
			err := m.Validate()
			if c.ok && err != nil {
				t.Errorf("IMAP port %d should be accepted: %v", c.port, err)
			}
			if !c.ok && err == nil {
				t.Errorf("IMAP port %d should be rejected", c.port)
			}
		})
	}
}

func TestMailbox_Validate_DailyCapOverride(t *testing.T) {
	cases := []struct {
		val *int
		ok  bool
	}{
		{nil, true}, // nil = defer to warmup daemon
		{intPtr(0), true},
		{intPtr(1), true},
		{intPtr(100), true},
		{intPtr(10_000), true},
		{intPtr(-1), false},
		{intPtr(-100), false},
	}
	for _, c := range cases {
		label := "nil"
		if c.val != nil {
			label = fmt.Sprint(*c.val)
		}
		t.Run(label, func(t *testing.T) {
			m := baseValid()
			m.DailyCapOverride = c.val
			err := m.Validate()
			if c.ok && err != nil {
				t.Errorf("cap %s should be accepted: %v", label, err)
			}
			if !c.ok && err == nil {
				t.Errorf("cap %s should be rejected", label)
			}
		})
	}
}

func intPtr(i int) *int { return &i }

func TestMailbox_Validate_StatusValues(t *testing.T) {
	valid := []Status{StatusActive, StatusPaused, StatusBounceHold, StatusRetired}
	invalid := []Status{"", "unknown", "ACTIVE", "active ", "disabled", "Status"}
	for _, s := range valid {
		t.Run("valid/"+string(s), func(t *testing.T) {
			m := baseValid()
			m.Status = s
			if err := m.Validate(); err != nil {
				t.Errorf("status %q should be accepted: %v", s, err)
			}
		})
	}
	for _, s := range invalid {
		t.Run("invalid/"+string(s), func(t *testing.T) {
			m := baseValid()
			m.Status = s
			if err := m.Validate(); err == nil {
				t.Errorf("status %q should be rejected", s)
			}
		})
	}
}

// ─── NormaliseAddress ──────────────────────────────────────────────

func TestNormaliseAddress_Cases(t *testing.T) {
	cases := map[string]string{
		"":                 "",
		" ":                "",
		"\t":               "",
		"\n":               "",
		"a@b.c":            "a@b.c",
		"A@B.C":            "a@b.c",
		"  ABC@xy.com":     "abc@xy.com",
		"ABC@xy.com\t":     "abc@xy.com",
		"User@Example.Org": "user@example.org",
	}
	for in, want := range cases {
		t.Run(fmt.Sprintf("%q", in), func(t *testing.T) {
			if got := NormaliseAddress(in); got != want {
				t.Errorf("NormaliseAddress(%q) = %q, want %q", in, got, want)
			}
		})
	}
}

func TestNormaliseAddress_Idempotent(t *testing.T) {
	cases := []string{"a@b.c", "foo@bar.org", "user.name+tag@host.tld"}
	for _, in := range cases {
		t.Run(in, func(t *testing.T) {
			once := NormaliseAddress(in)
			twice := NormaliseAddress(once)
			if once != twice {
				t.Errorf("not idempotent: %q → %q → %q", in, once, twice)
			}
		})
	}
}

// ─── Status methods ─────────────────────────────────────────────────

func TestStatus_ValidExhaustive(t *testing.T) {
	valid := []Status{StatusActive, StatusPaused, StatusBounceHold, StatusRetired}
	invalid := []Status{
		"", "Active", "paused ", " active", "bounce-hold",
		"retired!", "ACTIVE", "unknown", "deleted", "archived",
	}
	for _, s := range valid {
		if !s.Valid() {
			t.Errorf("%q should be valid", s)
		}
	}
	for _, s := range invalid {
		if s.Valid() {
			t.Errorf("%q should be invalid", s)
		}
	}
}

func TestStatus_SendableOnlyActive(t *testing.T) {
	cases := map[Status]bool{
		StatusActive:     true,
		StatusPaused:     false,
		StatusBounceHold: false,
		StatusRetired:    false,
		"":               false,
		"other":          false,
	}
	for s, want := range cases {
		if got := s.Sendable(); got != want {
			t.Errorf("%q.Sendable(): got %v want %v", s, got, want)
		}
	}
}
