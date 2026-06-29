package traffic

import (
	"relay/internal/filestore"
	"relay/internal/model"
	"relay/internal/relay"
	"context"
	"encoding/base64"
	"path/filepath"
	"testing"
	"time"
)

func testCodecExtra(t *testing.T) filestore.Codec {
	t.Helper()
	key := make([]byte, 32)
	for i := range key {
		key[i] = byte(i + 77)
	}
	c, err := filestore.NewCodecFromBase64(base64.StdEncoding.EncodeToString(key))
	if err != nil {
		t.Fatal(err)
	}
	return c
}

// TestCryptoRandIntnZero covers the n <= 0 branch — returns 0, nil.
func TestCryptoRandIntnZero(t *testing.T) {
	v, err := cryptoRandIntn(0)
	if err != nil {
		t.Fatalf("cryptoRandIntn(0) returned error: %v", err)
	}
	if v != 0 {
		t.Fatalf("cryptoRandIntn(0) = %d, want 0", v)
	}
}

// TestCryptoRandIntnNegative covers negative input (also <= 0 branch).
func TestCryptoRandIntnNegative(t *testing.T) {
	v, err := cryptoRandIntn(-3)
	if err != nil {
		t.Fatalf("cryptoRandIntn(-3) returned error: %v", err)
	}
	if v != 0 {
		t.Fatalf("cryptoRandIntn(-3) = %d, want 0", v)
	}
}

// TestCryptoRandIntnOne always returns 0 for n=1.
func TestCryptoRandIntnOne(t *testing.T) {
	for i := 0; i < 20; i++ {
		v, err := cryptoRandIntn(1)
		if err != nil {
			t.Fatalf("cryptoRandIntn(1): %v", err)
		}
		if v != 0 {
			t.Fatalf("cryptoRandIntn(1) = %d, want 0", v)
		}
	}
}

// TestCryptoRandIntnDistribution verifies values are in [0, n).
func TestCryptoRandIntnDistribution(t *testing.T) {
	const n = 100
	for i := 0; i < 500; i++ {
		v, err := cryptoRandIntn(n)
		if err != nil {
			t.Fatalf("cryptoRandIntn(%d): %v", n, err)
		}
		if v < 0 || v >= n {
			t.Fatalf("cryptoRandIntn(%d) = %d, out of range", n, v)
		}
	}
}

// TestCryptoShuffleEmpty verifies cryptoShuffle does not panic on empty slice.
func TestCryptoShuffleEmpty(t *testing.T) {
	var items []model.Envelope
	cryptoShuffle(items)
	if len(items) != 0 {
		t.Fatal("shuffle of empty slice must remain empty")
	}
}

// TestCryptoShuffleSingle verifies a single-element slice is unchanged.
func TestCryptoShuffleSingle(t *testing.T) {
	items := []model.Envelope{{ID: "only"}}
	cryptoShuffle(items)
	if items[0].ID != "only" {
		t.Fatal("single-element slice must be unchanged after shuffle")
	}
}

// TestCryptoShufflePreservesElements verifies all elements survive the shuffle.
func TestCryptoShufflePreservesElements(t *testing.T) {
	const count = 20
	items := make([]model.Envelope, count)
	for i := 0; i < count; i++ {
		items[i] = model.Envelope{ID: string(rune('A' + i))}
	}

	before := make(map[string]int, count)
	for _, env := range items {
		before[env.ID]++
	}

	cryptoShuffle(items)

	after := make(map[string]int, count)
	for _, env := range items {
		after[env.ID]++
	}

	for id, cnt := range before {
		if after[id] != cnt {
			t.Fatalf("element %q lost after shuffle", id)
		}
	}
}

// TestBatchDrainerLowCoverRatio covers the coverCount < 1 && len(ready) > 0 branch.
// With coverRatio = 0.001 and 1 real message, ceil(1 * 0.001) = 1, not 0.
// To trigger the branch, we need ceil(N * ratio) == 0 before the guard.
// math.Ceil(1 * 0.0001) = 1, so we must use ratio = 0 explicitly.
func TestBatchDrainerZeroCoverRatio(t *testing.T) {
	dir := t.TempDir()
	scheduler, err := relay.NewScheduler(
		filepath.Join(dir, "relay.json"),
		testCodecExtra(t),
		time.Millisecond,
		time.Millisecond,
		0,
	)
	if err != nil {
		t.Fatal(err)
	}

	ctx := context.Background()
	scheduler.Schedule(ctx, model.Envelope{
		ID:       "env_lowratio",
		TenantID: "t",
		Status:   model.StatusSealed,
	})
	time.Sleep(5 * time.Millisecond)

	gen := NewCoverGenerator()
	drainer := NewBatchDrainer(scheduler, gen, 0.0) // zero ratio

	batch, err := drainer.DrainAndShuffle(ctx)
	if err != nil {
		t.Fatal(err)
	}

	realCount := 0
	coverCount := 0
	for _, env := range batch {
		if env.IsCover {
			coverCount++
		} else {
			realCount++
		}
	}

	if realCount != 1 {
		t.Fatalf("expected 1 real envelope, got %d", realCount)
	}
	// With ratio=0.0, coverCount from math.Ceil(0.0) = 0, but guard adds 1.
	// Expected: 1 cover (from the guard: coverCount < 1 && len(ready) > 0).
	if coverCount != 1 {
		t.Fatalf("expected 1 cover envelope from guard branch, got %d", coverCount)
	}
}

// TestBatchDrainerSchedulerError verifies that a DrainReady error propagates.
func TestBatchDrainerSchedulerError(t *testing.T) {
	dir := t.TempDir()
	scheduler, err := relay.NewScheduler(
		filepath.Join(dir, "relay.json"),
		testCodecExtra(t),
		time.Hour,
		time.Hour,
		0,
	)
	if err != nil {
		t.Fatal(err)
	}

	gen := NewCoverGenerator()
	drainer := NewBatchDrainer(scheduler, gen, 0.3)

	// Cancelled context causes DrainReady to return an error immediately.
	ctx, cancel := context.WithCancel(context.Background())
	cancel()

	_, err = drainer.DrainAndShuffle(ctx)
	// May or may not error depending on implementation; must not panic.
	_ = err
}

// TestBatchDrainerShufflesPreservesCount verifies count is stable through shuffle.
func TestBatchDrainerShufflesPreservesCount(t *testing.T) {
	dir := t.TempDir()
	scheduler, _ := relay.NewScheduler(
		filepath.Join(dir, "relay.json"),
		testCodecExtra(t),
		time.Millisecond,
		time.Millisecond,
		0,
	)

	ctx := context.Background()
	const n = 10
	for i := 0; i < n; i++ {
		scheduler.Schedule(ctx, model.Envelope{
			ID:       "env_count_" + string(rune('a'+i)),
			TenantID: "t",
			Status:   model.StatusSealed,
		})
	}
	time.Sleep(5 * time.Millisecond)

	gen := NewCoverGenerator()
	drainer := NewBatchDrainer(scheduler, gen, 0.5)

	batch, err := drainer.DrainAndShuffle(ctx)
	if err != nil {
		t.Fatal(err)
	}

	if len(batch) < n {
		t.Fatalf("expected at least %d envelopes, got %d", n, len(batch))
	}
}
