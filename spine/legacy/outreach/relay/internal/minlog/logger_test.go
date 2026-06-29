package minlog

import (
	"bytes"
	"log"
	"strings"
	"testing"
	"time"
)

func TestFieldRedactsIP(t *testing.T) {
	f := F("source", "192.168.1.1")
	if f.Value != "[REDACTED]" {
		t.Fatalf("expected [REDACTED] for IP, got %s", f.Value)
	}
}

func TestFieldRedactsEmail(t *testing.T) {
	f := F("sender", "user@example.com")
	if f.Value != "[REDACTED]" {
		t.Fatalf("expected [REDACTED] for email, got %s", f.Value)
	}
}

func TestFieldRedactsSensitiveKeys(t *testing.T) {
	cases := []string{"ip_address", "remote_addr", "email", "content", "body", "password", "secret"}
	for _, key := range cases {
		f := F(key, "some value")
		if f.Value != "[REDACTED]" {
			t.Fatalf("key %q should be redacted, got %s", key, f.Value)
		}
	}
}

func TestFieldAllowsSafeValues(t *testing.T) {
	f := F("envelope_id", "env_abc123")
	if f.Value != "env_abc123" {
		t.Fatalf("safe value should pass through, got %s", f.Value)
	}

	f2 := F("status", "accepted")
	if f2.Value != "accepted" {
		t.Fatalf("safe value should pass through, got %s", f2.Value)
	}
}

func TestFieldRedactsIPv6(t *testing.T) {
	f := F("source", "::1")
	if f.Value != "[REDACTED]" {
		t.Fatalf("expected [REDACTED] for IPv6, got %s", f.Value)
	}
}

// captureLog swaps the stdlib log output so tests can assert on emitted lines
// without leaking noise into test output.
func captureLog(t *testing.T) *bytes.Buffer {
	t.Helper()
	buf := &bytes.Buffer{}
	origOut := log.Writer()
	origFlags := log.Flags()
	origPrefix := log.Prefix()
	log.SetOutput(buf)
	log.SetFlags(0)
	log.SetPrefix("")
	t.Cleanup(func() {
		log.SetOutput(origOut)
		log.SetFlags(origFlags)
		log.SetPrefix(origPrefix)
	})
	return buf
}

func TestNewAssignsPrefix(t *testing.T) {
	l := New("relay")
	if l == nil {
		t.Fatal("New returned nil")
	}
	if l.prefix != "relay" {
		t.Fatalf("prefix = %q, want %q", l.prefix, "relay")
	}
}

func TestLoggerInfoEmitsFormattedLine(t *testing.T) {
	buf := captureLog(t)
	l := New("relay")
	l.Info("accepted", F("envelope_id", "env_123"), F("status", "ok"))

	got := buf.String()
	for _, want := range []string{"[INFO]", "relay:", "accepted", "envelope_id=env_123", "status=ok"} {
		if !strings.Contains(got, want) {
			t.Errorf("output %q missing %q", got, want)
		}
	}
}

func TestLoggerErrorEmitsFormattedLine(t *testing.T) {
	buf := captureLog(t)
	l := New("vault")
	l.Error("decrypt failed", F("envelope_id", "env_xyz"))

	got := buf.String()
	if !strings.Contains(got, "[ERROR]") {
		t.Errorf("expected [ERROR] prefix in %q", got)
	}
	if !strings.Contains(got, "vault:") {
		t.Errorf("expected logger prefix in %q", got)
	}
	if !strings.Contains(got, "decrypt failed") {
		t.Errorf("expected message in %q", got)
	}
	if !strings.Contains(got, "envelope_id=env_xyz") {
		t.Errorf("expected field in %q", got)
	}
}

func TestLoggerEmitWithNoFields(t *testing.T) {
	buf := captureLog(t)
	l := New("svc")
	l.Info("starting")

	got := strings.TrimSpace(buf.String())
	want := "[INFO] svc: starting"
	if got != want {
		t.Errorf("emit with no fields = %q, want %q", got, want)
	}
}

func TestLoggerRedactsFieldsAtEmit(t *testing.T) {
	buf := captureLog(t)
	l := New("svc")
	// F() should redact the value before emit sees it.
	l.Info("received", F("ip", "10.0.0.1"))

	got := buf.String()
	if strings.Contains(got, "10.0.0.1") {
		t.Errorf("raw IP leaked into output: %q", got)
	}
	if !strings.Contains(got, "ip=[REDACTED]") {
		t.Errorf("expected redacted field in %q", got)
	}
}

func TestBucketedTime(t *testing.T) {
	tests := []struct {
		name  string
		in    time.Time
		wantV string
	}{
		{
			name:  "truncates to 15-minute boundary",
			in:    time.Date(2026, 4, 17, 12, 37, 45, 123456789, time.UTC),
			wantV: "2026-04-17T12:30:00Z",
		},
		{
			name:  "on-boundary stays unchanged",
			in:    time.Date(2026, 4, 17, 12, 45, 0, 0, time.UTC),
			wantV: "2026-04-17T12:45:00Z",
		},
		{
			name:  "converts non-UTC to UTC",
			in:    time.Date(2026, 4, 17, 14, 3, 10, 0, time.FixedZone("CET", 2*60*60)),
			wantV: "2026-04-17T12:00:00Z",
		},
	}
	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			f := BucketedTime("when", tc.in)
			if f.Key != "when" {
				t.Errorf("key = %q, want %q", f.Key, "when")
			}
			if f.Value != tc.wantV {
				t.Errorf("value = %q, want %q", f.Value, tc.wantV)
			}
		})
	}
}

func TestLooksLikeIP(t *testing.T) {
	tests := []struct {
		name string
		in   string
		want bool
	}{
		{"ipv4", "192.168.1.1", true},
		{"ipv4_low", "0.0.0.0", true},
		{"ipv4_with_extra_octet", "192.168.1.1.5", false},
		{"ipv4_too_long_octet", "1234.5.6.7", false},
		{"ipv4_with_empty_octet", "192..1.1", false},
		{"ipv4_with_nondigit", "192.168.1.a", false},
		{"ipv6_shorthand", "::1", true},
		{"ipv6_full", "fe80::1ff:fe23:4567:890a", true},
		{"ipv6_two_colons", "a:b:c", true},
		{"hostname", "relay.example.internal", false},
		{"plain_word", "hello", false},
		{"single_colon", "key:value", false},
		{"empty", "", false},
	}
	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			if got := looksLikeIP(tc.in); got != tc.want {
				t.Errorf("looksLikeIP(%q) = %v, want %v", tc.in, got, tc.want)
			}
		})
	}
}

func TestIsForbidden(t *testing.T) {
	tests := []struct {
		name  string
		key   string
		value string
		want  bool
	}{
		{"safe_pair", "envelope_id", "env_abc", false},
		{"key_addr", "remote_addr", "value", true},
		{"key_x_forwarded", "x-forwarded-for", "value", true},
		{"key_identity", "real_identity", "value", true},
		{"key_subject", "subject_hash", "value", true},
		{"key_token", "auth_token", "value", true},
		{"key_key", "api_key", "value", true},
		{"value_email_like", "note", "user@host.tld", true},
		{"value_at_no_dot", "note", "user@localhost", false},
		{"value_ipv4", "sample", "8.8.8.8", true},
		{"value_ipv6", "sample", "2001::1", true},
	}
	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			if got := isForbidden(tc.key, tc.value); got != tc.want {
				t.Errorf("isForbidden(%q, %q) = %v, want %v", tc.key, tc.value, got, tc.want)
			}
		})
	}
}
