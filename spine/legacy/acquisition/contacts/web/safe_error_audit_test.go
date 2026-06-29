package contactsweb

import (
	"os"
	"regexp"
	"testing"
)

// S-H2 audit — locks the rule that categories.go must NOT echo raw err
// to clients. Reverting any of the 3 closed sites flips this RED.
func TestNoRawErrorEchoedToClient(t *testing.T) {
	raw, err := os.ReadFile("categories.go")
	if err != nil {
		t.Fatalf("read categories.go: %v", err)
	}
	src := string(raw)

	forbidden := []*regexp.Regexp{
		regexp.MustCompile(`http\.Error\([^)]*err\.Error\(\)`),
		regexp.MustCompile(`http\.Error\([^)]*fmt\.Sprintf\([^)]*err\b`),
		regexp.MustCompile(`http\.Error\([^)]*"\s*\+\s*err\b`),
	}
	for _, rx := range forbidden {
		if rx.MatchString(src) {
			t.Errorf("categories.go leaks err to client (regex %q)", rx.String())
		}
	}

	if !regexp.MustCompile(`func safeError\(`).MatchString(src) {
		t.Error("safeError helper missing from categories.go")
	}
	if !regexp.MustCompile(`safeError\(`).MatchString(src) {
		t.Error("categories.go does not call safeError")
	}
}
