package inboxweb

import (
	"os"
	"regexp"
	"testing"
)

// S-H2 audit — locks the rule that threads.go must NOT echo raw err to
// clients. Reverting any of the 3 closed sites flips this RED.
func TestNoRawErrorEchoedToClient(t *testing.T) {
	raw, err := os.ReadFile("threads.go")
	if err != nil {
		t.Fatalf("read threads.go: %v", err)
	}
	src := string(raw)

	forbidden := []*regexp.Regexp{
		regexp.MustCompile(`http\.Error\([^)]*err\.Error\(\)`),
		regexp.MustCompile(`http\.Error\([^)]*fmt\.Sprintf\([^)]*err\b`),
		regexp.MustCompile(`http\.Error\([^)]*"\s*\+\s*err\b`),
	}
	for _, rx := range forbidden {
		if rx.MatchString(src) {
			t.Errorf("threads.go leaks err to client (regex %q)", rx.String())
		}
	}

	if !regexp.MustCompile(`func safeError\(`).MatchString(src) {
		t.Error("safeError helper missing from threads.go")
	}
	if !regexp.MustCompile(`safeError\(`).MatchString(src) {
		t.Error("threads.go does not call safeError")
	}
}
