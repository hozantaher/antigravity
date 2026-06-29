package audit

import (
	"os"
	"path/filepath"
	"regexp"
	"strings"
	"testing"
)

// F1-3 audit — locks the rule that production Go code does NOT use
// `err == sql.ErrNoRows` or `err != sql.ErrNoRows` directly. The
// errors.Is form survives fmt.Errorf("%w") wrapping; the direct sentinel
// comparison silently breaks if any layer between the driver and the
// caller wraps the error (a future retry middleware, a typed wrapper
// for instrumentation, etc.).
//
// Goes RED if anyone re-introduces the direct sentinel comparison.
// Allow-list: code in the sql/driver standard library, or test files
// that intentionally exercise the un-wrapped sentinel.
func TestNoDirectSqlErrNoRowsCompare_AcrossServices(t *testing.T) {
	// Walk the services tree from this file's location: ../../
	thisFile, err := os.Getwd()
	if err != nil {
		t.Fatalf("getwd: %v", err)
	}
	servicesRoot := filepath.Join(thisFile, "..", "..")

	// Patterns that flag the bug:
	//   err == sql.ErrNoRows
	//   err != sql.ErrNoRows
	// Allow:
	//   errors.Is(err, sql.ErrNoRows)
	bad := regexp.MustCompile(`\berr\s*(?:==|!=)\s*sql\.ErrNoRows\b`)

	var violations []string
	walkErr := filepath.Walk(servicesRoot, func(path string, info os.FileInfo, err error) error {
		if err != nil {
			return nil
		}
		if info.IsDir() {
			// Skip vendored / generated trees.
			name := info.Name()
			if name == "node_modules" || name == "vendor" || name == ".stryker-tmp" || name == "tmp" {
				return filepath.SkipDir
			}
			return nil
		}
		if !strings.HasSuffix(path, ".go") {
			return nil
		}
		// Exclude *_test.go — test files may legitimately exercise the
		// un-wrapped sentinel as part of stub setup.
		if strings.HasSuffix(path, "_test.go") {
			return nil
		}
		raw, readErr := os.ReadFile(path)
		if readErr != nil {
			return nil
		}
		// Annotate match with the line number for actionable failure output.
		for i, line := range strings.Split(string(raw), "\n") {
			if bad.MatchString(line) {
				rel, _ := filepath.Rel(servicesRoot, path)
				violations = append(violations,
					rel+":"+itoa(i+1)+" → "+strings.TrimSpace(line))
			}
		}
		return nil
	})
	if walkErr != nil {
		t.Fatalf("walk: %v", walkErr)
	}
	if len(violations) > 0 {
		t.Errorf("found %d direct sql.ErrNoRows comparisons (use errors.Is):\n  %s",
			len(violations), strings.Join(violations, "\n  "))
	}
}

func itoa(i int) string {
	if i == 0 {
		return "0"
	}
	var b []byte
	for i > 0 {
		b = append([]byte{byte('0' + i%10)}, b...)
		i /= 10
	}
	return string(b)
}
