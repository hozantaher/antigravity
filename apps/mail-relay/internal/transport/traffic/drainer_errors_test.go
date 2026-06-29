package traffic

import (
	"context"
	"errors"
	"io"
	"relay/internal/model"
	"testing"
)

// stubScheduler is a drainReadier that always returns an error.
type stubScheduler struct{ err error }

func (s *stubScheduler) DrainReady(_ context.Context) ([]model.Envelope, error) {
	return nil, s.err
}

// TestDrainAndShuffle_DrainReadyError covers the `return nil, err` branch in
// DrainAndShuffle when the scheduler returns an error.
func TestDrainAndShuffle_DrainReadyError(t *testing.T) {
	want := errors.New("injected scheduler failure")
	drainer := &BatchDrainer{
		scheduler:  &stubScheduler{err: want},
		cover:      NewCoverGenerator(),
		coverRatio: 0.3,
	}

	_, err := drainer.DrainAndShuffle(context.Background())
	if err == nil {
		t.Fatal("expected error from DrainAndShuffle when DrainReady fails")
	}
	if !errors.Is(err, want) {
		t.Fatalf("unexpected error: %v", err)
	}
}

// errReader is an io.Reader that always returns an error.
type errReader struct{ err error }

func (e *errReader) Read(p []byte) (int, error) { return 0, e.err }

// TestCryptoRandIntn_ReadError covers the `return 0, err` branch in
// cryptoRandIntn when cryptoRandReader.Read fails.
func TestCryptoRandIntn_ReadError(t *testing.T) {
	want := errors.New("injected rand failure")
	origReader := cryptoRandReader
	cryptoRandReader = &errReader{err: want}
	defer func() { cryptoRandReader = origReader }()

	_, err := cryptoRandIntn(10)
	if err == nil {
		t.Fatal("expected error from cryptoRandIntn when rand.Read fails")
	}
	if !errors.Is(err, want) {
		t.Fatalf("unexpected error: %v", err)
	}
}

// TestCryptoShuffle_RandError covers the fallback `return` in cryptoShuffle
// when cryptoRandIntn returns an error (rand.Read fails on first iteration).
func TestCryptoShuffle_RandError(t *testing.T) {
	origReader := cryptoRandReader
	cryptoRandReader = &errReader{err: errors.New("rand fail")}
	defer func() { cryptoRandReader = origReader }()

	// Build a small slice — shuffle should exit early without panicking.
	items := []model.Envelope{
		{ID: "A"},
		{ID: "B"},
		{ID: "C"},
	}
	// Must not panic; the fallback path just returns without shuffling.
	cryptoShuffle(items)
	// All elements must still be present (no modification or loss).
	ids := map[string]int{}
	for _, e := range items {
		ids[e.ID]++
	}
	for _, id := range []string{"A", "B", "C"} {
		if ids[id] != 1 {
			t.Fatalf("element %q missing or duplicated after error-path shuffle", id)
		}
	}
}

// TestCryptoRandIntn_EOFError covers the io.EOF error path, ensuring it is
// treated as a real error (not swallowed).
func TestCryptoRandIntn_EOFError(t *testing.T) {
	origReader := cryptoRandReader
	cryptoRandReader = &errReader{err: io.EOF}
	defer func() { cryptoRandReader = origReader }()

	_, err := cryptoRandIntn(5)
	if err == nil {
		t.Fatal("expected error on EOF from rand reader")
	}
}
