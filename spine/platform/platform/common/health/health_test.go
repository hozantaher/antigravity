package health

import (
	"testing"
	"time"
)

func TestRegistryReportAndSnapshot(t *testing.T) {
	r := New()
	r.Report("imap", true, "")
	r.Report("sender", false, "smtp timeout")

	snapshot := r.Snapshot()
	if len(snapshot) != 2 {
		t.Fatalf("snapshot len = %d, want 2", len(snapshot))
	}

	var imap, sender *DaemonStatus
	for _, s := range snapshot {
		switch s.Name {
		case "imap":
			imap = s
		case "sender":
			sender = s
		}
	}

	if imap == nil || !imap.OK {
		t.Fatalf("imap status not recorded correctly: %+v", imap)
	}
	if sender == nil || sender.OK || sender.Error != "smtp timeout" {
		t.Fatalf("sender status not recorded correctly: %+v", sender)
	}
	if imap.LastRun.IsZero() || sender.LastRun.IsZero() {
		t.Fatalf("expected LastRun timestamps, got imap=%v sender=%v", imap.LastRun, sender.LastRun)
	}
}

func TestSnapshotReturnsCopies(t *testing.T) {
	r := New()
	r.Report("imap", true, "")

	first := r.Snapshot()
	if len(first) != 1 {
		t.Fatalf("first snapshot len = %d, want 1", len(first))
	}
	first[0].Error = "mutated"

	second := r.Snapshot()
	if second[0].Error == "mutated" {
		t.Fatal("snapshot should return copies, but mutation leaked back")
	}
}

func TestAllOK(t *testing.T) {
	r := New()
	if !r.AllOK() {
		t.Fatal("empty registry should be all OK")
	}

	r.Report("imap", true, "")
	if !r.AllOK() {
		t.Fatal("expected AllOK=true when all daemons are healthy")
	}

	r.Report("sender", false, "error")
	if r.AllOK() {
		t.Fatal("expected AllOK=false when one daemon is failing")
	}
}

func TestUptimeSecondsIsNonNegativeAndMonotonic(t *testing.T) {
	r := New()
	first := r.UptimeSeconds()
	if first < 0 {
		t.Fatalf("first uptime = %f, want >= 0", first)
	}

	time.Sleep(10 * time.Millisecond)
	second := r.UptimeSeconds()
	if second < first {
		t.Fatalf("uptime should not decrease: first=%f second=%f", first, second)
	}
}
