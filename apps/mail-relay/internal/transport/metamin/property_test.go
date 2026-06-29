package metamin

import (
	"relay/internal/model"
	"bytes"
	"testing"
	"testing/quick"
	"time"
)

// ---------------------------------------------------------------------------
// Property: PadToSizeClass never panics on arbitrary byte slices
// ---------------------------------------------------------------------------

func TestPadToSizeClass_NeverPanics_Property(t *testing.T) {
	m := NewMinimizer()
	f := func(data []byte) bool {
		defer func() { recover() }()
		m.PadToSizeClass(data)
		return true
	}
	if err := quick.Check(f, &quick.Config{MaxCount: 500}); err != nil {
		t.Error(err)
	}
}

// ---------------------------------------------------------------------------
// Property: UnpadFromSizeClass never panics on arbitrary bytes
// ---------------------------------------------------------------------------

func TestUnpadFromSizeClass_NeverPanics_Property(t *testing.T) {
	m := NewMinimizer()
	f := func(data []byte) bool {
		defer func() { recover() }()
		m.UnpadFromSizeClass(data)
		return true
	}
	if err := quick.Check(f, &quick.Config{MaxCount: 500}); err != nil {
		t.Error(err)
	}
}

// ---------------------------------------------------------------------------
// Property: pad → unpad round-trip is lossless for arbitrary payloads
// ---------------------------------------------------------------------------

func TestPadUnpad_RoundTrip_Property(t *testing.T) {
	m := NewMinimizer()
	f := func(data []byte) bool {
		padded, _ := m.PadToSizeClass(data)
		recovered := m.UnpadFromSizeClass(padded)
		return bytes.Equal(recovered, data)
	}
	if err := quick.Check(f, &quick.Config{MaxCount: 500}); err != nil {
		t.Error(err)
	}
}

// ---------------------------------------------------------------------------
// Property: padded length is always a valid size class
// ---------------------------------------------------------------------------

func TestPadToSizeClass_OutputLenIsValidSizeClass_Property(t *testing.T) {
	m := NewMinimizer()
	validClasses := map[int]bool{
		model.SizeClass512: true,
		model.SizeClass2K:  true,
		model.SizeClass8K:  true,
		model.SizeClass32K: true,
	}
	f := func(data []byte) bool {
		padded, sc := m.PadToSizeClass(data)
		return validClasses[sc] && len(padded) == sc
	}
	if err := quick.Check(f, &quick.Config{MaxCount: 500}); err != nil {
		t.Error(err)
	}
}

// ---------------------------------------------------------------------------
// Property: padded length is always ≥ original length + 4 (length prefix)
// ---------------------------------------------------------------------------

func TestPadToSizeClass_PaddedAtLeastDataPlusFour_Property(t *testing.T) {
	m := NewMinimizer()
	f := func(data []byte) bool {
		padded, _ := m.PadToSizeClass(data)
		return len(padded) >= len(data)+4
	}
	if err := quick.Check(f, &quick.Config{MaxCount: 500}); err != nil {
		t.Error(err)
	}
}

// ---------------------------------------------------------------------------
// Property: BucketTime is always ≤ input and always UTC
// ---------------------------------------------------------------------------

func TestBucketTime_NeverExceedsInput_Property(t *testing.T) {
	m := NewMinimizer()
	f := func(unixSec int64) bool {
		ts := time.Unix(unixSec, 0).UTC()
		bucketed := m.BucketTime(ts)
		return !bucketed.After(ts) && bucketed.Location() == time.UTC
	}
	if err := quick.Check(f, &quick.Config{MaxCount: 500}); err != nil {
		t.Error(err)
	}
}

// ---------------------------------------------------------------------------
// Property: BucketTime is idempotent — bucketing an already-bucketed time is a no-op
// ---------------------------------------------------------------------------

func TestBucketTime_Idempotent_Property(t *testing.T) {
	m := NewMinimizer()
	f := func(unixSec int64) bool {
		ts := time.Unix(unixSec, 0).UTC()
		once := m.BucketTime(ts)
		twice := m.BucketTime(once)
		return once.Equal(twice)
	}
	if err := quick.Check(f, &quick.Config{MaxCount: 500}); err != nil {
		t.Error(err)
	}
}

// ---------------------------------------------------------------------------
// Property: BucketTime minutes field is always a multiple of 15
// ---------------------------------------------------------------------------

func TestBucketTime_MinutesAlwaysMultipleOf15_Property(t *testing.T) {
	m := NewMinimizer()
	f := func(unixSec int64) bool {
		ts := time.Unix(unixSec, 0).UTC()
		bucketed := m.BucketTime(ts)
		return bucketed.Minute()%15 == 0
	}
	if err := quick.Check(f, &quick.Config{MaxCount: 500}); err != nil {
		t.Error(err)
	}
}

// ---------------------------------------------------------------------------
// Monkey: MinimizeEnvelope never panics on zero-value envelope
// ---------------------------------------------------------------------------

func TestMinimizeEnvelope_ZeroValue_NeverPanics(t *testing.T) {
	m := NewMinimizer()
	defer func() {
		if r := recover(); r != nil {
			t.Fatalf("MinimizeEnvelope panicked: %v", r)
		}
	}()
	var env model.Envelope
	m.MinimizeEnvelope(&env)
	if env.BucketedAt.IsZero() {
		t.Fatal("BucketedAt should be set after MinimizeEnvelope")
	}
}

// ---------------------------------------------------------------------------
// Monkey: MinimizeEnvelope sets BucketedAt to a past-or-present bucketed time
// ---------------------------------------------------------------------------

func TestMinimizeEnvelope_SetsRecentBucketedAt(t *testing.T) {
	m := NewMinimizer()
	before := time.Now().UTC()
	var env model.Envelope
	m.MinimizeEnvelope(&env)
	after := time.Now().UTC()

	if env.BucketedAt.After(after) {
		t.Fatalf("BucketedAt=%v is after current time=%v", env.BucketedAt, after)
	}
	// BucketedAt should be at most 15 min before `before`
	earliest := before.Add(-15 * time.Minute)
	if env.BucketedAt.Before(earliest) {
		t.Fatalf("BucketedAt=%v is more than 15 min before call time=%v", env.BucketedAt, before)
	}
	if env.BucketedAt.Minute()%15 != 0 {
		t.Fatalf("BucketedAt.Minute()=%d is not a multiple of 15", env.BucketedAt.Minute())
	}
}

// ---------------------------------------------------------------------------
// Monkey: UnpadFromSizeClass on nil → nil (no panic)
// ---------------------------------------------------------------------------

func TestUnpadFromSizeClass_Nil_ReturnsNil(t *testing.T) {
	m := NewMinimizer()
	result := m.UnpadFromSizeClass(nil)
	if result != nil {
		t.Fatalf("expected nil, got %v", result)
	}
}

// ---------------------------------------------------------------------------
// Monkey: UnpadFromSizeClass on 3-byte input (< 4) → nil
// ---------------------------------------------------------------------------

func TestUnpadFromSizeClass_TooShort_ReturnsNil(t *testing.T) {
	m := NewMinimizer()
	for _, short := range [][]byte{{}, {0x00}, {0x00, 0x00}, {0x00, 0x00, 0x00}} {
		result := m.UnpadFromSizeClass(short)
		if result != nil {
			t.Fatalf("input len %d: expected nil, got %v", len(short), result)
		}
	}
}

// ---------------------------------------------------------------------------
// Monkey: empty data pad/unpad is lossless
// ---------------------------------------------------------------------------

func TestPadUnpad_EmptyData_Lossless(t *testing.T) {
	m := NewMinimizer()
	padded, sc := m.PadToSizeClass([]byte{})
	if sc != model.SizeClass512 {
		t.Fatalf("empty data: expected size class 512, got %d", sc)
	}
	recovered := m.UnpadFromSizeClass(padded)
	if len(recovered) != 0 {
		t.Fatalf("expected empty slice, got len=%d", len(recovered))
	}
}
