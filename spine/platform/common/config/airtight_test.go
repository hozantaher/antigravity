// Tests pro AT2.2 airtight gate (ADR-005).
//
// Pinujeme:
//   - LoadFromEnv parsing TRANSPORT_MODE + LAB_ONLY,
//   - SendingConfig.ValidateAirtight refuses banned/unknown modes a
//     LabOnly mismatch,
//   - Production backward-compat (LAB_ONLY unset, TRANSPORT_MODE=proxy)
//     pass-through bez change.
//
// Cíl: brutal — ≥12 asserts (D2/D3 z ADR-005). Žádné spekulace ani
// fabricated samples — jenom enum coverage + boot-gate behaviour.
package config

import (
	"errors"
	"os"
	"testing"
)

// withEnv saves + restores env vars so test cases don't leak state.
// Any var listed but absent in `set` gets cleared during fn(), then
// restored to its prior value (or unset if not previously set).
func withEnv(t *testing.T, set map[string]string, fn func()) {
	t.Helper()
	keys := []string{"TRANSPORT_MODE", "LAB_ONLY"}
	prev := make(map[string]string, len(keys))
	exists := make(map[string]bool, len(keys))
	for _, k := range keys {
		v, ok := os.LookupEnv(k)
		prev[k], exists[k] = v, ok
	}
	defer func() {
		for _, k := range keys {
			if exists[k] {
				_ = os.Setenv(k, prev[k])
			} else {
				_ = os.Unsetenv(k)
			}
		}
	}()
	for _, k := range keys {
		if v, ok := set[k]; ok {
			_ = os.Setenv(k, v)
		} else {
			_ = os.Unsetenv(k)
		}
	}
	fn()
}

func TestValidateAirtight_DefaultsToProxy(t *testing.T) {
	// Empty TransportMode + LabOnly=false → backward-compat (legacy prod).
	s := SendingConfig{}
	if err := s.ValidateAirtight(); err != nil {
		t.Fatalf("empty config should pass (legacy prod), got %v", err)
	}
}

func TestValidateAirtight_AllowedModesPass(t *testing.T) {
	for _, mode := range []string{
		TransportModeLab,
		TransportModeProxy,
		TransportModeSocks5,
		TransportModeTor,
		TransportModeVPN,
		TransportModeVPNTor,
	} {
		t.Run("mode="+mode, func(t *testing.T) {
			s := SendingConfig{TransportMode: mode}
			if err := s.ValidateAirtight(); err != nil {
				t.Errorf("mode %q should pass, got %v", mode, err)
			}
		})
	}
}

func TestValidateAirtight_DirectIsBanned(t *testing.T) {
	s := SendingConfig{TransportMode: TransportModeDirectBanned}
	err := s.ValidateAirtight()
	if err == nil {
		t.Fatal("expected error for direct mode, got nil")
	}
	var ae *AirtightError
	if !errors.As(err, &ae) {
		t.Fatalf("expected AirtightError, got %T", err)
	}
	if ae.ExitCode != AirtightExitCodeBadMode {
		t.Errorf("expected exit %d, got %d", AirtightExitCodeBadMode, ae.ExitCode)
	}
	if !contains(ae.Message, "TRANSPORT_MODE=direct") {
		t.Errorf("message should mention banned mode: %s", ae.Message)
	}
}

func TestValidateAirtight_UnknownModeRejected(t *testing.T) {
	for _, mode := range []string{"foo", "PROXY", "Lab", "tor+lab", "vpn+vpn"} {
		t.Run("mode="+mode, func(t *testing.T) {
			s := SendingConfig{TransportMode: mode}
			err := s.ValidateAirtight()
			if err == nil {
				t.Fatalf("mode %q should be rejected, got nil", mode)
			}
			var ae *AirtightError
			if !errors.As(err, &ae) || ae.ExitCode != AirtightExitCodeBadMode {
				t.Errorf("expected ExitCode=%d, got err=%v", AirtightExitCodeBadMode, err)
			}
		})
	}
}

func TestValidateAirtight_LabOnlyRequiresLabMode(t *testing.T) {
	cases := []struct {
		name     string
		mode     string
		labOnly  bool
		wantPass bool
		wantCode int
	}{
		{"prod_default_no_lab_only", TransportModeProxy, false, true, 0},
		{"prod_socks5_no_lab_only", TransportModeSocks5, false, true, 0},
		{"lab_only_with_lab_mode_passes", TransportModeLab, true, true, 0},
		{"lab_only_with_proxy_refused", TransportModeProxy, true, false, AirtightExitCodeLabOnlyMismatch},
		{"lab_only_with_socks5_refused", TransportModeSocks5, true, false, AirtightExitCodeLabOnlyMismatch},
		{"lab_only_with_vpn_refused", TransportModeVPN, true, false, AirtightExitCodeLabOnlyMismatch},
		{"lab_only_with_empty_refused", "", true, false, AirtightExitCodeLabOnlyMismatch},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			s := SendingConfig{TransportMode: tc.mode, LabOnly: tc.labOnly}
			err := s.ValidateAirtight()
			if tc.wantPass {
				if err != nil {
					t.Errorf("expected pass, got %v", err)
				}
				return
			}
			if err == nil {
				t.Fatalf("expected refusal, got nil")
			}
			var ae *AirtightError
			if !errors.As(err, &ae) {
				t.Fatalf("expected AirtightError, got %T", err)
			}
			if ae.ExitCode != tc.wantCode {
				t.Errorf("expected ExitCode=%d, got %d (%s)", tc.wantCode, ae.ExitCode, ae.Message)
			}
		})
	}
}

func TestValidateAirtight_LabOnlyMessageOperatorUX(t *testing.T) {
	// Operator UX: when LabOnly trips the gate against a non-lab mode the
	// error message must (a) name the gate (LAB_ONLY=1), (b) name the
	// remediation knob (TRANSPORT_MODE=lab), and (c) embed the actual
	// rejected mode so an operator can grep their environment without
	// running the binary again. Ported from the deleted
	// services/orchestrator/cmd/outreach/airtight_test.go after
	// enforceAirtightGate was unified into ValidateAirtight.
	for _, mode := range []string{TransportModeProxy, TransportModeTor, TransportModeVPN, TransportModeSocks5} {
		t.Run("mode="+mode, func(t *testing.T) {
			s := SendingConfig{TransportMode: mode, LabOnly: true}
			err := s.ValidateAirtight()
			if err == nil {
				t.Fatalf("LabOnly + mode=%q must refuse, got nil", mode)
			}
			var ae *AirtightError
			if !errors.As(err, &ae) {
				t.Fatalf("expected AirtightError, got %T", err)
			}
			if !contains(ae.Message, "LAB_ONLY=1") {
				t.Errorf("message should reference LAB_ONLY=1: %q", ae.Message)
			}
			if !contains(ae.Message, "TRANSPORT_MODE=lab") {
				t.Errorf("message should reference required TRANSPORT_MODE=lab: %q", ae.Message)
			}
			if !contains(ae.Message, mode) {
				t.Errorf("message should embed actual mode %q: %q", mode, ae.Message)
			}
		})
	}
}

func TestLoadFromEnv_ParsesTransportMode(t *testing.T) {
	withEnv(t, map[string]string{"TRANSPORT_MODE": "lab", "LAB_ONLY": "1"}, func() {
		cfg := LoadFromEnv()
		if cfg.Sending.TransportMode != "lab" {
			t.Errorf("TransportMode = %q, want lab", cfg.Sending.TransportMode)
		}
		if !cfg.Sending.LabOnly {
			t.Error("LabOnly = false, want true")
		}
	})
}

func TestLoadFromEnv_LabOnlyAcceptsCommonTrueForms(t *testing.T) {
	for _, v := range []string{"1", "true", "TRUE", "yes", "on"} {
		t.Run("v="+v, func(t *testing.T) {
			withEnv(t, map[string]string{"LAB_ONLY": v}, func() {
				cfg := LoadFromEnv()
				if !cfg.Sending.LabOnly {
					t.Errorf("LAB_ONLY=%q should parse true", v)
				}
			})
		})
	}
}

func TestLoadFromEnv_LabOnlyAcceptsCommonFalseForms(t *testing.T) {
	for _, v := range []string{"0", "false", "FALSE", "no", "off", ""} {
		t.Run("v="+v, func(t *testing.T) {
			withEnv(t, map[string]string{"LAB_ONLY": v}, func() {
				cfg := LoadFromEnv()
				if cfg.Sending.LabOnly {
					t.Errorf("LAB_ONLY=%q should parse false", v)
				}
			})
		})
	}
}

func TestLoadFromEnv_LabOnlyTypoFallsBackToFalse(t *testing.T) {
	// Per envBoolOr: unrecognised value → fallback (false). Operator
	// fails loud only on Validate(); LoadFromEnv stays infallible.
	for _, v := range []string{"YES_PLEASE", "enabled", "garbage"} {
		t.Run("v="+v, func(t *testing.T) {
			withEnv(t, map[string]string{"LAB_ONLY": v}, func() {
				cfg := LoadFromEnv()
				if cfg.Sending.LabOnly {
					t.Errorf("LAB_ONLY=%q (typo) should fallback to false", v)
				}
			})
		})
	}
}

func TestValidate_AirtightRefusalSurfaces(t *testing.T) {
	// Top-level Config.Validate() must surface airtight failures even
	// when no mailboxes are configured (lab dev path).
	c := &Config{
		Sending: SendingConfig{TransportMode: "direct"},
	}
	err := c.Validate()
	if err == nil {
		t.Fatal("expected airtight error, got nil")
	}
	var ae *AirtightError
	if !errors.As(err, &ae) {
		t.Fatalf("expected AirtightError, got %T (%v)", err, err)
	}
}

func TestValidate_ProductionBackwardCompat(t *testing.T) {
	// Production: LAB_ONLY unset, TRANSPORT_MODE unset (defaults to
	// proxy semantics). Validate() must pass on a config with no
	// authenticated mailboxes (typical local dev / migration command).
	withEnv(t, map[string]string{}, func() {
		cfg := LoadFromEnv()
		// Only check the airtight surface — full Validate() trips on
		// tracking URL etc. not relevant here.
		if err := cfg.Sending.ValidateAirtight(); err != nil {
			t.Fatalf("legacy prod (no env) should pass airtight, got %v", err)
		}
	})
}

// Helpers — kept package-private + minimal to avoid coupling test infra
// to other test files. Reading os.Getenv via t.Setenv would require
// Go 1.17+ test API which the package already uses, but we stick to
// the explicit pair so withEnv() can scope multiple keys atomically.

func contains(s, substr string) bool {
	if substr == "" {
		return true
	}
	for i := 0; i+len(substr) <= len(s); i++ {
		if s[i:i+len(substr)] == substr {
			return true
		}
	}
	return false
}
