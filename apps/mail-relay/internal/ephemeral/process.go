package ephemeral

import "os"

// osExit is the function called by Guard on signal. Tests override this to
// prevent the test process from being killed.
var osExit = os.Exit

// Guard installs signal handlers and ensures cleanup runs on any exit path.
// Catches SIGINT, SIGTERM (and SIGHUP on Unix).
// SIGKILL cannot be caught -- known OS limitation.
func Guard(cleanup func()) {
	sigCh := make(chan os.Signal, 1)
	notifySignals(sigCh)

	go func() {
		<-sigCh
		if cleanup != nil {
			cleanup()
		}
		WipeAll()
		osExit(0)
	}()
}

// PanicGuard wraps a function with panic recovery that ensures cleanup.
func PanicGuard(cleanup func(), fn func()) {
	defer func() {
		if r := recover(); r != nil {
			if cleanup != nil {
				cleanup()
			}
			WipeAll()
			panic(r)
		}
	}()
	fn()
}
