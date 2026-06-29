package inbox

import (
	"context"
	"path/filepath"
	"testing"
	"time"

	"privacy-gateway/internal/model"
)

type staticAliasLookup struct {
	items []model.Alias
	err   error
}

type staticSubmissionLookup struct {
	items []model.Submission
	err   error
}

func (s staticAliasLookup) ListForActor(context.Context, model.Actor) ([]model.Alias, error) {
	return append([]model.Alias(nil), s.items...), s.err
}

func (s staticSubmissionLookup) ListForActor(context.Context, model.Actor) ([]model.Submission, error) {
	return append([]model.Submission(nil), s.items...), s.err
}

func TestContextResolverMatchesAliasAndSubmission(t *testing.T) {
	actor := model.Actor{ID: "user-1", TenantID: "tenant-1"}
	resolver := NewContextResolver(
		staticAliasLookup{
			items: []model.Alias{{
				ID:       "al_1",
				UserID:   actor.ID,
				TenantID: actor.TenantID,
				Email:    "support@relay.example",
			}},
		},
		staticSubmissionLookup{
			items: []model.Submission{{
				ID:          "sub_1",
				TenantID:    actor.TenantID,
				ChannelID:   "al_1",
				SubmittedBy: actor.ID,
				To:          []string{"sender@example.com"},
				Subject:     "Hello world",
			}},
		},
	)

	resolved, err := resolver.Resolve(context.Background(), actor, model.InboxMessage{
		AliasEmail: "support@relay.example",
		From:       "sender@example.com",
		Subject:    "Re: Hello world",
	})
	if err != nil {
		t.Fatalf("Resolve() error = %v", err)
	}
	if resolved.AliasID != "al_1" {
		t.Fatalf("expected alias match al_1, got %q", resolved.AliasID)
	}
	if resolved.SubmissionID != "sub_1" {
		t.Fatalf("expected submission match sub_1, got %q", resolved.SubmissionID)
	}
}

func TestContextResolverDoesNotMatchSubmissionAcrossDifferentSender(t *testing.T) {
	actor := model.Actor{ID: "user-1", TenantID: "tenant-1"}
	resolver := NewContextResolver(
		staticAliasLookup{
			items: []model.Alias{{
				ID:       "al_1",
				UserID:   actor.ID,
				TenantID: actor.TenantID,
				Email:    "support@relay.example",
			}},
		},
		staticSubmissionLookup{
			items: []model.Submission{{
				ID:          "sub_1",
				TenantID:    actor.TenantID,
				ChannelID:   "al_1",
				SubmittedBy: actor.ID,
				To:          []string{"expected@example.com"},
				Subject:     "Hello world",
			}},
		},
	)

	resolved, err := resolver.Resolve(context.Background(), actor, model.InboxMessage{
		AliasEmail: "support@relay.example",
		From:       "other@example.com",
		Subject:    "Re: Hello world",
	})
	if err != nil {
		t.Fatalf("Resolve() error = %v", err)
	}
	if resolved.AliasID != "al_1" {
		t.Fatalf("expected alias match al_1, got %q", resolved.AliasID)
	}
	if resolved.SubmissionID != "" {
		t.Fatalf("expected no submission match, got %q", resolved.SubmissionID)
	}
}

func TestIMAPSyncerSyncAppliesResolverContext(t *testing.T) {
	store, err := NewStore(filepath.Join(t.TempDir(), "inbox.json"))
	if err != nil {
		t.Fatalf("NewStore() error = %v", err)
	}
	cursors, err := NewCursorStore(filepath.Join(t.TempDir(), "imap-sync-state.json"))
	if err != nil {
		t.Fatalf("NewCursorStore() error = %v", err)
	}
	syncer, err := NewIMAPSyncer(IMAPSyncConfig{
		Host:     "imap.example.com",
		Username: "imap-user",
		Password: "imap-pass",
	}, store, cursors)
	if err != nil {
		t.Fatalf("NewIMAPSyncer() error = %v", err)
	}

	session := &fakeSession{
		uids: []string{"10"},
		messages: map[string][]byte{
			"10": []byte("From: sender@example.com\r\nTo: support@relay.example\r\nSubject: Re: Hello world\r\nDate: Fri, 03 Apr 2026 10:00:00 +0000\r\n\r\nFirst body"),
		},
	}
	syncer.sessions = fakeSessionFactory{session: session}
	syncer.WithResolver(NewContextResolver(
		staticAliasLookup{
			items: []model.Alias{{
				ID:       "al_1",
				UserID:   "user-1",
				TenantID: "tenant-1",
				Email:    "support@relay.example",
			}},
		},
		staticSubmissionLookup{
			items: []model.Submission{{
				ID:          "sub_1",
				TenantID:    "tenant-1",
				ChannelID:   "al_1",
				SubmittedBy: "user-1",
				To:          []string{"sender@example.com"},
				Subject:     "Hello world",
				CreatedAt:   time.Now().UTC(),
			}},
		},
	))

	actor := model.Actor{ID: "user-1", TenantID: "tenant-1", PrimaryEmail: "user@example.com"}
	if _, err := syncer.Sync(context.Background(), actor); err != nil {
		t.Fatalf("Sync() error = %v", err)
	}

	messages, err := store.ListByActor(context.Background(), actor)
	if err != nil {
		t.Fatalf("ListByActor() error = %v", err)
	}
	if len(messages) != 1 {
		t.Fatalf("expected 1 stored message, got %d", len(messages))
	}
	if messages[0].AliasID != "al_1" {
		t.Fatalf("expected stored alias id al_1, got %q", messages[0].AliasID)
	}
	if messages[0].SubmissionID != "sub_1" {
		t.Fatalf("expected stored submission id sub_1, got %q", messages[0].SubmissionID)
	}
}
