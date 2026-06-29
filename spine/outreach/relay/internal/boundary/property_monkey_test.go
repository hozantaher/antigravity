package boundary

import (
	"relay/internal/filestore"
	"relay/internal/model"
	"context"
	"encoding/base64"
	"path/filepath"
	"sync"
	"testing"
	"testing/quick"
)

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

func newVerifier(t *testing.T) *ExitVerifier {
	t.Helper()
	key := make([]byte, 32)
	for i := range key {
		key[i] = byte(i + 55)
	}
	c, _ := filestore.NewCodecFromBase64(base64.StdEncoding.EncodeToString(key))
	v, err := NewExitVerifier(filepath.Join(t.TempDir(), "ch.json"), c)
	if err != nil {
		t.Fatal(err)
	}
	return v
}

// ─────────────────────────────────────────────────────────────────────────────
// Property tests
// ─────────────────────────────────────────────────────────────────────────────

// TestBoundary_Verify_NeverPanics_Property feeds arbitrary channelID strings and
// tenantIDs into Verify and asserts the function never panics.
func TestBoundary_Verify_NeverPanics_Property(t *testing.T) {
	v := newVerifier(t)
	ctx := context.Background()

	f := func(channelID, tenantID string) bool {
		defer func() { recover() }()
		env := model.Envelope{TenantID: tenantID}
		_ = v.Verify(ctx, env, channelID)
		return true
	}
	if err := quick.Check(f, &quick.Config{MaxCount: 300}); err != nil {
		t.Errorf("Verify panicked: %v", err)
	}
}

// TestBoundary_Verify_UnknownChannel_AlwaysError asserts that Verify on a fresh
// verifier (no channels) always returns a non-nil error regardless of inputs.
func TestBoundary_Verify_UnknownChannel_AlwaysError(t *testing.T) {
	v := newVerifier(t)
	ctx := context.Background()

	f := func(channelID, tenantID string) bool {
		defer func() { recover() }()
		env := model.Envelope{TenantID: tenantID}
		err := v.Verify(ctx, env, channelID)
		return err != nil
	}
	if err := quick.Check(f, &quick.Config{MaxCount: 300}); err != nil {
		t.Errorf("Verify returned nil error for unknown channel: %v", err)
	}
}

// TestBoundary_RegisterChannel_NeverPanics_Property sends arbitrary ExitChannel
// structs into RegisterChannel and asserts no panic escapes.
func TestBoundary_RegisterChannel_NeverPanics_Property(t *testing.T) {
	v := newVerifier(t)
	ctx := context.Background()

	f := func(name, chType, tenantID string) bool {
		defer func() { recover() }()
		_ = v.RegisterChannel(ctx, model.ExitChannel{
			Name:     name,
			Type:     chType,
			TenantID: tenantID,
		})
		return true
	}
	if err := quick.Check(f, &quick.Config{MaxCount: 300}); err != nil {
		t.Errorf("RegisterChannel panicked: %v", err)
	}
}

// TestBoundary_InvalidChannel_AlwaysError asserts that RegisterChannel rejects
// any channel where at least one mandatory field is empty.
func TestBoundary_InvalidChannel_AlwaysError(t *testing.T) {
	v := newVerifier(t)
	ctx := context.Background()

	cases := []model.ExitChannel{
		{},
		{Name: "x"},
		{Type: "smtp"},
		{TenantID: "t"},
		{Name: "x", Type: "smtp"},
		{Name: "x", TenantID: "t"},
		{Type: "smtp", TenantID: "t"},
	}
	for _, ch := range cases {
		if err := v.RegisterChannel(ctx, ch); err != ErrInvalidChannel {
			t.Errorf("expected ErrInvalidChannel for %+v, got %v", ch, err)
		}
	}
}

// TestBoundary_ListChannels_TenantIsolation_Property asserts that ListChannels
// for a tenant never returns channels registered under a different tenant.
func TestBoundary_ListChannels_TenantIsolation_Property(t *testing.T) {
	v := newVerifier(t)
	ctx := context.Background()

	// Register a fixed set of channels for known tenants.
	tenants := []string{"alpha", "beta", "gamma"}
	for i, tenant := range tenants {
		if err := v.RegisterChannel(ctx, model.ExitChannel{
			Name:     "ch",
			Type:     model.ExitTypeSMTP,
			TenantID: tenant,
		}); err != nil {
			t.Fatalf("register for %s[%d]: %v", tenant, i, err)
		}
	}

	f := func(queryTenant string) bool {
		defer func() { recover() }()
		channels, err := v.ListChannels(ctx, queryTenant)
		if err != nil {
			return true // error OK
		}
		for _, ch := range channels {
			if ch.TenantID != queryTenant {
				return false // tenant leak — violation
			}
		}
		return true
	}
	if err := quick.Check(f, &quick.Config{MaxCount: 200}); err != nil {
		t.Errorf("tenant isolation violated: %v", err)
	}
}

// TestBoundary_GenerateChannelID_NoPanic verifies generateChannelID never panics
// and always produces an id with the expected prefix and length.
func TestBoundary_GenerateChannelID_NoPanic(t *testing.T) {
	for range 200 {
		id, err := generateChannelID()
		if err != nil {
			t.Fatalf("unexpected error: %v", err)
		}
		if len(id) != 19 {
			t.Fatalf("expected 19-char id, got %d (%q)", len(id), id)
		}
		if id[:3] != "ch_" {
			t.Fatalf("expected ch_ prefix, got %q", id)
		}
	}
}

// ─────────────────────────────────────────────────────────────────────────────
// Monkey tests — all exported methods with nil / zero / adversarial inputs
// ─────────────────────────────────────────────────────────────────────────────

// TestBoundary_Monkey_AllMethods calls every exported method on ExitVerifier
// with zero / empty values and asserts no unrecovered panic escapes.
func TestBoundary_Monkey_AllMethods(t *testing.T) {
	ctx := context.Background()

	t.Run("Verify_emptyChannelID", func(t *testing.T) {
		defer func() {
			if r := recover(); r != nil {
				t.Fatalf("panic: %v", r)
			}
		}()
		v := newVerifier(t)
		_ = v.Verify(ctx, model.Envelope{}, "")
	})

	t.Run("Verify_zeroEnvelope", func(t *testing.T) {
		defer func() {
			if r := recover(); r != nil {
				t.Fatalf("panic: %v", r)
			}
		}()
		v := newVerifier(t)
		_ = v.Verify(ctx, model.Envelope{}, "ch_does_not_exist")
	})

	t.Run("RegisterChannel_allEmpty", func(t *testing.T) {
		defer func() {
			if r := recover(); r != nil {
				t.Fatalf("panic: %v", r)
			}
		}()
		v := newVerifier(t)
		_ = v.RegisterChannel(ctx, model.ExitChannel{})
	})

	t.Run("VerifyChannel_emptyIDs", func(t *testing.T) {
		defer func() {
			if r := recover(); r != nil {
				t.Fatalf("panic: %v", r)
			}
		}()
		v := newVerifier(t)
		_ = v.VerifyChannel(ctx, "", "")
	})

	t.Run("ListChannels_emptyTenant", func(t *testing.T) {
		defer func() {
			if r := recover(); r != nil {
				t.Fatalf("panic: %v", r)
			}
		}()
		v := newVerifier(t)
		_, _ = v.ListChannels(ctx, "")
	})

	t.Run("GetChannel_emptyIDs", func(t *testing.T) {
		defer func() {
			if r := recover(); r != nil {
				t.Fatalf("panic: %v", r)
			}
		}()
		v := newVerifier(t)
		_, _ = v.GetChannel(ctx, "", "")
	})

	t.Run("GetChannel_veryLongID", func(t *testing.T) {
		defer func() {
			if r := recover(); r != nil {
				t.Fatalf("panic: %v", r)
			}
		}()
		v := newVerifier(t)
		longID := string(make([]byte, 65536))
		_, _ = v.GetChannel(ctx, longID, "tenant")
	})

	t.Run("RegisterChannel_unicodeFields", func(t *testing.T) {
		defer func() {
			if r := recover(); r != nil {
				t.Fatalf("panic: %v", r)
			}
		}()
		v := newVerifier(t)
		_ = v.RegisterChannel(ctx, model.ExitChannel{
			Name:     "héllo wörld 🌍",
			Type:     "smtp",
			TenantID: "tëñänt-αβγ",
		})
	})
}

// ─────────────────────────────────────────────────────────────────────────────
// Concurrency safety
// ─────────────────────────────────────────────────────────────────────────────

// TestBoundary_ConcurrentAccess_Safe runs Register + List + Verify concurrently
// (use -race to detect data races).
func TestBoundary_ConcurrentAccess_Safe(t *testing.T) {
	v := newVerifier(t)
	ctx := context.Background()

	// Register one verified channel to exercise the Verify path.
	if err := v.RegisterChannel(ctx, model.ExitChannel{
		Name:     "seed",
		Type:     model.ExitTypeSMTP,
		TenantID: "tenant-race",
	}); err != nil {
		t.Fatal(err)
	}
	channels, _ := v.ListChannels(ctx, "tenant-race")
	var verifiedID string
	if len(channels) > 0 {
		verifiedID = channels[0].ID
		_ = v.VerifyChannel(ctx, verifiedID, "tenant-race")
	}

	var wg sync.WaitGroup
	for i := range 12 {
		wg.Add(1)
		go func(i int) {
			defer wg.Done()
			defer func() { recover() }()
			switch i % 4 {
			case 0:
				_ = v.RegisterChannel(ctx, model.ExitChannel{
					Name:     "goroutine-chan",
					Type:     model.ExitTypeSMTP,
					TenantID: "tenant-race",
				})
			case 1:
				_, _ = v.ListChannels(ctx, "tenant-race")
			case 2:
				env := model.Envelope{TenantID: "tenant-race"}
				_ = v.Verify(ctx, env, verifiedID)
			case 3:
				_, _ = v.GetChannel(ctx, verifiedID, "tenant-race")
			}
		}(i)
	}
	wg.Wait()
}
