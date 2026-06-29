package sender

import "os"

// Helpers for the F3-3 source-level audit.

func readAntiTraceSource() ([]byte, error) {
	return os.ReadFile("antitrace.go")
}

func containsAntiTrace(s []byte, sub string) bool {
	if len(sub) == 0 {
		return true
	}
	for i := 0; i+len(sub) <= len(s); i++ {
		if string(s[i:i+len(sub)]) == sub {
			return true
		}
	}
	return false
}
