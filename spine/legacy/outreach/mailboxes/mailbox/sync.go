package mailbox

import (
	"context"
	"fmt"

	"common/config"
)

// FromConfig converts a config.MailboxConfig (JSON-backed) into a Mailbox
// suitable for the registry. Counter fields are left at zero — the Store's
// UpsertFromConfig preserves existing counters on update, so reloading
// config never clobbers bookkeeping.
//
// The global persona is passed so mailboxes without a dedicated persona
// inherit one. The persona slug recorded here is the resolved identity's
// email address (lower-cased) — a stable key the cockpit can join against.
func FromConfig(mb config.MailboxConfig, globalPersona config.PersonaConfig) Mailbox {
	persona := mb.ResolvePersona(globalPersona)
	status := StatusActive
	tz := "Europe/Prague"
	locale := "cs-CZ"

	m := Mailbox{
		FromAddress: NormaliseAddress(mb.Address),
		DisplayName: displayNameFor(persona, mb),
		SMTPHost:    mb.SMTPHost,
		SMTPPort:    mb.SMTPPort,
		SMTPUsername: mb.Username,
		IMAPHost:     mb.IMAPHost,
		IMAPPort:     mb.IMAPPort,
		IMAPUsername: mb.Username,
		Status:       status,
		TZ:           tz,
		Locale:       locale,
	}
	if mb.DailyLimit > 0 {
		dl := mb.DailyLimit
		m.DailyCapOverride = &dl
	}
	return m
}

func displayNameFor(p config.PersonaConfig, mb config.MailboxConfig) string {
	if p.Name != "" {
		return p.Name
	}
	return mb.Address
}

// SyncResult reports how many mailboxes were inserted vs updated by
// SyncFromConfig. Counts are kept separate for operator visibility — a
// fresh install reports N inserts; a subsequent reload reports N updates.
type SyncResult struct {
	Synced  int
	Skipped []SyncSkip
}

// SyncSkip records why a single mailbox was not synced (validation failure).
// The caller gets back every failure instead of only the first so operators
// can fix a broken config in one pass.
type SyncSkip struct {
	Address string
	Reason  string
}

// SyncFromConfig reconciles the config.yaml mailbox list with the
// outreach_mailboxes registry. Every well-formed mailbox is upserted;
// invalid entries are collected into SyncResult.Skipped without aborting
// the sync — this lets a single malformed mailbox not block the others.
//
// Intended to be called on bootstrap and after config reload.
func SyncFromConfig(ctx context.Context, store Store, cfg *config.Config) (SyncResult, error) {
	if cfg == nil {
		return SyncResult{}, fmt.Errorf("mailbox: SyncFromConfig given nil config")
	}
	var result SyncResult
	for _, mb := range cfg.Mailboxes {
		m := FromConfig(mb, cfg.Persona)
		if err := m.Validate(); err != nil {
			result.Skipped = append(result.Skipped, SyncSkip{
				Address: mb.Address,
				Reason:  err.Error(),
			})
			continue
		}
		if _, err := store.UpsertFromConfig(ctx, m); err != nil {
			result.Skipped = append(result.Skipped, SyncSkip{
				Address: mb.Address,
				Reason:  err.Error(),
			})
			continue
		}
		result.Synced++
	}
	return result, nil
}

// ToConfig converts a registry entry back into a config.MailboxConfig so the
// sender engine (which consumes config.MailboxConfig) can treat DB-managed
// mailboxes identically to YAML-managed ones.
//
// Counters (last_send_at, total_sent, bounces) are not copied — those are
// tracked separately via the Store and Backpressure interface.
func (m Mailbox) ToConfig() config.MailboxConfig {
	cfg := config.MailboxConfig{
		Address:          m.FromAddress,
		SMTPHost:         m.SMTPHost,
		SMTPPort:         m.SMTPPort,
		Username:         m.SMTPUsername,
		Password:         m.Password,
		IMAPHost:         m.IMAPHost,
		IMAPPort:         m.IMAPPort,
		DisplayName:      m.DisplayName,
		Timezone:         m.TZ,
		PreferredCountry: m.PreferredCountry,
	}
	if cfg.Username == "" {
		cfg.Username = m.FromAddress
	}
	if m.DailyCapOverride != nil {
		// The DB computes the effective cap as LEAST(phase_cap, override):
		// daily_cap_override may only LOWER the cap, never raise it past the
		// phase ceiling (migrations 115/116). Mirror that clamp here so the
		// engine can't be driven above the phase cap via a stale/oversized
		// override.
		cfg.DailyLimit = min(PhaseDailyCap(m.LifecyclePhase), *m.DailyCapOverride)
	} else {
		// DB-only mailbox without an override silently disables the sender
		// engine because cfg.DailyLimit=0 → pickMailbox treats it as
		// "at limit" (memory project_tocfg_daily_limit_zero). Derive a
		// floor from lifecycle_phase so phase-driven caps work without
		// the operator having to set daily_cap_override on every new row.
		cfg.DailyLimit = PhaseDailyCap(m.LifecyclePhase)
	}
	return cfg
}

// OverlayRegistry merges DB-managed mailboxes into cfg.Mailboxes so the
// sender engine picks them up without a YAML change.
//
// Merge rules:
//   - Only active DB mailboxes are included (paused/held/retired are ignored;
//     the engine's backpressure layer handles those at send time anyway).
//   - Match by canonical from-address: a DB entry with the same address as a
//     YAML entry overrides the YAML entry (DB is the source of truth).
//   - DB entries without a YAML counterpart are appended.
//   - If DB password is empty, the existing YAML password (or env fallback)
//     is preserved — so operators can migrate gradually.
//
// Returns the number of mailboxes overlaid vs. added, for boot-log visibility.
func OverlayRegistry(ctx context.Context, store Store, cfg *config.Config) (overlaid, added int, err error) {
	if cfg == nil {
		return 0, 0, fmt.Errorf("mailbox: OverlayRegistry given nil config")
	}
	if store == nil {
		return 0, 0, fmt.Errorf("mailbox: OverlayRegistry given nil store")
	}

	dbMailboxes, err := store.List(ctx, Filter{Status: []Status{StatusActive}, Limit: 200})
	if err != nil {
		return 0, 0, fmt.Errorf("mailbox: list registry: %w", err)
	}

	// Index existing cfg.Mailboxes by normalised address for O(1) lookup.
	idxByAddr := make(map[string]int, len(cfg.Mailboxes))
	for i, mb := range cfg.Mailboxes {
		idxByAddr[NormaliseAddress(mb.Address)] = i
	}

	for _, dbMB := range dbMailboxes {
		dbCfg := dbMB.ToConfig()
		if idx, ok := idxByAddr[dbMB.FromAddress]; ok {
			// Override — preserve YAML password only if DB has none.
			existing := cfg.Mailboxes[idx]
			if dbCfg.Password == "" {
				dbCfg.Password = existing.Password
			}
			// Preserve YAML DisplayName/Timezone when the DB row carries
			// no value — half-migrated environments still emit correct
			// From/Date headers via sender/headers.go.
			if dbCfg.DisplayName == "" {
				dbCfg.DisplayName = existing.DisplayName
			}
			if dbCfg.Timezone == "" {
				dbCfg.Timezone = existing.Timezone
			}
			// Preserve YAML-only fields the registry doesn't track.
			dbCfg.Persona = existing.Persona
			dbCfg.ProxyURL = existing.ProxyURL
			dbCfg.WarmupDay = existing.WarmupDay
			cfg.Mailboxes[idx] = dbCfg
			overlaid++
		} else {
			cfg.Mailboxes = append(cfg.Mailboxes, dbCfg)
			added++
		}
	}
	return overlaid, added, nil
}
