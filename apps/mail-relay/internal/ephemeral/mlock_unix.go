//go:build !windows

package ephemeral

import "syscall"

func mlock(b []byte) error   { return syscall.Mlock(b) }
func munlock(b []byte) error { return syscall.Munlock(b) }
