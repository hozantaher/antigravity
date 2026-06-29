package main

import "os"

// readSrc returns the source of a sibling .go file. Split into its own
// non-test file so the test file's import block stays minimal — the
// source-level audits in dns_resolver_test.go grep imports to assert
// dependency hygiene.
func readSrc(name string) ([]byte, error) {
	return os.ReadFile(name)
}
