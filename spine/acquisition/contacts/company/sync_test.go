package company

import (
	"testing"
)

func TestSyncConfig_DefaultBatchSize(t *testing.T) {
	syncer := NewSyncer(nil, &mockDB{}, SyncConfig{})
	if syncer.cfg.BatchSize != 5000 {
		t.Errorf("expected default batch size 5000, got %d", syncer.cfg.BatchSize)
	}
}

func TestSyncConfig_CustomBatchSize(t *testing.T) {
	syncer := NewSyncer(nil, &mockDB{}, SyncConfig{BatchSize: 100})
	if syncer.cfg.BatchSize != 100 {
		t.Errorf("expected batch size 100, got %d", syncer.cfg.BatchSize)
	}
}

func TestSyncConfig_NegativeBatchSize(t *testing.T) {
	syncer := NewSyncer(nil, &mockDB{}, SyncConfig{BatchSize: -1})
	if syncer.cfg.BatchSize != 5000 {
		t.Errorf("negative batch size should default to 5000, got %d", syncer.cfg.BatchSize)
	}
}

func TestNewSyncer_CreatesStore(t *testing.T) {
	db := &mockDB{}
	syncer := NewSyncer(nil, db, SyncConfig{})
	if syncer.store == nil {
		t.Fatal("syncer.store should not be nil")
	}
}

func TestSyncResult_ZeroValues(t *testing.T) {
	r := SyncResult{}
	if r.CompaniesUpserted != 0 || r.LinkedByFirmyID != 0 || r.LinkedByICO != 0 || r.MetricsUpdated != 0 {
		t.Error("SyncResult should have zero values by default")
	}
}

// ── joinStrings ──

func TestJoinStrings_Empty(t *testing.T) {
	if joinStrings(nil, ",") != "" {
		t.Error("nil slice should produce empty string")
	}
	if joinStrings([]string{}, ",") != "" {
		t.Error("empty slice should produce empty string")
	}
}

func TestJoinStrings_Single(t *testing.T) {
	if joinStrings([]string{"only"}, ",") != "only" {
		t.Error("single element should return that element")
	}
}

func TestJoinStrings_Multiple(t *testing.T) {
	got := joinStrings([]string{"a", "b", "c"}, ",")
	if got != "a,b,c" {
		t.Errorf("got %q, want %q", got, "a,b,c")
	}
}

func TestJoinStrings_CustomSep(t *testing.T) {
	got := joinStrings([]string{"x", "y"}, " | ")
	if got != "x | y" {
		t.Errorf("got %q, want %q", got, "x | y")
	}
}
