package sender

import (
	"context"
	"database/sql"
	"encoding/json"
	"fmt"
)

// ProtectionTrace records which layers were active per send.
// It is a simple fire-and-forget INSERT — errors are logged and swallowed
// so a trace outage never blocks delivery.
type ProtectionTrace struct {
	DB *sql.DB // nil → no-op
}

// NewProtectionTrace wraps db for per-send protection tracing.
func NewProtectionTrace(db *sql.DB) *ProtectionTrace { return &ProtectionTrace{DB: db} }

// Record writes one row to protection_trace for the given message_id.
// layers maps each checked protection layer to its status string
// ("ok", "warn", "err", "skip"). Absent keys mean the layer was not
// configured / not applicable for this send.
func (t *ProtectionTrace) Record(ctx context.Context, messageID string, layers map[string]string) error {
	if t == nil || t.DB == nil || messageID == "" {
		return nil
	}
	blob, err := json.Marshal(layers)
	if err != nil {
		return fmt.Errorf("protection_trace: marshal: %w", err)
	}
	_, err = t.DB.ExecContext(ctx,
		`INSERT INTO protection_trace (message_id, layers) VALUES ($1, $2)`,
		messageID, blob)
	if err != nil {
		return fmt.Errorf("protection_trace: insert: %w", err)
	}
	return nil
}
