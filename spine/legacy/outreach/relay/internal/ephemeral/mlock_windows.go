//go:build windows

package ephemeral

// Windows uses VirtualLock but it requires unsafe pointers.
// Degraded security: memory may be paged to disk.
func mlock(b []byte) error   { return nil }
func munlock(b []byte) error { return nil }
