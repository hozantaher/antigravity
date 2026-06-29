package minlog

import "testing"

func TestErrorKeyMasksPIIButPreservesContext(t *testing.T) {
	cases := []struct {
		name, in, want string
	}{
		{
			"smtp recipient rejection",
			"550 5.7.1 <info@auto-mt.com>: Recipient address rejected",
			"550 5.7.1 <i***@a***.com>: Recipient address rejected",
		},
		{
			"i/o timeout with IPv4",
			"i/o timeout connecting to 178.249.209.165:25",
			"i/o timeout connecting to 178.249.x.x:25",
		},
		{
			"clean SMTP code no PII",
			"535 5.7.0 Authentication failed",
			"535 5.7.0 Authentication failed",
		},
		{
			"tls handshake",
			"tls: handshake failure",
			"tls: handshake failure",
		},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			got := F("error", tc.in).Value
			if got != tc.want {
				t.Errorf("F(error, %q) = %q, want %q", tc.in, got, tc.want)
			}
		})
	}
}

func TestNonErrorKeysStillRedactEmails(t *testing.T) {
	got := F("to", "user@example.com").Value
	if got != "[REDACTED]" {
		t.Errorf("F(to, email) = %q, want [REDACTED]", got)
	}
}

func TestNonErrorKeysStillRedactIPs(t *testing.T) {
	got := F("ip", "1.2.3.4").Value
	if got != "[REDACTED]" {
		t.Errorf("F(ip, IP) = %q, want [REDACTED]", got)
	}
}
