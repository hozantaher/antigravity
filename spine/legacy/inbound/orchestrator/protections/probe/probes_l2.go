package probe

import (
	"context"
	"database/sql"
	"errors"
	"fmt"
	"io"
	"net/http"
	"time"
)

// --------------------------------------------------------------------
// L2 probe: anti_trace — GET {url}/healthz should return 200
// --------------------------------------------------------------------

type AntiTraceL2 struct {
	BaseURL  string
	HTTP     *http.Client
	Cadence  time.Duration
	layer    string
}

func NewAntiTraceL2(baseURL string, cadence time.Duration) *AntiTraceL2 {
	return &AntiTraceL2{BaseURL: baseURL, Cadence: cadence, layer: "anti_trace"}
}

func (p *AntiTraceL2) Layer() string           { return p.layer }
func (p *AntiTraceL2) Level() Level             { return LevelAlive }
func (p *AntiTraceL2) Interval() time.Duration {
	if p.Cadence <= 0 {
		return 30 * time.Second
	}
	return p.Cadence
}

func (p *AntiTraceL2) Run(ctx context.Context) Result {
	if p.BaseURL == "" {
		return Result{Status: StatusSkip, Detail: "anti_trace base url not configured"}
	}
	client := p.HTTP
	if client == nil {
		client = &http.Client{Timeout: 5 * time.Second}
	}
	req, err := http.NewRequestWithContext(ctx, "GET", p.BaseURL+"/healthz", nil)
	if err != nil {
		return Result{Status: StatusErr, Detail: err.Error()}
	}
	start := time.Now()
	resp, err := client.Do(req)
	if err != nil {
		return Result{Status: StatusErr, Detail: err.Error(), Latency: time.Since(start)}
	}
	defer resp.Body.Close()
	_, _ = io.Copy(io.Discard, resp.Body)
	if resp.StatusCode != 200 {
		return Result{
			Status:  StatusErr,
			Detail:  fmt.Sprintf("healthz status=%d", resp.StatusCode),
			Latency: time.Since(start),
		}
	}
	return Result{
		Status:   StatusOK,
		Latency:  time.Since(start),
		Expected: map[string]any{"http_status": 200},
		Actual:   map[string]any{"http_status": 200},
	}
}

// --------------------------------------------------------------------
// L2 probe: proxy_pool — BFF /api/proxy-pool working > 0
// --------------------------------------------------------------------

type ProxyPoolL2 struct {
	BFFURL  string
	APIKey  string
	HTTP    *http.Client
	Cadence time.Duration
}

func NewProxyPoolL2(bffURL, apiKey string, cadence time.Duration) *ProxyPoolL2 {
	return &ProxyPoolL2{BFFURL: bffURL, APIKey: apiKey, Cadence: cadence}
}

func (p *ProxyPoolL2) Layer() string { return "proxy_pool" }
func (p *ProxyPoolL2) Level() Level   { return LevelAlive }
func (p *ProxyPoolL2) Interval() time.Duration {
	if p.Cadence <= 0 {
		return 30 * time.Second
	}
	return p.Cadence
}

func (p *ProxyPoolL2) Run(ctx context.Context) Result {
	if p.BFFURL == "" {
		return Result{Status: StatusSkip, Detail: "BFF url not configured"}
	}
	client := p.HTTP
	if client == nil {
		client = &http.Client{Timeout: 8 * time.Second}
	}
	req, err := http.NewRequestWithContext(ctx, "GET", p.BFFURL+"/api/proxy-pool?full=1", nil)
	if err != nil {
		return Result{Status: StatusErr, Detail: err.Error()}
	}
	if p.APIKey != "" {
		req.Header.Set("X-API-Key", p.APIKey)
	}
	start := time.Now()
	resp, err := client.Do(req)
	if err != nil {
		return Result{Status: StatusErr, Detail: err.Error(), Latency: time.Since(start)}
	}
	defer resp.Body.Close()
	body, _ := io.ReadAll(resp.Body)
	if resp.StatusCode != 200 {
		return Result{
			Status:  StatusErr,
			Detail:  fmt.Sprintf("proxy-pool status=%d", resp.StatusCode),
			Latency: time.Since(start),
		}
	}
	working := countWorkingProxies(body)
	status := StatusOK
	if working == 0 {
		status = StatusErr
	} else if working < 3 {
		status = StatusWarn
	}
	return Result{
		Status:   status,
		Detail:   fmt.Sprintf("working=%d", working),
		Latency:  time.Since(start),
		Expected: map[string]any{"working_min": 3},
		Actual:   map[string]any{"working": working},
	}
}

// --------------------------------------------------------------------
// L2 probe: watchdog — watchdog_events recent heartbeat < 15 min
// --------------------------------------------------------------------

type WatchdogL2 struct {
	DB      *sql.DB
	Cadence time.Duration
	MaxAge  time.Duration // default 15m
}

func NewWatchdogL2(db *sql.DB, cadence, maxAge time.Duration) *WatchdogL2 {
	return &WatchdogL2{DB: db, Cadence: cadence, MaxAge: maxAge}
}

func (p *WatchdogL2) Layer() string { return "watchdog" }
func (p *WatchdogL2) Level() Level   { return LevelAlive }
func (p *WatchdogL2) Interval() time.Duration {
	if p.Cadence <= 0 {
		return 60 * time.Second
	}
	return p.Cadence
}

func (p *WatchdogL2) Run(ctx context.Context) Result {
	if p.DB == nil {
		return Result{Status: StatusSkip, Detail: "no db"}
	}
	maxAge := p.MaxAge
	if maxAge <= 0 {
		maxAge = 15 * time.Minute
	}
	var lastAt sql.NullTime
	err := p.DB.QueryRowContext(ctx, `SELECT MAX(created_at) FROM watchdog_events`).Scan(&lastAt)
	if err != nil {
		return Result{Status: StatusErr, Detail: err.Error()}
	}
	if !lastAt.Valid {
		return Result{
			Status:   StatusWarn,
			Detail:   "no watchdog events recorded yet",
			Expected: map[string]any{"age_max_sec": int(maxAge.Seconds())},
			Actual:   map[string]any{"age_sec": nil},
		}
	}
	age := time.Since(lastAt.Time)
	status := StatusOK
	if age > maxAge {
		status = StatusErr
	} else if age > maxAge/2 {
		status = StatusWarn
	}
	return Result{
		Status:   status,
		Detail:   fmt.Sprintf("last_event_age=%s", age.Round(time.Second)),
		Expected: map[string]any{"age_max_sec": int(maxAge.Seconds())},
		Actual:   map[string]any{"age_sec": int(age.Seconds())},
	}
}

// --------------------------------------------------------------------
// L2 probe: db_pool — SELECT 1
// --------------------------------------------------------------------

type DBPoolL2 struct {
	DB      *sql.DB
	Cadence time.Duration
}

func NewDBPoolL2(db *sql.DB, cadence time.Duration) *DBPoolL2 {
	return &DBPoolL2{DB: db, Cadence: cadence}
}

func (p *DBPoolL2) Layer() string { return "db_pool" }
func (p *DBPoolL2) Level() Level   { return LevelAlive }
func (p *DBPoolL2) Interval() time.Duration {
	if p.Cadence <= 0 {
		return 30 * time.Second
	}
	return p.Cadence
}

func (p *DBPoolL2) Run(ctx context.Context) Result {
	if p.DB == nil {
		return Result{Status: StatusSkip, Detail: "no db"}
	}
	var one int
	err := p.DB.QueryRowContext(ctx, `SELECT 1`).Scan(&one)
	if err != nil {
		return Result{Status: StatusErr, Detail: err.Error()}
	}
	stats := p.DB.Stats()
	return Result{
		Status:   StatusOK,
		Detail:   fmt.Sprintf("open=%d in_use=%d", stats.OpenConnections, stats.InUse),
		Expected: map[string]any{"select_1": 1},
		Actual: map[string]any{
			"select_1":          one,
			"open_connections":  stats.OpenConnections,
			"in_use":            stats.InUse,
			"idle":              stats.Idle,
			"wait_count":        stats.WaitCount,
			"max_open":          stats.MaxOpenConnections,
		},
	}
}

// --------------------------------------------------------------------
// L2 probe: sender_engine — recent outreach_emails activity
// --------------------------------------------------------------------

type SenderEngineL2 struct {
	DB      *sql.DB
	Cadence time.Duration
	MaxAge  time.Duration // default 30m — during quiet hours no sends happen
}

func NewSenderEngineL2(db *sql.DB, cadence, maxAge time.Duration) *SenderEngineL2 {
	return &SenderEngineL2{DB: db, Cadence: cadence, MaxAge: maxAge}
}

func (p *SenderEngineL2) Layer() string { return "sender_engine" }
func (p *SenderEngineL2) Level() Level   { return LevelAlive }
func (p *SenderEngineL2) Interval() time.Duration {
	if p.Cadence <= 0 {
		return 60 * time.Second
	}
	return p.Cadence
}

func (p *SenderEngineL2) Run(ctx context.Context) Result {
	if p.DB == nil {
		return Result{Status: StatusSkip, Detail: "no db"}
	}
	maxAge := p.MaxAge
	if maxAge <= 0 {
		maxAge = 30 * time.Minute
	}
	// Heartbeat key lives in outreach_config (sender engine updates it on every
	// send loop iteration regardless of whether a send happened).
	var at sql.NullTime
	err := p.DB.QueryRowContext(ctx, `
		SELECT updated_at
		FROM outreach_config
		WHERE key = 'sender_heartbeat_at'
	`).Scan(&at)
	if errors.Is(err, sql.ErrNoRows) {
		return Result{
			Status: StatusWarn,
			Detail: "no sender heartbeat recorded yet",
		}
	}
	if err != nil {
		return Result{Status: StatusErr, Detail: err.Error()}
	}
	if !at.Valid {
		return Result{Status: StatusWarn, Detail: "heartbeat row has null timestamp"}
	}
	age := time.Since(at.Time)
	status := StatusOK
	if age > maxAge {
		status = StatusErr
	} else if age > maxAge/2 {
		status = StatusWarn
	}
	return Result{
		Status:   status,
		Detail:   fmt.Sprintf("last_heartbeat_age=%s", age.Round(time.Second)),
		Expected: map[string]any{"age_max_sec": int(maxAge.Seconds())},
		Actual:   map[string]any{"age_sec": int(age.Seconds())},
	}
}
