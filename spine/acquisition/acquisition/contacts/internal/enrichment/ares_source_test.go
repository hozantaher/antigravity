package enrichment

import (
	"context"
	"errors"
	"reflect"
	"testing"

	"contacts/ares"
)

// fakeFetcher is a programmable ARESFetcher for unit tests.
type fakeFetcher struct {
	data    *ares.SubjectData
	err     error
	calls   int
	lastICO string
}

func (f *fakeFetcher) FetchSubject(ctx context.Context, ico string) (*ares.SubjectData, error) {
	f.calls++
	f.lastICO = ico
	return f.data, f.err
}

func TestARESSource_Name(t *testing.T) {
	s := NewARESSource(&fakeFetcher{}, nil)
	if s.Name() != SourceARES {
		t.Errorf("Name() = %q want %q", s.Name(), SourceARES)
	}
}

func TestARESSource_Priority(t *testing.T) {
	s := NewARESSource(&fakeFetcher{}, nil)
	if got := s.Priority(); got != 1 {
		t.Errorf("Priority() = %d want 1", got)
	}
}

func TestARESSource_IsAvailable(t *testing.T) {
	tests := []struct {
		name  string
		probe HealthProbe
		want  bool
	}{
		{"no probe → available", nil, true},
		{"probe returns 1.0 → available", func() float64 { return 1.0 }, true},
		{"probe returns 0.5 → available", func() float64 { return 0.5 }, true},
		{"probe returns 0.3 → boundary available", func() float64 { return 0.3 }, true},
		{"probe returns 0.29 → unavailable", func() float64 { return 0.29 }, false},
		{"probe returns 0 → unavailable", func() float64 { return 0 }, false},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			s := NewARESSource(&fakeFetcher{}, tt.probe)
			got := s.IsAvailable(context.Background())
			if got != tt.want {
				t.Errorf("IsAvailable() = %v want %v", got, tt.want)
			}
		})
	}
}

func TestARESSource_IsAvailable_CancelledContext(t *testing.T) {
	s := NewARESSource(&fakeFetcher{}, nil)
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	if s.IsAvailable(ctx) {
		t.Errorf("IsAvailable should be false on cancelled context")
	}
}

func TestARESSource_Lookup_EmptyICO(t *testing.T) {
	f := &fakeFetcher{}
	s := NewARESSource(f, nil)
	data, err := s.Lookup(context.Background(), "")
	if !errors.Is(err, ErrICORequired) {
		t.Errorf("err = %v want ErrICORequired", err)
	}
	if data != nil {
		t.Errorf("data = %v want nil", data)
	}
	if f.calls != 0 {
		t.Errorf("fetcher calls = %d, must be 0 on empty ICO", f.calls)
	}
}

func TestARESSource_Lookup_NotFound(t *testing.T) {
	// ARES returns (nil, nil) on 404 — not found is not an error.
	f := &fakeFetcher{data: nil, err: nil}
	s := NewARESSource(f, nil)
	data, err := s.Lookup(context.Background(), "99999999")
	if err != nil {
		t.Errorf("err = %v want nil", err)
	}
	if data != nil {
		t.Errorf("data = %+v want nil", data)
	}
}

func TestARESSource_Lookup_FetchError(t *testing.T) {
	f := &fakeFetcher{err: errors.New("network down")}
	s := NewARESSource(f, nil)
	data, err := s.Lookup(context.Background(), "12345678")
	if err == nil {
		t.Fatal("expected error, got nil")
	}
	if data != nil {
		t.Errorf("data should be nil on error, got %+v", data)
	}
}

func TestARESSource_Lookup_NilFetcher(t *testing.T) {
	s := NewARESSource(nil, nil)
	_, err := s.Lookup(context.Background(), "12345678")
	if err == nil {
		t.Fatal("expected error when fetcher is nil")
	}
}

func TestARESSource_Lookup_MapsAllFields(t *testing.T) {
	sub := &ares.SubjectData{
		ICO:           "27082440",
		ObchodniJmeno: "Alza.cz a.s.",
		PravniForma:   "121",
		DatumVzniku:   "2003-08-26",
		NACECodes:     []string{"47910", "46510", "26110"},
		NACEPrimary:   "47910",
	}
	s := NewARESSource(&fakeFetcher{data: sub}, nil)

	data, err := s.Lookup(context.Background(), "27082440")
	if err != nil {
		t.Fatalf("err = %v want nil", err)
	}
	if data == nil {
		t.Fatal("data is nil")
	}
	if data.ICO != "27082440" {
		t.Errorf("ICO = %q", data.ICO)
	}
	if data.Name != "Alza.cz a.s." {
		t.Errorf("Name = %q", data.Name)
	}
	if data.PravniForma != "121" {
		t.Errorf("PravniForma = %q", data.PravniForma)
	}
	if data.DatumVzniku != "2003-08-26" {
		t.Errorf("DatumVzniku = %q", data.DatumVzniku)
	}
	if data.NACEPrimary != "47910" {
		t.Errorf("NACEPrimary = %q", data.NACEPrimary)
	}
	if !reflect.DeepEqual(data.NACECodes, []string{"47910", "46510", "26110"}) {
		t.Errorf("NACECodes = %v", data.NACECodes)
	}
}

func TestARESSource_Lookup_ICOPassedThrough(t *testing.T) {
	f := &fakeFetcher{data: &ares.SubjectData{ICO: "12345678"}}
	s := NewARESSource(f, nil)
	_, _ = s.Lookup(context.Background(), "12345678")
	if f.lastICO != "12345678" {
		t.Errorf("lastICO = %q want 12345678", f.lastICO)
	}
	if f.calls != 1 {
		t.Errorf("calls = %d want 1", f.calls)
	}
}

func TestARESSource_Lookup_NACECodesIndependentSlice(t *testing.T) {
	// Verify Lookup defensively copies NACECodes — mutating the returned
	// slice must not corrupt the underlying ARES SubjectData.
	original := []string{"41.20", "43.99"}
	sub := &ares.SubjectData{ICO: "1", NACECodes: original}
	s := NewARESSource(&fakeFetcher{data: sub}, nil)

	data, err := s.Lookup(context.Background(), "1")
	if err != nil {
		t.Fatal(err)
	}
	if len(data.NACECodes) != 2 {
		t.Fatalf("want 2 codes, got %d", len(data.NACECodes))
	}
	data.NACECodes[0] = "MUTATED"
	if original[0] == "MUTATED" {
		t.Error("Lookup did not defensively copy NACECodes — caller mutation leaked into SubjectData")
	}
}

func TestARESSource_Lookup_EmptyNACECodes(t *testing.T) {
	sub := &ares.SubjectData{ICO: "1", ObchodniJmeno: "X", NACECodes: nil}
	s := NewARESSource(&fakeFetcher{data: sub}, nil)
	data, err := s.Lookup(context.Background(), "1")
	if err != nil {
		t.Fatal(err)
	}
	if len(data.NACECodes) != 0 {
		t.Errorf("NACECodes len = %d want 0", len(data.NACECodes))
	}
}

func TestARESSource_Lookup_MinimalPayload(t *testing.T) {
	// ARES sometimes returns a subject with only ICO + name. Ensure mapping
	// does not panic and zero-fills the rest.
	sub := &ares.SubjectData{ICO: "1", ObchodniJmeno: "X"}
	s := NewARESSource(&fakeFetcher{data: sub}, nil)
	data, err := s.Lookup(context.Background(), "1")
	if err != nil {
		t.Fatal(err)
	}
	if data.PravniForma != "" || data.DatumVzniku != "" || data.NACEPrimary != "" {
		t.Errorf("unexpected non-empty optional field: %+v", data)
	}
}
