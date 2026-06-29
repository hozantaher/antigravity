package watchdog

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"log/slog"
	"net/http"
	"sort"
	"sync"
	"sync/atomic"
	"time"

	"mailboxes/mailbox"
)

// ProxyCandidate is one entry from the BFF /api/proxy-pool response.
type ProxyCandidate struct {
	Addr          string `json:"addr"`
	Country       string `json:"country"`
	Source        string `json:"source"`
	ProbeMs       int    `json:"probe_ms"`
	LastLatencyMs *int   `json:"last_latency_ms,omitempty"`
}

// ProxyPoolResponse matches the BFF contract.
type ProxyPoolResponse struct {
	Working     []ProxyCandidate `json:"working"`
	CzWorking   int              `json:"cz_working"`
	CachedAt    string           `json:"cached_at"`
	LastProbeAt string           `json:"last_probe_at"`
}

// ProxyPoolClient fetches the live proxy pool from the dashboard BFF.
// A nil client makes proxy swap a no-op — useful for tests.
type ProxyPoolClient struct {
	BaseURL string
	HTTP    *http.Client
}

// Fetch calls GET {BaseURL}/api/proxy-pool?full=1 and returns the parsed pool.
func (c *ProxyPoolClient) Fetch(ctx context.Context) (*ProxyPoolResponse, error) {
	if c == nil || c.BaseURL == "" {
		return nil, fmt.Errorf("watchdog: proxy-pool client not configured")
	}
	httpc := c.HTTP
	if httpc == nil {
		httpc = &http.Client{Timeout: 10 * time.Second}
	}
	req, err := http.NewRequestWithContext(ctx, "GET", c.BaseURL+"/api/proxy-pool?full=1", nil)
	if err != nil {
		return nil, fmt.Errorf("watchdog: proxy-pool request: %w", err)
	}
	resp, err := httpc.Do(req)
	if err != nil {
		return nil, fmt.Errorf("watchdog: proxy-pool fetch: %w", err)
	}
	defer resp.Body.Close()
	body, err := io.ReadAll(resp.Body)
	if err != nil {
		return nil, fmt.Errorf("watchdog: proxy-pool read: %w", err)
	}
	if resp.StatusCode != 200 {
		return nil, fmt.Errorf("watchdog: proxy-pool status %d: %s", resp.StatusCode, string(body))
	}
	var out ProxyPoolResponse
	if err := json.Unmarshal(body, &out); err != nil {
		return nil, fmt.Errorf("watchdog: proxy-pool parse: %w", err)
	}
	return &out, nil
}

// EventSink is the narrow interface the daemon uses to persist audit events.
type EventSink interface {
	Record(ctx context.Context, e Event) error
}

// AuthFailReader is the narrow interface the daemon uses to read/clear auth fails.
type AuthFailReader interface {
	CountRecent(ctx context.Context, mailboxID int64, window time.Duration) (int, error)
	ResolveAll(ctx context.Context, mailboxID int64) error
}

// AuthFailLister is an optional extension: when the underlying reader can
// return per-event timestamps the daemon uses them for the SEND-S6.3 alert
// primitive. Readers that only implement AuthFailReader skip the alert path.
type AuthFailLister interface {
	ListRecent(ctx context.Context, mailboxID int64, window time.Duration) ([]AuthFailEvent, error)
}

// ProxyFetcher is the narrow interface the daemon uses to retrieve a proxy pool.
type ProxyFetcher interface {
	Fetch(ctx context.Context) (*ProxyPoolResponse, error)
}

// DaemonConfig wires the watchdog dependencies.
type DaemonConfig struct {
	Store        mailbox.Store // read+write mailbox rows
	Events       EventSink
	AuthFails    AuthFailReader
	ProxyPool    ProxyFetcher         // nil = proxy swaps disabled
	Circuit      CircuitBreakerStore  // nil = circuit breaker disabled
	CircuitCfg   CircuitBreakerConfig // zero-value → defaults
	Interval     time.Duration        // default 5min
	BounceDecay  time.Duration        // no-bounce window that triggers decay; default 24h
	AuthWindow   time.Duration        // auth-fail counting window; default 1h
	AuthThresh   int                  // fails/window that triggers proxy swap; default 3
	AllowedProxy func(m mailbox.Mailbox, c ProxyCandidate) bool

	// AlertWebhookURL, when non-empty, receives a POST JSON payload
	// whenever the SEND-S6.3 auth-fail-alert primitive fires for a mailbox.
	// Slack/Discord-compatible envelope: {"text": "..."} plus structured
	// fields. Errors (non-2xx, timeout, network) are logged and swallowed
	// so the alert path never blocks a watchdog tick.
	AlertWebhookURL string
	// AlertWebhookClient is an optional injection point for tests. When
	// nil a default *http.Client with a 2s timeout is used.
	AlertWebhookClient *http.Client
}

// Daemon runs a periodic self-heal loop. One instance per deployment.
type Daemon struct {
	cfg         DaemonConfig
	lastRunAt   atomic.Int64 // unix seconds; 0 = never
	lastSwapCnt atomic.Int64

	// alertMu guards lastAuthAlertAt. Simple map is fine because ticks are
	// strictly serial within a single Daemon instance; the mutex only
	// protects against concurrent manual Tick invocations (e.g. from a
	// "Recover now" dashboard button firing during a scheduled tick).
	alertMu         sync.Mutex
	lastAuthAlertAt map[int64]time.Time
}

// NewDaemon applies defaults and returns a ready daemon.
func NewDaemon(cfg DaemonConfig) *Daemon {
	if cfg.Interval <= 0 {
		cfg.Interval = 5 * time.Minute
	}
	if cfg.BounceDecay <= 0 {
		cfg.BounceDecay = 24 * time.Hour
	}
	if cfg.AuthWindow <= 0 {
		cfg.AuthWindow = 1 * time.Hour
	}
	if cfg.AuthThresh <= 0 {
		cfg.AuthThresh = 3
	}
	return &Daemon{cfg: cfg, lastAuthAlertAt: make(map[int64]time.Time)}
}

// LastRunAt returns when the daemon last completed a cycle (zero = never).
func (d *Daemon) LastRunAt() time.Time {
	u := d.lastRunAt.Load()
	if u == 0 {
		return time.Time{}
	}
	return time.Unix(u, 0)
}

// Run blocks until ctx is cancelled, executing Tick on the configured cadence.
// First tick runs immediately.
func (d *Daemon) Run(ctx context.Context) {
	t := time.NewTicker(d.cfg.Interval)
	defer t.Stop()
	slog.Info("watchdog daemon started", "op", "watchdog.Run/start", "interval", d.cfg.Interval)
	if err := d.Tick(ctx); err != nil {
		slog.Warn("watchdog initial tick failed", "op", "watchdog.Run/initTick", "error", err)
	}
	for {
		select {
		case <-ctx.Done():
			slog.Info("watchdog daemon stopped", "op", "watchdog.Run/stop")
			return
		case <-t.C:
			if err := d.Tick(ctx); err != nil {
				slog.Warn("watchdog tick failed", "op", "watchdog.Run/tick", "error", err)
			}
		}
	}
}

// TickResult summarises one cycle.
type TickResult struct {
	MailboxesChecked int
	ProxySwaps       int
	BounceDecays     int
	AuthSpikes       int
	AuthAlerts       int
	CircuitTrips     int
	CircuitCloses    int
	Duration         time.Duration
}

// Tick runs one cycle of the watchdog. Safe to call manually (e.g. from a
// "Recover now" dashboard button) independently of the scheduled ticker.
func (d *Daemon) Tick(ctx context.Context) error {
	start := time.Now()
	res := TickResult{}
	defer func() {
		res.Duration = time.Since(start)
		d.lastRunAt.Store(time.Now().Unix())
		slog.Info("watchdog tick",
			"checked", res.MailboxesChecked,
			"proxy_swaps", res.ProxySwaps,
			"bounce_decays", res.BounceDecays,
			"auth_spikes", res.AuthSpikes,
			"auth_alerts", res.AuthAlerts,
			"circuit_trips", res.CircuitTrips,
			"circuit_closes", res.CircuitCloses,
			"duration", res.Duration.Round(time.Millisecond))
	}()

	if d.cfg.Store == nil {
		return fmt.Errorf("watchdog: no store configured")
	}

	// Include paused mailboxes so circuit-breaker auto-close has a chance to
	// resume them. The rest of the tick loop skips non-active mailboxes.
	active, err := d.cfg.Store.List(ctx, mailbox.Filter{
		Status: []mailbox.Status{mailbox.StatusActive, mailbox.StatusPaused},
		Limit:  500,
	})
	if err != nil {
		return fmt.Errorf("watchdog: list mailboxes: %w", err)
	}
	res.MailboxesChecked = len(active)

	// Fetch proxy pool once per cycle (if enabled). Failure = skip swaps,
	// keep doing bounce decay and auth-fail tracking (fail-open).
	var pool *ProxyPoolResponse
	if d.cfg.ProxyPool != nil {
		if p, err := d.cfg.ProxyPool.Fetch(ctx); err != nil {
			slog.Warn("watchdog: proxy pool unavailable", "op", "watchdog.Tick/fetchPool", "error", err)
		} else {
			pool = p
		}
	}

	for _, m := range active {
		// Auth-fail count is used by both the circuit breaker (short window)
		// and the proxy-swap path (longer window). Fetch once per mailbox.
		var circuitFails int
		if d.cfg.AuthFails != nil && d.cfg.Circuit != nil {
			window := d.cfg.CircuitCfg.withDefaults().Window
			if n, err := d.cfg.AuthFails.CountRecent(ctx, m.ID, window); err == nil {
				circuitFails = n
			}
		}
		if tripped, closed := d.runCircuitBreaker(ctx, m, circuitFails); tripped {
			res.CircuitTrips++
			// Even after a trip we still want to surface the alert so a
			// human sees the paused mailbox; evaluate before continue.
			if d.evaluateAuthFailAlert(ctx, m) {
				res.AuthAlerts++
			}
			continue // mailbox is now paused; don't do further work this tick
		} else if closed {
			res.CircuitCloses++
		}

		// SEND-S6.3: fire alert when a mailbox accumulates the alert
		// threshold in the short window. Independent of the proxy-swap
		// path (longer window) and circuit breaker (higher threshold).
		if d.evaluateAuthFailAlert(ctx, m) {
			res.AuthAlerts++
		}

		// Everything below this point is active-only work.
		if m.Status != mailbox.StatusActive {
			continue
		}

		// Bounce decay: 1h+ cycles of no new bounce → decrement counter.
		if m.ConsecutiveBounces > 0 && !recentlyBounced(m, d.cfg.BounceDecay) {
			if err := d.decayBounce(ctx, m); err != nil {
				slog.Warn("watchdog: bounce decay failed", "op", "watchdog.Tick/decayBounce", "address", m.FromAddress, "error", err)
			} else {
				res.BounceDecays++
			}
		}

		// Auth fail spike → proxy swap.
		if d.cfg.AuthFails == nil {
			continue
		}
		n, err := d.cfg.AuthFails.CountRecent(ctx, m.ID, d.cfg.AuthWindow)
		if err != nil {
			slog.Warn("watchdog: count auth fails", "op", "watchdog.Tick/countAuthFails", "address", m.FromAddress, "error", err)
			continue
		}
		if n < d.cfg.AuthThresh {
			continue
		}
		res.AuthSpikes++
		if pool == nil {
			// Record spike even if we can't swap, so UI shows the problem.
			_ = d.cfg.Events.Record(ctx, Event{
				MailboxID: &m.ID, Type: EventAuthFailSpike, AutoHealed: false,
				Reason:   fmt.Sprintf("%d auth fails in %s; proxy pool unavailable", n, d.cfg.AuthWindow),
				Metadata: map[string]any{"count": n, "window_sec": int(d.cfg.AuthWindow.Seconds())},
			})
			continue
		}
		if err := d.swapProxy(ctx, m, pool, n); err != nil {
			slog.Warn("watchdog: proxy swap failed", "op", "watchdog.Tick/swapProxy", "address", m.FromAddress, "error", err)
			continue
		}
		res.ProxySwaps++
		d.lastSwapCnt.Add(1)
	}

	return nil
}

func (d *Daemon) decayBounce(ctx context.Context, m mailbox.Mailbox) error {
	// Store exposes ResetBounce (zero) but not arbitrary-value set, so decay
	// semantics are "quiet for BounceDecay → full clean". Simple, auditable.
	if err := d.cfg.Store.ResetBounce(ctx, m.ID); err != nil {
		return fmt.Errorf("reset bounce: %w", err)
	}
	return d.cfg.Events.Record(ctx, Event{
		MailboxID: &m.ID, Type: EventBounceDecay, AutoHealed: true,
		Reason: fmt.Sprintf("no bounce in %s", d.cfg.BounceDecay),
		Metadata: map[string]any{
			"from": m.ConsecutiveBounces,
			"to":   0,
		},
	})
}

func (d *Daemon) swapProxy(ctx context.Context, m mailbox.Mailbox, pool *ProxyPoolResponse, fails int) error {
	candidate, ok := pickProxy(m, pool.Working, d.cfg.AllowedProxy)
	if !ok {
		return fmt.Errorf("no eligible proxy candidate (pool=%d)", len(pool.Working))
	}
	newURL := "socks5://" + candidate.Addr
	if newURL == m.ProxyURL {
		return fmt.Errorf("proxy pool top candidate equals current (no swap)")
	}
	// Capture the pre-swap URL before overwriting so the audit event records
	// the real from→to transition (not from==to).
	oldURL := m.ProxyURL
	m.ProxyURL = newURL
	if _, err := d.cfg.Store.Update(ctx, m.ID, m); err != nil {
		return fmt.Errorf("store update proxy: %w", err)
	}
	// Clear the auth-fail queue so we don't swap again next tick from stale counts.
	if err := d.cfg.AuthFails.ResolveAll(ctx, m.ID); err != nil {
		slog.Warn("watchdog: resolve auth fails after swap", "op", "watchdog.swapProxy/clearAuthFails", "address", m.FromAddress, "error", err)
	}
	return d.cfg.Events.Record(ctx, Event{
		MailboxID: &m.ID, Type: EventProxySwap, AutoHealed: true,
		Reason: fmt.Sprintf("%d auth fails in %s", fails, d.cfg.AuthWindow),
		Metadata: map[string]any{
			"from_proxy":   oldURL,
			"to_proxy":     newURL,
			"country":      candidate.Country,
			"source":       candidate.Source,
			"probe_ms":     candidate.ProbeMs,
			"auth_fails":   fails,
			"pool_size":    len(pool.Working),
			"cz_available": pool.CzWorking,
		},
	})
}

func recentlyBounced(m mailbox.Mailbox, window time.Duration) bool {
	// Without a dedicated last_bounce_at column we use updated_at as a proxy —
	// the bounce path writes to consecutive_bounces which bumps updated_at.
	// This is conservative: a manual status change also looks "recent", so
	// we skip decay. False negatives (missed decay) are preferable to
	// false positives (resetting counter after a fresh bounce).
	return time.Since(m.UpdatedAt) < window
}

// evaluateAuthFailAlert queries the short-window auth-fail events for one
// mailbox, evaluates the SEND-S6.3 alert primitive with per-mailbox cooldown
// state, and (on trigger) emits slog.Warn + a watchdog event + an optional
// webhook POST. Returns true iff the alert fired.
//
// The path is best-effort: any error from the lister, event sink, or webhook
// is logged and does not propagate. The function never panics.
func (d *Daemon) evaluateAuthFailAlert(ctx context.Context, m mailbox.Mailbox) (fired bool) {
	lister, ok := d.cfg.AuthFails.(AuthFailLister)
	if !ok || lister == nil {
		return false
	}
	events, err := lister.ListRecent(ctx, m.ID, AuthFailAlertWindow)
	if err != nil {
		slog.Warn("watchdog: list auth fails for alert", "op", "watchdog.evaluateAuthFailAlert/list", "id", m.ID, "error", err)
		return false
	}
	now := time.Now()

	// Single critical section covers both the cooldown read AND the claim:
	// without it, two concurrent Ticks (scheduled + manual "Recover Now")
	// both observe lastPtr=nil, both call ShouldAlertOnAuthFail()=true, and
	// both emit — double-page. Evaluating the primitive inside the lock is
	// cheap (pure function, small events slice) and correctness wins.
	d.alertMu.Lock()
	var lastPtr *time.Time
	if t, found := d.lastAuthAlertAt[m.ID]; found {
		tt := t
		lastPtr = &tt
	}
	if !ShouldAlertOnAuthFail(events, now, lastPtr) {
		d.alertMu.Unlock()
		return false
	}
	d.lastAuthAlertAt[m.ID] = now
	d.alertMu.Unlock()

	failCount := len(events)
	slog.Warn("mailbox_auth_fail_alert",
		"op", "watchdog.evaluateAuthFailAlert/alert",
		"mailbox_id", m.ID,
		"from_address", m.FromAddress,
		"fail_count", failCount,
		"window_min", int(AuthFailAlertWindow/time.Minute),
	)
	if d.cfg.Events != nil {
		mid := m.ID
		_ = d.cfg.Events.Record(ctx, Event{
			MailboxID:  &mid,
			Type:       EventAuthFailAlert,
			AutoHealed: false,
			Reason:     fmt.Sprintf("%d auth fails in %s", failCount, AuthFailAlertWindow),
			Metadata: map[string]any{
				"fail_count":   failCount,
				"window_min":   int(AuthFailAlertWindow / time.Minute),
				"threshold":    AuthFailAlertThreshold,
				"from_address": m.FromAddress,
				"cooldown_min": int(AuthFailAlertCooldown / time.Minute),
			},
		})
	}
	d.postAlertWebhook(ctx, m, failCount)
	return true
}

// postAlertWebhook fires a non-blocking POST to the configured webhook URL.
// Slack/Discord-compatible JSON envelope. All errors are logged and
// swallowed — the watchdog tick must never block on an external dependency.
func (d *Daemon) postAlertWebhook(ctx context.Context, m mailbox.Mailbox, failCount int) {
	if d.cfg.AlertWebhookURL == "" {
		return
	}
	client := d.cfg.AlertWebhookClient
	if client == nil {
		client = &http.Client{Timeout: 2 * time.Second}
	} else if client.Timeout == 0 {
		// Callers injecting a client for tests may omit timeout. Enforce
		// a hard ceiling to honour the "never block the tick" contract.
		c := *client
		c.Timeout = 2 * time.Second
		client = &c
	}
	payload := map[string]any{
		"text": fmt.Sprintf("outreach watchdog: mailbox %s had %d SMTP AUTH fails in %s",
			m.FromAddress, failCount, AuthFailAlertWindow),
		"mailbox_id":   m.ID,
		"from_address": m.FromAddress,
		"fail_count":   failCount,
		"window_min":   int(AuthFailAlertWindow / time.Minute),
		"event_type":   string(EventAuthFailAlert),
	}
	body, err := json.Marshal(payload)
	if err != nil {
		slog.Warn("watchdog: marshal alert webhook payload", "op", "watchdog.postAlertWebhook/marshal", "id", m.ID, "error", err)
		return
	}
	// Bound the outbound request to 2s regardless of the caller's ctx.
	reqCtx, cancel := context.WithTimeout(ctx, 2*time.Second)
	defer cancel()
	req, err := http.NewRequestWithContext(reqCtx, "POST", d.cfg.AlertWebhookURL, bytes.NewReader(body))
	if err != nil {
		slog.Warn("watchdog: build alert webhook request", "op", "watchdog.postAlertWebhook/buildRequest", "id", m.ID, "error", err)
		return
	}
	req.Header.Set("Content-Type", "application/json")
	resp, err := client.Do(req)
	if err != nil {
		slog.Warn("watchdog: alert webhook POST failed", "op", "watchdog.postAlertWebhook/post", "id", m.ID, "error", err)
		return
	}
	defer resp.Body.Close()
	if resp.StatusCode >= 500 {
		b, _ := io.ReadAll(io.LimitReader(resp.Body, 1024))
		slog.Warn("watchdog: alert webhook 5xx", "op", "watchdog.postAlertWebhook/5xx", "id", m.ID, "status", resp.StatusCode, "body", string(b))
		return
	}
	if resp.StatusCode >= 400 {
		slog.Warn("watchdog: alert webhook 4xx", "op", "watchdog.postAlertWebhook/4xx", "id", m.ID, "status", resp.StatusCode)
		return
	}
}

func pickProxy(m mailbox.Mailbox, candidates []ProxyCandidate, allowed func(mailbox.Mailbox, ProxyCandidate) bool) (ProxyCandidate, bool) {
	if len(candidates) == 0 {
		return ProxyCandidate{}, false
	}
	filtered := make([]ProxyCandidate, 0, len(candidates))
	for _, c := range candidates {
		if "socks5://"+c.Addr == m.ProxyURL {
			continue // never swap to the same proxy
		}
		if allowed != nil && !allowed(m, c) {
			continue
		}
		filtered = append(filtered, c)
	}
	if len(filtered) == 0 {
		return ProxyCandidate{}, false
	}
	sort.SliceStable(filtered, func(i, j int) bool {
		return filtered[i].ProbeMs < filtered[j].ProbeMs
	})
	return filtered[0], true
}
