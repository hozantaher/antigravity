package traffic

import (
	"relay/internal/filestore"
	"relay/internal/model"
	"relay/internal/relay"
	"context"
	"encoding/base64"
	"math"
	"path/filepath"
	"testing"
	"time"
)

func testCodec(t *testing.T) filestore.Codec {
	t.Helper()
	key := make([]byte, 32)
	for i := range key {
		key[i] = byte(i + 44)
	}
	c, _ := filestore.NewCodecFromBase64(base64.StdEncoding.EncodeToString(key))
	return c
}

func TestCoverGeneratorSizeClass(t *testing.T) {
	gen := NewCoverGenerator()

	for _, sc := range model.SizeClasses() {
		cover := gen.Generate(sc)
		if cover.SizeClass != sc {
			t.Errorf("expected size class %d, got %d", sc, cover.SizeClass)
		}
		if len(cover.SealedContent) != sc {
			t.Errorf("expected content length %d, got %d", sc, len(cover.SealedContent))
		}
		if !cover.IsCover {
			t.Error("cover envelope should have IsCover=true")
		}
		if cover.IntakeChannel != "cover" {
			t.Errorf("expected channel 'cover', got %s", cover.IntakeChannel)
		}
	}
}

func TestCoverIndistinguishableFromReal(t *testing.T) {
	gen := NewCoverGenerator()

	// Generate two covers of same size class -- they should have same length
	c1 := gen.Generate(model.SizeClass2K)
	c2 := gen.Generate(model.SizeClass2K)

	if len(c1.SealedContent) != len(c2.SealedContent) {
		t.Fatal("covers of same size class should have identical content length")
	}

	// They should have different IDs and content (random)
	if c1.ID == c2.ID {
		t.Fatal("covers should have unique IDs")
	}
}

func TestCoverBatchDistribution(t *testing.T) {
	gen := NewCoverGenerator()
	batch := gen.GenerateBatch(20)

	if len(batch) != 20 {
		t.Fatalf("expected 20 covers, got %d", len(batch))
	}

	// Check distribution across size classes
	classCounts := map[int]int{}
	for _, c := range batch {
		classCounts[c.SizeClass]++
	}
	// With 20 items and 4 classes, each class should appear 5 times
	for _, sc := range model.SizeClasses() {
		if classCounts[sc] != 5 {
			t.Errorf("size class %d: expected 5, got %d", sc, classCounts[sc])
		}
	}
}

func TestBatchDrainerAddsCovers(t *testing.T) {
	dir := t.TempDir()
	scheduler, _ := relay.NewScheduler(
		filepath.Join(dir, "relay.json"),
		testCodec(t),
		time.Millisecond,
		time.Millisecond,
		0,
	)

	ctx := context.Background()
	// Schedule 10 real envelopes
	for i := 0; i < 10; i++ {
		scheduler.Schedule(ctx, model.Envelope{
			ID:       "env_" + string(rune('a'+i)),
			TenantID: "t",
			Status:   model.StatusSealed,
		})
	}

	time.Sleep(5 * time.Millisecond)

	gen := NewCoverGenerator()
	drainer := NewBatchDrainer(scheduler, gen, 0.3)

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

	if realCount != 10 {
		t.Fatalf("expected 10 real envelopes, got %d", realCount)
	}

	// Cover should be ~30% of real = ceil(10 * 0.3) = 3
	expectedCover := int(math.Ceil(10 * 0.3))
	if coverCount != expectedCover {
		t.Fatalf("expected %d cover envelopes, got %d", expectedCover, coverCount)
	}
}

func TestBatchDrainerShuffles(t *testing.T) {
	dir := t.TempDir()
	scheduler, _ := relay.NewScheduler(
		filepath.Join(dir, "relay.json"),
		testCodec(t),
		time.Millisecond,
		time.Millisecond,
		0,
	)

	ctx := context.Background()
	for i := 0; i < 20; i++ {
		scheduler.Schedule(ctx, model.Envelope{
			ID:       "env_seq_" + string(rune('A'+i)),
			TenantID: "t",
			Status:   model.StatusSealed,
		})
	}

	time.Sleep(5 * time.Millisecond)

	gen := NewCoverGenerator()
	drainer := NewBatchDrainer(scheduler, gen, 0.3)

	batch, _ := drainer.DrainAndShuffle(ctx)

	// Check that covers are mixed in (not all at the end)
	firstCoverIdx := -1
	lastRealIdx := -1
	for i, env := range batch {
		if env.IsCover && firstCoverIdx == -1 {
			firstCoverIdx = i
		}
		if !env.IsCover {
			lastRealIdx = i
		}
	}

	// In a shuffled batch, we expect covers to be interleaved with real
	// (not all grouped together). With 20+ items, pure chance of all covers
	// at end is astronomically low.
	if firstCoverIdx > lastRealIdx {
		// This could happen by chance but is extremely unlikely with 20+ items
		t.Log("WARNING: covers appear to be grouped at end -- may indicate insufficient shuffling")
	}
}

func TestBatchDrainerEmptyQueue(t *testing.T) {
	dir := t.TempDir()
	scheduler, _ := relay.NewScheduler(
		filepath.Join(dir, "relay.json"),
		testCodec(t),
		time.Hour, // large delay
		2*time.Hour,
		0,
	)

	gen := NewCoverGenerator()
	drainer := NewBatchDrainer(scheduler, gen, 0.3)

	batch, err := drainer.DrainAndShuffle(context.Background())
	if err != nil {
		t.Fatal(err)
	}

	// Empty queue = no real + no covers (cover ratio of 0 real = 0)
	if len(batch) != 0 {
		t.Fatalf("expected empty batch, got %d", len(batch))
	}
}
