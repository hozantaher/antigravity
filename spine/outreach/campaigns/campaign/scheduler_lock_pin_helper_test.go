package campaign

import "os"

// readFileBytes reads a source file relative to the package directory.
// Shared by scheduler_lock_pin_test.go's source-level audits.
func readFileBytes(path string) ([]byte, error) {
	return os.ReadFile(path)
}
