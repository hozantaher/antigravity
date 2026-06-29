package mailbox

import "strings"

// minRealisticPasswordLen is the shortest length we will accept as a
// plausible real SMTP credential. Anything shorter is treated as a
// placeholder. Seznam, Forpsi, and most mail providers require >=8 chars
// for app passwords, so this is a safe floor.
const minRealisticPasswordLen = 8

// knownBadPrefixes is the list of literal prefixes we consider to be
// placeholder / default credentials. These were observed in real misconfig
// incidents (2026-04-22 SEND-S6.1 debug: "123p123p123p123" shipped into
// outreach_mailboxes for all 4 Seznam accounts).
//
// Keep this list conservative: a false positive here blocks real sending,
// so we only add patterns that no sane credential should ever start with.
var knownBadPrefixes = []string{
	"123p",
	"xxxx",
	"password",
	"admin",
	"test",
}

// IsPlaceholderPassword returns true if the given password looks like a
// placeholder or default credential that should never reach production SMTP
// AUTH. It is intentionally conservative — false positives are cheaper than
// shipping a silent auth failure, which is what happened in the 2026-04-22
// Seznam incident.
//
// Detection rules (ordered; first match wins):
//  1. empty string
//  2. shorter than minRealisticPasswordLen
//  3. starts with a known bad prefix ("123p", "xxxx", "password", "admin", "test")
//  4. highly repetitive — same 3-char substring appears >=3 times
//
// This function never logs or returns the password itself.
func IsPlaceholderPassword(p string) bool {
	if p == "" {
		return true
	}
	if len(p) < minRealisticPasswordLen {
		return true
	}
	lower := strings.ToLower(p)
	for _, prefix := range knownBadPrefixes {
		if strings.HasPrefix(lower, prefix) {
			return true
		}
	}
	if hasRepeatedTrigram(p, 3) {
		return true
	}
	return false
}

// hasRepeatedTrigram reports whether any 3-character substring of s appears
// at least minRepeats times (overlapping matches count). This catches
// patterns like "123p123p123p" (the "123" trigram appears 4 times) and
// "abcabcabc" (the "abc" trigram appears 3 times) without flagging normal
// passwords that happen to contain short incidental repeats.
func hasRepeatedTrigram(s string, minRepeats int) bool {
	if len(s) < 3*minRepeats {
		return false
	}
	counts := make(map[string]int, len(s))
	for i := 0; i+3 <= len(s); i++ {
		tri := s[i : i+3]
		counts[tri]++
		if counts[tri] >= minRepeats {
			return true
		}
	}
	return false
}
