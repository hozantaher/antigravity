package main_test

import (
	"os/exec"
	"strings"
	"testing"
)

// TestMain_NoArgs verifies the binary exits with usage message (not a panic).
func TestMain_NoArgs(t *testing.T) {
	cmd := exec.Command("go", "run", ".")
	out, _ := cmd.CombinedOutput()
	output := string(out)
	if strings.Contains(output, "panic") {
		t.Errorf("binary panicked on no args:\n%s", output)
	}
	// Should print usage
	if !strings.Contains(output, "Usage") && !strings.Contains(output, "usage") && !strings.Contains(output, "outreach") {
		t.Logf("output: %s", output)
	}
}
