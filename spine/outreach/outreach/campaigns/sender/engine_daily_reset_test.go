package sender

import (
	"common/config"
	"testing"
	"time"
)

// TestEngine_ResetCounters_SameDayNoReset verifies that within the same hour
// and day, counters are NOT cleared.
func TestEngine_ResetCounters_SameDayNoReset(t *testing.T) {
	e := NewEngine(nil, config.SendingConfig{}, config.SafetyConfig{})

	e.mu.Lock()
	e.sentCounts["mb@t.cz"] = 5
	e.domainCounts["d.cz"] = 3
	e.lastReset = time.Now() // just now → not old enough for either reset
	e.mu.Unlock()

	e.resetCountersIfNeeded()

	e.mu.Lock()
	sc := e.sentCounts["mb@t.cz"]
	dc := e.domainCounts["d.cz"]
	e.mu.Unlock()

	if sc != 5 {
		t.Errorf("sentCounts should be unchanged, got %d", sc)
	}
	if dc != 3 {
		t.Errorf("domainCounts should be unchanged, got %d", dc)
	}
}

// TestGenerateMessageID_EmptyAddr exercises the empty-fromAddr path
// where DomainFromEmail returns "".
func TestGenerateMessageID_EmptyAddr(t *testing.T) {
	id := generateMessageID("")
	if id == "" {
		t.Error("generateMessageID should return non-empty string even with empty addr")
	}
}

// TestGenerateMessageID_UniqueOnRepeatedCalls ensures entropy across calls.
func TestGenerateMessageID_UniqueOnRepeatedCalls(t *testing.T) {
	seen := make(map[string]struct{})
	for i := 0; i < 20; i++ {
		id := generateMessageID("test@firma.cz")
		if _, dup := seen[id]; dup {
			t.Errorf("duplicate generateMessageID after %d calls", i)
		}
		seen[id] = struct{}{}
	}
}

// TestRandomDelay_ZeroRange returns minSec when max <= min.
func TestRandomDelay_ZeroMin(t *testing.T) {
	d := randomDelay(0, 0)
	if d != 0 {
		t.Errorf("expected 0 delay when min=max=0, got %v", d)
	}
}

func TestRandomDelay_MaxLessThanMin(t *testing.T) {
	d := randomDelay(10, 5)
	if d != 10*time.Second {
		t.Errorf("expected 10s when max<min, got %v", d)
	}
}

func TestRandomDelay_LargeRange_InBounds(t *testing.T) {
	for i := 0; i < 50; i++ {
		d := randomDelay(1, 10)
		secs := int(d.Seconds())
		if secs < 1 || secs >= 10 {
			t.Errorf("randomDelay(1,10) = %v out of [1,10)", d)
		}
	}
}
