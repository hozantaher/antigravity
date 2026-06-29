package probe

import (
	"context"
	"time"
)

// StubProbe emits a fixed Status for a (layer, level) pair. Use it to
// fill cells the UI always renders (see dashboard PROTECTION_LAYERS ×
// PROTECTION_LEVELS) for layers where a given level has no meaningful
// check. Without a stub the cell would show "Bez dat"; with a Skip
// stub it renders green with an honest "not applicable here" detail.
//
// Intended usage:
//   - L2 stubs for logic-only layers (header_gate, warmup,
//     bounce_guard, circuit_breaker, send_rate, spf_dmarc, canary):
//     these layers have no runtime "is it alive?" surface — they are
//     in-process guards whose correctness L3 already proves.
//   - L3 stubs for pure liveness layers (db_pool, sender_engine):
//     db_pool correctness is redundant with L2 SELECT 1; sender_engine
//     correctness is surfaced via send_events traces, not a probe.
type StubProbe struct {
	LayerName string
	LevelVal  Level
	Fixed     Status
	DetailMsg string
	Cadence   time.Duration
}

func NewStubProbe(layer string, level Level, status Status, detail string, cadence time.Duration) *StubProbe {
	return &StubProbe{
		LayerName: layer,
		LevelVal:  level,
		Fixed:     status,
		DetailMsg: detail,
		Cadence:   cadence,
	}
}

func (p *StubProbe) Layer() string { return p.LayerName }
func (p *StubProbe) Level() Level   { return p.LevelVal }
func (p *StubProbe) Interval() time.Duration {
	if p.Cadence <= 0 {
		return 5 * time.Minute
	}
	return p.Cadence
}

func (p *StubProbe) Run(_ context.Context) Result {
	return Result{Status: p.Fixed, Detail: p.DetailMsg}
}
