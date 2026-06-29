//go:build cli_integration

// Package cmd_integration contains end-to-end CLI integration tests that
// build and execute the `submit` and `receive` binaries via `go run` and
// drive them through stdin/env vars against a stub HTTP relay.
//
// These tests are gated behind the `cli_integration` build tag because
// each invocation shells out to the Go toolchain (compilation + link +
// process start) and is substantially slower than unit tests.
//
// Run locally:
//
//	go test -tags=cli_integration ./cmd/...
package cmd_integration

import (
	"bytes"
	"context"
	"encoding/hex"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"strings"
	"sync"
	"testing"
	"time"
)

// perTestTimeout bounds each CLI invocation. All tests should finish well
// under this -- we assert a hard ceiling to keep the suite deterministic.
const perTestTimeout = 20 * time.Second

// moduleRoot walks up from the test's working directory until it finds a
// go.mod file. Tests run with cwd == the package directory (cmd/), so we
// need the parent directory to resolve `./cmd/submit` and `./cmd/receive`.
func moduleRoot(t *testing.T) string {
	t.Helper()
	dir, err := os.Getwd()
	if err != nil {
		t.Fatalf("Getwd: %v", err)
	}
	for i := 0; i < 10; i++ {
		if _, err := os.Stat(filepath.Join(dir, "go.mod")); err == nil {
			return dir
		}
		parent := filepath.Dir(dir)
		if parent == dir {
			break
		}
		dir = parent
	}
	t.Fatalf("could not locate go.mod from %s", dir)
	return ""
}

// runCLI executes `go run ./cmd/<binary>` with the supplied args, stdin,
// and environment. Returns stdout, stderr, exit code, and any start error.
// A non-zero exit code is NOT treated as a test error; the caller asserts.
func runCLI(t *testing.T, binary string, args []string, stdin string, env map[string]string) (stdout, stderr string, exitCode int) {
	t.Helper()

	ctx, cancel := context.WithTimeout(context.Background(), perTestTimeout)
	defer cancel()

	cmdArgs := append([]string{"run", "./cmd/" + binary}, args...)
	cmd := exec.CommandContext(ctx, "go", cmdArgs...)
	cmd.Dir = moduleRoot(t)

	// Start from a clean, deterministic env plus what the caller specifies.
	// Retain PATH, HOME, and GOCACHE so the toolchain can actually run.
	baseEnv := []string{
		"PATH=" + os.Getenv("PATH"),
		"HOME=" + os.Getenv("HOME"),
		"GOCACHE=" + os.Getenv("GOCACHE"),
		"GOMODCACHE=" + os.Getenv("GOMODCACHE"),
		"GOPATH=" + os.Getenv("GOPATH"),
		"GOROOT=" + os.Getenv("GOROOT"),
		"TMPDIR=" + os.Getenv("TMPDIR"),
	}
	for k, v := range env {
		baseEnv = append(baseEnv, k+"="+v)
	}
	cmd.Env = baseEnv

	var outBuf, errBuf bytes.Buffer
	cmd.Stdout = &outBuf
	cmd.Stderr = &errBuf
	cmd.Stdin = strings.NewReader(stdin)

	err := cmd.Run()
	exitCode = 0
	if err != nil {
		var exitErr *exec.ExitError
		if errors.As(err, &exitErr) {
			exitCode = exitErr.ExitCode()
		} else {
			// Process failed to start (compilation error, go not found, etc.).
			t.Fatalf("failed to run %s: %v\nstderr: %s", binary, err, errBuf.String())
		}
	}

	if ctx.Err() == context.DeadlineExceeded {
		t.Fatalf("%s exceeded %s timeout\nstdout: %s\nstderr: %s",
			binary, perTestTimeout, outBuf.String(), errBuf.String())
	}

	return outBuf.String(), errBuf.String(), exitCode
}

// ---------- submit tests ----------

func TestSubmitCLI_HelpfulErrorWhenRelayMissing(t *testing.T) {
	// No --relay flag and no RELAY_URL env -> should exit 1 with a clear
	// error mentioning --relay or RELAY_URL. Stdin is never consumed because
	// the relay check happens before the passphrase prompt.
	_, stderr, code := runCLI(t, "submit",
		[]string{"--message", "hello"},
		"",
		nil,
	)

	if code != 1 {
		t.Fatalf("expected exit code 1, got %d\nstderr: %s", code, stderr)
	}
	if !strings.Contains(stderr, "--relay") && !strings.Contains(stderr, "RELAY_URL") {
		t.Fatalf("stderr should mention --relay or RELAY_URL, got: %s", stderr)
	}
}

func TestSubmitCLI_HelpfulErrorWhenMessageMissing(t *testing.T) {
	// --relay supplied but no message -> should exit 1 with error about
	// missing --message. Stdin is never consumed.
	_, stderr, code := runCLI(t, "submit",
		[]string{"--relay", "http://127.0.0.1:1"},
		"",
		nil,
	)

	if code != 1 {
		t.Fatalf("expected exit code 1, got %d\nstderr: %s", code, stderr)
	}
	if !strings.Contains(stderr, "--message") && !strings.Contains(stderr, "MESSAGE") {
		t.Fatalf("stderr should mention --message or MESSAGE, got: %s", stderr)
	}
}

func TestSubmitCLI_SuccessAgainstStubRelay(t *testing.T) {
	// Stand up a stub relay that accepts POST /v1/drop/<slotHex> with
	// a JSON {"data": "<hex>"} body, returns 200, and records the request
	// so we can assert the CLI actually submitted something.
	type capture struct {
		mu        sync.Mutex
		method    string
		path      string
		body      []byte
		contentTy string
		hits      int
	}
	var cap capture

	slotPath := regexp.MustCompile(`^/v1/drop/[0-9a-fA-F]+$`)
	stub := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		body, _ := io.ReadAll(io.LimitReader(r.Body, 1<<20))
		cap.mu.Lock()
		cap.method = r.Method
		cap.path = r.URL.Path
		cap.body = body
		cap.contentTy = r.Header.Get("Content-Type")
		cap.hits++
		cap.mu.Unlock()

		if !slotPath.MatchString(r.URL.Path) {
			w.WriteHeader(http.StatusNotFound)
			return
		}
		w.WriteHeader(http.StatusOK)
		_, _ = w.Write([]byte(`{"status":"ok"}`))
	}))
	defer stub.Close()

	stdout, stderr, code := runCLI(t, "submit",
		[]string{"--relay", stub.URL, "--message", "integration-test-payload"},
		"integration-test-passphrase\n",
		nil,
	)

	if code != 0 {
		t.Fatalf("expected exit code 0, got %d\nstdout: %s\nstderr: %s",
			code, stdout, stderr)
	}
	if !strings.Contains(stderr, "Submitted successfully") {
		t.Fatalf("stderr should confirm submission, got: %s", stderr)
	}

	cap.mu.Lock()
	defer cap.mu.Unlock()

	if cap.hits == 0 {
		t.Fatal("stub relay was never hit")
	}
	if cap.method != http.MethodPost {
		t.Errorf("expected POST, got %s", cap.method)
	}
	if !slotPath.MatchString(cap.path) {
		t.Errorf("path %q does not match /v1/drop/<hex>", cap.path)
	}
	if !strings.HasPrefix(cap.contentTy, "application/json") {
		t.Errorf("expected JSON content-type, got %q", cap.contentTy)
	}

	// The body should be JSON with a hex-encoded "data" field.
	var payload struct {
		Data string `json:"data"`
	}
	if err := json.Unmarshal(cap.body, &payload); err != nil {
		t.Fatalf("body is not JSON: %v\nraw: %s", err, cap.body)
	}
	if payload.Data == "" {
		t.Error("payload.data is empty")
	}
	if _, err := hex.DecodeString(payload.Data); err != nil {
		t.Errorf("payload.data is not valid hex: %v", err)
	}
}

// ---------- receive tests ----------

func TestReceiveCLI_ShowKey(t *testing.T) {
	// --show-key derives the epoch recipient public key from the passphrase
	// and prints it as a hex string to stdout. It must not require a relay.
	stdout, stderr, code := runCLI(t, "receive",
		[]string{"--show-key"},
		"integration-test-passphrase\n",
		nil,
	)

	if code != 0 {
		t.Fatalf("expected exit code 0, got %d\nstdout: %s\nstderr: %s",
			code, stdout, stderr)
	}

	hexKey := strings.TrimSpace(stdout)
	if hexKey == "" {
		t.Fatalf("expected hex public key on stdout, got empty\nstderr: %s", stderr)
	}
	if len(hexKey) != 64 {
		t.Errorf("expected 64 hex chars (32 bytes), got %d: %q", len(hexKey), hexKey)
	}
	raw, err := hex.DecodeString(hexKey)
	if err != nil {
		t.Errorf("stdout is not valid hex: %v", err)
	}
	if len(raw) != 32 {
		t.Errorf("expected 32 decoded bytes, got %d", len(raw))
	}

	// The "share with sender" prompt lives on stderr, not stdout --
	// stdout must stay machine-parseable.
	if !strings.Contains(stderr, "Recipient public key") {
		t.Errorf("stderr should include the share prompt, got: %s", stderr)
	}
}

func TestReceiveCLI_NoMessages(t *testing.T) {
	// Stand up a stub relay that serves an empty mailbox for any slot.
	var hits int
	var mu sync.Mutex
	stub := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		mu.Lock()
		hits++
		mu.Unlock()
		if r.Method != http.MethodGet {
			w.WriteHeader(http.StatusMethodNotAllowed)
			return
		}
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{"messages":[]}`))
	}))
	defer stub.Close()

	stdout, stderr, code := runCLI(t, "receive",
		[]string{"--relay", stub.URL},
		"integration-test-passphrase\n",
		nil,
	)

	if code != 0 {
		t.Fatalf("expected exit code 0, got %d\nstdout: %s\nstderr: %s",
			code, stdout, stderr)
	}
	if !strings.Contains(stderr, "No messages.") {
		t.Fatalf("stderr should say 'No messages.', got: %s", stderr)
	}
	if stdout != "" {
		t.Errorf("stdout should be empty when no messages, got: %q", stdout)
	}

	mu.Lock()
	defer mu.Unlock()
	if hits == 0 {
		t.Error("stub relay was never polled")
	}
}
