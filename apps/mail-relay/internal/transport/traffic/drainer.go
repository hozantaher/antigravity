package traffic

import (
	"relay/internal/model"
	"relay/internal/relay"
	"context"
	"crypto/rand"
	"encoding/binary"
	"io"
	"math"
)

// cryptoRandReader is the source of random bytes for cryptoRandIntn.
// Tests override this to inject failures or deterministic values.
var cryptoRandReader io.Reader = rand.Reader

// drainReadier is the minimal interface BatchDrainer needs from the scheduler.
// Tests stub this to inject DrainReady errors without a real scheduler.
type drainReadier interface {
	DrainReady(ctx context.Context) ([]model.Envelope, error)
}

// BatchDrainer collects ready envelopes, mixes with cover traffic,
// and shuffles them using Fisher-Yates to resist ordering analysis.
type BatchDrainer struct {
	scheduler    drainReadier
	cover        *CoverGenerator
	coverRatio   float64
}

// NewBatchDrainer creates a drainer that mixes cover traffic at the given ratio.
// coverRatio 0.3 means ~30% of each batch will be cover traffic.
func NewBatchDrainer(scheduler *relay.Scheduler, cover *CoverGenerator, coverRatio float64) *BatchDrainer {
	return &BatchDrainer{
		scheduler:  scheduler,
		cover:      cover,
		coverRatio: coverRatio,
	}
}

// DrainAndShuffle collects ready envelopes, adds cover traffic, and shuffles.
func (d *BatchDrainer) DrainAndShuffle(ctx context.Context) ([]model.Envelope, error) {
	ready, err := d.scheduler.DrainReady(ctx)
	if err != nil {
		return nil, err
	}

	// Calculate cover traffic count
	coverCount := int(math.Ceil(float64(len(ready)) * d.coverRatio))
	if coverCount < 1 && len(ready) > 0 {
		coverCount = 1
	}

	covers := d.cover.GenerateBatch(coverCount)
	batch := make([]model.Envelope, 0, len(ready)+len(covers))
	batch = append(batch, ready...)
	batch = append(batch, covers...)

	cryptoShuffle(batch)

	return batch, nil
}

// cryptoShuffle performs a Fisher-Yates shuffle using crypto/rand.
func cryptoShuffle(items []model.Envelope) {
	for i := len(items) - 1; i > 0; i-- {
		j, err := cryptoRandIntn(i + 1)
		if err != nil {
			// Fallback: no shuffle if crypto/rand fails (shouldn't happen)
			return
		}
		items[i], items[j] = items[j], items[i]
	}
}

func cryptoRandIntn(n int) (int, error) {
	if n <= 0 {
		return 0, nil
	}
	var buf [8]byte
	if _, err := cryptoRandReader.Read(buf[:]); err != nil {
		return 0, err
	}
	v := binary.BigEndian.Uint64(buf[:])
	return int(v % uint64(n)), nil
}
