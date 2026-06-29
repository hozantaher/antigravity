package mailbox

import (
	"context"
	"errors"
	"testing"
	"time"

	"common/config"
)

// fakeStore is an in-memory Store implementation used by sync tests.
type fakeStore struct {
	upserts  []Mailbox
	failOn   map[string]error
	listResp []Mailbox // pre-seeded DB state for List() in overlay tests
	listErr  error
}

func newFakeStore() *fakeStore { return &fakeStore{failOn: map[string]error{}} }

func (f *fakeStore) List(_ context.Context, _ Filter) ([]Mailbox, error) {
	return f.listResp, f.listErr
}
func (f *fakeStore) Get(_ context.Context, _ int64) (Mailbox, error) {
	return Mailbox{}, ErrMailboxNotFound
}
func (f *fakeStore) GetByAddress(_ context.Context, _ string) (Mailbox, error) {
	return Mailbox{}, ErrMailboxNotFound
}
func (f *fakeStore) UpsertFromConfig(_ context.Context, m Mailbox) (Mailbox, error) {
	if err, ok := f.failOn[m.FromAddress]; ok {
		return Mailbox{}, err
	}
	f.upserts = append(f.upserts, m)
	return m, nil
}
func (f *fakeStore) UpdateStatus(_ context.Context, _ int64, _ Status, _ string) (Mailbox, error) {
	return Mailbox{}, nil
}
func (f *fakeStore) TouchLastSend(_ context.Context, _ int64, _ time.Time) error { return nil }
func (f *fakeStore) IncrementBounce(_ context.Context, _ int64) (Mailbox, error) {
	return Mailbox{}, nil
}
func (f *fakeStore) ResetBounce(_ context.Context, _ int64) error { return nil }
func (f *fakeStore) Create(_ context.Context, m Mailbox) (Mailbox, error) { return m, nil }
func (f *fakeStore) Update(_ context.Context, _ int64, m Mailbox) (Mailbox, error) {
	return m, nil
}
func (f *fakeStore) Delete(_ context.Context, _ int64) error { return nil }

func TestFromConfig_NormalisesAndResolvesPersona(t *testing.T) {
	mb := config.MailboxConfig{
		Address:    "  JAN@Sender.Test  ",
		SMTPHost:   "smtp.sender.test",
		SMTPPort:   587,
		IMAPHost:   "imap.sender.test",
		IMAPPort:   993,
		Username:   "jan",
		DailyLimit: 42,
		Persona: config.PersonaConfig{
			Name:  "Jan Novák",
			Email: "  Jan@Sender.Test  ",
		},
	}
	got := FromConfig(mb, config.PersonaConfig{})

	if got.FromAddress != "jan@sender.test" {
		t.Errorf("FromAddress not normalised: %q", got.FromAddress)
	}
	if got.DisplayName != "Jan Novák" {
		t.Errorf("DisplayName: got %q", got.DisplayName)
	}
	if got.Status != StatusActive {
		t.Errorf("default Status: got %q want active", got.Status)
	}
	if got.DailyCapOverride == nil || *got.DailyCapOverride != 42 {
		t.Errorf("DailyCapOverride: got %v want 42", got.DailyCapOverride)
	}
	if err := got.Validate(); err != nil {
		t.Errorf("converted mailbox failed Validate: %v", err)
	}
}

func TestFromConfig_FallsBackToGlobalPersona(t *testing.T) {
	mb := config.MailboxConfig{
		Address:  "ops@sender.test",
		SMTPHost: "smtp.sender.test",
		SMTPPort: 587,
	}
	global := config.PersonaConfig{Name: "Default Ops", Email: "ops@sender.test"}
	got := FromConfig(mb, global)

	if got.DisplayName != "Default Ops" {
		t.Errorf("global persona not used: got %q", got.DisplayName)
	}
}

func TestFromConfig_NoDailyLimitLeavesOverrideNil(t *testing.T) {
	mb := config.MailboxConfig{
		Address:  "new@sender.test",
		SMTPHost: "smtp.sender.test",
		SMTPPort: 587,
	}
	got := FromConfig(mb, config.PersonaConfig{})
	if got.DailyCapOverride != nil {
		t.Errorf("no daily_limit in config must leave DailyCapOverride nil, got %v", got.DailyCapOverride)
	}
}

func TestSyncFromConfig_UpsertsAll(t *testing.T) {
	store := newFakeStore()
	cfg := &config.Config{
		Persona: config.PersonaConfig{Name: "Team"},
		Mailboxes: []config.MailboxConfig{
			{Address: "a@sender.test", SMTPHost: "smtp.sender.test", SMTPPort: 587},
			{Address: "b@sender.test", SMTPHost: "smtp.sender.test", SMTPPort: 587},
		},
	}

	res, err := SyncFromConfig(context.Background(), store, cfg)
	if err != nil {
		t.Fatalf("SyncFromConfig: %v", err)
	}
	if res.Synced != 2 {
		t.Errorf("Synced: got %d want 2", res.Synced)
	}
	if len(res.Skipped) != 0 {
		t.Errorf("unexpected skips: %+v", res.Skipped)
	}
	if len(store.upserts) != 2 {
		t.Errorf("store received %d upserts, want 2", len(store.upserts))
	}
}

func TestSyncFromConfig_CollectsEveryFailure(t *testing.T) {
	// Invariant: one bad mailbox must not abort the sync — operators should
	// see every problem at once, not fix-then-retry N times.
	store := newFakeStore()
	store.failOn["broken@sender.test"] = errors.New("simulated upsert failure")

	cfg := &config.Config{
		Mailboxes: []config.MailboxConfig{
			// Valid:
			{Address: "ok@sender.test", SMTPHost: "smtp.sender.test", SMTPPort: 587},
			// Fails at store level:
			{Address: "broken@sender.test", SMTPHost: "smtp.sender.test", SMTPPort: 587},
			// Fails at Validate() (bad port):
			{Address: "badport@sender.test", SMTPHost: "smtp.sender.test", SMTPPort: 0},
			// Fails at Validate() (missing from):
			{Address: "", SMTPHost: "smtp.sender.test", SMTPPort: 587},
		},
	}

	res, err := SyncFromConfig(context.Background(), store, cfg)
	if err != nil {
		t.Fatalf("SyncFromConfig: %v", err)
	}
	if res.Synced != 1 {
		t.Errorf("Synced: got %d want 1 (only 'ok')", res.Synced)
	}
	if len(res.Skipped) != 3 {
		t.Errorf("Skipped: got %d want 3, skipped=%+v", len(res.Skipped), res.Skipped)
	}
}

func TestSyncFromConfig_NilConfigReturnsError(t *testing.T) {
	_, err := SyncFromConfig(context.Background(), newFakeStore(), nil)
	if err == nil {
		t.Error("nil config must return an error")
	}
}

func TestToConfig_RoundTripsCoreFields(t *testing.T) {
	cap := 42
	m := Mailbox{
		FromAddress:      "jan@sender.test",
		SMTPHost:         "smtp.sender.test",
		SMTPPort:         587,
		SMTPUsername:     "",
		Password:         "s3cret",
		IMAPHost:         "imap.sender.test",
		IMAPPort:         993,
		// production phase cap (180) is above the override so the override
		// value round-trips unchanged through the LEAST(phase_cap, override)
		// clamp in ToConfig.
		LifecyclePhase:   "production",
		DailyCapOverride: &cap,
	}
	got := m.ToConfig()
	if got.Address != "jan@sender.test" {
		t.Errorf("Address: got %q", got.Address)
	}
	if got.Username != "jan@sender.test" {
		t.Errorf("empty SMTPUsername should default to FromAddress, got %q", got.Username)
	}
	if got.Password != "s3cret" {
		t.Errorf("Password not carried: got %q", got.Password)
	}
	if got.DailyLimit != 42 {
		t.Errorf("DailyLimit: got %d", got.DailyLimit)
	}
}

// TestToConfig_NilOverrideUsesPhaseFallback exercises the lifecycle_phase
// fallback ladder (memory project_tocfg_daily_limit_zero). Before this
// change, DB-only mailboxes with NULL daily_cap_override silently disabled
// the engine because cfg.DailyLimit was 0.
func TestToConfig_NilOverrideUsesPhaseFallback(t *testing.T) {
	tests := []struct {
		phase     string
		wantLimit int
	}{
		{"warmup_d0", 10},
		{"warmup_d3", 30},
		{"warmup_d7", 70},
		{"warmup_d14", 120},
		{"production", 180},
		{"", 10},          // unset phase falls back to warmup_d0 (safest floor)
		{"garbage", 10},   // unknown phase falls back to warmup_d0
	}
	for _, tt := range tests {
		t.Run(tt.phase, func(t *testing.T) {
			m := Mailbox{
				FromAddress:    "x@sender.test",
				SMTPHost:       "smtp.sender.test",
				SMTPPort:       587,
				LifecyclePhase: tt.phase,
			}
			got := m.ToConfig()
			if got.DailyLimit != tt.wantLimit {
				t.Errorf("phase=%q DailyLimit: got %d want %d", tt.phase, got.DailyLimit, tt.wantLimit)
			}
		})
	}
}

// TestToConfig_OverridePrecedesPhase: explicit daily_cap_override beats
// the lifecycle_phase ladder. Operator can dial the cap below the phase
// ceiling (lower-only intent — DB trigger still enforces the upper cap).
func TestToConfig_OverridePrecedesPhase(t *testing.T) {
	cap := 3
	m := Mailbox{
		FromAddress:      "x@sender.test",
		SMTPHost:         "smtp.sender.test",
		SMTPPort:         587,
		LifecyclePhase:   "production",
		DailyCapOverride: &cap,
	}
	if got := m.ToConfig().DailyLimit; got != 3 {
		t.Errorf("override should win: got %d want 3", got)
	}
}

func TestPhaseDailyCap(t *testing.T) {
	cases := map[string]int{
		"warmup_d0":  10,
		"warmup_d3":  30,
		"warmup_d7":  70,
		"warmup_d14": 120,
		"production": 180,
		"":           10,
		"weird":      10,
	}
	for phase, want := range cases {
		if got := PhaseDailyCap(phase); got != want {
			t.Errorf("PhaseDailyCap(%q) = %d, want %d", phase, got, want)
		}
	}
}

func TestOverlayRegistry_OverridesMatchingAddress(t *testing.T) {
	store := newFakeStore()
	store.listResp = []Mailbox{
		{
			ID: 1, FromAddress: "jan@sender.test", Status: StatusActive,
			SMTPHost: "smtp.new.test", SMTPPort: 465,
			Password: "db-password",
		},
	}

	cfg := &config.Config{
		Mailboxes: []config.MailboxConfig{
			{
				Address:  "jan@sender.test",
				SMTPHost: "smtp.old.test",
				SMTPPort: 587,
				Password: "yaml-password",
				Persona:  config.PersonaConfig{Name: "Yaml Persona"},
			},
		},
	}

	overlaid, added, err := OverlayRegistry(context.Background(), store, cfg)
	if err != nil {
		t.Fatalf("OverlayRegistry: %v", err)
	}
	if overlaid != 1 || added != 0 {
		t.Errorf("counts: overlaid=%d added=%d want 1/0", overlaid, added)
	}
	if len(cfg.Mailboxes) != 1 {
		t.Fatalf("mailbox count: got %d want 1", len(cfg.Mailboxes))
	}
	mb := cfg.Mailboxes[0]
	if mb.SMTPHost != "smtp.new.test" {
		t.Errorf("SMTPHost not overlaid: %q", mb.SMTPHost)
	}
	if mb.Password != "db-password" {
		t.Errorf("DB password should override YAML: %q", mb.Password)
	}
	if mb.Persona.Name != "Yaml Persona" {
		t.Errorf("Persona must be preserved from YAML: %q", mb.Persona.Name)
	}
}

func TestOverlayRegistry_PreservesYAMLPasswordWhenDBEmpty(t *testing.T) {
	// Invariant: empty DB password means "not yet set" — we must NOT clobber
	// the YAML/env password so gradual migration works.
	store := newFakeStore()
	store.listResp = []Mailbox{
		{ID: 1, FromAddress: "jan@sender.test", Status: StatusActive,
			SMTPHost: "smtp.sender.test", SMTPPort: 587, Password: ""},
	}
	cfg := &config.Config{
		Mailboxes: []config.MailboxConfig{
			{Address: "jan@sender.test", SMTPHost: "smtp.sender.test", SMTPPort: 587, Password: "yaml-password"},
		},
	}
	if _, _, err := OverlayRegistry(context.Background(), store, cfg); err != nil {
		t.Fatalf("OverlayRegistry: %v", err)
	}
	if cfg.Mailboxes[0].Password != "yaml-password" {
		t.Errorf("empty DB password must not clobber YAML password, got %q", cfg.Mailboxes[0].Password)
	}
}

func TestOverlayRegistry_AppendsDBOnlyMailboxes(t *testing.T) {
	// Dashboard-only flow: mailbox exists in DB but not in YAML.
	// Sender must still see it.
	store := newFakeStore()
	store.listResp = []Mailbox{
		{ID: 1, FromAddress: "new@sender.test", Status: StatusActive,
			SMTPHost: "smtp.sender.test", SMTPPort: 587, Password: "p1"},
	}
	cfg := &config.Config{Mailboxes: nil}
	overlaid, added, err := OverlayRegistry(context.Background(), store, cfg)
	if err != nil {
		t.Fatalf("OverlayRegistry: %v", err)
	}
	if overlaid != 0 || added != 1 {
		t.Errorf("counts: overlaid=%d added=%d want 0/1", overlaid, added)
	}
	if len(cfg.Mailboxes) != 1 || cfg.Mailboxes[0].Address != "new@sender.test" {
		t.Errorf("DB-only mailbox not appended: %+v", cfg.Mailboxes)
	}
}

func TestOverlayRegistry_NilInputsError(t *testing.T) {
	if _, _, err := OverlayRegistry(context.Background(), nil, &config.Config{}); err == nil {
		t.Error("nil store must error")
	}
	if _, _, err := OverlayRegistry(context.Background(), newFakeStore(), nil); err == nil {
		t.Error("nil config must error")
	}
}
