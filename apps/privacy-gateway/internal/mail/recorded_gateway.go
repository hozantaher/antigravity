package mail

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"sync"
	"time"

	"privacy-gateway/internal/filestore"
	"privacy-gateway/internal/model"
)

type Gateway interface {
	Send(ctx context.Context, msg model.SanitizedMessage) (model.MessageRecord, error)
	ListByActor(ctx context.Context, actor model.Actor) ([]model.MessageRecord, error)
}

type RecordedGateway struct {
	mu        sync.RWMutex
	records   []model.MessageRecord
	now       func() time.Time
	path      string
	codec     filestore.Codec
	retention time.Duration
}

func NewRecordedGateway() *RecordedGateway {
	return &RecordedGateway{now: time.Now}
}

func NewPersistentRecordedGateway(path string) (*RecordedGateway, error) {
	return NewPersistentRecordedGatewayWithCodec(path, filestore.DefaultCodec())
}

func NewPersistentRecordedGatewayWithCodec(path string, codec filestore.Codec) (*RecordedGateway, error) {
	return NewPersistentRecordedGatewayWithCodecAndRetention(path, codec, 0)
}

func NewPersistentRecordedGatewayWithCodecAndRetention(path string, codec filestore.Codec, retention time.Duration) (*RecordedGateway, error) {
	var records []model.MessageRecord
	if err := filestore.ReadJSONWithCodec(path, &records, codec); err != nil {
		return nil, err
	}

	return &RecordedGateway{
		records:   cloneRecords(records),
		now:       time.Now,
		path:      path,
		codec:     codec,
		retention: retention,
	}, nil
}

func (g *RecordedGateway) Send(_ context.Context, msg model.SanitizedMessage) (model.MessageRecord, error) {
	record := model.MessageRecord{
		ID:        messageID(),
		AliasID:   msg.Alias.ID,
		UserID:    msg.Actor.ID,
		TenantID:  msg.Actor.TenantID,
		Sender:    msg.Alias.Email,
		To:        append([]string(nil), msg.To...),
		Subject:   msg.Subject,
		TextBody:  msg.TextBody,
		CreatedAt: g.now().UTC(),
	}

	g.mu.Lock()
	defer g.mu.Unlock()

	next := g.prunedRecordsLocked()
	next = append(next, record)
	if g.path != "" {
		if err := filestore.WriteJSONAtomicWithCodec(g.path, next, g.codec); err != nil {
			return model.MessageRecord{}, err
		}
	}

	g.records = next

	return record, nil
}

func (g *RecordedGateway) ListByActor(_ context.Context, actor model.Actor) ([]model.MessageRecord, error) {
	g.mu.Lock()
	defer g.mu.Unlock()

	next := g.prunedRecordsLocked()
	if len(next) != len(g.records) && g.path != "" {
		if err := filestore.WriteJSONAtomicWithCodec(g.path, next, g.codec); err != nil {
			return nil, err
		}
		g.records = next
	}

	out := make([]model.MessageRecord, 0, len(next))
	for _, record := range next {
		if record.UserID == actor.ID && record.TenantID == actor.TenantID {
			out = append(out, record)
		}
	}

	return out, nil
}

func cloneRecords(records []model.MessageRecord) []model.MessageRecord {
	return append([]model.MessageRecord(nil), records...)
}

func (g *RecordedGateway) prunedRecordsLocked() []model.MessageRecord {
	next := cloneRecords(g.records)
	if g.retention <= 0 {
		return next
	}
	cutoff := g.now().UTC().Add(-g.retention)
	filtered := next[:0]
	for _, record := range next {
		if record.CreatedAt.IsZero() || !record.CreatedAt.Before(cutoff) {
			filtered = append(filtered, record)
		}
	}
	return append([]model.MessageRecord(nil), filtered...)
}

func messageID() string {
	buf := make([]byte, 4)
	_, _ = rand.Read(buf)
	return "msg_" + hex.EncodeToString(buf)
}
