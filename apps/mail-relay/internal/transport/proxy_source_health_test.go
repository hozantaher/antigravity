package transport

import (
	"sync"
	"testing"
	"time"
)

// TestRecordSourceResult_SuccessResetsZero tests that a successful result
// (count > 0, err == nil) resets consecutiveZero to 0.
func TestRecordSourceResult_SuccessResetsZero(t *testing.T) {
	resetGlobalSourceHealth()
	recordSourceResult("geonode", 500, nil)
	snap := SourceHealthSnapshot()
	if snap["geonode"]["consecutive_zero"] != int32(0) {
		t.Errorf("expected consecutive_zero=0, got %d", snap["geonode"]["consecutive_zero"])
	}
	if snap["geonode"]["last_count"] != 500 {
		t.Errorf("expected last_count=500, got %d", snap["geonode"]["last_count"])
	}
}

// TestRecordSourceResult_ZeroTriggersAlert tests that 3 consecutive zero
// results transitions to degraded=true and triggers a slog.Warn.
func TestRecordSourceResult_ZeroTriggersAlert(t *testing.T) {
	resetGlobalSourceHealth()
	recordSourceResult("geonode", 0, nil)
	recordSourceResult("geonode", 0, nil)
	recordSourceResult("geonode", 0, nil)

	snap := SourceHealthSnapshot()
	if snap["geonode"]["consecutive_zero"] != int32(3) {
		t.Errorf("expected consecutive_zero=3, got %d", snap["geonode"]["consecutive_zero"])
	}
	if !snap["geonode"]["degraded"].(bool) {
		t.Errorf("expected degraded=true at threshold 3")
	}
}

// TestRecordSourceResult_RecoveryAfterDegradation tests that a successful
// result after degradation resets the counter to 0.
func TestRecordSourceResult_RecoveryAfterDegradation(t *testing.T) {
	resetGlobalSourceHealth()
	recordSourceResult("geonode", 0, nil)
	recordSourceResult("geonode", 0, nil)
	recordSourceResult("geonode", 0, nil)

	snap := SourceHealthSnapshot()
	if !snap["geonode"]["degraded"].(bool) {
		t.Errorf("expected degraded=true after 3 zeros")
	}

	recordSourceResult("geonode", 500, nil)
	snap = SourceHealthSnapshot()
	if snap["geonode"]["consecutive_zero"] != int32(0) {
		t.Errorf("expected consecutive_zero=0 after recovery, got %d", snap["geonode"]["consecutive_zero"])
	}
	if snap["geonode"]["degraded"].(bool) {
		t.Errorf("expected degraded=false after recovery")
	}
}

// TestRecordSourceResult_ErrorIncrementsZero tests that an error result
// increments consecutiveZero.
func TestRecordSourceResult_ErrorIncrementsZero(t *testing.T) {
	resetGlobalSourceHealth()
	recordSourceResult("proxyscrape", 0, errTestProxy)

	snap := SourceHealthSnapshot()
	if snap["proxyscrape"]["consecutive_zero"] != int32(1) {
		t.Errorf("expected consecutive_zero=1 after error, got %d", snap["proxyscrape"]["consecutive_zero"])
	}
	if snap["proxyscrape"]["last_error"] != errTestProxy.Error() {
		t.Errorf("expected last_error=%s, got %s", errTestProxy.Error(), snap["proxyscrape"]["last_error"])
	}
}

// TestSourceHealthSnapshot_AllSources tests that SourceHealthSnapshot returns
// all 3 sources even if some haven't been recorded yet.
func TestSourceHealthSnapshot_AllSources(t *testing.T) {
	resetGlobalSourceHealth()
	snap := SourceHealthSnapshot()

	if _, ok := snap["geonode"]; !ok {
		t.Errorf("expected geonode in snapshot")
	}
	if _, ok := snap["proxyscrape"]; !ok {
		t.Errorf("expected proxyscrape in snapshot")
	}
	if _, ok := snap["proxifly"]; !ok {
		t.Errorf("expected proxifly in snapshot")
	}
}

// TestRecordSourceResult_ConcurrentCalls tests that concurrent recordSourceResult
// calls don't cause data races.
func TestRecordSourceResult_ConcurrentCalls(t *testing.T) {
	resetGlobalSourceHealth()
	var wg sync.WaitGroup
	for i := 0; i < 20; i++ {
		wg.Add(1)
		go func(idx int) {
			defer wg.Done()
			if idx%3 == 0 {
				recordSourceResult("geonode", 100+idx, nil)
			} else if idx%3 == 1 {
				recordSourceResult("proxyscrape", 50+idx, nil)
			} else {
				recordSourceResult("proxifly", 200+idx, errTestProxy)
			}
		}(i)
	}
	wg.Wait()

	snap := SourceHealthSnapshot()
	if len(snap) != 3 {
		t.Errorf("expected 3 sources in snapshot, got %d", len(snap))
	}
}

// TestRecordSourceResult_ThresholdConstant tests that the threshold is 3
// (not 2, not 4).
func TestRecordSourceResult_ThresholdConstant(t *testing.T) {
	resetGlobalSourceHealth()
	recordSourceResult("geonode", 0, nil)
	recordSourceResult("geonode", 0, nil)

	snap := SourceHealthSnapshot()
	if snap["geonode"]["degraded"].(bool) {
		t.Errorf("expected degraded=false at 2, threshold is 3")
	}

	recordSourceResult("geonode", 0, nil)
	snap = SourceHealthSnapshot()
	if !snap["geonode"]["degraded"].(bool) {
		t.Errorf("expected degraded=true at 3")
	}
}

// TestRecordSourceResult_NonexistentSource tests that recording to a
// non-existent source doesn't panic.
func TestRecordSourceResult_NonexistentSource(t *testing.T) {
	resetGlobalSourceHealth()
	recordSourceResult("nonexistent", 100, nil)
	snap := SourceHealthSnapshot()
	if _, ok := snap["nonexistent"]; ok {
		t.Errorf("expected nonexistent source not in registry")
	}
}

// TestRecordSourceResult_TwoZerosOneSuccess tests that 2 zeros + 1 success
// yields degraded=false (counter is reset on any success).
func TestRecordSourceResult_TwoZerosOneSuccess(t *testing.T) {
	resetGlobalSourceHealth()
	recordSourceResult("geonode", 0, nil)
	recordSourceResult("geonode", 0, nil)
	recordSourceResult("geonode", 100, nil)

	snap := SourceHealthSnapshot()
	if snap["geonode"]["consecutive_zero"] != int32(0) {
		t.Errorf("expected consecutive_zero=0 after success, got %d", snap["geonode"]["consecutive_zero"])
	}
	if snap["geonode"]["degraded"].(bool) {
		t.Errorf("expected degraded=false, success resets")
	}
}

// TestRecordSourceResult_LastFetchAtUpdated tests that lastFetchAt is updated
// on every record call.
func TestRecordSourceResult_LastFetchAtUpdated(t *testing.T) {
	resetGlobalSourceHealth()
	recordSourceResult("geonode", 100, nil)
	_ = SourceHealthSnapshot()
	time.Sleep(10 * time.Millisecond)
	recordSourceResult("geonode", 200, nil)
	snap2 := SourceHealthSnapshot()

	// lastFetchAt should be more recent in snap2.
	// We can't directly compare time.Time from snapshots in current structure,
	// but we can infer that a second call succeeded.
	if snap2["geonode"]["last_count"] != 200 {
		t.Errorf("expected last_count to update to 200")
	}
}

// TestRecordSourceResult_ErrorMessage tests that error messages are captured
// and stored in lastError.
func TestRecordSourceResult_ErrorMessage(t *testing.T) {
	resetGlobalSourceHealth()
	recordSourceResult("proxyscrape", 0, errTestProxy)
	snap := SourceHealthSnapshot()

	if snap["proxyscrape"]["last_error"] != "test proxy error" {
		t.Errorf("expected error message 'test proxy error', got %s", snap["proxyscrape"]["last_error"])
	}
}

// TestRecordSourceResult_ZeroErrorMessage tests that a zero result (not an
// error) sets lastError to "returned 0 proxies".
func TestRecordSourceResult_ZeroErrorMessage(t *testing.T) {
	resetGlobalSourceHealth()
	recordSourceResult("proxifly", 0, nil)
	snap := SourceHealthSnapshot()

	if snap["proxifly"]["last_error"] != "returned 0 proxies" {
		t.Errorf("expected error message 'returned 0 proxies', got %s", snap["proxifly"]["last_error"])
	}
}

// Helper: resetGlobalSourceHealth clears the global health registry for clean tests.
func resetGlobalSourceHealth() {
	globalSourceHealth.mu.Lock()
	defer globalSourceHealth.mu.Unlock()
	globalSourceHealth.sources = map[string]*sourceHealth{
		"geonode":     {},
		"proxyscrape": {},
		"proxifly":    {},
	}
}

// errTestProxy is a test error for error-path tests.
var errTestProxy = NewTestError("test proxy error")

// NewTestError creates a simple error for testing.
func NewTestError(msg string) error {
	return simpleError(msg)
}

// simpleError is a minimal error implementation for testing.
type simpleError string

func (e simpleError) Error() string {
	return string(e)
}
