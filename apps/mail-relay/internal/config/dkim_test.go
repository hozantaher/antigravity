package config

import (
	"encoding/base64"
	"testing"
)

// TestDKIMConfig_DisabledWhenBothEnvMissing verifies Enabled=false when neither env is set.
func TestDKIMConfig_DisabledWhenBothEnvMissing(t *testing.T) {
	t.Setenv("DKIM_DOMAIN", "")
	t.Setenv("DKIM_PRIVATE_KEY_B64", "")
	t.Setenv("DKIM_SELECTOR", "")

	cfg := Load()

	if cfg.DKIM.Enabled {
		t.Fatal("DKIM.Enabled = true, want false when both env vars are unset")
	}
}

// TestDKIMConfig_DisabledWhenOnlyDomainSet verifies Enabled=false when key is missing.
func TestDKIMConfig_DisabledWhenOnlyDomainSet(t *testing.T) {
	t.Setenv("DKIM_DOMAIN", "example.com")
	t.Setenv("DKIM_PRIVATE_KEY_B64", "")
	t.Setenv("DKIM_SELECTOR", "")

	cfg := Load()

	if cfg.DKIM.Enabled {
		t.Fatal("DKIM.Enabled = true, want false when DKIM_PRIVATE_KEY_B64 is unset")
	}
}

// TestDKIMConfig_DisabledWhenOnlyKeySet verifies Enabled=false when domain is missing.
func TestDKIMConfig_DisabledWhenOnlyKeySet(t *testing.T) {
	t.Setenv("DKIM_DOMAIN", "")
	t.Setenv("DKIM_PRIVATE_KEY_B64", base64.StdEncoding.EncodeToString([]byte("fake-key")))
	t.Setenv("DKIM_SELECTOR", "")

	cfg := Load()

	if cfg.DKIM.Enabled {
		t.Fatal("DKIM.Enabled = true, want false when DKIM_DOMAIN is unset")
	}
}

// TestDKIMConfig_EnabledWhenBothEnvSet verifies Enabled=true when both env vars are set.
func TestDKIMConfig_EnabledWhenBothEnvSet(t *testing.T) {
	fakeKey := []byte("-----BEGIN RSA PRIVATE KEY-----\nMIIFakeKey\n-----END RSA PRIVATE KEY-----")
	t.Setenv("DKIM_DOMAIN", "outreach-relay.example.com")
	t.Setenv("DKIM_PRIVATE_KEY_B64", base64.StdEncoding.EncodeToString(fakeKey))
	t.Setenv("DKIM_SELECTOR", "")

	cfg := Load()

	if !cfg.DKIM.Enabled {
		t.Fatal("DKIM.Enabled = false, want true when both env vars are set")
	}
	if cfg.DKIM.Domain != "outreach-relay.example.com" {
		t.Fatalf("DKIM.Domain = %q, want %q", cfg.DKIM.Domain, "outreach-relay.example.com")
	}
	if string(cfg.DKIM.PrivateKey) != string(fakeKey) {
		t.Fatalf("DKIM.PrivateKey mismatch: got %q", cfg.DKIM.PrivateKey)
	}
}

// TestDKIMConfig_SelectorDefaultOutreach verifies the default selector.
func TestDKIMConfig_SelectorDefaultOutreach(t *testing.T) {
	t.Setenv("DKIM_DOMAIN", "")
	t.Setenv("DKIM_PRIVATE_KEY_B64", "")
	t.Setenv("DKIM_SELECTOR", "")

	cfg := Load()

	if cfg.DKIM.Selector != "outreach" {
		t.Fatalf("DKIM.Selector = %q, want %q", cfg.DKIM.Selector, "outreach")
	}
}

// TestDKIMConfig_SelectorCustomOverridesDefault verifies DKIM_SELECTOR env is respected.
func TestDKIMConfig_SelectorCustomOverridesDefault(t *testing.T) {
	fakeKey := []byte("fake-key-bytes")
	t.Setenv("DKIM_DOMAIN", "example.com")
	t.Setenv("DKIM_PRIVATE_KEY_B64", base64.StdEncoding.EncodeToString(fakeKey))
	t.Setenv("DKIM_SELECTOR", "mail2026")

	cfg := Load()

	if cfg.DKIM.Selector != "mail2026" {
		t.Fatalf("DKIM.Selector = %q, want %q", cfg.DKIM.Selector, "mail2026")
	}
}

// TestDKIMConfig_DisabledOnInvalidBase64 verifies graceful fallback on bad base64.
func TestDKIMConfig_DisabledOnInvalidBase64(t *testing.T) {
	t.Setenv("DKIM_DOMAIN", "example.com")
	t.Setenv("DKIM_PRIVATE_KEY_B64", "!!!not-valid-base64!!!")
	t.Setenv("DKIM_SELECTOR", "")

	cfg := Load()

	if cfg.DKIM.Enabled {
		t.Fatal("DKIM.Enabled = true, want false for invalid base64 key")
	}
}

// TestDKIMConfig_PrivateKeyDecodedCorrectly verifies the decoded key matches the input.
func TestDKIMConfig_PrivateKeyDecodedCorrectly(t *testing.T) {
	expected := []byte("my-super-secret-key-pem-data")
	t.Setenv("DKIM_DOMAIN", "relay.example.com")
	t.Setenv("DKIM_PRIVATE_KEY_B64", base64.StdEncoding.EncodeToString(expected))
	t.Setenv("DKIM_SELECTOR", "")

	cfg := Load()

	if string(cfg.DKIM.PrivateKey) != string(expected) {
		t.Fatalf("DKIM.PrivateKey = %q, want %q", cfg.DKIM.PrivateKey, expected)
	}
}

// TestDKIMConfig_DoesNotAffectOtherConfigFields verifies DKIM addition doesn't break existing fields.
func TestDKIMConfig_DoesNotAffectOtherConfigFields(t *testing.T) {
	t.Setenv("DKIM_DOMAIN", "")
	t.Setenv("DKIM_PRIVATE_KEY_B64", "")
	t.Setenv("LISTEN_ADDR", "")
	t.Setenv("RELAY_MIN_DELAY_SECONDS", "")
	t.Setenv("SMTP_PORT", "")

	cfg := Load()

	if cfg.ListenAddr != ":8090" {
		t.Fatalf("ListenAddr = %q, want :8090", cfg.ListenAddr)
	}
	if cfg.RelayMinDelaySeconds != 30 {
		t.Fatalf("RelayMinDelaySeconds = %d, want 30", cfg.RelayMinDelaySeconds)
	}
	if cfg.SMTPPort != 587 {
		t.Fatalf("SMTPPort = %d, want 587", cfg.SMTPPort)
	}
}
