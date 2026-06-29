package main

import (
	"bytes"
	"io"
	"os"
	"testing"
)

func TestEnvOrArg(t *testing.T) {
	origArgs := os.Args
	t.Cleanup(func() { os.Args = origArgs })

	t.Run("env_wins", func(t *testing.T) {
		t.Setenv("TEST_RCV_EOA_RELAY", "env-value")
		os.Args = []string{"receive", "--relay", "flag-value"}
		if got := envOrArg("TEST_RCV_EOA_RELAY", "--relay", "fallback"); got != "env-value" {
			t.Errorf("got %q, want env-value", got)
		}
	})

	t.Run("flag_when_env_empty", func(t *testing.T) {
		os.Unsetenv("TEST_RCV_EOA_NOENV")
		os.Args = []string{"receive", "--relay", "flag-value"}
		if got := envOrArg("TEST_RCV_EOA_NOENV", "--relay", "fallback"); got != "flag-value" {
			t.Errorf("got %q, want flag-value", got)
		}
	})

	t.Run("fallback", func(t *testing.T) {
		os.Unsetenv("TEST_RCV_EOA_MISS")
		os.Args = []string{"receive"}
		if got := envOrArg("TEST_RCV_EOA_MISS", "--missing", "fb"); got != "fb" {
			t.Errorf("got %q, want fb", got)
		}
	})

	t.Run("flag_without_value", func(t *testing.T) {
		os.Unsetenv("TEST_RCV_EOA_NOVAL")
		os.Args = []string{"receive", "--relay"}
		if got := envOrArg("TEST_RCV_EOA_NOVAL", "--relay", "fb"); got != "fb" {
			t.Errorf("got %q, want fb", got)
		}
	})
}

func TestHasFlag(t *testing.T) {
	origArgs := os.Args
	t.Cleanup(func() { os.Args = origArgs })

	tests := []struct {
		name string
		args []string
		flag string
		want bool
	}{
		{"present_first", []string{"bin", "--show-key"}, "--show-key", true},
		{"present_middle", []string{"bin", "--relay", "x", "--show-key", "--other"}, "--show-key", true},
		{"absent", []string{"bin", "--relay", "x"}, "--show-key", false},
		{"empty_args", []string{"bin"}, "--show-key", false},
		{"case_sensitive", []string{"bin", "--Show-Key"}, "--show-key", false},
	}
	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			os.Args = tc.args
			if got := hasFlag(tc.flag); got != tc.want {
				t.Errorf("hasFlag(%q) with args %v = %v, want %v", tc.flag, tc.args, got, tc.want)
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
		{"unset", "TEST_RCV_EIO_UNSET", "", false, 5, 5},
		{"empty", "TEST_RCV_EIO_EMPTY", "", true, 5, 5},
		{"valid", "TEST_RCV_EIO_VALID", "42", true, 0, 42},
		{"zero", "TEST_RCV_EIO_ZERO", "0", true, 9, 0},
		{"bad_alpha", "TEST_RCV_EIO_BAD", "abc", true, 3, 3},
		{"bad_negative", "TEST_RCV_EIO_NEG", "-5", true, 2, 2},
	}
	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			if tc.setEnv {
				t.Setenv(tc.envKey, tc.envVal)
			} else {
				os.Unsetenv(tc.envKey)
			}
			if got := envIntOr(tc.envKey, tc.fallback); got != tc.want {
				t.Errorf("envIntOr = %d, want %d", got, tc.want)
			}
		})
	}
}

func TestReadPassphrase(t *testing.T) {
	tests := []struct {
		name  string
		input string
		want  string
	}{
		{"plain", "secret", "secret"},
		{"trailing_newline", "secret\n", "secret"},
		{"trailing_crlf", "secret\r\n", "secret"},
		{"multiple_trailing_newlines", "secret\n\n\n", "secret"},
		{"empty", "", ""},
		{"spaces_preserved", "my pass phrase\n", "my pass phrase"},
		{"unicode", "héslo\n", "héslo"},
	}
	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			withStdin(t, tc.input, func() {
				got := readPassphrase()
				if string(got) != tc.want {
					t.Errorf("readPassphrase() = %q, want %q", got, tc.want)
				}
			})
		})
	}
}

func withStdin(t *testing.T, input string, fn func()) {
	t.Helper()
	r, w, err := os.Pipe()
	if err != nil {
		t.Fatal(err)
	}
	origStdin := os.Stdin
	os.Stdin = r
	t.Cleanup(func() {
		os.Stdin = origStdin
		r.Close()
	})

	go func() {
		io.Copy(w, bytes.NewBufferString(input))
		w.Close()
	}()

	fn()
}
