//go:build !windows

package main

import "syscall"

func disableCoreDumpsOS() error {
	var rlimit syscall.Rlimit
	rlimit.Cur = 0
	rlimit.Max = 0
	return syscall.Setrlimit(syscall.RLIMIT_CORE, &rlimit)
}
