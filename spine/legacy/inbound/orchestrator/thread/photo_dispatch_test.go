package thread

import (
	"context"
	"errors"
	"sync"
	"testing"

	"orchestrator/mime"
)

// fakePhotoProcessor records every Process call and lets tests assert
// fan-out shape + ordering.
type fakePhotoProcessor struct {
	mu        sync.Mutex
	calls     []PhotoInput
	imageCT   map[string]bool // override: explicit map of content_type → IsImage
	processFn func(PhotoInput) (int64, error)
}

func (f *fakePhotoProcessor) IsImage(ct string) bool {
	if f.imageCT != nil {
		return f.imageCT[ct]
	}
	return ct == "image/jpeg" || ct == "image/png" || ct == "image/webp"
}

func (f *fakePhotoProcessor) Process(_ context.Context, in PhotoInput) (int64, error) {
	f.mu.Lock()
	f.calls = append(f.calls, in)
	f.mu.Unlock()
	if f.processFn != nil {
		return f.processFn(in)
	}
	return 1, nil
}

// 1. processInboundPhotos forwards image attachments and skips
// non-images. Order is preserved.
func TestProcessInboundPhotos_ForwardsImagesOnly(t *testing.T) {
	fake := &fakePhotoProcessor{}
	atts := []mime.Attachment{
		{ContentType: "application/pdf", Filename: "report.pdf", Data: []byte("pdf")},
		{ContentType: "image/jpeg", Filename: "photo1.jpg", Data: []byte("jpg-bytes")},
		{ContentType: "text/plain", Filename: "note.txt", Data: []byte("hi")},
		{ContentType: "image/png", Filename: "photo2.png", Data: []byte("png-bytes")},
	}
	processInboundPhotos(context.Background(), fake, 7, "msg-1", atts)

	if len(fake.calls) != 2 {
		t.Fatalf("calls = %d, want 2", len(fake.calls))
	}
	if fake.calls[0].Filename != "photo1.jpg" {
		t.Errorf("call[0].Filename = %q", fake.calls[0].Filename)
	}
	if fake.calls[1].Filename != "photo2.png" {
		t.Errorf("call[1].Filename = %q", fake.calls[1].Filename)
	}
	if fake.calls[0].ThreadID != 7 || fake.calls[0].MessageID != "msg-1" {
		t.Errorf("call[0] thread/message = %v/%q", fake.calls[0].ThreadID, fake.calls[0].MessageID)
	}
}

// 2. Empty attachment list → no calls.
func TestProcessInboundPhotos_EmptyListIsNoop(t *testing.T) {
	fake := &fakePhotoProcessor{}
	processInboundPhotos(context.Background(), fake, 1, "m", nil)
	if len(fake.calls) != 0 {
		t.Errorf("calls = %d, want 0", len(fake.calls))
	}
}

// 3. A single failing photo does not abort the rest — best-effort.
func TestProcessInboundPhotos_FailureDoesNotAbortOthers(t *testing.T) {
	fake := &fakePhotoProcessor{
		processFn: func(in PhotoInput) (int64, error) {
			if in.Filename == "fail.jpg" {
				return 0, errors.New("upstream down")
			}
			return 1, nil
		},
	}
	atts := []mime.Attachment{
		{ContentType: "image/jpeg", Filename: "ok1.jpg", Data: []byte("a")},
		{ContentType: "image/jpeg", Filename: "fail.jpg", Data: []byte("b")},
		{ContentType: "image/jpeg", Filename: "ok2.jpg", Data: []byte("c")},
	}
	processInboundPhotos(context.Background(), fake, 1, "m", atts)
	if len(fake.calls) != 3 {
		t.Errorf("calls = %d, want 3 (fan-out continues after failure)", len(fake.calls))
	}
}

// 4. Custom IsImage map → caller controls which content types to
// dispatch. Empty map = nothing dispatched.
func TestProcessInboundPhotos_HonorsIsImageDecision(t *testing.T) {
	fake := &fakePhotoProcessor{imageCT: map[string]bool{}} // nothing
	atts := []mime.Attachment{
		{ContentType: "image/jpeg", Filename: "photo.jpg", Data: []byte("x")},
	}
	processInboundPhotos(context.Background(), fake, 1, "m", atts)
	if len(fake.calls) != 0 {
		t.Errorf("calls = %d, want 0", len(fake.calls))
	}
}

// 5. WithPhotoProcessor stores the dependency so ProcessReply can use
// it. (Smoke test — full ProcessReply flow exercised in unit_test.go.)
func TestInboundProcessor_WithPhotoProcessorStoresDep(t *testing.T) {
	p := &InboundProcessor{}
	fake := &fakePhotoProcessor{}
	got := p.WithPhotoProcessor(fake)
	if got != p {
		t.Errorf("returned receiver != p (chain broken)")
	}
	if p.photo != fake {
		t.Errorf("photo dep not stored")
	}
}
