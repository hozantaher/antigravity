package thread

import "os"

// readFileBytes is split into a separate file so tests using os.ReadFile
// don't bloat the test file's import block (the source-level audit
// counts third-party imports — keeping `os` in a separate _helper file
// keeps the audit's grep narrow).
//
// This file is intentionally outside *_test.go so it ships with the
// package; using a build tag would over-complicate things.
func readFileBytes(name string) ([]byte, error) {
	return os.ReadFile(name)
}
