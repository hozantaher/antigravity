package config

import (
	"encoding/json"
	"fmt"
	"net/url"
	"os"
	"strconv"
	"strings"

	"common/envconfig"
)

type Config struct {
	Database   DatabaseConfig   `json:"database"`
	FirmyDSN   string           `json:"firmy_dsn"`
	Mailboxes  []MailboxConfig  `json:"mailboxes"`
	Sending    SendingConfig    `json:"sending"`
	Safety     SafetyConfig     `json:"safety"`
	Tracking   TrackingConfig   `json:"tracking"`
	Web        WebConfig        `json:"web"`
	Persona    PersonaConfig    `json:"persona"`
	AntiTrace  AntiTraceConfig  `json:"anti_trace"`
}

// AntiTraceConfig routes outbound emails through the anti-trace-relay
// instead of direct SMTP, adding header sanitization and metadata minimization.
type AntiTraceConfig struct {
	Enabled  bool   `json:"enabled"`
	URL      string `json:"url"`      // e.g. http://anti-trace-relay.railway.internal
	Token    string `json:"token"`    // DEV_API_TOKEN from anti-trace-relay
}

type DatabaseConfig struct {
	Host     string `json:"host"`
	Port     int    `json:"port"`
	Name     string `json:"name"`
	User     string `json:"user"`
	Password string `json:"password"`
	SSLMode  string `json:"ssl_mode"`
}

func (d DatabaseConfig) DSN() string {
	sslMode := d.SSLMode
	if sslMode == "" {
		sslMode = "disable"
	}
	return fmt.Sprintf("host=%s port=%d dbname=%s user=%s password=%s sslmode=%s",
		d.Host, d.Port, d.Name, d.User, d.Password, sslMode)
}

type MailboxConfig struct {
	Address    string `json:"address"`
	SMTPHost   string `json:"smtp_host"`
	SMTPPort   int    `json:"smtp_port"`
	Username   string `json:"username"`
	Password   string `json:"password"`
	IMAPHost   string `json:"imap_host"`
	IMAPPort   int    `json:"imap_port"`
	DailyLimit int    `json:"daily_limit"`
	WarmupDay  int    `json:"warmup_day"`

	// ProxyURL — per-mailbox outbound SMTP proxy for IP diversity and
	// deliverability isolation. Empty = direct TLS dial.
	// Supported schemes: socks5://user:pass@host:port, http://host:port
	// (HTTP CONNECT for TLS tunnel). Each mailbox SHOULD have its own
	// proxy so reputation damage on one IP does not cascade across the
	// warmup pool.
	ProxyURL string `json:"proxy_url"`

	// DisplayName — per-mailbox From-header display name. Mirrors
	// outreach_mailboxes.display_name. When empty, the engine title-cases
	// the email's local part as the fallback (so a.mazher@email.cz reads
	// "A. Mazher <a.mazher@email.cz>" on the wire). Source of truth for
	// production deploys is the DB column populated by sync.go FromConfig.
	DisplayName string `json:"display_name"`

	// Timezone — IANA zone (e.g. "Europe/Prague") used for two purposes:
	//   1. mailbox-local working hours (anti-trace timing scheduler), and
	//   2. the Date header so a Prague-located mailbox never emits a UTC-
	//      stamped Date when the server lives on a US datacenter
	//      (anti-trace anonymity bundle FIX 3).
	// Mirrors outreach_mailboxes.tz. Empty falls back to
	// SendingConfig.Timezone for working-hours and to "Europe/Prague" for
	// the Date header (sender/headers.go BuildDateHeader).
	Timezone string `json:"timezone"`

	// Persona — each mailbox has its own virtual salesperson identity.
	// Falls back to global PersonaConfig if not set.
	Persona PersonaConfig `json:"persona"`

	// PreferredCountry — ISO 3166-1 alpha-2 egress country pin for this mailbox.
	// When set (e.g. "SK", "RO"), the wgpool picker restricts candidate
	// endpoints to that country. Empty = no preference (hash-based rotation).
	// Source: outreach_mailboxes.preferred_country (migration 065).
	PreferredCountry string `json:"preferred_country,omitempty"`
}

type SendingConfig struct {
	WindowStart      int    `json:"window_start"`
	WindowEnd        int    `json:"window_end"`
	Timezone         string `json:"timezone"`
	MinDelaySeconds  int    `json:"min_delay_seconds"`
	MaxDelaySeconds  int    `json:"max_delay_seconds"`
	MaxPerDomainHour int    `json:"max_per_domain_hour"`
	WarmupSchedule   map[int]int `json:"warmup_schedule"`

	// TransportMode — outbound transport gate per ADR-005 airtight design.
	// Allowed values: "lab" | "proxy" | "socks5" | "tor" | "vpn" | "vpn+tor".
	// "direct" is forbidden (per project_b2b_transport_mode + relay
	// ErrDirectTransportForbidden). Empty defaults to "proxy" for prod
	// backward-compat. See ADR-005 §D2.
	TransportMode string `json:"transport_mode"`

	// LabOnly — opt-in kill switch. When true, engine init refuses to boot
	// unless TransportMode == "lab". Production deploy keeps this unset
	// (default false). See ADR-005 §D3.
	LabOnly bool `json:"lab_only"`

	// Environment — production hard-gates for anonymity hygiene. When set
	// to "production", Engine enforces:
	//   - Subject scrub: rejects envelopes whose Subject starts with a
	//     "[A:..." test marker unless AllowTestMarkers is true.
	//   - Working-hours window: defers sends outside
	//     [SendWindowStartHour, SendWindowEndHour) in the mailbox-local
	//     timezone, weekdays only when WeekdaysOnly is true.
	// Empty (or any value other than "production") keeps legacy permissive
	// behaviour for tests and dev. Source: env ENVIRONMENT.
	Environment string `json:"environment"`

	// AllowTestMarkers — explicit opt-in escape hatch for the
	// cmd/anonymity-* CLI suite. When true, Engine.Run does not strip
	// "[A:<short>]" subject markers used by anonymity-harvest for run-id
	// correlation. MUST stay false in production. Source: env
	// ALLOW_TEST_MARKERS.
	AllowTestMarkers bool `json:"allow_test_markers"`

	// SendWindowStartHour / SendWindowEndHour — per-mailbox-local working
	// window applied in production. End is exclusive (16:59 last sendable
	// minute when end=17). Override of legacy WindowStart / WindowEnd
	// which were hour-of-day in the global SendingConfig.Timezone. When
	// zero, falls back to WindowStart / WindowEnd. Source: env
	// SEND_WINDOW_START_HOUR / SEND_WINDOW_END_HOUR.
	SendWindowStartHour int `json:"send_window_start_hour"`
	SendWindowEndHour   int `json:"send_window_end_hour"`

	// WeekdaysOnly — when true, Engine refuses to send on Saturday/Sunday
	// in the mailbox-local timezone. Source: env SEND_WEEKDAYS_ONLY.
	WeekdaysOnly bool `json:"weekdays_only"`

	// PoissonMeanSeconds — mean inter-arrival spacing for the Poisson
	// timing model. The brutal anonymity test (2026-05-01) found 1-3s
	// spacing that the harvester flagged as machine-cadence. Default 120s
	// mean produces a human-plausible distribution across
	// [PoissonMinSeconds, PoissonMaxSeconds]. Source: env
	// POISSON_MEAN_SECONDS.
	PoissonMeanSeconds int `json:"poisson_mean_seconds"`

	// PoissonMinSeconds / PoissonMaxSeconds — hard clamp for the Poisson
	// sample. Default 30 / 300. The samples never burst below the floor
	// or above the ceiling, regardless of the exponential tail. Source:
	// env POISSON_MIN_SECONDS / POISSON_MAX_SECONDS.
	PoissonMinSeconds int `json:"poisson_min_seconds"`
	PoissonMaxSeconds int `json:"poisson_max_seconds"`

	// MailboxMinSpacingSeconds — minimum wall-clock seconds between two
	// sends from the same mailbox (post-Poisson dampening). Anti-burst
	// enforcement: if Engine selected the same mailbox <N seconds after
	// its last send, the envelope is deferred. 0 disables. Source: env
	// MAILBOX_MIN_SPACING_SECONDS.
	MailboxMinSpacingSeconds int `json:"mailbox_min_spacing_seconds"`
}

// Transport mode constants per ADR-005.
const (
	TransportModeLab    = "lab"
	TransportModeProxy  = "proxy"
	TransportModeSocks5 = "socks5"
	TransportModeTor    = "tor"
	TransportModeVPN    = "vpn"
	TransportModeVPNTor = "vpn+tor"

	// TransportModeDirectBanned is the explicit banned value. Recognising it
	// allows ValidateAirtight to emit a precise error instead of the generic
	// "unknown mode" message.
	TransportModeDirectBanned = "direct"

	// AirtightExitCodeLabOnlyMismatch — exit code 47 per ADR-005 §D3.
	// LAB_ONLY=1 requested but TransportMode != "lab".
	AirtightExitCodeLabOnlyMismatch = 47
	// AirtightExitCodeBadMode — exit code 48 per ADR-005 §D2.
	// TransportMode is "direct" or unknown value.
	AirtightExitCodeBadMode = 48
)

// allowedTransportModes is the closed set of legal TRANSPORT_MODE values
// per ADR-005 §D2. Order does not matter; lookup is via map.
var allowedTransportModes = map[string]bool{
	TransportModeLab:    true,
	TransportModeProxy:  true,
	TransportModeSocks5: true,
	TransportModeTor:    true,
	TransportModeVPN:    true,
	TransportModeVPNTor: true,
}

// AirtightError is returned by ValidateAirtight on misconfig. ExitCode
// distinguishes the failure class so the boot wrapper can map to a
// distinct os.Exit code (47 = lab-only mismatch, 48 = banned/unknown mode).
type AirtightError struct {
	ExitCode int
	Message  string
}

func (e *AirtightError) Error() string { return e.Message }

// ValidateAirtight enforces ADR-005 boot gate rules on SendingConfig.
//
//   - Empty TransportMode is treated as legacy "proxy" (prod backward-compat).
//   - "direct" is rejected (exit 48) — leaks egress IP, breaks anonymization.
//   - Unknown values are rejected (exit 48) — fail-closed on typos.
//   - LabOnly=true requires TransportMode == "lab" (exit 47) — operator's
//     opt-in kill switch refuses real-SMTP path.
//
// Production (LabOnly=false, TransportMode unset or any allowed value
// other than "direct") passes silently. See ADR-005 Recovery procedures
// for operator-side response to each failure.
func (s *SendingConfig) ValidateAirtight() error {
	mode := s.TransportMode
	if mode == "" {
		mode = TransportModeProxy
	}
	if mode == TransportModeDirectBanned {
		return &AirtightError{
			ExitCode: AirtightExitCodeBadMode,
			Message:  "airtight: TRANSPORT_MODE=direct is forbidden (leaks egress IP); set lab/proxy/socks5/tor/vpn/vpn+tor",
		}
	}
	if !allowedTransportModes[mode] {
		return &AirtightError{
			ExitCode: AirtightExitCodeBadMode,
			Message:  fmt.Sprintf("airtight: TRANSPORT_MODE=%q is not a recognised mode; allowed: lab, proxy, socks5, tor, vpn, vpn+tor", s.TransportMode),
		}
	}
	if s.LabOnly && mode != TransportModeLab {
		return &AirtightError{
			ExitCode: AirtightExitCodeLabOnlyMismatch,
			Message:  fmt.Sprintf("airtight: refusing real SMTP dial under LAB_ONLY=1 (mode=%s); export TRANSPORT_MODE=lab or unset LAB_ONLY", mode),
		}
	}
	return nil
}

// IsProduction reports whether the engine is running in production mode.
// Hard gates (subject scrub, working-hours window) only fire in production.
// Empty Environment defaults to non-production for backward-compat with
// existing tests and dev runs.
func (s *SendingConfig) IsProduction() bool {
	return strings.EqualFold(strings.TrimSpace(s.Environment), "production")
}

// sendWindowHourUnset is the int zero-value that marks an unconfigured
// SendWindowStartHour / SendWindowEndHour. Because it coincides with a legit
// hour 0 (midnight), EffectiveSendWindow treats the new-field pair as
// configured when EITHER field differs from it, so a deliberately-set midnight
// is preserved rather than silently rewritten to the legacy WindowStart.
const sendWindowHourUnset = 0

// EffectiveSendWindow returns the (start, end) hour pair the engine should
// use for the working-hours gate. SendWindowStartHour / SendWindowEndHour
// override the legacy WindowStart / WindowEnd when set; both must be in
// [0, 24].
//
// Two valid shapes are supported (operator spec 2026-05-13, "6-3 wrap =
// 06:00 Prague → 03:00 next day"):
//
//   - Same-day window when start < end (e.g. 6→23): valid hours are
//     [start, end), so hour 6..22 inclusive ship.
//   - Overnight wrap when start > end (e.g. 22→3): valid hours are
//     [start, 24) ∪ [0, end), so hour 22, 23, 0, 1, 2 ship.
//
// When start == end the window is treated as zero-width (never send) — the
// caller must use 0→24 to opt into "always send" semantics. Out-of-range
// values are clamped to [0, 24]. When both new and legacy fields are unset
// the defensive 09:00–17:00 default applies so a misconfigured boot does
// not collapse to "always send".
func (s *SendingConfig) EffectiveSendWindow() (start, end int) {
	// The SendWindowStartHour / SendWindowEndHour pair overrides the legacy
	// WindowStart / WindowEnd. Treat the pair as configured when EITHER field
	// is non-zero, then use both verbatim — that way an explicitly-set hour 0
	// (midnight) in one field is preserved instead of being mistaken for the
	// int zero-value "unset" state (the prior per-field `<= 0` test conflated
	// a legit midnight with unset and silently rewrote it to WindowStart).
	// Only when BOTH new fields are the zero value do we fall back to the
	// legacy pair.
	if s.SendWindowStartHour != sendWindowHourUnset || s.SendWindowEndHour != sendWindowHourUnset {
		start = s.SendWindowStartHour
		end = s.SendWindowEndHour
	} else {
		start = s.WindowStart
		end = s.WindowEnd
	}
	if start < 0 {
		start = 0
	}
	if start > 24 {
		start = 24
	}
	if end < 0 {
		end = 0
	}
	if end > 24 {
		end = 24
	}
	// Both unset → defensive business-hours default. Without this the
	// legacy zero-config boot would collapse to (0, 0) = never send.
	if start == 0 && end == 0 {
		start, end = 9, 17
	}
	return start, end
}

// HourInSendWindow reports whether the given hour-of-day satisfies the
// (start, end) window returned by EffectiveSendWindow. Supports the same
// three shapes:
//
//   - Same-day  (start <  end): hour ∈ [start, end)
//   - Overnight (start >  end): hour ∈ [start, 24) ∪ [0, end)
//   - Zero-width (start == end): never (treated as "do not send")
//
// Special case: (0, 24) is recognized as "all day, every hour".
func HourInSendWindow(hour, start, end int) bool {
	if start == end {
		return false
	}
	if start < end {
		return hour >= start && hour < end
	}
	// Wrap-around: hour belongs to the window if it sits in the tail
	// before midnight OR in the head after midnight.
	return hour >= start || hour < end
}

type SafetyConfig struct {
	MaxBounceRate          float64 `json:"max_bounce_rate"`
	MaxComplaints24h       int     `json:"max_complaints_24h"`
	CircuitBreakerWindow   string  `json:"circuit_breaker_window"`
	CircuitBreakerCooldown string  `json:"circuit_breaker_cooldown"`
	MinDaysBetweenCampaigns int    `json:"min_days_between_campaigns"`
}

type TrackingConfig struct {
	BaseURL         string `json:"base_url"`
	PixelPath       string `json:"pixel_path"`
	RedirectPath    string `json:"redirect_path"`
	UnsubscribePath string `json:"unsubscribe_path"`
}

type WebConfig struct {
	Port int    `json:"port"`
	Host string `json:"host"`
}

// PersonaConfig holds the sender identity for humanization.
type PersonaConfig struct {
	Name    string `json:"name"`
	Role    string `json:"role"`
	Company string `json:"company"`
	Phone   string `json:"phone"`
	Email   string `json:"email"`
	Website string `json:"website"`
	Region  string `json:"region"`
}

// IsEmpty returns true if no persona fields are set.
func (p PersonaConfig) IsEmpty() bool {
	return p.Name == "" && p.Email == ""
}

// ResolvePersona returns the mailbox-level persona if set, otherwise the global fallback.
func (m MailboxConfig) ResolvePersona(global PersonaConfig) PersonaConfig {
	if !m.Persona.IsEmpty() {
		// Fill in blanks from global
		p := m.Persona
		if p.Company == "" { p.Company = global.Company }
		if p.Website == "" { p.Website = global.Website }
		if p.Region == "" { p.Region = global.Region }
		if p.Email == "" { p.Email = m.Address }
		return p
	}
	if !global.IsEmpty() {
		return global
	}
	// No persona anywhere — build minimal from mailbox address
	return PersonaConfig{Email: m.Address}
}

func Load(path string) (*Config, error) {
	data, err := os.ReadFile(path)
	if err != nil {
		return nil, fmt.Errorf("read config: %w", err)
	}

	// Expand environment variables
	expanded := os.ExpandEnv(string(data))

	var cfg Config
	if err := json.Unmarshal([]byte(expanded), &cfg); err != nil {
		return nil, fmt.Errorf("parse config: %w", err)
	}

	// Defaults
	if cfg.Sending.WindowStart == 0 { cfg.Sending.WindowStart = 8 }
	if cfg.Sending.WindowEnd == 0 { cfg.Sending.WindowEnd = 17 }
	if cfg.Sending.Timezone == "" { cfg.Sending.Timezone = "Europe/Prague" }
	if cfg.Sending.MinDelaySeconds == 0 { cfg.Sending.MinDelaySeconds = 45 }
	if cfg.Sending.MaxDelaySeconds == 0 { cfg.Sending.MaxDelaySeconds = 180 }
	if cfg.Sending.MaxPerDomainHour == 0 { cfg.Sending.MaxPerDomainHour = 5 }
	if cfg.Safety.MaxBounceRate == 0 { cfg.Safety.MaxBounceRate = 0.05 }
	if cfg.Safety.MaxComplaints24h == 0 { cfg.Safety.MaxComplaints24h = 1 }
	if cfg.Web.Port == 0 { cfg.Web.Port = 8080 }
	if cfg.Web.Host == "" { cfg.Web.Host = "0.0.0.0" }

	return &cfg, nil
}

func LoadFromEnv() *Config {
	// Parse MAILBOX_N_* env vars (N = 1, 2, 3, ...)
	var mailboxes []MailboxConfig
	for i := 1; ; i++ {
		prefix := fmt.Sprintf("MAILBOX_%d_", i)
		addr := envconfig.GetOr(prefix+"ADDRESS", "")
		if addr == "" {
			break
		}
		mailboxes = append(mailboxes, MailboxConfig{
			Address:    addr,
			SMTPHost:   envconfig.GetOr(prefix+"SMTP_HOST", "localhost"),
			SMTPPort:   envIntOr(prefix+"SMTP_PORT", 1025),
			Username:   envconfig.GetOr(prefix+"USERNAME", ""),
			Password:   envconfig.GetOr(prefix+"PASSWORD", ""),
			IMAPHost:   envconfig.GetOr(prefix+"IMAP_HOST", "localhost"),
			IMAPPort:   envIntOr(prefix+"IMAP_PORT", 1143),
			DailyLimit: envIntOr(prefix+"DAILY_LIMIT", 100),
			WarmupDay:  envIntOr(prefix+"WARMUP_DAY", 0),
			Persona: PersonaConfig{
				Name:    envconfig.GetOr(prefix+"PERSONA_NAME", ""),
				Role:    envconfig.GetOr(prefix+"PERSONA_ROLE", ""),
				Company: envconfig.GetOr(prefix+"PERSONA_COMPANY", ""),
				Phone:   envconfig.GetOr(prefix+"PERSONA_PHONE", ""),
				Email:   envconfig.GetOr(prefix+"PERSONA_EMAIL", ""),
				Website: envconfig.GetOr(prefix+"PERSONA_WEBSITE", ""),
				Region:  envconfig.GetOr(prefix+"PERSONA_REGION", ""),
			},
		})
	}

	return &Config{
		FirmyDSN:  envconfig.GetOr("FIRMY_DSN", ""),
		Mailboxes: mailboxes,
		Database: DatabaseConfig{
			Host:     envconfig.GetOr("DB_HOST", "localhost"),
			Port:     envIntOr("DB_PORT", 5432),
			Name:     envconfig.GetOr("DB_NAME", "outreach"),
			User:     envconfig.GetOr("DB_USER", "outreach"),
			Password: envconfig.GetOr("DB_PASSWORD", ""),
			SSLMode:  envconfig.GetOr("DB_SSL_MODE", "disable"),
		},
		Sending: SendingConfig{
			WindowStart:              envIntOr("SENDING_WINDOW_START", 8),
			WindowEnd:                envIntOr("SENDING_WINDOW_END", 17),
			Timezone:                 envconfig.GetOr("SENDING_TIMEZONE", "Europe/Prague"),
			MinDelaySeconds:          envIntOr("SENDING_MIN_DELAY_SECONDS", 45),
			MaxDelaySeconds:          envIntOr("SENDING_MAX_DELAY_SECONDS", 180),
			MaxPerDomainHour:         envIntOr("SENDING_MAX_PER_DOMAIN_HOUR", 5),
			TransportMode:            envconfig.GetOr("TRANSPORT_MODE", ""),
			LabOnly:                  envconfig.BoolOr("LAB_ONLY", false),
			Environment:              envconfig.GetOr("ENVIRONMENT", ""),
			AllowTestMarkers:         envconfig.BoolOr("ALLOW_TEST_MARKERS", false),
			SendWindowStartHour:      envIntOr("SEND_WINDOW_START_HOUR", 9),
			SendWindowEndHour:        envIntOr("SEND_WINDOW_END_HOUR", 17),
			WeekdaysOnly:             envconfig.BoolOr("SEND_WEEKDAYS_ONLY", true),
			PoissonMeanSeconds:       envIntOr("POISSON_MEAN_SECONDS", 120),
			PoissonMinSeconds:        envIntOr("POISSON_MIN_SECONDS", 30),
			PoissonMaxSeconds:        envIntOr("POISSON_MAX_SECONDS", 300),
			MailboxMinSpacingSeconds: envIntOr("MAILBOX_MIN_SPACING_SECONDS", 60),
		},
		Safety: SafetyConfig{
			MaxBounceRate:    envFloatOr("SAFETY_MAX_BOUNCE_RATE", 0.05),
			MaxComplaints24h: envIntOr("SAFETY_MAX_COMPLAINTS_24H", 1),
		},
		Tracking: TrackingConfig{
			BaseURL:         envconfig.GetOr("TRACKING_BASE_URL", ""),
			PixelPath:       "/o",
			RedirectPath:    "/c",
			UnsubscribePath: "/unsub",
		},
		Web: WebConfig{Port: 8080, Host: "0.0.0.0"},
		AntiTrace: func() AntiTraceConfig {
			// ANTI_TRACE_URL is the canonical name used by the orchestrator.
			// ANTI_TRACE_RELAY_URL is the legacy alias used by the BFF .env.
			// Accept either; primary takes precedence.
			url := envconfig.GetOr("ANTI_TRACE_URL", "")
			if url == "" {
				url = envconfig.GetOr("ANTI_TRACE_RELAY_URL", "")
			}
			token := envconfig.GetOr("ANTI_TRACE_TOKEN", "")
			if token == "" {
				token = envconfig.GetOr("ANTI_TRACE_RELAY_TOKEN", "")
			}
			return AntiTraceConfig{
				Enabled:  url != "",
				URL:      url,
				Token:    token,
				
			}
		}(),
		Persona: PersonaConfig{
			Name:    envconfig.GetOr("PERSONA_NAME", ""),
			Role:    envconfig.GetOr("PERSONA_ROLE", ""),
			Company: envconfig.GetOr("PERSONA_COMPANY", ""),
			Phone:   envconfig.GetOr("PERSONA_PHONE", ""),
			Email:   envconfig.GetOr("PERSONA_EMAIL", ""),
			Website: envconfig.GetOr("PERSONA_WEBSITE", ""),
			Region:  envconfig.GetOr("PERSONA_REGION", ""),
		},
	}
}

func envIntOr(key string, fallback int) int {
	// envconfig-allowed: local helper for integer parsing; abstracted for reuse
	v := os.Getenv(key)
	if v == "" {
		return fallback
	}
	n, err := strconv.Atoi(v)
	if err != nil {
		return fallback
	}
	return n
}

func envFloatOr(key string, fallback float64) float64 {
	// envconfig-allowed: local helper for float parsing; abstracted for reuse
	v := os.Getenv(key)
	if v == "" {
		return fallback
	}
	f, err := strconv.ParseFloat(v, 64)
	if err != nil {
		return fallback
	}
	return f
}

// Validate checks that the config is safe to use in production.
// Returns an error if credentials are configured without TLS-capable ports
// or if airtight invariants (ADR-005) are violated.
func (c *Config) Validate() error {
	// Airtight (ADR-005) — TRANSPORT_MODE / LAB_ONLY gate. Runs before
	// the per-mailbox port checks because LAB_ONLY=1 with the wrong
	// mode should fail loudly even when credentials are absent (lab dev
	// boots without prod credentials).
	if err := c.Sending.ValidateAirtight(); err != nil {
		return err
	}
	if envconfig.BoolOr("DEV_MODE", false) {
		// D0.8 kill-switch: dev engine must not accidentally hit production
		// SMTP/IMAP infrastructure. Refuse anything that isn't a sandbox host
		// (localhost / RFC 6761 test TLDs) or an unauthenticated mailbox.
		for i, mb := range c.Mailboxes {
			if !isDevSafeMailbox(mb) {
				return fmt.Errorf(
					"mailbox %d (%s): DEV_MODE=1 refuses non-sandbox targets (host=%q smtp=%q imap=%q). "+
						"Use mailpit/greenmail on localhost or a .test/.example host, or unset DEV_MODE.",
					i+1, mb.Address, hostOf(mb.Address), mb.SMTPHost, mb.IMAPHost)
			}
		}
		return nil
	}
	hasAuthMailbox := false
	for i, mb := range c.Mailboxes {
		if mb.Username == "" && mb.Password == "" {
			continue // local dev — no credentials, no TLS required
		}
		hasAuthMailbox = true
		if mb.SMTPPort != 465 && mb.SMTPPort != 587 {
			return fmt.Errorf("mailbox %d (%s): authenticated SMTP requires port 465 or 587, got %d", i+1, mb.Address, mb.SMTPPort)
		}
		if mb.IMAPPort != 993 {
			return fmt.Errorf("mailbox %d (%s): authenticated IMAP requires port 993, got %d", i+1, mb.Address, mb.IMAPPort)
		}
	}

	// Tracking URL must be a valid HTTPS URL in production. Tracking pixels
	// and click redirects are rendered into every outbound, so a misconfigured
	// or http:// value silently breaks engagement tracking and, worse, leaks
	// opens over plaintext. Gated by hasAuthMailbox — purely unauthenticated
	// configs are local dev (mailpit/greenmail) where tracking URL is optional.
	if hasAuthMailbox {
		if err := validateTrackingBaseURL(c.Tracking.BaseURL); err != nil {
			return err
		}
	}

	return nil
}

// validateTrackingBaseURL enforces production-grade constraints on the public
// tracking URL: present, absolute HTTPS, host set, no credentials inline.
func validateTrackingBaseURL(raw string) error {
	raw = strings.TrimSpace(raw)
	if raw == "" {
		return fmt.Errorf("TRACKING_BASE_URL is required in production (set to the public HTTPS URL of the tracking server, e.g. https://track.example.com)")
	}
	u, err := url.Parse(raw)
	if err != nil {
		return fmt.Errorf("TRACKING_BASE_URL %q is not a valid URL: %w", raw, err)
	}
	if u.Scheme != "https" {
		return fmt.Errorf("TRACKING_BASE_URL %q must use https:// (got scheme %q)", raw, u.Scheme)
	}
	if u.Host == "" {
		return fmt.Errorf("TRACKING_BASE_URL %q has no host", raw)
	}
	if u.User != nil {
		return fmt.Errorf("TRACKING_BASE_URL must not contain userinfo credentials")
	}
	return nil
}

// DomainFromEmail extracts domain from email address.
func DomainFromEmail(email string) string {
	parts := strings.SplitN(email, "@", 2)
	if len(parts) != 2 { return "" }
	return strings.ToLower(parts[1])
}

// hostOf returns the domain portion of an email address, lower-cased. Empty
// when the address has no '@'.
func hostOf(email string) string {
	return DomainFromEmail(email)
}

// isSandboxHost reports whether hostname refers to a local loopback or an
// RFC 6761 reserved test TLD (.test, .example, .invalid, .localhost).
// Matches common docker-compose service names too (mailpit, greenmail,
// smtp4dev) so the dev engine runs against the usual fixtures.
func isSandboxHost(hostname string) bool {
	h := strings.ToLower(strings.TrimSpace(hostname))
	if h == "" {
		return true // unconfigured host → treated as sandbox; the auth check still fires
	}
	switch h {
	case "localhost", "127.0.0.1", "::1",
		"mailpit", "greenmail", "smtp4dev", "maildev", "inbucket":
		return true
	}
	// RFC 6761 reserved TLDs
	for _, tld := range []string{".test", ".example", ".invalid", ".localhost"} {
		if strings.HasSuffix(h, tld) {
			return true
		}
	}
	// Allow *.example.com / *.example.org / *.example.net — these are
	// reserved for documentation and cannot host a real MX.
	for _, suffix := range []string{".example.com", ".example.org", ".example.net",
		"example.com", "example.org", "example.net"} {
		if h == suffix || strings.HasSuffix(h, "."+suffix) {
			return true
		}
	}
	return false
}

// isDevSafeMailbox reports whether a mailbox can be used under DEV_MODE=1
// without risking outbound mail to production infrastructure. A mailbox is
// considered dev-safe when its From-address host and both SMTP/IMAP hosts
// are sandbox hosts. An authenticated mailbox with production credentials
// is always rejected — even a correct sandbox host pair cannot excuse the
// presence of a real password in the dev engine.
func isDevSafeMailbox(mb MailboxConfig) bool {
	if mb.Password != "" {
		// Production creds have no business in DEV_MODE=1. Unset DEV_MODE
		// if the intent is to test a real mailbox.
		return false
	}
	if !isSandboxHost(hostOf(mb.Address)) {
		return false
	}
	if !isSandboxHost(mb.SMTPHost) {
		return false
	}
	if !isSandboxHost(mb.IMAPHost) {
		return false
	}
	return true
}
