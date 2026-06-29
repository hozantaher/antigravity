package config

import (
	"os"
	"path/filepath"
	"testing"
)

func TestLoadSecretsFileParsesKeyValuePairs(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "secrets.env")
	content := "# a comment\n" +
		"\n" +
		"DATA_ENCRYPTION_KEY_B64=abc123\n" +
		"  VAULT_ENCRYPTION_KEY_B64=  padded-value  \n" +
		"VALUE_WITH_EQUALS=foo=bar=baz\n" +
		"no-equals-line\n" +
		"# another comment\n"
	if err := os.WriteFile(path, []byte(content), 0o600); err != nil {
		t.Fatalf("write file: %v", err)
	}

	secrets, err := LoadSecretsFile(path)
	if err != nil {
		t.Fatalf("LoadSecretsFile: %v", err)
	}

	tests := []struct {
		key  string
		want string
	}{
		{"DATA_ENCRYPTION_KEY_B64", "abc123"},
		{"VAULT_ENCRYPTION_KEY_B64", "padded-value"},
		{"VALUE_WITH_EQUALS", "foo=bar=baz"},
	}
	for _, tc := range tests {
		if got := secrets[tc.key]; got != tc.want {
			t.Errorf("secrets[%q] = %q, want %q", tc.key, got, tc.want)
		}
	}

	if _, exists := secrets["no-equals-line"]; exists {
		t.Errorf("line without '=' should be skipped")
	}
	if len(secrets) != 3 {
		t.Errorf("expected 3 parsed secrets, got %d (%+v)", len(secrets), secrets)
	}
}

func TestLoadSecretsFileErrorsOnMissingFile(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "does-not-exist.env")

	_, err := LoadSecretsFile(path)
	if err == nil {
		t.Fatal("expected error for missing file, got nil")
	}
	if !os.IsNotExist(err) {
		t.Fatalf("expected os.IsNotExist error, got %v", err)
	}
}

func TestApplySecretsOnlySetsUnsetVars(t *testing.T) {
	// ATR_TEST_UNSET must not exist; ATR_TEST_SET is pre-populated.
	t.Setenv("ATR_TEST_SET", "existing-value")
	// Ensure ATR_TEST_UNSET is empty for the duration of this test.
	t.Setenv("ATR_TEST_UNSET", "")
	// t.Setenv with "" still counts as set in some Go versions; unset explicitly.
	os.Unsetenv("ATR_TEST_UNSET")
	t.Cleanup(func() { os.Unsetenv("ATR_TEST_UNSET") })

	secrets := map[string]string{
		"ATR_TEST_SET":   "replacement",
		"ATR_TEST_UNSET": "new-value",
	}

	ApplySecrets(secrets)

	if got := os.Getenv("ATR_TEST_SET"); got != "existing-value" {
		t.Errorf("pre-set var overwritten: got %q, want %q", got, "existing-value")
	}
	if got := os.Getenv("ATR_TEST_UNSET"); got != "new-value" {
		t.Errorf("unset var not populated: got %q, want %q", got, "new-value")
	}
}

func TestLoadAndApplySecretsFile(t *testing.T) {
	t.Run("empty path is a no-op", func(t *testing.T) {
		if err := LoadAndApplySecretsFile(""); err != nil {
			t.Fatalf("empty path should not error: %v", err)
		}
	})

	t.Run("nonexistent file is a no-op", func(t *testing.T) {
		dir := t.TempDir()
		path := filepath.Join(dir, "missing.env")
		if err := LoadAndApplySecretsFile(path); err != nil {
			t.Fatalf("missing file should not error: %v", err)
		}
	})

	t.Run("valid file applies secrets", func(t *testing.T) {
		dir := t.TempDir()
		path := filepath.Join(dir, "secrets.env")
		content := "ATR_LOAD_APPLY_KEY=value-from-file\n"
		if err := os.WriteFile(path, []byte(content), 0o600); err != nil {
			t.Fatalf("write file: %v", err)
		}
		os.Unsetenv("ATR_LOAD_APPLY_KEY")
		t.Cleanup(func() { os.Unsetenv("ATR_LOAD_APPLY_KEY") })

		if err := LoadAndApplySecretsFile(path); err != nil {
			t.Fatalf("LoadAndApplySecretsFile: %v", err)
		}
		if got := os.Getenv("ATR_LOAD_APPLY_KEY"); got != "value-from-file" {
			t.Fatalf("env var = %q, want %q", got, "value-from-file")
		}
	})

	t.Run("unreadable file returns a non-NotExist error", func(t *testing.T) {
		// A directory used where a file is expected produces an error that is
		// not os.IsNotExist (EISDIR/EISDIR-like), which exercises the non-nil,
		// non-NotExist branch of LoadAndApplySecretsFile.
		dir := t.TempDir()
		if err := LoadAndApplySecretsFile(dir); err == nil {
			t.Fatal("expected error opening a directory as a file, got nil")
		}
	})
}
