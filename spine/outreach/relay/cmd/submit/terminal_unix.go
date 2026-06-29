//go:build !windows

package main

import "fmt"

func disableEcho() (any, error) {
	// Simplified: on most Unix systems, passphrase echo should be disabled
	// via termios. For now, degraded but functional.
	return nil, fmt.Errorf("echo disable not implemented")
}

func restoreEcho(state any) {}
