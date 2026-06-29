package main

import (
	"bytes"
	"os"
	"testing"
)

func TestHexDigit(t *testing.T) {
	tests := []struct {
		name string
		in   byte
		want int
	}{
		{"zero", '0', 0},
		{"nine", '9', 9},
		{"lower_a", 'a', 10},
		{"lower_f", 'f', 15},
		{"upper_A", 'A', 10},
		{"upper_F", 'F', 15},
		{"invalid_space", ' ', -1},
		{"invalid_g", 'g', -1},
		{"invalid_slash", '/', -1},
		{"invalid_colon", ':', -1},
		{"invalid_G", 'G', -1},
	}
	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			if got := hexDigit(tc.in); got != tc.want {
				t.Errorf("hexDigit(%q) = %d, want %d", tc.in, got, tc.want)
			}
		})
	}
}

func TestDecodeHex(t *testing.T) {
	tests := []struct {
		name string
		in   string
		want []byte
	}{
		{"empty", "", []byte{}},
		{"single_byte", "ff", []byte{0xff}},
		{"two_bytes", "dead", []byte{0xde, 0xad}},
		{"mixed_case", "AbCd", []byte{0xab, 0xcd}},
		{"all_lower", "1234abcd", []byte{0x12, 0x34, 0xab, 0xcd}},
		{"odd_length", "abc", nil},
		{"invalid_char", "xy", nil},
		{"invalid_in_middle", "aag!", nil},
		{"32_bytes_x25519", "0000000000000000000000000000000000000000000000000000000000000001", append(make([]byte, 31), 0x01)},
	}
	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			got := decodeHex(tc.in)
			if !bytes.Equal(got, tc.want) {
				t.Errorf("decodeHex(%q) = %x, want %x", tc.in, got, tc.want)
			}
		})
	}
}

func TestEnvIntOr(t *testing.T) {
	tests := []struct {
		name     string
		envKey   string
		envVal   string
		setEnv   bool
		fallback int
		want     int
	}{
		{"unset_returns_fallback", "TEST_EIO_UNSET", "", false, 42, 42},
		{"empty_returns_fallback", "TEST_EIO_EMPTY", "", true, 7, 7},
		{"valid_integer", "TEST_EIO_VALID", "123", true, 0, 123},
		{"zero", "TEST_EIO_ZERO", "0", true, 99, 0},
		{"non_numeric_returns_fallback", "TEST_EIO_BAD", "abc", true, 5, 5},
		{"negative_returns_fallback", "TEST_EIO_NEG", "-1", true, 8, 8},
		{"with_space_returns_fallback", "TEST_EIO_SPACE", "12 3", true, 1, 1},
		{"large_number", "TEST_EIO_LARGE", "1000000", true, 0, 1000000},
	}
	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			if tc.setEnv {
				t.Setenv(tc.envKey, tc.envVal)
			} else {
				os.Unsetenv(tc.envKey)
			}
			if got := envIntOr(tc.envKey, tc.fallback); got != tc.want {
				t.Errorf("envIntOr(%q, %d) = %d, want %d", tc.envKey, tc.fallback, got, tc.want)
			}
		})
	}
}

func TestEnvOrArg(t *testing.T) {
	origArgs := os.Args
	t.Cleanup(func() { os.Args = origArgs })

	t.Run("env_wins_over_flag", func(t *testing.T) {
		t.Setenv("TEST_EOA_RELAY", "env-value")
		os.Args = []string{"submit", "--relay", "flag-value"}
		if got := envOrArg("TEST_EOA_RELAY", "--relay", "fallback"); got != "env-value" {
			t.Errorf("got %q, want env-value", got)
		}
	})

	t.Run("flag_when_env_empty", func(t *testing.T) {
		os.Unsetenv("TEST_EOA_NOENV")
		os.Args = []string{"submit", "--key", "flag-value"}
		if got := envOrArg("TEST_EOA_NOENV", "--key", "fallback"); got != "flag-value" {
			t.Errorf("got %q, want flag-value", got)
		}
	})

	t.Run("fallback_when_neither", func(t *testing.T) {
		os.Unsetenv("TEST_EOA_MISS")
		os.Args = []string{"submit"}
		if got := envOrArg("TEST_EOA_MISS", "--missing", "fallback"); got != "fallback" {
			t.Errorf("got %q, want fallback", got)
		}
	})

	t.Run("flag_without_value_returns_fallback", func(t *testing.T) {
		os.Unsetenv("TEST_EOA_NOVAL")
		os.Args = []string{"submit", "--relay"}
		if got := envOrArg("TEST_EOA_NOVAL", "--relay", "fallback"); got != "fallback" {
			t.Errorf("got %q, want fallback", got)
		}
	})

	t.Run("flag_in_middle_of_args", func(t *testing.T) {
		os.Unsetenv("TEST_EOA_MID")
		os.Args = []string{"submit", "--other", "x", "--relay", "target", "--more", "y"}
		if got := envOrArg("TEST_EOA_MID", "--relay", "fallback"); got != "target" {
			t.Errorf("got %q, want target", got)
		}
	})

	t.Run("env_empty_string_falls_through_to_flag", func(t *testing.T) {
		t.Setenv("TEST_EOA_EMPTY", "")
		os.Args = []string{"submit", "--relay", "flag-value"}
		if got := envOrArg("TEST_EOA_EMPTY", "--relay", "fallback"); got != "flag-value" {
			t.Errorf("got %q, want flag-value", got)
		}
	})
}
