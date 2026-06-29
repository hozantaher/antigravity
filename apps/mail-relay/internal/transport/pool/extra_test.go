package pool

import (
	"relay/internal/model"
	"testing"
)

func TestMixPool_Requeue(t *testing.T) {
	p := NewMixPool(1)
	p.Submit(model.Envelope{ID: "env_1"})

	env, isReal := p.Draw()
	if !isReal {
		t.Fatal("expected real draw")
	}
	if p.Size() != 0 {
		t.Fatalf("size after draw = %d, want 0", p.Size())
	}

	p.Requeue(env)
	if p.Size() != 1 {
		t.Fatalf("size after requeue = %d, want 1", p.Size())
	}

	redrawn, isReal := p.Draw()
	if !isReal {
		t.Fatal("expected real draw of requeued message")
	}
	if redrawn.ID != "env_1" {
		t.Fatalf("requeued ID = %q, want env_1", redrawn.ID)
	}
}

func TestMixPool_MinSize(t *testing.T) {
	tests := []struct {
		name  string
		input int
		want  int
	}{
		{"explicit size", 5, 5},
		{"zero clamps to one", 0, 1},
		{"negative clamps to one", -3, 1},
		{"one stays one", 1, 1},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			p := NewMixPool(tt.input)
			if got := p.MinSize(); got != tt.want {
				t.Fatalf("MinSize() = %d, want %d", got, tt.want)
			}
		})
	}
}

func TestCryptoRandIntn_ZeroAndNegative(t *testing.T) {
	tests := []struct {
		name string
		n    int
	}{
		{"zero", 0},
		{"negative", -1},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			got, err := cryptoRandIntn(tt.n)
			if err != nil {
				t.Fatalf("unexpected error: %v", err)
			}
			if got != 0 {
				t.Fatalf("cryptoRandIntn(%d) = %d, want 0", tt.n, got)
			}
		})
	}
}

func TestCryptoRandIntn_PositiveBounds(t *testing.T) {
	for i := 0; i < 200; i++ {
		got, err := cryptoRandIntn(7)
		if err != nil {
			t.Fatalf("unexpected error: %v", err)
		}
		if got < 0 || got >= 7 {
			t.Fatalf("cryptoRandIntn(7) = %d, out of [0,7)", got)
		}
	}
}

func TestGenerateCover_ShapeAndFlags(t *testing.T) {
	env := generateCover()
	if !env.IsCover {
		t.Fatal("cover envelope must have IsCover=true")
	}
	if env.Status != model.StatusScheduled {
		t.Fatalf("cover status = %q, want %q", env.Status, model.StatusScheduled)
	}
	if env.IntakeChannel != "cover" {
		t.Fatalf("cover IntakeChannel = %q, want cover", env.IntakeChannel)
	}
	if len(env.SealedContent) != env.SizeClass {
		t.Fatalf("content length %d != size class %d", len(env.SealedContent), env.SizeClass)
	}

	valid := false
	for _, sc := range model.SizeClasses() {
		if sc == env.SizeClass {
			valid = true
			break
		}
	}
	if !valid {
		t.Fatalf("cover SizeClass %d is not in SizeClasses()", env.SizeClass)
	}
	if env.ID == "" || env.AliasToken == "" {
		t.Fatal("cover envelope missing ID or AliasToken")
	}
	// BucketedAt must be rounded to 15 minutes.
	if env.BucketedAt.Truncate(15*60*1000*1000*1000) != env.BucketedAt {
		t.Fatalf("BucketedAt %v is not truncated to 15 minutes", env.BucketedAt)
	}
}

func TestMixPool_DrawRemovesMessage(t *testing.T) {
	p := NewMixPool(1)
	p.Submit(model.Envelope{ID: "only"})
	if p.Size() != 1 {
		t.Fatalf("size = %d, want 1", p.Size())
	}

	_, isReal := p.Draw()
	if !isReal {
		t.Fatal("expected real draw")
	}
	if p.Size() != 0 {
		t.Fatalf("size after draw = %d, want 0", p.Size())
	}

	// Second draw -> cover because empty.
	_, isReal = p.Draw()
	if isReal {
		t.Fatal("expected cover from empty pool")
	}
}
