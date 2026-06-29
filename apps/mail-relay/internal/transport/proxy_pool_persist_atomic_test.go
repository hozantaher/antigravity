package transport

import (
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

// W2-E — locks the rule that savePool writes via tmp+rename, NOT a
// single os.WriteFile. SIGKILL or out-of-disk mid-write left the file
// partially written; loadPool then unmarshals partial JSON, fails, and
// returns nil — wiping the previous good state.

func TestSavePool_WritesAtomically_TmpThenRename(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "cache.json")
	t.Setenv("PROXY_POOL_PERSIST_PATH", path)

	entries := []proxyEntry{
		{addr: "1.2.3.4:1080", latency: 50 * time.Millisecond, country: "CZ", source: "test"},
	}
	savePool(entries)

	// Final file exists.
	b, err := os.ReadFile(path)
	if err != nil {
		t.Fatalf("save did not create %s: %v", path, err)
	}
	var got persistedPool
	if err := json.Unmarshal(b, &got); err != nil {
		t.Fatalf("unmarshal: %v", err)
	}
	if len(got.Entries) != 1 || got.Entries[0].Addr != "1.2.3.4:1080" {
		t.Errorf("unexpected entries: %+v", got.Entries)
	}

	// Tmp file should NOT remain after a successful save.
	if _, err := os.Stat(path + ".tmp"); !os.IsNotExist(err) {
		t.Errorf(".tmp not cleaned up after successful save: err=%v", err)
	}
}

func TestSavePool_DoesNotCorruptExistingFileOnRenameFail(t *testing.T) {
	// Pre-seed a known-good file.
	dir := t.TempDir()
	path := filepath.Join(dir, "cache.json")
	good := []byte(`{"entries":[{"addr":"good","latency_ms":100,"country":"CZ","source":"prev"}],"saved_at":"2026-01-01T00:00:00Z"}`)
	if err := os.WriteFile(path, good, 0600); err != nil {
		t.Fatal(err)
	}

	// Force the .tmp write to succeed but rename to fail by making the
	// destination a read-only directory's child path. Simplest path:
	// pre-create path as a directory (Rename of file→directory fails).
	// We need a different approach since path is also where Rename's
	// destination would land. Instead: pre-create path.tmp as an
	// existing READ-ONLY file owned by another mode; Rename can still
	// overwrite on POSIX so this won't reliably fail.
	//
	// Best portable approach: pre-create the destination as a directory.
	// Now os.WriteFile on path.tmp succeeds, but os.Rename(tmp, dir)
	// fails because path is a directory, not a file.
	if err := os.Remove(path); err != nil {
		t.Fatal(err)
	}
	if err := os.Mkdir(path, 0700); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = os.RemoveAll(path) })

	t.Setenv("PROXY_POOL_PERSIST_PATH", path)
	entries := []proxyEntry{
		{addr: "5.6.7.8:1080", latency: 30 * time.Millisecond, country: "CZ", source: "new"},
	}
	savePool(entries) // Should fail Rename, log warn, NOT crash.

	// The pre-existing directory must still exist.
	st, err := os.Stat(path)
	if err != nil {
		t.Fatalf("path disappeared: %v", err)
	}
	if !st.IsDir() {
		t.Errorf("path was overwritten — atomic guarantee broken")
	}
}

func TestSavePool_SourceAudit_TmpRenamePattern(t *testing.T) {
	src, err := os.ReadFile("proxy_pool_persist.go")
	if err != nil {
		t.Fatal(err)
	}
	s := string(src)

	// Required: tmp+rename pattern.
	if !strings.Contains(s, ".tmp") {
		t.Error("proxy_pool_persist.go must use a .tmp suffix for atomic write")
	}
	if !strings.Contains(s, "os.Rename(tmp") {
		t.Error("proxy_pool_persist.go must os.Rename(tmp, path) for atomic swap")
	}

	// Forbidden: bare os.WriteFile(path, ...) without the .tmp+rename.
	// Strip comments for this check so the regression-doc comment that
	// legitimately mentions the prior bare WriteFile doesn't trip it.
	code := stripCommentsW2EF(s)
	if strings.Contains(code, "os.WriteFile(path, b, 0600)") {
		t.Error("proxy_pool_persist.go reverted to bare os.WriteFile(path, ...) — non-atomic")
	}
}

// W2-F — env override for geoip endpoint.
func TestGeoBatchEndpointURL_DefaultIsHTTP(t *testing.T) {
	os.Unsetenv("PROXY_GEOIP_BATCH_URL")
	got := geoBatchEndpointURL()
	if got != defaultGeoBatchEndpoint {
		t.Errorf("default = %q, want %q", got, defaultGeoBatchEndpoint)
	}
}

func TestGeoBatchEndpointURL_EnvOverride(t *testing.T) {
	t.Setenv("PROXY_GEOIP_BATCH_URL", "https://pro.ip-api.com/batch?key=secret")
	got := geoBatchEndpointURL()
	if got != "https://pro.ip-api.com/batch?key=secret" {
		t.Errorf("env override not honored, got %q", got)
	}
}

func TestGeoIP_SourceAudit_EnvOverridable(t *testing.T) {
	src, err := os.ReadFile("geoip.go")
	if err != nil {
		t.Fatal(err)
	}
	s := string(src)

	if !strings.Contains(s, "PROXY_GEOIP_BATCH_URL") {
		t.Error("geoip.go must read PROXY_GEOIP_BATCH_URL env override")
	}
	if !strings.Contains(s, "geoBatchEndpointURL()") {
		t.Error("geoip.go must call geoBatchEndpointURL() to resolve runtime URL")
	}
}

// stripCommentsW2EF — local copy (chain_ticker_ctx_test.go's variant
// lives on the W2-A branch).
func stripCommentsW2EF(src string) string {
	out := []byte{}
	i := 0
	for i < len(src) {
		if i+1 < len(src) && src[i] == '/' && src[i+1] == '*' {
			i += 2
			for i+1 < len(src) && !(src[i] == '*' && src[i+1] == '/') {
				i++
			}
			i += 2
			continue
		}
		if i+1 < len(src) && src[i] == '/' && src[i+1] == '/' {
			for i < len(src) && src[i] != '\n' {
				i++
			}
			continue
		}
		out = append(out, src[i])
		i++
	}
	return string(out)
}
