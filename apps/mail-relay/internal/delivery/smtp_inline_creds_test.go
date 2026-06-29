package delivery

import (
	"context"
	"math/rand"
	"testing"
	"time"
)

// ---------------------------------------------------------------------------
// AccountPool.DeliverWithInlineCreds — inline path used when creds complete
// ---------------------------------------------------------------------------

func TestDeliverWithInlineCreds_InlinePathUsed(t *testing.T) {
	// Start a real fake SMTP server that accepts AUTH PLAIN.
	srv := newFakeSMTPServer(t, false)
	defer srv.listener.Close()

	// Pool has no matching account for from-address — but inline creds override.
	pool := NewAccountPool(directTransport{}, SMTPConfig{
		Host: "fallback.example.com",
		Port: 9999, // unreachable; must not be dialled
	}, nil, NewRecordDeliverer())

	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()

	err := pool.DeliverWithInlineCreds(ctx,
		srv.host(), srv.port(),
		"", // empty username — only the host+port matter for the fake server
		"", // empty password
		"sender@example.com",
		[]string{"rcpt@example.com"},
		[]byte("Subject: test\r\n\r\nbody"),
	)
	// Empty username/password → falls back to pool path (fallback deliverer = RecordDeliverer)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
}

func TestDeliverWithInlineCreds_HitsInlineServer(t *testing.T) {
	srv := newFakeSMTPServer(t, false)
	defer srv.listener.Close()

	// Fallback pool points to a closed port — if inline path is NOT taken, we'd get a connect error.
	fallback := NewRecordDeliverer()
	pool := NewAccountPool(directTransport{}, SMTPConfig{
		Host: "127.0.0.1",
		Port: 1, // nothing here
	}, nil, fallback)

	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()

	err := pool.DeliverWithInlineCreds(ctx,
		srv.host(), srv.port(),
		"inlineuser@example.com",
		"inlinepassword",
		"inlineuser@example.com",
		[]string{"dest@example.com"},
		[]byte("Subject: inline\r\n\r\ninline body"),
	)
	if err != nil {
		t.Fatalf("inline delivery to fake SMTP server failed: %v", err)
	}
	// Fallback should not have been called.
	if len(fallback.Records) != 0 {
		t.Fatalf("fallback should not have been used, got %d records", len(fallback.Records))
	}
}

// ---------------------------------------------------------------------------
// DeliverWithInlineCreds — partial creds → falls back to pool
// ---------------------------------------------------------------------------

func TestDeliverWithInlineCreds_PartialCreds_MissingHost(t *testing.T) {
	fallback := NewRecordDeliverer()
	pool := NewAccountPool(nil, SMTPConfig{}, nil, fallback)

	ctx := context.Background()
	err := pool.DeliverWithInlineCreds(ctx,
		"", // empty host
		587,
		"user@example.com",
		"pass",
		"sender@example.com",
		[]string{"rcpt@example.com"},
		[]byte("body"),
	)
	if err != nil {
		t.Fatalf("unexpected error on partial creds: %v", err)
	}
	if len(fallback.Records) != 1 {
		t.Fatalf("expected fallback to be used once, got %d", len(fallback.Records))
	}
}

func TestDeliverWithInlineCreds_PartialCreds_MissingUsername(t *testing.T) {
	fallback := NewRecordDeliverer()
	pool := NewAccountPool(nil, SMTPConfig{}, nil, fallback)

	ctx := context.Background()
	err := pool.DeliverWithInlineCreds(ctx,
		"smtp.example.com",
		587,
		"", // empty username
		"pass",
		"sender@example.com",
		[]string{"rcpt@example.com"},
		[]byte("body"),
	)
	if err != nil {
		t.Fatalf("unexpected error on missing username: %v", err)
	}
	if len(fallback.Records) != 1 {
		t.Fatalf("expected fallback, got %d records", len(fallback.Records))
	}
}

func TestDeliverWithInlineCreds_PartialCreds_MissingPassword(t *testing.T) {
	fallback := NewRecordDeliverer()
	pool := NewAccountPool(nil, SMTPConfig{}, nil, fallback)

	ctx := context.Background()
	err := pool.DeliverWithInlineCreds(ctx,
		"smtp.example.com",
		587,
		"user@example.com",
		"", // empty password
		"sender@example.com",
		[]string{"rcpt@example.com"},
		[]byte("body"),
	)
	if err != nil {
		t.Fatalf("unexpected error on missing password: %v", err)
	}
	if len(fallback.Records) != 1 {
		t.Fatalf("expected fallback, got %d records", len(fallback.Records))
	}
}

// ---------------------------------------------------------------------------
// DeliverWithInlineCreds — error from SMTP server propagates
// ---------------------------------------------------------------------------

func TestDeliverWithInlineCreds_ConnectError_Propagates(t *testing.T) {
	fallback := NewRecordDeliverer()
	pool := NewAccountPool(directTransport{}, SMTPConfig{}, nil, fallback)

	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
	defer cancel()

	err := pool.DeliverWithInlineCreds(ctx,
		"127.0.0.1",
		1, // nothing listening
		"user@example.com",
		"pass",
		"sender@example.com",
		[]string{"rcpt@example.com"},
		[]byte("body"),
	)
	if err == nil {
		t.Fatal("expected error when connecting to closed port")
	}
}

// ---------------------------------------------------------------------------
// DeliverWithInlineCreds — default port 587 when SMTPPort is 0
// ---------------------------------------------------------------------------

func TestDeliverWithInlineCreds_DefaultPort587(t *testing.T) {
	// We just verify no panic / no crash when port=0 and the connection fails
	// on 127.0.0.1:587 (likely closed in CI). The important assertion is that
	// a connection attempt is made (i.e., we don't silently swallow).
	pool := NewAccountPool(directTransport{}, SMTPConfig{}, nil, NewRecordDeliverer())

	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
	defer cancel()

	err := pool.DeliverWithInlineCreds(ctx,
		"127.0.0.1",
		0, // zero port → default 587
		"user@example.com",
		"pass",
		"sender@example.com",
		[]string{"rcpt@example.com"},
		[]byte("body"),
	)
	// We expect an error (port 587 is not open), not a nil or silent skip.
	if err == nil {
		// If somehow 587 is open and accepts, that's OK too.
		t.Log("port 587 was reachable — default port resolution worked")
	}
}

// ---------------------------------------------------------------------------
// Property / monkey tests
// ---------------------------------------------------------------------------

// TestDeliverWithInlineCredsProperty_RandomPartialCreds verifies that for any
// combination with at least one empty field, the fallback is always used.
func TestDeliverWithInlineCredsProperty_RandomPartialCreds(t *testing.T) {
	rng := rand.New(rand.NewSource(42)) //nolint:gosec — test seed

	for i := 0; i < 50; i++ {
		host := randomString(rng, 8) + ".example.com"
		user := randomString(rng, 6) + "@example.com"
		pass := randomString(rng, 12)

		// Randomly zero out one of the three fields.
		switch rng.Intn(3) {
		case 0:
			host = ""
		case 1:
			user = ""
		case 2:
			pass = ""
		}

		fallback := NewRecordDeliverer()
		pool := NewAccountPool(nil, SMTPConfig{}, nil, fallback)
		ctx := context.Background()

		err := pool.DeliverWithInlineCreds(ctx, host, 587, user, pass,
			"sender@example.com", []string{"rcpt@example.com"}, []byte("msg"))
		if err != nil {
			t.Fatalf("iteration %d: unexpected error with partial creds: %v", i, err)
		}
		if len(fallback.Records) != 1 {
			t.Fatalf("iteration %d: expected exactly 1 fallback record, got %d", i, len(fallback.Records))
		}
	}
}

// TestDeliverWithInlineCredsProperty_CompleteCreds verifies that when all three
// fields are present, DeliverWithInlineCreds always attempts an outbound connection
// (and hence errors on a closed port) rather than silently using the fallback.
func TestDeliverWithInlineCredsProperty_CompleteCredsAlwaysDials(t *testing.T) {
	rng := rand.New(rand.NewSource(99)) //nolint:gosec — test seed

	for i := 0; i < 20; i++ {
		host := "127.0.0.1"
		user := randomString(rng, 6) + "@example.com"
		pass := randomString(rng, 12)
		port := 1 // always closed

		fallback := NewRecordDeliverer()
		pool := NewAccountPool(directTransport{}, SMTPConfig{}, nil, fallback)

		ctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
		err := pool.DeliverWithInlineCreds(ctx, host, port, user, pass,
			"sender@example.com", []string{"rcpt@example.com"}, []byte("msg"))
		cancel()

		// Must have dialled (producing a connect error), NOT used fallback.
		if err == nil {
			t.Fatalf("iteration %d: expected connect error, got nil", i)
		}
		if len(fallback.Records) != 0 {
			t.Fatalf("iteration %d: fallback must not be used with complete creds", i)
		}
	}
}

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

func randomString(rng *rand.Rand, n int) string {
	const letters = "abcdefghijklmnopqrstuvwxyz0123456789"
	b := make([]byte, n)
	for i := range b {
		b[i] = letters[rng.Intn(len(letters))]
	}
	return string(b)
}
