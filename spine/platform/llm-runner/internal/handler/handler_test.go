package handler

import (
	"context"
	"errors"
	"io"
	"log/slog"
	"strings"
	"testing"
)

// stubClient je test double pro LLMClient.
type stubClient struct {
	generateOut    string
	generateErr    error
	generateCalls  int
	withImageOut   string
	withImageErr   error
	withImageCalls int

	// captureModel/Prompt zaznamenávají poslední volání (pro assertion).
	lastModel  string
	lastPrompt string
	lastImage  string
}

func (s *stubClient) Generate(ctx context.Context, model, prompt string) (string, error) {
	s.generateCalls++
	s.lastModel = model
	s.lastPrompt = prompt
	return s.generateOut, s.generateErr
}

func (s *stubClient) GenerateWithImage(ctx context.Context, model, prompt, img string) (string, error) {
	s.withImageCalls++
	s.lastModel = model
	s.lastPrompt = prompt
	s.lastImage = img
	return s.withImageOut, s.withImageErr
}

// silentLogger vrací logger který neloguje nic (test noise reduction).
func silentLogger() *slog.Logger {
	return slog.New(slog.NewTextHandler(io.Discard, nil))
}

// errBoom je shared sentinel pro test injection.
var errBoom = errors.New("boom")

// readBody přečte HTTP response body do stringu (helper pro test).
func readBody(t *testing.T, body io.Reader) string {
	t.Helper()
	out, err := io.ReadAll(body)
	if err != nil {
		t.Fatalf("read body: %v", err)
	}
	return string(out)
}

// containsAll asertuje že all substrings jsou ve string.
func containsAll(s string, parts ...string) bool {
	for _, p := range parts {
		if !strings.Contains(s, p) {
			return false
		}
	}
	return true
}
