package metamin

import (
	"relay/internal/model"
	"bytes"
	"testing"
	"time"
)

func TestBucketTime(t *testing.T) {
	m := NewMinimizer()

	// 14:07 should bucket to 14:00
	input := time.Date(2026, 4, 3, 14, 7, 33, 0, time.UTC)
	bucketed := m.BucketTime(input)
	expected := time.Date(2026, 4, 3, 14, 0, 0, 0, time.UTC)

	if !bucketed.Equal(expected) {
		t.Fatalf("expected %v, got %v", expected, bucketed)
	}

	// 14:16 should bucket to 14:15
	input2 := time.Date(2026, 4, 3, 14, 16, 0, 0, time.UTC)
	bucketed2 := m.BucketTime(input2)
	expected2 := time.Date(2026, 4, 3, 14, 15, 0, 0, time.UTC)

	if !bucketed2.Equal(expected2) {
		t.Fatalf("expected %v, got %v", expected2, bucketed2)
	}
}

func TestPadAndUnpad(t *testing.T) {
	m := NewMinimizer()

	data := []byte("hello world")
	padded, sizeClass := m.PadToSizeClass(data)

	if sizeClass != 512 {
		t.Fatalf("expected size class 512, got %d", sizeClass)
	}
	if len(padded) != 512 {
		t.Fatalf("expected padded length 512, got %d", len(padded))
	}

	unpadded := m.UnpadFromSizeClass(padded)
	if !bytes.Equal(unpadded, data) {
		t.Fatalf("unpadded mismatch: got %q, want %q", unpadded, data)
	}
}

func TestPadSizeClasses(t *testing.T) {
	m := NewMinimizer()

	cases := []struct {
		dataLen   int
		wantClass int
	}{
		{10, 512},
		{500, 512},
		{508, 512},    // 508 + 4 = 512
		{509, 2048},   // 509 + 4 = 513 > 512
		{2000, 2048},
		{2044, 2048},  // 2044 + 4 = 2048
		{2045, 8192},  // 2045 + 4 > 2048
		{8000, 8192},
		{30000, 32768},
	}

	for _, tc := range cases {
		data := make([]byte, tc.dataLen)
		_, sc := m.PadToSizeClass(data)
		if sc != tc.wantClass {
			t.Errorf("data len %d: got class %d, want %d", tc.dataLen, sc, tc.wantClass)
		}
	}
}

// TestPadToSizeClass_OversizeRejected verifies that content too large for the
// top size class is rejected with (nil, 0) instead of being silently truncated
// and stamped with a length prefix larger than the buffer. The old behavior
// wrote an unrecoverable envelope that UnpadFromSizeClass later returned nil
// for, dropping mail that intake had already accepted (202).
func TestPadToSizeClass_OversizeRejected(t *testing.T) {
	m := NewMinimizer()

	// Largest representable payload: SizeClass32K minus the 4-byte length prefix.
	maxPayload := model.SizeClass32K - 4
	atLimit := make([]byte, maxPayload)
	padded, sc := m.PadToSizeClass(atLimit)
	if sc != model.SizeClass32K || len(padded) != model.SizeClass32K {
		t.Fatalf("payload at limit (%d): got class %d / len %d, want %d",
			maxPayload, sc, len(padded), model.SizeClass32K)
	}
	if recovered := m.UnpadFromSizeClass(padded); len(recovered) != maxPayload {
		t.Fatalf("at-limit round-trip lost data: recovered %d, want %d", len(recovered), maxPayload)
	}

	// One byte over the limit must be rejected, not truncated.
	oversize := make([]byte, maxPayload+1)
	padded, sc = m.PadToSizeClass(oversize)
	if padded != nil || sc != 0 {
		t.Fatalf("oversize payload (%d): got (len %d, class %d), want (nil, 0)",
			len(oversize), len(padded), sc)
	}
}

func TestAllPaddedSameSizeAreIndistinguishable(t *testing.T) {
	m := NewMinimizer()

	msg1 := []byte("short")
	msg2 := []byte("a slightly longer message here")

	padded1, sc1 := m.PadToSizeClass(msg1)
	padded2, sc2 := m.PadToSizeClass(msg2)

	if sc1 != sc2 {
		t.Skip("different size classes, can't compare")
	}

	if len(padded1) != len(padded2) {
		t.Fatalf("same size class should produce same length: %d vs %d", len(padded1), len(padded2))
	}
}
