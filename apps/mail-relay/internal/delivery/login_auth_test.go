package delivery_test

import (
	"net/smtp"
	"testing"
	"testing/quick"

	"relay/internal/delivery"
)

// ── LoginAuth challenge/response ─────────────────────────────────────────

func TestLoginAuth_Start_ReturnsLOGIN(t *testing.T) {
	auth := delivery.LoginAuth("user@example.com", "secret")
	mech, data, err := auth.Start(&smtp.ServerInfo{Name: "smtp.example.com"})
	if err != nil {
		t.Fatalf("Start() error: %v", err)
	}
	if mech != "LOGIN" {
		t.Errorf("expected mechanism LOGIN, got %q", mech)
	}
	if data != nil {
		t.Errorf("expected nil initial data, got %q", data)
	}
}

func TestLoginAuth_Next_UsernameChallenge(t *testing.T) {
	auth := delivery.LoginAuth("mazher.a@email.cz", "secret")
	challenges := []string{"Username:", "username:", "USERNAME:"}
	for _, c := range challenges {
		resp, err := auth.Next([]byte(c), true)
		if err != nil {
			t.Errorf("Next(%q) error: %v", c, err)
		}
		if string(resp) != "mazher.a@email.cz" {
			t.Errorf("Next(%q) = %q, want username", c, resp)
		}
	}
}

func TestLoginAuth_Next_PasswordChallenge(t *testing.T) {
	auth := delivery.LoginAuth("user@email.cz", "my-secret-pw")
	challenges := []string{"Password:", "password:", "PASSWORD:"}
	for _, c := range challenges {
		resp, err := auth.Next([]byte(c), true)
		if err != nil {
			t.Errorf("Next(%q) error: %v", c, err)
		}
		if string(resp) != "my-secret-pw" {
			t.Errorf("Next(%q) = %q, want password", c, resp)
		}
	}
}

func TestLoginAuth_Next_DonePhase_ReturnsNil(t *testing.T) {
	auth := delivery.LoginAuth("user", "pass")
	resp, err := auth.Next(nil, false)
	if err != nil {
		t.Fatalf("Next(nil, false) error: %v", err)
	}
	if resp != nil {
		t.Errorf("expected nil response when more=false, got %q", resp)
	}
}

func TestLoginAuth_Next_UnknownChallenge_ReturnsError(t *testing.T) {
	auth := delivery.LoginAuth("user", "pass")
	_, err := auth.Next([]byte("Unknown:"), true)
	if err == nil {
		t.Error("expected error for unknown challenge, got nil")
	}
}

func TestLoginAuth_EmptyCredentials_Safe(t *testing.T) {
	auth := delivery.LoginAuth("", "")
	mech, _, err := auth.Start(nil)
	if err != nil {
		t.Fatalf("Start() with empty creds error: %v", err)
	}
	if mech != "LOGIN" {
		t.Errorf("mechanism should be LOGIN even with empty creds")
	}
	resp, err := auth.Next([]byte("Username:"), true)
	if err != nil {
		t.Fatalf("Next() with empty user error: %v", err)
	}
	if string(resp) != "" {
		t.Errorf("expected empty username, got %q", resp)
	}
}

// ── MONKEY tests ──────────────────────────────────────────────────────────

func TestLoginAuth_NeverPanics_Property(t *testing.T) {
	f := func(user, pass string) bool {
		defer func() { recover() }()
		auth := delivery.LoginAuth(user, pass)
		auth.Start(&smtp.ServerInfo{Name: "smtp.test"}) //nolint:errcheck
		auth.Next([]byte("Username:"), true)             //nolint:errcheck
		auth.Next([]byte("Password:"), true)             //nolint:errcheck
		auth.Next(nil, false)                            //nolint:errcheck
		return true
	}
	if err := quick.Check(f, &quick.Config{MaxCount: 500}); err != nil {
		t.Errorf("LoginAuth panicked: %v", err)
	}
}

func TestLoginAuth_UnicodeCredentials_Safe(t *testing.T) {
	cases := []struct{ user, pass string }{
		{"uživatel@email.cz", "héslo123"},
		{"用户@mail.cn", "密码"},
		{"user@email.cz", string(make([]byte, 10000))},
	}
	for _, c := range cases {
		auth := delivery.LoginAuth(c.user, c.pass)
		func() {
			defer func() {
				if r := recover(); r != nil {
					t.Errorf("panic for user=%q: %v", c.user, r)
				}
			}()
			auth.Next([]byte("Username:"), true) //nolint:errcheck
			auth.Next([]byte("Password:"), true) //nolint:errcheck
		}()
	}
}
