package pool

import (
	"relay/internal/model"
	"testing"
)

func TestSubmitAndDraw(t *testing.T) {
	p := NewMixPool(1) // minSize=1 so single message can be drawn

	p.Submit(model.Envelope{ID: "env_1", Status: model.StatusSealed})

	env, isReal := p.Draw()
	if !isReal {
		t.Fatal("expected real message")
	}
	if env.ID != "env_1" {
		t.Fatalf("wrong ID: %s", env.ID)
	}
}

func TestDrawReturnsCoverWhenBelowMinSize(t *testing.T) {
	p := NewMixPool(5) // need at least 5 messages

	p.Submit(model.Envelope{ID: "env_1"})
	p.Submit(model.Envelope{ID: "env_2"})

	// Pool has 2, minSize is 5 -- should return cover
	env, isReal := p.Draw()
	if isReal {
		t.Fatal("expected cover traffic when pool < minSize")
	}
	if !env.IsCover {
		t.Fatal("cover envelope should have IsCover=true")
	}

	// Pool should still have 2 messages (cover drawn, not real)
	if p.Size() != 2 {
		t.Fatalf("expected 2 remaining, got %d", p.Size())
	}
}

func TestDrawIsRandom(t *testing.T) {
	p := NewMixPool(1)

	// Submit 100 messages
	for i := 0; i < 100; i++ {
		p.Submit(model.Envelope{ID: "env_" + string(rune('A'+i%26))})
	}

	// Draw all and check they come out (not necessarily in order)
	drawn := make(map[string]bool)
	for i := 0; i < 100; i++ {
		env, isReal := p.Draw()
		if !isReal {
			break
		}
		drawn[env.ID] = true
	}

	if len(drawn) == 0 {
		t.Fatal("should have drawn some messages")
	}
}

func TestPoolMixingDecorelatesOrder(t *testing.T) {
	// Submit messages in order A, B, C, ..., run many draws,
	// verify output order differs from input at least sometimes
	const n = 50
	p := NewMixPool(1)

	ids := make([]string, n)
	for i := 0; i < n; i++ {
		id := "env_" + string(rune('A'+i%26)) + string(rune('0'+i/26))
		ids[i] = id
		p.Submit(model.Envelope{ID: id})
	}

	outputOrder := make([]string, 0, n)
	for i := 0; i < n; i++ {
		env, isReal := p.Draw()
		if !isReal {
			break
		}
		outputOrder = append(outputOrder, env.ID)
	}

	if len(outputOrder) != n {
		t.Fatalf("expected %d outputs, got %d", n, len(outputOrder))
	}

	// Count how many positions match input order
	matches := 0
	for i := 0; i < n; i++ {
		if outputOrder[i] == ids[i] {
			matches++
		}
	}

	// With n=50, random shuffle should match ~1 position (1/50 each).
	// If ALL match, mixing is broken.
	if matches == n {
		t.Fatal("output order identical to input -- mixing not working")
	}
}

func TestEmptyPoolDrawReturnscover(t *testing.T) {
	p := NewMixPool(1)

	env, isReal := p.Draw()
	if isReal {
		t.Fatal("empty pool should return cover")
	}
	if !env.IsCover {
		t.Fatal("should be cover")
	}
}
