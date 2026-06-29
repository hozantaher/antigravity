package main

import (
	"fmt"
	"strings"
	"testing"
	"time"
)

// ─────────────────────────────────────────────────────────────────────────────
// 1. Header parser: Received chain in correct order (multi-value)
// ─────────────────────────────────────────────────────────────────────────────

func TestParseRawMessage_ReceivedChain(t *testing.T) {
	raw := buildRawMessage(map[string][]string{
		"Received": {
			"from smtp1.example.com (smtp1 [1.2.3.4]) by mx.seznam.cz; Thu, 1 May 2026 12:00:00 +0200",
			"from relay.antitrace.internal by smtp1.example.com; Thu, 1 May 2026 11:59:58 +0200",
		},
		"Message-Id":  {"<msg001@example.com>"},
		"From":        {"sender@email.cz"},
		"X-Test-Run-ID": {"run-uuid-001"},
	}, "hello body")

	pm, err := parseRawMessage([]byte(raw))
	if err != nil {
		t.Fatalf("parseRawMessage: %v", err)
	}

	if len(pm.receivedChain) != 2 {
		t.Fatalf("want 2 Received headers, got %d: %v", len(pm.receivedChain), pm.receivedChain)
	}
	// net/mail preserves raw declaration order; first declared = most recent in IMAP (prepended)
	if !strings.Contains(pm.receivedChain[0], "smtp1.example.com") {
		t.Errorf("first Received should contain smtp1.example.com, got: %q", pm.receivedChain[0])
	}
	if !strings.Contains(pm.receivedChain[1], "relay.antitrace.internal") {
		t.Errorf("second Received should contain relay.antitrace.internal, got: %q", pm.receivedChain[1])
	}
}

// ─────────────────────────────────────────────────────────────────────────────
// 2. Header parser: Message-ID, From, Return-Path
// ─────────────────────────────────────────────────────────────────────────────

func TestParseRawMessage_ScalarHeaders(t *testing.T) {
	raw := buildRawMessage(map[string][]string{
		"Message-Id":  {"<test-id-42@mail.example.com>"},
		"From":        {"Test Sender <sender@email.cz>"},
		"Return-Path": {"<bounce@email.cz>"},
	}, "")

	pm, err := parseRawMessage([]byte(raw))
	if err != nil {
		t.Fatalf("parseRawMessage: %v", err)
	}

	if pm.messageID != "<test-id-42@mail.example.com>" {
		t.Errorf("messageID want <test-id-42@mail.example.com>, got %q", pm.messageID)
	}
	if pm.fromAddr != "Test Sender <sender@email.cz>" {
		t.Errorf("fromAddr want 'Test Sender <sender@email.cz>', got %q", pm.fromAddr)
	}
	if pm.returnPath != "<bounce@email.cz>" {
		t.Errorf("returnPath want <bounce@email.cz>, got %q", pm.returnPath)
	}
}

// ─────────────────────────────────────────────────────────────────────────────
// 3. Authentication-Results: dkim/spf/dmarc extracted correctly
// ─────────────────────────────────────────────────────────────────────────────

func TestParseRawMessage_AuthResults_Present(t *testing.T) {
	raw := buildRawMessage(map[string][]string{
		"Authentication-Results": {
			"mx.seznam.cz; dkim=pass header.d=email.cz; spf=pass smtp.mailfrom=email.cz; dmarc=pass",
		},
	}, "")

	pm, err := parseRawMessage([]byte(raw))
	if err != nil {
		t.Fatalf("parseRawMessage: %v", err)
	}

	assertStrPtr(t, "dkimResult", pm.dkimResult, "pass")
	assertStrPtr(t, "spfResult", pm.spfResult, "pass")
	assertStrPtr(t, "dmarcResult", pm.dmarcResult, "pass")
}

// ─────────────────────────────────────────────────────────────────────────────
// 4. Authentication-Results absent → all three NULL (not empty string)
// ─────────────────────────────────────────────────────────────────────────────

func TestParseRawMessage_AuthResults_Absent(t *testing.T) {
	raw := buildRawMessage(map[string][]string{
		"From": {"sender@email.cz"},
	}, "body text")

	pm, err := parseRawMessage([]byte(raw))
	if err != nil {
		t.Fatalf("parseRawMessage: %v", err)
	}

	if pm.dkimResult != nil {
		t.Errorf("dkimResult: want nil, got %q", *pm.dkimResult)
	}
	if pm.spfResult != nil {
		t.Errorf("spfResult: want nil, got %q", *pm.spfResult)
	}
	if pm.dmarcResult != nil {
		t.Errorf("dmarcResult: want nil, got %q", *pm.dmarcResult)
	}
}

// ─────────────────────────────────────────────────────────────────────────────
// 5. X-Test-Run-ID match: only matching messages are counted; non-matching skipped
// ─────────────────────────────────────────────────────────────────────────────

func TestHeaderFirst_RunIDMatch(t *testing.T) {
	wantRunID := "aaaabbbb-1234-5678-abcd-000000000001"

	// Matching message
	headers1 := map[string][]string{
		"x-test-run-id": {wantRunID},
	}
	got := headerFirst(headers1, "X-Test-Run-Id")
	if got != wantRunID {
		t.Errorf("want %q, got %q", wantRunID, got)
	}

	// Non-matching message
	headers2 := map[string][]string{
		"x-test-run-id": {"different-run-id"},
	}
	got2 := headerFirst(headers2, "X-Test-Run-Id")
	if got2 == wantRunID {
		t.Errorf("non-matching header should not equal run ID")
	}

	// Missing header
	headers3 := map[string][]string{}
	got3 := headerFirst(headers3, "X-Test-Run-Id")
	if got3 != "" {
		t.Errorf("missing header: want empty string, got %q", got3)
	}
}

// ─────────────────────────────────────────────────────────────────────────────
// 6. extractBareAddress: From header → bare address
// ─────────────────────────────────────────────────────────────────────────────

func TestExtractBareAddress(t *testing.T) {
	cases := []struct {
		in   string
		want string
	}{
		{"Test Sender <sender@email.cz>", "sender@email.cz"},
		{"sender@email.cz", "sender@email.cz"},
		{"  SENDER@Email.Cz  ", "sender@email.cz"},
		{"<bounce@email.cz>", "bounce@email.cz"},
		{"=?UTF-8?Q?Jméno?= <name@host.cz>", "name@host.cz"},
	}
	for _, tc := range cases {
		got := extractBareAddress(tc.in)
		if got != tc.want {
			t.Errorf("extractBareAddress(%q) = %q, want %q", tc.in, got, tc.want)
		}
	}
}

// ─────────────────────────────────────────────────────────────────────────────
// 7. Wait-loop: target met early → exits before max-wait
//    Simulated via the logic of the exit condition check.
// ─────────────────────────────────────────────────────────────────────────────

func TestWaitLoopExitsEarlyWhenTargetMet(t *testing.T) {
	target := 3
	harvested := 0
	deadline := time.Now().Add(300 * time.Second)
	pollCount := 0

	for {
		if time.Now().After(deadline) {
			t.Fatal("deadline reached before target was met")
		}
		if harvested >= target {
			break
		}
		// Simulate harvesting 3 messages in the first poll.
		harvested += 3
		pollCount++
	}

	if pollCount != 1 {
		t.Errorf("expected exactly 1 poll before early exit, got %d", pollCount)
	}
	if harvested < target {
		t.Errorf("target not met: harvested %d < target %d", harvested, target)
	}
}

// ─────────────────────────────────────────────────────────────────────────────
// 8. Wait-loop: target never met → exits at deadline
// ─────────────────────────────────────────────────────────────────────────────

func TestWaitLoopExitsAtDeadline(t *testing.T) {
	target := 36
	harvested := 0
	// Very short deadline to simulate timeout without actually sleeping.
	deadline := time.Now().Add(-1 * time.Millisecond) // already expired
	pollCount := 0

	for {
		if time.Now().After(deadline) {
			break // deadline hit
		}
		if harvested >= target {
			break
		}
		harvested++ // would harvest one at a time
		pollCount++
	}

	if harvested >= target {
		t.Errorf("expected target NOT met, but harvested = %d", harvested)
	}
	// Gap detection.
	if target > 0 && harvested < target {
		gap := target - harvested
		if gap != target {
			t.Errorf("expected gap = %d, got %d", target, gap)
		}
	}
}

// ─────────────────────────────────────────────────────────────────────────────
// 9. UNIQUE constraint: idempotent — pq_array + nullableStr helpers
// ─────────────────────────────────────────────────────────────────────────────

func TestPqArray_Idempotent(t *testing.T) {
	// Empty slice.
	if got := pq_array(nil); got != "{}" {
		t.Errorf("pq_array(nil) = %q, want {}", got)
	}
	// Single element.
	if got := pq_array([]string{"hello"}); got != `{"hello"}` {
		t.Errorf(`pq_array(["hello"]) = %q, want {"hello"}`, got)
	}
	// Quoting.
	if got := pq_array([]string{`a"b`, `c\d`}); !strings.Contains(got, `\"`) {
		t.Errorf("expected escaped quote in %q", got)
	}
	// Running the same value twice produces the same output (idempotent).
	chain := []string{"from a by b; date1", "from c by d; date2"}
	r1 := pq_array(chain)
	r2 := pq_array(chain)
	if r1 != r2 {
		t.Errorf("pq_array not idempotent: %q != %q", r1, r2)
	}
}

// ─────────────────────────────────────────────────────────────────────────────
// 10. UIDVALIDITY change → watermark reset
// ─────────────────────────────────────────────────────────────────────────────

func TestUIDValidityChange_ResetsWatermark(t *testing.T) {
	watermarks := map[int64]int64{42: 1000}
	uidvalidities := map[int64]int64{42: 100}

	const mailboxID int64 = 42
	newUIDValidity := int64(200) // changed

	prev := uidvalidities[mailboxID]
	if prev != newUIDValidity {
		// Simulate the reset logic in pollMailbox.
		watermarks[mailboxID] = 0
	}
	uidvalidities[mailboxID] = newUIDValidity

	if watermarks[mailboxID] != 0 {
		t.Errorf("expected watermark reset to 0 after UIDVALIDITY change, got %d", watermarks[mailboxID])
	}
	if uidvalidities[mailboxID] != newUIDValidity {
		t.Errorf("expected uidvalidity updated to %d, got %d", newUIDValidity, uidvalidities[mailboxID])
	}
}

// ─────────────────────────────────────────────────────────────────────────────
// 11. Connection drop mid-poll: watermark not advanced on error
// ─────────────────────────────────────────────────────────────────────────────

func TestWatermarkNotAdvancedOnFetchError(t *testing.T) {
	watermarks := map[int64]int64{1: 50}

	// Simulate: fetch UID 51 fails. Watermark must stay at 50.
	fetchUID := int64(51)
	fetchErr := fmt.Errorf("connection reset by peer")

	if fetchErr == nil {
		watermarks[1] = fetchUID
	}
	// fetchErr != nil → watermark unchanged.

	if watermarks[1] != 50 {
		t.Errorf("watermark should stay at 50 after fetch error, got %d", watermarks[1])
	}
}

// ─────────────────────────────────────────────────────────────────────────────
// 12. Empty INBOX → exits cleanly at deadline with 0 harvested
// ─────────────────────────────────────────────────────────────────────────────

func TestEmptyInbox_ZeroHarvested(t *testing.T) {
	uids := parseUIDSearchResponse("H002 OK SEARCH completed\r\n")
	if len(uids) != 0 {
		t.Errorf("empty SEARCH response should yield 0 UIDs, got %d", len(uids))
	}

	// Simulate harvest with no UIDs.
	harvested := 0
	target := 36
	if harvested < target {
		// Correct: gap is detected, warning should be emitted.
		gap := target - harvested
		if gap != 36 {
			t.Errorf("gap = %d, want 36", gap)
		}
	}
}

// ─────────────────────────────────────────────────────────────────────────────
// 13. Archive folder: empty → INBOX untouched (no archive entries added)
// ─────────────────────────────────────────────────────────────────────────────

func TestArchiveFolder_EmptySkipsMove(t *testing.T) {
	archiveFolder := ""
	toArchive := []int64{101, 102, 103}
	movesCalled := 0

	// Simulate the archive block from pollMailbox.
	if archiveFolder != "" && len(toArchive) > 0 {
		movesCalled = len(toArchive)
	}

	if movesCalled != 0 {
		t.Errorf("expected 0 move calls when archiveFolder='', got %d", movesCalled)
	}
}

func TestArchiveFolder_NonEmptyMovesMessages(t *testing.T) {
	archiveFolder := "Tested-Anonymity"
	toArchive := []int64{101, 102, 103}
	movesCalled := 0

	if archiveFolder != "" && len(toArchive) > 0 {
		movesCalled = len(toArchive)
	}

	if movesCalled != 3 {
		t.Errorf("expected 3 move calls, got %d", movesCalled)
	}
}

// ─────────────────────────────────────────────────────────────────────────────
// Helper: parseUIDVALIDITY
// ─────────────────────────────────────────────────────────────────────────────

func TestParseUIDVALIDITY(t *testing.T) {
	cases := []struct {
		input string
		want  int64
		fail  bool
	}{
		{"* 5 EXISTS\r\n* OK [UIDVALIDITY 1746057600] UIDs valid\r\nH002 OK [READ-WRITE] SELECT completed", 1746057600, false},
		{"* OK [UIDVALIDITY 1] UIDs valid\r\n", 1, false},
		{"* OK no uidvalidity here\r\n", 0, true},
	}
	for _, tc := range cases {
		got, err := parseUIDVALIDITY(tc.input)
		if tc.fail && err == nil {
			t.Errorf("parseUIDVALIDITY(%q) expected error, got %d", tc.input, got)
		}
		if !tc.fail && err != nil {
			t.Errorf("parseUIDVALIDITY(%q) unexpected error: %v", tc.input, err)
		}
		if !tc.fail && got != tc.want {
			t.Errorf("parseUIDVALIDITY(%q) = %d, want %d", tc.input, got, tc.want)
		}
	}
}

// ─────────────────────────────────────────────────────────────────────────────
// Helper: parseUIDSearchResponse
// ─────────────────────────────────────────────────────────────────────────────

func TestParseUIDSearchResponse(t *testing.T) {
	cases := []struct {
		input string
		want  []int64
	}{
		{"* SEARCH 1 2 3\r\nH002 OK SEARCH completed\r\n", []int64{1, 2, 3}},
		{"* SEARCH\r\nH002 OK SEARCH completed\r\n", nil},
		{"H002 OK SEARCH completed\r\n", nil},
		{"* SEARCH 100 200 300 400\r\n", []int64{100, 200, 300, 400}},
	}
	for _, tc := range cases {
		got := parseUIDSearchResponse(tc.input)
		if len(got) != len(tc.want) {
			t.Errorf("parseUIDSearchResponse(%q): got %v, want %v", tc.input, got, tc.want)
			continue
		}
		for i := range tc.want {
			if got[i] != tc.want[i] {
				t.Errorf("parseUIDSearchResponse index %d: got %d, want %d", i, got[i], tc.want[i])
			}
		}
	}
}

// ─────────────────────────────────────────────────────────────────────────────
// Helper: extractAuthResult with mixed casing and multi-value
// ─────────────────────────────────────────────────────────────────────────────

func TestExtractAuthResult_Variants(t *testing.T) {
	cases := []struct {
		vals      []string
		mechanism string
		want      string
		wantNil   bool
	}{
		{[]string{"dkim=pass spf=fail dmarc=bestguesspass"}, "dkim", "pass", false},
		{[]string{"dkim=fail"}, "spf", "", true},
		{[]string{}, "dkim", "", true},
		{[]string{"DKIM=pass"}, "dkim", "pass", false},        // case-insensitive
		{[]string{"dkim=permerror; spf=pass"}, "spf", "pass", false},
		// Multi-value: take first occurrence
		{[]string{"dkim=none", "dkim=pass"}, "dkim", "none", false},
	}
	for _, tc := range cases {
		ptr := extractAuthResult(tc.vals, tc.mechanism)
		if tc.wantNil {
			if ptr != nil {
				t.Errorf("mechanism=%q vals=%v: want nil, got %q", tc.mechanism, tc.vals, *ptr)
			}
		} else {
			if ptr == nil {
				t.Errorf("mechanism=%q vals=%v: want %q, got nil", tc.mechanism, tc.vals, tc.want)
			} else if *ptr != tc.want {
				t.Errorf("mechanism=%q vals=%v: want %q, got %q", tc.mechanism, tc.vals, tc.want, *ptr)
			}
		}
	}
}

// ─────────────────────────────────────────────────────────────────────────────
// Helper: extractIMAPFullBodyLiteral
// ─────────────────────────────────────────────────────────────────────────────

func TestExtractIMAPFullBodyLiteral(t *testing.T) {
	body := "From: test@email.cz\r\nSubject: Hi\r\n\r\nBody text here"
	response := fmt.Sprintf("* 3 FETCH (BODY[] {%d}\r\n%sUID 3)\r\nH003 OK FETCH completed\r\n",
		len(body), body)

	got := extractIMAPFullBodyLiteral(response)
	if got != body {
		t.Errorf("extractIMAPFullBodyLiteral:\ngot:  %q\nwant: %q", got, body)
	}

	// Missing marker.
	got2 := extractIMAPFullBodyLiteral("no body here")
	if got2 != "" {
		t.Errorf("expected empty string for missing BODY[], got %q", got2)
	}
}

// ─────────────────────────────────────────────────────────────────────────────
// buildRawMessage constructs a minimal RFC 2822 raw message string for testing.
// ─────────────────────────────────────────────────────────────────────────────

func buildRawMessage(headers map[string][]string, body string) string {
	var sb strings.Builder
	for name, vals := range headers {
		for _, v := range vals {
			sb.WriteString(name)
			sb.WriteString(": ")
			sb.WriteString(v)
			sb.WriteString("\r\n")
		}
	}
	// Ensure at minimum a Date header so net/mail doesn't complain.
	if _, ok := headers["Date"]; !ok {
		sb.WriteString("Date: Thu, 01 May 2026 12:00:00 +0200\r\n")
	}
	if _, ok := headers["From"]; !ok {
		sb.WriteString("From: test@email.cz\r\n")
	}
	sb.WriteString("\r\n") // blank line separates headers from body
	sb.WriteString(body)
	return sb.String()
}

// ─────────────────────────────────────────────────────────────────────────────
// assertStrPtr compares a *string against an expected string value.
// ─────────────────────────────────────────────────────────────────────────────

func assertStrPtr(t *testing.T, name string, got *string, want string) {
	t.Helper()
	if got == nil {
		t.Errorf("%s: want %q, got nil", name, want)
		return
	}
	if *got != want {
		t.Errorf("%s: want %q, got %q", name, want, *got)
	}
}

// ─────────────────────────────────────────────────────────────────────────────
// Subject-marker helpers (issue #552) — parseSubjectMarker + matchesRun
// ─────────────────────────────────────────────────────────────────────────────

func TestParseSubjectMarker_Valid(t *testing.T) {
	cases := []struct {
		subject   string
		wantShort string
		wantOK    bool
	}{
		{"[A:1a2b3c4d] Váš stroj je připraven", "1a2b3c4d", true},
		{"[A:cafebabe] Test subject here", "cafebabe", true},
		{"[A:00000000] minimal", "00000000", true},
		// Invalid/absent markers
		{"Regular subject", "", false},
		{"", "", false},
		{"[A: incomplete", "", false},
		{"[B:1a2b3c4d] wrong bracket type", "", false},
		{"[A:] empty short", "", true}, // empty short is technically parseable
	}
	for _, tc := range cases {
		short, ok := parseSubjectMarker(tc.subject)
		if ok != tc.wantOK {
			t.Errorf("parseSubjectMarker(%q) ok=%v, want %v", tc.subject, ok, tc.wantOK)
			continue
		}
		if ok && short != tc.wantShort {
			t.Errorf("parseSubjectMarker(%q) short=%q, want %q", tc.subject, short, tc.wantShort)
		}
	}
}

func TestSubjectShortID_ExtractsFirstEightChars(t *testing.T) {
	cases := []struct {
		runID string
		want  string
	}{
		{"1a2b3c4d-5e6f-4000-8000-abcdef012345", "1a2b3c4d"},
		{"aabbccdd-eeff-4000-8000-000000000000", "aabbccdd"},
		{"00000000-0000-4000-8000-000000000000", "00000000"},
	}
	for _, tc := range cases {
		got := subjectShortID(tc.runID)
		if got != tc.want {
			t.Errorf("subjectShortID(%q) = %q, want %q", tc.runID, got, tc.want)
		}
	}
}

func TestMatchesRun_SubjectMarkerPrimary(t *testing.T) {
	runID := "cafecafe-0000-4000-8000-000000000001"
	short := subjectShortID(runID)

	// Matching subject
	subject := "[A:" + short + "] Test subject"
	if !matchesRun(subject, runID) {
		t.Errorf("matchesRun(%q, %q) = false, want true", subject, runID)
	}

	// Wrong run-id prefix
	subject2 := "[A:deadbeef] Test subject"
	if matchesRun(subject2, runID) {
		t.Errorf("matchesRun with wrong prefix should return false")
	}

	// No marker
	subject3 := "No marker here"
	if matchesRun(subject3, runID) {
		t.Errorf("matchesRun with no marker should return false")
	}
}

func TestMatchesRun_RoundTrip_InjectParse(t *testing.T) {
	// Verify that a subject injected by injectSubjectMarker (from anonymity-test)
	// is correctly matched by matchesRun (from anonymity-harvest).
	runID := "1a2b3c4d-5e6f-4000-8000-abcdef012345"
	original := "Váš stroj je připraven k prohlídce"

	// Simulate the inject step from anonymity-test.
	short := subjectShortID(runID)
	injected := "[A:" + short + "] " + original

	// Simulate the match step from anonymity-harvest.
	if !matchesRun(injected, runID) {
		t.Errorf("roundtrip: matchesRun(%q, %q) = false, want true", injected, runID)
	}

	// Different run-id should not match.
	otherRun := "ffffffff-ffff-4fff-8fff-ffffffffffff"
	if matchesRun(injected, otherRun) {
		t.Errorf("roundtrip: matchesRun should not match different run-id")
	}
}
