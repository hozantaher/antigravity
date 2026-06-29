package constrate

import (
	"relay/internal/minlog"
	"relay/internal/model"
	"context"
	"sync"
	"time"
)

// MessageSource provides messages for the emitter to send.
// Typically backed by a MixPool.
type MessageSource interface {
	// Draw returns one message. If no real messages are available,
	// returns a cover message with IsCover=true.
	Draw() (model.Envelope, bool)
	// Requeue returns a message to the pool after failed delivery.
	Requeue(env model.Envelope)
}

// Sender delivers messages to their exit channel.
type Sender interface {
	Send(ctx context.Context, env model.Envelope) error
}

// Emitter sends messages at a strictly constant rate.
// When real messages are available, it sends one from the pool.
// When the pool is empty, it sends cover traffic.
// An external observer sees identical timing regardless of actual traffic volume.
//
// This is the primary defense against state-level traffic analysis.
// Unlike random delays or jittered batch intervals, constant-rate emission
// makes volume analysis yield zero information.
type Emitter struct {
	interval time.Duration
	source   MessageSource
	sender   Sender
	log      *minlog.Logger
	mu       sync.Mutex
	running  bool
	stats    EmitterStats
}

// EmitterStats tracks emission statistics (no PII).
type EmitterStats struct {
	TotalEmitted int64
	RealEmitted  int64
	CoverEmitted int64
}

// NewEmitter creates a constant-rate emitter.
// interval determines the emission rate (e.g., 5s = 12 messages/minute).
// The rate should be chosen to exceed peak real traffic with margin.
func NewEmitter(interval time.Duration, source MessageSource, sender Sender, log *minlog.Logger) *Emitter {
	return &Emitter{
		interval: interval,
		source:   source,
		sender:   sender,
		log:      log,
	}
}

// Run starts the emission loop. It ticks at exactly `interval`.
// Each tick: draw one message from source (real or cover), send it.
// Jitter is intentionally zero -- the constant cadence IS the defense.
func (e *Emitter) Run(ctx context.Context) {
	e.mu.Lock()
	if e.running {
		e.mu.Unlock()
		return
	}
	e.running = true
	e.mu.Unlock()

	ticker := time.NewTicker(e.interval)
	defer ticker.Stop()

	for {
		select {
		case <-ctx.Done():
			e.mu.Lock()
			e.running = false
			e.mu.Unlock()
			return
		case <-ticker.C:
			e.emitOne(ctx)
		}
	}
}

func (e *Emitter) emitOne(ctx context.Context) {
	env, isReal := e.source.Draw()

	// Retry up to 3 times to maintain constant-rate guarantee
	var sent bool
	for attempt := 0; attempt < 3; attempt++ {
		if err := e.sender.Send(ctx, env); err == nil {
			sent = true
			break
		}
	}

	if !sent {
		// All retries failed -- requeue real message, emit cover instead
		if isReal {
			e.source.Requeue(env)
			e.log.Error("emission_requeued", minlog.F("envelope_id", env.ID))
		}
		// Emit cover to maintain constant rate (best effort)
		cover, _ := e.source.Draw()
		if cover.IsCover {
			e.sender.Send(ctx, cover)
		}
	}

	e.mu.Lock()
	e.stats.TotalEmitted++
	if isReal {
		e.stats.RealEmitted++
	} else {
		e.stats.CoverEmitted++
	}
	e.mu.Unlock()
}

// Stats returns a snapshot of emission statistics.
func (e *Emitter) Stats() EmitterStats {
	e.mu.Lock()
	defer e.mu.Unlock()
	return e.stats
}

// IsRunning reports whether the emitter is active.
func (e *Emitter) IsRunning() bool {
	e.mu.Lock()
	defer e.mu.Unlock()
	return e.running
}
