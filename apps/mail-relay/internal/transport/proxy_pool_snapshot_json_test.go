package transport

import (
	"encoding/json"
	"strings"
	"testing"
	"time"
)

// buildTestSnapshot returns a RotatingProxyTransport with pre-seeded working
// entries suitable for JSON serialisation tests.
func buildTestSnapshot(entries []proxyEntry) *RotatingProxyTransport {
	t := &RotatingProxyTransport{}
	t.working = entries
	t.lastRefresh = time.Date(2026, 4, 24, 12, 0, 0, 0, time.UTC)
	return t
}

// TestSnapshotJSON_AddrIsLowercase verifies the JSON key is "addr" not "Addr".
func TestSnapshotJSON_AddrIsLowercase(t *testing.T) {
	tr := buildTestSnapshot([]proxyEntry{
		{addr: "1.2.3.4:1080", latency: 42 * time.Millisecond, source: "geonode"},
	})
	data, err := json.Marshal(tr.Snapshot())
	if err != nil {
		t.Fatalf("marshal: %v", err)
	}
	if !strings.Contains(string(data), `"addr"`) {
		t.Errorf("JSON does not contain lowercase \"addr\" key: %s", data)
	}
	if strings.Contains(string(data), `"Addr"`) {
		t.Errorf("JSON contains uppercase \"Addr\" key (schema leak): %s", data)
	}
}

// TestSnapshotJSON_LatencyMsIsInt verifies latency_ms is an integer in JSON.
func TestSnapshotJSON_LatencyMsIsInt(t *testing.T) {
	tr := buildTestSnapshot([]proxyEntry{
		{addr: "5.6.7.8:1080", latency: 137 * time.Millisecond},
	})
	data, err := json.Marshal(tr.Snapshot())
	if err != nil {
		t.Fatalf("marshal: %v", err)
	}
	if !strings.Contains(string(data), `"latency_ms":137`) {
		t.Errorf("JSON does not contain \"latency_ms\":137: %s", data)
	}
}

// TestSnapshotJSON_NoRawDurationField verifies the raw time.Duration field is
// not exposed (it would appear as a big integer nanosecond value).
func TestSnapshotJSON_NoRawDurationField(t *testing.T) {
	tr := buildTestSnapshot([]proxyEntry{
		{addr: "9.10.11.12:1080", latency: 200 * time.Millisecond},
	})
	data, err := json.Marshal(tr.Snapshot())
	if err != nil {
		t.Fatalf("marshal: %v", err)
	}
	// "Latency" as a JSON key would indicate the Duration got serialised
	if strings.Contains(string(data), `"Latency"`) {
		t.Errorf("JSON exposes raw Latency Duration field: %s", data)
	}
	// The nanosecond value 200_000_000 should also not appear
	if strings.Contains(string(data), "200000000") {
		t.Errorf("JSON contains raw nanosecond duration value: %s", data)
	}
}

// TestSnapshotJSON_EmptyPoolIsArray verifies Working is [] not null for empty pool.
func TestSnapshotJSON_EmptyPoolIsArray(t *testing.T) {
	tr := buildTestSnapshot([]proxyEntry{})
	snap := tr.Snapshot()

	data, err := json.Marshal(snap)
	if err != nil {
		t.Fatalf("marshal: %v", err)
	}
	if !strings.Contains(string(data), `"working":[]`) {
		t.Errorf("JSON working field is not [] for empty pool: %s", data)
	}
}

// TestSnapshotJSON_LastRefreshIsISO8601 verifies last_refresh is a valid
// RFC3339 timestamp (Go's encoding/json uses RFC3339Nano for time.Time).
func TestSnapshotJSON_LastRefreshIsISO8601(t *testing.T) {
	tr := buildTestSnapshot(nil)
	tr.working = make([]proxyEntry, 0)

	data, err := json.Marshal(tr.Snapshot())
	if err != nil {
		t.Fatalf("marshal: %v", err)
	}

	// Unmarshal back and verify last_refresh is a parseable time
	var raw map[string]json.RawMessage
	if err := json.Unmarshal(data, &raw); err != nil {
		t.Fatalf("unmarshal: %v", err)
	}
	var ts time.Time
	if err := json.Unmarshal(raw["last_refresh"], &ts); err != nil {
		t.Errorf("last_refresh is not a valid ISO 8601 timestamp: %v — raw: %s", err, raw["last_refresh"])
	}
}

// TestSnapshotJSON_ConsecutiveZeroRefreshesIsInt verifies the field is an int
// in JSON output, not a string or nested object.
func TestSnapshotJSON_ConsecutiveZeroRefreshesIsInt(t *testing.T) {
	tr := buildTestSnapshot(nil)
	tr.working = make([]proxyEntry, 0)
	tr.consecutiveZeroRefreshes.Store(2)

	data, err := json.Marshal(tr.Snapshot())
	if err != nil {
		t.Fatalf("marshal: %v", err)
	}
	if !strings.Contains(string(data), `"consecutive_zero_refreshes":2`) {
		t.Errorf("JSON does not contain consecutive_zero_refreshes:2: %s", data)
	}
}

// TestSnapshotJSON_EmptyPoolCriticalIsBool verifies the field is a JSON bool.
func TestSnapshotJSON_EmptyPoolCriticalIsBool(t *testing.T) {
	tr := buildTestSnapshot(nil)
	tr.working = make([]proxyEntry, 0)
	tr.consecutiveZeroRefreshes.Store(emptyPoolCriticalThreshold)

	data, err := json.Marshal(tr.Snapshot())
	if err != nil {
		t.Fatalf("marshal: %v", err)
	}
	if !strings.Contains(string(data), `"empty_pool_critical":true`) {
		t.Errorf("JSON does not contain empty_pool_critical:true: %s", data)
	}
}

// TestSnapshotJSON_EmptyCountryOmitted verifies that a PoolEntry with an empty
// Country string omits the "country" key from JSON (omitempty).
func TestSnapshotJSON_EmptyCountryOmitted(t *testing.T) {
	tr := buildTestSnapshot([]proxyEntry{
		{addr: "1.2.3.4:1080", latency: 10 * time.Millisecond, country: "", source: "geonode"},
	})

	data, err := json.Marshal(tr.Snapshot())
	if err != nil {
		t.Fatalf("marshal: %v", err)
	}
	// The key "country" must not appear when country is empty
	if strings.Contains(string(data), `"country"`) {
		t.Errorf("JSON contains \"country\" key for empty-country entry (omitempty not working): %s", data)
	}
}

// TestSnapshotJSON_LatencyMsRoundtrip verifies LatencyMs is correctly derived
// from Latency.Milliseconds() during Snapshot() construction.
func TestSnapshotJSON_LatencyMsRoundtrip(t *testing.T) {
	latency := 250 * time.Millisecond
	tr := buildTestSnapshot([]proxyEntry{
		{addr: "2.3.4.5:1080", latency: latency},
	})

	snap := tr.Snapshot()
	if snap.Working[0].LatencyMs != latency.Milliseconds() {
		t.Errorf("LatencyMs = %d, want %d", snap.Working[0].LatencyMs, latency.Milliseconds())
	}

	// Also verify round-trip through JSON
	data, err := json.Marshal(snap)
	if err != nil {
		t.Fatalf("marshal: %v", err)
	}
	var out struct {
		Working []struct {
			LatencyMs int64 `json:"latency_ms"`
		} `json:"working"`
	}
	if err := json.Unmarshal(data, &out); err != nil {
		t.Fatalf("unmarshal: %v", err)
	}
	if out.Working[0].LatencyMs != 250 {
		t.Errorf("round-trip latency_ms = %d, want 250", out.Working[0].LatencyMs)
	}
}
