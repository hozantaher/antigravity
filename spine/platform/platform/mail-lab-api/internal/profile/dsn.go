package profile

import (
	"encoding/json"
	"fmt"
	"strings"
	"time"
)

// DSNEnvelope captures the metadata needed to render an RFC3464 DSN
// (delivery status notification). All fields optional except OriginalTo
// — without it the bounce has no target address to report on.
//
// MessageID + ArrivalTime echo the original message's headers so the
// bouncing MTA's report can be correlated with sender's logs.
type DSNEnvelope struct {
	OriginalFrom string    `json:"original_from,omitempty"`
	OriginalTo   string    `json:"original_to"`
	MessageID    string    `json:"message_id,omitempty"`
	ArrivalTime  time.Time `json:"arrival_time,omitempty"`
}

// DSN holds the rendered bounce body. RFC3464 mandates multipart/report
// with three parts: human readable, message/delivery-status (machine),
// and message/rfc822 (or message/rfc822-headers). The provider's
// reporting MTA acts as the bounce origin.
type DSN struct {
	From            string `json:"from"`              // postmaster@<provider>
	To              string `json:"to"`                // OriginalFrom (sender)
	Subject         string `json:"subject"`           // "Undelivered Mail Returned to Sender"
	StatusCode      string `json:"status_code"`       // 5.7.1, 5.2.2, etc.
	DiagnosticCode  string `json:"diagnostic_code"`   // human reason
	Action          string `json:"action"`            // "failed" | "delayed"
	ReportingMTA    string `json:"reporting_mta"`     // <provider>.lab
	Body            string `json:"body"`              // full RFC822 multipart/report
}

// BuildDSN renders a bounce per the profile's bounce_kind_on_reject and
// the verdict that triggered the rejection. Greylist verdicts produce a
// 4xx delayed response (action=delayed) since real MTAs treat greylist
// as a temporary defer. Accept verdicts return zero DSN.
//
// The function is pure — no docker exec, no IO. The returned DSN.Body is
// a fully formed multipart/report message that an MTA could 'sendmail
// -bs' verbatim. Callers needing actual delivery wrap this in their own
// transport step.
func BuildDSN(p *Profile, env DSNEnvelope, decision Decision, reason string) DSN {
	if p == nil || decision == DecisionAccept || env.OriginalTo == "" {
		return DSN{}
	}

	action := "failed"
	statusCode := strings.TrimSpace(p.BounceKindOnReject)
	if statusCode == "" {
		statusCode = "5.0.0"
	}
	if decision == DecisionGreylist {
		action = "delayed"
		statusCode = "4.7.1"
	}

	if env.ArrivalTime.IsZero() {
		env.ArrivalTime = time.Now().UTC()
	}

	postmaster := "postmaster@" + p.Domain
	subject := "Undelivered Mail Returned to Sender"
	if action == "delayed" {
		subject = "Delayed: greylist defer"
	}

	body := renderRFC3464(rfc3464Args{
		From:           postmaster,
		To:             env.OriginalFrom,
		Subject:        subject,
		ReportingMTA:   p.Domain,
		FailedRecip:    env.OriginalTo,
		Action:         action,
		StatusCode:     statusCode,
		DiagnosticCode: reason,
		MessageID:      env.MessageID,
		ArrivalTime:    env.ArrivalTime.UTC(),
	})

	return DSN{
		From:           postmaster,
		To:             env.OriginalFrom,
		Subject:        subject,
		StatusCode:     statusCode,
		DiagnosticCode: reason,
		Action:         action,
		ReportingMTA:   p.Domain,
		Body:           body,
	}
}

// PreviewDSN is the JSON-friendly Registry method exposed to handlers.
// Both the envelope and the message context come in as raw decoded JSON
// maps so the HTTP layer doesn't have to know about typed structs. The
// rendered DSN is returned as `interface{}` (concrete type *DSN) so the
// handler can pass it straight to writeJSON.
//
// Returns a zero DSN (with empty Body) when the verdict is accept — the
// caller can detect "no bounce" by checking the body field client-side.
func (r *Registry) PreviewDSN(domain string, envRaw, ctxRaw map[string]interface{}) (interface{}, string, error) {
	r.mu.RLock()
	p, ok := r.profiles[strings.ToLower(domain)]
	r.mu.RUnlock()
	if !ok {
		return nil, "", ErrUnknownDomain
	}
	env, err := decodeInto[DSNEnvelope](envRaw)
	if err != nil {
		return nil, "", err
	}
	ctx, err := decodeInto[MessageContext](ctxRaw)
	if err != nil {
		return nil, "", err
	}
	d, reason := Verdict(p, ctx)
	dsn := BuildDSN(p, env, d, reason)
	return &dsn, string(d), nil
}

func decodeInto[T any](raw map[string]interface{}) (T, error) {
	var out T
	if len(raw) == 0 {
		return out, nil
	}
	buf, err := json.Marshal(raw)
	if err != nil {
		return out, err
	}
	if err := json.Unmarshal(buf, &out); err != nil {
		return out, err
	}
	return out, nil
}

type rfc3464Args struct {
	From           string
	To             string
	Subject        string
	ReportingMTA   string
	FailedRecip    string
	Action         string
	StatusCode     string
	DiagnosticCode string
	MessageID      string
	ArrivalTime    time.Time
}

// renderRFC3464 emits a multipart/report message body. We pin the
// boundary to a stable token so tests can grep for it; a real MTA would
// randomize.
func renderRFC3464(a rfc3464Args) string {
	const boundary = "==BOUNDARY_LAB_DSN=="
	var b strings.Builder
	fmt.Fprintf(&b, "From: %s\r\n", a.From)
	fmt.Fprintf(&b, "To: %s\r\n", a.To)
	fmt.Fprintf(&b, "Subject: %s\r\n", a.Subject)
	fmt.Fprintf(&b, "Date: %s\r\n", a.ArrivalTime.Format(time.RFC1123Z))
	fmt.Fprintf(&b, "Auto-Submitted: auto-replied\r\n")
	fmt.Fprintf(&b, "MIME-Version: 1.0\r\n")
	fmt.Fprintf(&b, "Content-Type: multipart/report; report-type=delivery-status; boundary=\"%s\"\r\n", boundary)
	b.WriteString("\r\n")
	b.WriteString("This is a MIME-encapsulated message.\r\n\r\n")

	// Part 1 — human readable.
	fmt.Fprintf(&b, "--%s\r\n", boundary)
	b.WriteString("Content-Type: text/plain; charset=utf-8\r\n\r\n")
	fmt.Fprintf(&b, "Your message to %s could not be delivered.\r\n", a.FailedRecip)
	fmt.Fprintf(&b, "Reason: %s (%s)\r\n", a.DiagnosticCode, a.StatusCode)
	b.WriteString("\r\n")

	// Part 2 — machine readable delivery-status.
	fmt.Fprintf(&b, "--%s\r\n", boundary)
	b.WriteString("Content-Type: message/delivery-status\r\n\r\n")
	fmt.Fprintf(&b, "Reporting-MTA: dns; %s\r\n", a.ReportingMTA)
	fmt.Fprintf(&b, "Arrival-Date: %s\r\n", a.ArrivalTime.Format(time.RFC1123Z))
	b.WriteString("\r\n")
	fmt.Fprintf(&b, "Final-Recipient: rfc822; %s\r\n", a.FailedRecip)
	fmt.Fprintf(&b, "Action: %s\r\n", a.Action)
	fmt.Fprintf(&b, "Status: %s\r\n", a.StatusCode)
	if a.DiagnosticCode != "" {
		fmt.Fprintf(&b, "Diagnostic-Code: smtp; %s %s\r\n", a.StatusCode, a.DiagnosticCode)
	}
	b.WriteString("\r\n")

	// Part 3 — original headers (rfc822-headers, not full body, to keep
	// bounce small).
	fmt.Fprintf(&b, "--%s\r\n", boundary)
	b.WriteString("Content-Type: message/rfc822-headers\r\n\r\n")
	if a.MessageID != "" {
		fmt.Fprintf(&b, "Message-ID: %s\r\n", a.MessageID)
	}
	fmt.Fprintf(&b, "To: %s\r\n", a.FailedRecip)
	b.WriteString("\r\n")

	fmt.Fprintf(&b, "--%s--\r\n", boundary)
	return b.String()
}
