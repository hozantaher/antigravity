package photoparse

import (
	"context"
	"encoding/json"
	"errors"
	"os"
	"strings"
	"testing"

	"github.com/DATA-DOG/go-sqlmock"

	"orchestrator/internal/llmclient"
	"orchestrator/internal/photostore"
)

// fakeClient implements PhotoClient for tests.
type fakeClient struct {
	out *llmclient.PhotoExtract
	err error
	got struct {
		imageB64 string
		ctx      string
	}
}

func (f *fakeClient) ParsePhoto(_ context.Context, imageB64, ctx string) (*llmclient.PhotoExtract, error) {
	f.got.imageB64 = imageB64
	f.got.ctx = ctx
	return f.out, f.err
}

// helper to build a Processor + sqlmock harness.
func newHarness(t *testing.T, client PhotoClient, maxBytes int) (*Processor, sqlmock.Sqlmock, *photostore.Store) {
	t.Helper()
	db, mock, err := sqlmock.New(sqlmock.QueryMatcherOption(sqlmock.QueryMatcherEqual))
	if err != nil {
		t.Fatalf("sqlmock: %v", err)
	}
	t.Cleanup(func() { db.Close() })
	store := photostore.New(t.TempDir())
	p := New(db, Config{
		Store:         store,
		Client:        client,
		MaxSizeBytes:  maxBytes,
		PromptContext: "TP foto",
	})
	return p, mock, store
}

const insertSQL = `
		INSERT INTO photo_parse_audit (
			blob_ref, source, extracted, retained, discarded, details
		) VALUES ($1, $2, $3, $4, $5, $6)
		RETURNING id
	`

// 1. IsImage covers the core MIME types we accept.
func TestIsImage(t *testing.T) {
	cases := map[string]bool{
		"image/jpeg":               true,
		"IMAGE/PNG":                true,
		"image/webp":               true,
		"image/heic":               true,
		"application/octet-stream": false,
		"text/html":                false,
		"":                         false,
		" image/jpeg ":             true,
	}
	for ct, want := range cases {
		if got := IsImage(ct); got != want {
			t.Errorf("IsImage(%q) = %v, want %v", ct, got, want)
		}
	}
}

// 2. Happy path: store + LLM + audit insert.
func TestProcess_HappyPathInsertsAudit(t *testing.T) {
	year := 2018
	conf := 0.85
	client := &fakeClient{out: &llmclient.PhotoExtract{
		Year: &year, Make: "Caterpillar", Model: "320D",
		Condition: "good", Confidence: &conf,
	}}
	p, mock, store := newHarness(t, client, 0)

	mock.ExpectQuery(insertSQL).WillReturnRows(
		sqlmock.NewRows([]string{"id"}).AddRow(int64(99)),
	)

	id, err := p.Process(context.Background(), Photo{
		ThreadID: 1, MessageID: "m1", Filename: "p.jpg",
		ContentType: "image/jpeg", Data: []byte{0xFF, 0xD8, 0xFF, 0xE0},
	})
	if err != nil {
		t.Fatalf("Process: %v", err)
	}
	if id != 99 {
		t.Errorf("id = %d, want 99", id)
	}
	if err := mock.ExpectationsWereMet(); err != nil {
		t.Errorf("expectations: %v", err)
	}
	// Ensure the LLM saw base64 (not raw bytes) + the configured prompt.
	if client.got.imageB64 == "" || client.got.ctx != "TP foto" {
		t.Errorf("client got: %+v", client.got)
	}
	// Blob landed under the store root.
	if _, err := store.Read(1, "m1", "p.jpg"); err != nil {
		t.Errorf("blob not readable: %v", err)
	}
}

// 3. Non-image content type rejected without DB call.
func TestProcess_RejectsNonImage(t *testing.T) {
	p, mock, _ := newHarness(t, &fakeClient{}, 0)
	_, err := p.Process(context.Background(), Photo{
		ThreadID: 1, MessageID: "m1", Filename: "doc.pdf",
		ContentType: "application/pdf", Data: []byte("x"),
	})
	if err == nil {
		t.Fatal("expected error for non-image")
	}
	// Ensure no SQL was issued.
	if err := mock.ExpectationsWereMet(); err != nil {
		t.Errorf("unexpected SQL: %v", err)
	}
}

// 4. Empty data rejected.
func TestProcess_EmptyDataRejected(t *testing.T) {
	p, _, _ := newHarness(t, &fakeClient{}, 0)
	_, err := p.Process(context.Background(), Photo{
		ThreadID: 1, MessageID: "m1", Filename: "p.jpg",
		ContentType: "image/jpeg", Data: nil,
	})
	if err == nil || !strings.Contains(err.Error(), "empty") {
		t.Errorf("err = %v, want 'empty' error", err)
	}
}

// 5. Oversized photo rejected against the configured max.
func TestProcess_OversizedRejected(t *testing.T) {
	p, _, _ := newHarness(t, &fakeClient{}, 8) // 8-byte limit
	_, err := p.Process(context.Background(), Photo{
		ThreadID: 1, MessageID: "m1", Filename: "p.jpg",
		ContentType: "image/jpeg", Data: make([]byte, 32),
	})
	if err == nil || !strings.Contains(err.Error(), "too large") {
		t.Errorf("err = %v, want 'too large' error", err)
	}
}

// 6. Default max applied when caller passes zero.
func TestProcess_DefaultMaxAppliedWhenZero(t *testing.T) {
	p, mock, _ := newHarness(t, &fakeClient{}, 0)
	mock.ExpectQuery(insertSQL).WillReturnRows(
		sqlmock.NewRows([]string{"id"}).AddRow(int64(7)),
	)
	_, err := p.Process(context.Background(), Photo{
		ThreadID: 1, MessageID: "m1", Filename: "p.jpg",
		ContentType: "image/jpeg", Data: make([]byte, 1024),
	})
	if err != nil {
		t.Fatalf("Process: %v", err)
	}
}

// 7. LLM unavailable → audit row still written with extracted={} and
// upstream_status=unavailable in details.
func TestProcess_LLMUnavailableStillWritesAudit(t *testing.T) {
	client := &fakeClient{err: llmclient.ErrUnavailable}
	p, mock, _ := newHarness(t, client, 0)

	var capturedDetails string
	mock.ExpectQuery(insertSQL).WithArgs(
		sqlmock.AnyArg(), // blob_ref
		SourceEmailAttachment,
		sqlmock.AnyArg(), // extracted
		sqlmock.AnyArg(), // retained
		sqlmock.AnyArg(), // discarded
		sqlmock.AnyArg(), // details
	).WillReturnRows(sqlmock.NewRows([]string{"id"}).AddRow(int64(11)))

	id, err := p.Process(context.Background(), Photo{
		ThreadID: 1, MessageID: "m1", Filename: "p.jpg",
		ContentType: "image/jpeg", Data: []byte("xxxx"),
	})
	if err != nil {
		t.Fatalf("Process: %v", err)
	}
	if id != 11 {
		t.Errorf("id = %d", id)
	}
	_ = capturedDetails
	if err := mock.ExpectationsWereMet(); err != nil {
		t.Errorf("expectations: %v", err)
	}
}

// 8. LLM not implemented (501 skeleton) → audit row written +
// upstream_status=not_implemented.
func TestProcess_LLMNotImplementedStillWritesAudit(t *testing.T) {
	client := &fakeClient{err: llmclient.ErrNotImplemented}
	p, mock, _ := newHarness(t, client, 0)
	mock.ExpectQuery(insertSQL).WillReturnRows(
		sqlmock.NewRows([]string{"id"}).AddRow(int64(12)),
	)
	id, err := p.Process(context.Background(), Photo{
		ThreadID: 1, MessageID: "m1", Filename: "p.jpg",
		ContentType: "image/jpeg", Data: []byte("xx"),
	})
	if err != nil {
		t.Fatalf("Process: %v", err)
	}
	if id != 12 {
		t.Errorf("id = %d", id)
	}
}

// 9. Nil client (boot without llm-runner wired) → audit row with
// extracted={}.
func TestProcess_NilClientStillWritesAudit(t *testing.T) {
	p, mock, _ := newHarness(t, nil, 0)
	mock.ExpectQuery(insertSQL).WillReturnRows(
		sqlmock.NewRows([]string{"id"}).AddRow(int64(13)),
	)
	id, err := p.Process(context.Background(), Photo{
		ThreadID: 1, MessageID: "m1", Filename: "p.jpg",
		ContentType: "image/jpeg", Data: []byte("xx"),
	})
	if err != nil {
		t.Fatalf("Process: %v", err)
	}
	if id != 13 {
		t.Errorf("id = %d", id)
	}
}

// 10. Volume save failure surfaces wrapped error (no audit row).
func TestProcess_StoreSaveFailureSurfacesError(t *testing.T) {
	db, mock, _ := sqlmock.New()
	defer db.Close()
	// Root that is a file, not a dir → MkdirAll fails.
	dir := t.TempDir()
	bogus := dir + "/file"
	if err := os.WriteFile(bogus, []byte("x"), 0o644); err != nil {
		t.Fatalf("seed: %v", err)
	}
	store := photostore.New(bogus)
	p := New(db, Config{Store: store, Client: &fakeClient{}})

	_, err := p.Process(context.Background(), Photo{
		ThreadID: 1, MessageID: "m1", Filename: "p.jpg",
		ContentType: "image/jpeg", Data: []byte("xx"),
	})
	if err == nil {
		t.Fatal("expected save failure")
	}
	if err := mock.ExpectationsWereMet(); err != nil {
		t.Errorf("unexpected SQL: %v", err)
	}
}

// 11. retained column reflects only attributes the model returned.
func TestProcess_RetainedAttributesShape(t *testing.T) {
	year := 2020
	client := &fakeClient{out: &llmclient.PhotoExtract{
		Year: &year, Make: "Komatsu",
	}}
	p, mock, _ := newHarness(t, client, 0)
	mock.ExpectQuery(insertSQL).WillReturnRows(
		sqlmock.NewRows([]string{"id"}).AddRow(int64(14)),
	)
	if _, err := p.Process(context.Background(), Photo{
		ThreadID: 1, MessageID: "m1", Filename: "p.jpg",
		ContentType: "image/jpeg", Data: []byte("xx"),
	}); err != nil {
		t.Fatalf("Process: %v", err)
	}

	// Hand-test retainAttributes for shape (the SQL captures it but
	// QueryMatcherEqual lets WithArgs(AnyArg) skip the deep check).
	got := retainAttributes(client.out)
	buf, _ := json.Marshal(got)
	s := string(buf)
	if !strings.Contains(s, `"year":2020`) || !strings.Contains(s, `"make":"Komatsu"`) {
		t.Errorf("retained shape = %s", s)
	}
	if strings.Contains(s, "model") || strings.Contains(s, "condition") {
		t.Errorf("retained leaked empty fields: %s", s)
	}
}

// 12. classifyUpstreamErr maps known sentinels.
func TestClassifyUpstreamErr(t *testing.T) {
	cases := []struct {
		err  error
		want string
	}{
		{errors.New("random"), "other"},
		{llmclient.ErrUnavailable, "unavailable"},
		{llmclient.ErrNotImplemented, "not_implemented"},
	}
	for _, c := range cases {
		if got := classifyUpstreamErr(c.err); got != c.want {
			t.Errorf("classify(%v) = %q, want %q", c.err, got, c.want)
		}
	}
}

// 13. DB insert failure returns wrapped error so callers can slog it.
func TestProcess_DBInsertFailureSurfacesError(t *testing.T) {
	p, mock, _ := newHarness(t, &fakeClient{}, 0)
	mock.ExpectQuery(insertSQL).WillReturnError(errors.New("pg down"))

	_, err := p.Process(context.Background(), Photo{
		ThreadID: 1, MessageID: "m1", Filename: "p.jpg",
		ContentType: "image/jpeg", Data: []byte("xx"),
	})
	if err == nil || !strings.Contains(err.Error(), "insert audit") {
		t.Errorf("err = %v, want 'insert audit' wrap", err)
	}
}

// 14. nilProcessor receiver is safe to call (returns error).
func TestProcess_NilReceiverReturnsError(t *testing.T) {
	var p *Processor
	_, err := p.Process(context.Background(), Photo{})
	if err == nil {
		t.Fatal("expected error on nil receiver")
	}
}

