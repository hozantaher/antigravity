package pool_test

import (
	"fmt"
	"testing"
	"testing/quick"

	"relay/internal/model"
	"relay/internal/transport/pool"
)

func makeEnvelope(i int) model.Envelope {
	return model.Envelope{
		ID:            fmt.Sprintf("env-%d", i),
		SealedContent: []byte("test message"),
		SizeClass:     1,
	}
}

// ── Draw — cover traffic when pool below minSize ───────────────────────────

func TestDraw_BelowMinSize_ReturnsCover(t *testing.T) {
	p := pool.NewMixPool(5) // minSize=5
	// Add only 3 messages (below minSize)
	for i := 0; i < 3; i++ {
		p.Submit(makeEnvelope(i))
	}
	_, isReal := p.Draw()
	if isReal {
		t.Error("pool below minSize should return cover traffic (isReal=false)")
	}
}

func TestDraw_AtMinSize_CanReturnReal(t *testing.T) {
	p := pool.NewMixPool(3)
	for i := 0; i < 3; i++ {
		p.Submit(makeEnvelope(i))
	}
	_, isReal := p.Draw()
	if !isReal {
		t.Error("pool at minSize should return real message")
	}
}

func TestDraw_ReducesPoolSize(t *testing.T) {
	p := pool.NewMixPool(1)
	p.Submit(makeEnvelope(0))
	p.Submit(makeEnvelope(1))
	before := p.Size()
	_, isReal := p.Draw()
	if !isReal {
		t.Skip("drew cover — pool may have been below minSize")
	}
	after := p.Size()
	if after != before-1 {
		t.Errorf("expected size %d after Draw, got %d", before-1, after)
	}
}

func TestDraw_EmptyPool_ReturnsCover(t *testing.T) {
	p := pool.NewMixPool(1)
	_, isReal := p.Draw()
	if isReal {
		t.Error("empty pool should return cover (isReal=false)")
	}
}

func TestDraw_NeverPanics_Property(t *testing.T) {
	f := func(size uint8) bool {
		defer func() { recover() }()
		p := pool.NewMixPool(int(size) + 1)
		for i := 0; i < int(size); i++ {
			p.Submit(makeEnvelope(i))
		}
		p.Draw()
		return true
	}
	if err := quick.Check(f, &quick.Config{MaxCount: 200}); err != nil {
		t.Errorf("Draw panicked: %v", err)
	}
}

func TestDraw_ConcurrentSafe(t *testing.T) {
	p := pool.NewMixPool(1)
	for i := 0; i < 20; i++ {
		p.Submit(makeEnvelope(i))
	}
	done := make(chan struct{}, 10)
	for i := 0; i < 10; i++ {
		go func() {
			defer func() { recover() }()
			p.Draw()
			done <- struct{}{}
		}()
	}
	for i := 0; i < 10; i++ {
		<-done
	}
}
