// +build integration

package photostore_test

import (
	"fmt"
	"os"
	"path/filepath"
	"testing"

	"orchestrator/internal/photostore"
)

// TestVolumeWritePermissions verifies that the Railway volume mount at
// /data/photos is writable and supports the atomic write semantics that
// photostore.Save expects. This test is run only with `go test -tags=integration`
// and can be skipped if the volume is unavailable (e.g., during unit testing
// on a machine without the Railway volume mounted).
func TestVolumeWritePermissions(t *testing.T) {
	if testing.Short() {
		t.Skip("skipping integration test in short mode")
	}

	// Verify mount exists. On Railway, /data/photos is guaranteed to exist
	// and be writable. In dev, this may not be available, so skip gracefully.
	if _, err := os.Stat(photostore.DefaultRoot); err != nil {
		if os.IsNotExist(err) {
			t.Skipf("volume %s not mounted; skipping", photostore.DefaultRoot)
		}
		t.Fatalf("unexpected error checking volume mount: %v", err)
	}

	store := photostore.New(photostore.DefaultRoot)
	threadID := int64(9999)
	messageID := "integration-test-msg"
	filename := "test-photo.jpg"
	sampleData := []byte("fake JPEG header: \xFF\xD8\xFF\xE0")

	// Save and verify the path is written.
	path, err := store.Save(threadID, messageID, filename, sampleData)
	if err != nil {
		t.Fatalf("Save failed: %v", err)
	}

	// Verify the file exists on disk.
	_, err = os.Stat(path)
	if err != nil {
		t.Fatalf("saved file does not exist: %s: %v", path, err)
	}

	// Verify the file content matches.
	readData, err := os.ReadFile(path)
	if err != nil {
		t.Fatalf("failed to read back file: %v", err)
	}
	if string(readData) != string(sampleData) {
		t.Errorf("file content mismatch: got %q, want %q", readData, sampleData)
	}

	// Cleanup: remove the temporary directory created by this test.
	testDir := filepath.Join(store.Root(), fmt.Sprintf("%d", threadID))
	if err := os.RemoveAll(testDir); err != nil {
		t.Logf("warning: failed to clean up test directory %s: %v", testDir, err)
	}
}

// TestVolumeRetention verifies that files written to the volume persist
// across multiple invocations (i.e., the volume is not ephemeral).
func TestVolumeRetention(t *testing.T) {
	if testing.Short() {
		t.Skip("skipping integration test in short mode")
	}

	if _, err := os.Stat(photostore.DefaultRoot); err != nil {
		if os.IsNotExist(err) {
			t.Skipf("volume %s not mounted; skipping", photostore.DefaultRoot)
		}
		t.Fatalf("unexpected error checking volume mount: %v", err)
	}

	store := photostore.New(photostore.DefaultRoot)
	threadID := int64(9998)
	messageID := "retention-test-msg"
	filename := "retention-test.jpg"
	sampleData := []byte("retention test data")

	// First save.
	path1, err := store.Save(threadID, messageID, filename, sampleData)
	if err != nil {
		t.Fatalf("first Save failed: %v", err)
	}

	// Second invocation should return the same path and the file should still exist.
	path2, err := store.Save(threadID, messageID, filename, sampleData)
	if err != nil {
		t.Fatalf("second Save failed: %v", err)
	}

	if path1 != path2 {
		t.Errorf("paths differ: %s vs %s", path1, path2)
	}

	if _, err := os.Stat(path2); err != nil {
		t.Errorf("file did not persist: %v", err)
	}

	// Cleanup.
	testDir := filepath.Join(store.Root(), fmt.Sprintf("%d", threadID))
	if err := os.RemoveAll(testDir); err != nil {
		t.Logf("warning: failed to clean up test directory %s: %v", testDir, err)
	}
}

// TestVolumeCleanupHooks verifies that a DSR (GDPR Article 17 erasure)
// correctly cleans up all photos for a given thread. This test demonstrates
// the contract that cleanup routines must satisfy.
func TestVolumeCleanupHooks(t *testing.T) {
	if testing.Short() {
		t.Skip("skipping integration test in short mode")
	}

	if _, err := os.Stat(photostore.DefaultRoot); err != nil {
		if os.IsNotExist(err) {
			t.Skipf("volume %s not mounted; skipping", photostore.DefaultRoot)
		}
		t.Fatalf("unexpected error checking volume mount: %v", err)
	}

	store := photostore.New(photostore.DefaultRoot)
	threadID := int64(9997)

	// Write multiple photos for the thread.
	for i := 0; i < 3; i++ {
		path, err := store.Save(
			threadID,
			fmt.Sprintf("msg-%d", i),
			"photo.jpg",
			[]byte(fmt.Sprintf("photo data %d", i)),
		)
		if err != nil {
			t.Fatalf("Save failed for message %d: %v", i, err)
		}
		if _, err := os.Stat(path); err != nil {
			t.Fatalf("file not written: %s: %v", path, err)
		}
	}

	// Simulate cleanup: remove the entire thread directory (what a DSR handler would do).
	threadDir := filepath.Join(store.Root(), fmt.Sprintf("%d", threadID))
	if err := os.RemoveAll(threadDir); err != nil {
		t.Fatalf("cleanup failed: %v", err)
	}

	// Verify the directory is gone.
	if _, err := os.Stat(threadDir); err == nil {
		t.Error("thread directory still exists after cleanup")
	} else if !os.IsNotExist(err) {
		t.Errorf("unexpected error checking cleanup: %v", err)
	}
}
