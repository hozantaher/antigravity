package enrichment

import (
	"context"
	"errors"
	"testing"
)

func TestJusticeCZSource_Name(t *testing.T) {
	s := NewJusticeCZSource(nil)
	if s.Name() != SourceJusticeCZ {
		t.Errorf("Name() = %q want %q", s.Name(), SourceJusticeCZ)
	}
}

func TestJusticeCZSource_Priority(t *testing.T) {
	s := NewJusticeCZSource(nil)
	if s.Priority() != 3 {
		t.Errorf("Priority() = %d want 3", s.Priority())
	}
}

func TestJusticeCZSource_IsAvailable_Default(t *testing.T) {
	s := NewJusticeCZSource(nil)
	if s.IsAvailable(context.Background()) {
		t.Errorf("default stub must report unavailable until implementation lands")
	}
}

func TestJusticeCZSource_IsAvailable_WithProbe(t *testing.T) {
	tests := []struct {
		name  string
		probe HealthProbe
		want  bool
	}{
		{"probe 1.0", func() float64 { return 1.0 }, true},
		{"probe 0.3 boundary", func() float64 { return 0.3 }, true},
		{"probe 0.29", func() float64 { return 0.29 }, false},
		{"probe 0", func() float64 { return 0 }, false},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			s := NewJusticeCZSource(tt.probe)
			if got := s.IsAvailable(context.Background()); got != tt.want {
				t.Errorf("IsAvailable() = %v want %v", got, tt.want)
			}
		})
	}
}

func TestJusticeCZSource_IsAvailable_CancelledContext(t *testing.T) {
	s := NewJusticeCZSource(func() float64 { return 1.0 })
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	if s.IsAvailable(ctx) {
		t.Errorf("must report unavailable on cancelled context")
	}
}

func TestJusticeCZSource_Lookup_EmptyICO(t *testing.T) {
	s := NewJusticeCZSource(nil)
	_, err := s.Lookup(context.Background(), "")
	if !errors.Is(err, ErrICORequired) {
		t.Errorf("err = %v want ErrICORequired", err)
	}
}

func TestJusticeCZSource_Lookup_ReturnsNilNil(t *testing.T) {
	s := NewJusticeCZSource(nil)
	data, err := s.Lookup(context.Background(), "12345678")
	if err != nil {
		t.Errorf("err = %v want nil", err)
	}
	if data != nil {
		t.Errorf("data = %+v want nil (stub)", data)
	}
}

func TestJusticeCZSource_Lookup_ContextDeadline(t *testing.T) {
	s := NewJusticeCZSource(nil)
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	_, err := s.Lookup(ctx, "12345678")
	if err == nil {
		t.Fatal("expected context error")
	}
	if !errors.Is(err, context.Canceled) {
		t.Errorf("err = %v want context.Canceled", err)
	}
}

func TestJusticeCZSource_ImplementsInterface(t *testing.T) {
	// Compile-time check that JusticeCZSource satisfies EnrichmentSource.
	var _ EnrichmentSource = (*JusticeCZSource)(nil)
	var _ EnrichmentSource = NewJusticeCZSource(nil)
}

func TestARESSource_ImplementsInterface(t *testing.T) {
	var _ EnrichmentSource = (*ARESSource)(nil)
}

func TestFirmyCZSource_ImplementsInterface(t *testing.T) {
	var _ EnrichmentSource = (*FirmyCZSource)(nil)
}
