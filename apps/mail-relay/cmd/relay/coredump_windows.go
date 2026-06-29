//go:build windows

package main

func disableCoreDumpsOS() error {
	// Windows does not use RLIMIT_CORE. Core dumps (minidumps) are controlled
	// via Windows Error Reporting registry keys, not settable from Go stdlib.
	return nil
}
