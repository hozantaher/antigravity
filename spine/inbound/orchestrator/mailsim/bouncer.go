package mailsim

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"log/slog"
	"net/http"
	"net/smtp"
	"strings"
	"sync"
	"time"
)

// BouncerConfig wires the bouncer to Mailpit (outbound catch-all) and
// GreenMail (inbound IMAP where production `poll` reads from).
type BouncerConfig struct {
	// MailpitBaseURL is the HTTP endpoint of Mailpit — typically
	// "http://localhost:8025" in docker-compose dev.
	MailpitBaseURL string

	// GreenMailSMTPAddr is host:port of GreenMail's SMTP listener so
	// we can deliver bounces/replies into the mailbox that `poll`
	// reads. Typically "localhost:2025".
	GreenMailSMTPAddr string

	// InboxAddress is the mailbox the outreach poller fetches from.
	// GreenMail pre-creates `outreach@test.local`; production envs
	// override via env var.
	InboxAddress string

	// PollInterval controls how often we ask Mailpit for new messages.
	// Default 2s.
	PollInterval time.Duration

	// MinResponseDelay, MaxResponseDelay bracket the randomised delay
	// between catching an outbound message and injecting the reply.
	// This keeps the simulation realistic (real humans/servers don't
	// reply in 0 ms) and stops tight polling loops.
	MinResponseDelay time.Duration
	MaxResponseDelay time.Duration

	// HTTPClient is optional. A default client is used if nil.
	HTTPClient *http.Client
}

// DefaultBouncerConfig returns a config pre-wired to the docker-compose
// dev stack.
func DefaultBouncerConfig() *BouncerConfig {
	return &BouncerConfig{
		MailpitBaseURL:    "http://localhost:8025",
		GreenMailSMTPAddr: "localhost:2025",
		InboxAddress:      "outreach@test.local",
		PollInterval:      2 * time.Second,
		MinResponseDelay:  500 * time.Millisecond,
		MaxResponseDelay:  3 * time.Second,
	}
}

// Bouncer is the long-running service that simulates a real mail
// pipeline on localhost. Start it once per dev session; it polls
// Mailpit for outbound messages and injects the appropriate DSN /
// reply into GreenMail.
type Bouncer struct {
	cfg       *BouncerConfig
	dsn       *DSNBuilder
	reply     *ReplyBuilder
	processed sync.Map // Mailpit ID → struct{}, to avoid double-responding

	// Hooks for test/inspection — in production nil.
	OnRespond func(Behavior, string) // called after each response is delivered
}

// NewBouncer constructs a Bouncer from a config. Safe to reuse across
// Start/Stop calls.
func NewBouncer(cfg *BouncerConfig) *Bouncer {
	if cfg == nil {
		cfg = DefaultBouncerConfig()
	}
	if cfg.HTTPClient == nil {
		cfg.HTTPClient = &http.Client{Timeout: 10 * time.Second}
	}
	return &Bouncer{
		cfg:   cfg,
		dsn:   DefaultDSNBuilder(),
		reply: DefaultReplyBuilder(),
	}
}

// Run polls until the context is cancelled. Each iteration fetches the
// Mailpit message list, filters out already-processed entries, and
// triggers the appropriate response for each new message.
//
// Errors during a single iteration are logged but not fatal — the
// bouncer is a dev convenience, not a production component, so we
// favour resilience over strict correctness.
func (b *Bouncer) Run(ctx context.Context) error {
	slog.Info("mailsim bouncer starting",
		"mailpit", b.cfg.MailpitBaseURL,
		"greenmail", b.cfg.GreenMailSMTPAddr,
		"inbox", b.cfg.InboxAddress,
		"poll", b.cfg.PollInterval)

	ticker := time.NewTicker(b.cfg.PollInterval)
	defer ticker.Stop()

	for {
		select {
		case <-ctx.Done():
			return ctx.Err()
		case <-ticker.C:
			if err := b.tick(ctx); err != nil {
				slog.Warn("mailsim tick failed", "op", "Bouncer.Loop/tickFail", "error", err)
			}
		}
	}
}

// tick performs one polling cycle. Exposed for tests that want to
// drive the bouncer manually rather than on a timer.
func (b *Bouncer) tick(ctx context.Context) error {
	msgs, err := b.listMessages(ctx)
	if err != nil {
		return fmt.Errorf("list messages: %w", err)
	}
	for _, m := range msgs {
		if _, seen := b.processed.Load(m.ID); seen {
			continue
		}
		// Mark processed BEFORE responding — if SMTP injection fails
		// we don't want to loop generating duplicates.
		b.processed.Store(m.ID, struct{}{})

		if err := b.handle(ctx, m); err != nil {
			slog.Warn("mailsim handle failed", "op", "Bouncer.tick/handleFail", "id", m.ID, "error", err)
			continue
		}
	}
	return nil
}

// handle classifies the recipient and emits the appropriate response.
func (b *Bouncer) handle(ctx context.Context, m mailpitMessage) error {
	if len(m.To) == 0 {
		return fmt.Errorf("message %s has no recipient", m.ID)
	}
	// Multi-recipient messages: only the first address drives the
	// simulation. Real systems would bounce per-recipient; we skip
	// that complication for dev.
	recipient := m.To[0].Address
	beh := Classify(recipient)

	if beh == BehaviorDeliver || beh == BehaviorSilent {
		// No response at all — the message "delivered" and the recipient
		// is a ghost. The outreach thread stays in "sent" indefinitely.
		if b.OnRespond != nil {
			b.OnRespond(beh, recipient)
		}
		return nil
	}

	original, err := b.fetchOriginal(ctx, m.ID)
	if err != nil {
		return fmt.Errorf("fetch original body: %w", err)
	}

	var payload []byte
	switch {
	case beh.IsBounce():
		payload, err = b.dsn.Build(original, beh, recipient)
		if err != nil {
			return fmt.Errorf("build dsn: %w", err)
		}
	case beh == BehaviorOOO, beh.IsReply():
		payload, err = b.reply.Build(original, beh, recipient)
		if err != nil {
			return fmt.Errorf("build reply: %w", err)
		}
	default:
		return nil
	}

	// Respect the response delay window before injecting, so the
	// intelligence loop sees a plausible human/server latency.
	b.jitter()

	if err := b.injectToIMAP(payload, original.From); err != nil {
		return fmt.Errorf("inject SMTP to greenmail: %w", err)
	}

	slog.Info("mailsim response delivered",
		"behavior", beh,
		"recipient", recipient,
		"reply_to_message_id", original.MessageID)
	if b.OnRespond != nil {
		b.OnRespond(beh, recipient)
	}
	return nil
}

// jitter sleeps between Min and MaxResponseDelay. Mailpit returns
// messages as soon as they hit its SMTP, so without a small delay the
// bounce would arrive before the sender even persists the thread row.
func (b *Bouncer) jitter() {
	min := b.cfg.MinResponseDelay
	max := b.cfg.MaxResponseDelay
	if max <= min {
		time.Sleep(min)
		return
	}
	span := max - min
	// Not rng-backed — the bouncer isn't determinism-critical.
	// time.Now().UnixNano() is sufficient for jitter in dev.
	time.Sleep(min + time.Duration(int64(time.Now().UnixNano())%int64(span)))
}

// injectToIMAP sends `payload` to GreenMail SMTP so it lands in the
// inbox address. Because GreenMail was configured with auth disabled
// in docker-compose, we use net/smtp's NOAUTH path.
func (b *Bouncer) injectToIMAP(payload []byte, envelopeFrom string) error {
	if envelopeFrom == "" {
		envelopeFrom = b.dsn.MailerDaemonAddress
	}
	return smtp.SendMail(
		b.cfg.GreenMailSMTPAddr,
		nil, // auth disabled
		envelopeFrom,
		[]string{b.cfg.InboxAddress},
		payload,
	)
}

// --- Mailpit HTTP API helpers ---------------------------------------

type mailpitMessage struct {
	ID        string          `json:"ID"`
	MessageID string          `json:"MessageID"`
	From      mailpitAddress  `json:"From"`
	To        []mailpitAddress `json:"To"`
	Subject   string          `json:"Subject"`
	Created   time.Time       `json:"Created"`
	Snippet   string          `json:"Snippet"`
}

type mailpitAddress struct {
	Name    string `json:"Name"`
	Address string `json:"Address"`
}

type mailpitListResponse struct {
	Messages []mailpitMessage `json:"messages"`
}

// listMessages returns the 100 most recent messages from Mailpit. We
// don't paginate — dev volumes stay small, and the bouncer dedups via
// `processed` so re-reading the same 100 is harmless.
func (b *Bouncer) listMessages(ctx context.Context) ([]mailpitMessage, error) {
	u := b.cfg.MailpitBaseURL + "/api/v1/messages?limit=100"
	req, err := http.NewRequestWithContext(ctx, "GET", u, nil)
	if err != nil {
		return nil, err
	}
	resp, err := b.cfg.HTTPClient.Do(req)
	if err != nil {
		return nil, err
	}
	defer resp.Body.Close()
	if resp.StatusCode != 200 {
		body, _ := io.ReadAll(resp.Body)
		return nil, fmt.Errorf("mailpit list: %s — %s", resp.Status, string(body))
	}
	var out mailpitListResponse
	if err := json.NewDecoder(resp.Body).Decode(&out); err != nil {
		return nil, err
	}
	return out.Messages, nil
}

// fetchOriginal downloads the full message body from Mailpit so the
// DSN/reply builder can reference subject, Message-ID and a body
// snippet.
func (b *Bouncer) fetchOriginal(ctx context.Context, mailpitID string) (*OriginalMessage, error) {
	u := fmt.Sprintf("%s/api/v1/message/%s", b.cfg.MailpitBaseURL, mailpitID)
	req, err := http.NewRequestWithContext(ctx, "GET", u, nil)
	if err != nil {
		return nil, err
	}
	resp, err := b.cfg.HTTPClient.Do(req)
	if err != nil {
		return nil, err
	}
	defer resp.Body.Close()
	if resp.StatusCode != 200 {
		body, _ := io.ReadAll(resp.Body)
		return nil, fmt.Errorf("mailpit fetch: %s — %s", resp.Status, string(body))
	}
	var raw struct {
		ID        string          `json:"ID"`
		MessageID string          `json:"MessageID"`
		From      mailpitAddress  `json:"From"`
		To        []mailpitAddress `json:"To"`
		Subject   string          `json:"Subject"`
		Date      time.Time       `json:"Date"`
		Text      string          `json:"Text"`
	}
	if err := json.NewDecoder(resp.Body).Decode(&raw); err != nil {
		return nil, err
	}
	var toAddr string
	if len(raw.To) > 0 {
		toAddr = raw.To[0].Address
	}
	snippet := raw.Text
	if len(snippet) > 1024 {
		snippet = snippet[:1024]
	}
	// Clean up Windows line endings so reply body renders cleanly.
	snippet = strings.ReplaceAll(snippet, "\r\n", "\n")
	return &OriginalMessage{
		From:        raw.From.Address,
		To:          toAddr,
		Subject:     raw.Subject,
		MessageID:   raw.MessageID,
		Date:        raw.Date,
		BodySnippet: snippet,
	}, nil
}
