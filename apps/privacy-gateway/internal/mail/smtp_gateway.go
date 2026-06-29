package mail

import (
	"bytes"
	"context"
	"crypto/tls"
	"errors"
	"fmt"
	"io"
	"mime"
	"net"
	netmail "net/mail"
	"net/smtp"
	"strings"
	"time"

	"privacy-gateway/internal/model"
)

const maxMessageBytes = 25 * 1024 * 1024 // 25 MiB

var (
	ErrSMTPHostRequired          = errors.New("smtp host is required")
	ErrSMTPCredentialsIncomplete = errors.New("smtp username and password must both be set")
	ErrSMTPSTARTTLSRequired      = errors.New("smtp server does not support STARTTLS")
	ErrMessageTooLarge           = errors.New("message exceeds maximum allowed size")
)

type SMTPSettings struct {
	Host            string
	Port            int
	Username        string
	Password        string
	HelloDomain     string
	RequireSTARTTLS bool
	ConnectTimeout  time.Duration
}

type Envelope struct {
	From string
	To   []string
	Data []byte
}

type Transport interface {
	Send(ctx context.Context, envelope Envelope) error
}

type SMTPGateway struct {
	recordStore *RecordedGateway
	transport   Transport
	settings    SMTPSettings
}

type SMTPTransport struct {
	settings SMTPSettings
	factory  smtpClientFactory
}

type smtpClient interface {
	Hello(localName string) error
	Extension(name string) (bool, string)
	StartTLS(config *tls.Config) error
	Auth(auth smtp.Auth) error
	Mail(from string) error
	Rcpt(to string) error
	Reset() error
	Data() (io.WriteCloser, error)
	Quit() error
	Close() error
}

type smtpClientFactory interface {
	DialContext(ctx context.Context, address string) (smtpClient, error)
}

type netSMTPClientFactory struct {
	host    string
	timeout time.Duration
}

func NewSMTPTransport(settings SMTPSettings) (*SMTPTransport, error) {
	settings = normalizeSMTPSettings(settings)
	if strings.TrimSpace(settings.Host) == "" {
		return nil, ErrSMTPHostRequired
	}
	if (settings.Username == "") != (settings.Password == "") {
		return nil, ErrSMTPCredentialsIncomplete
	}

	return &SMTPTransport{
		settings: settings,
		factory: &netSMTPClientFactory{
			host:    settings.Host,
			timeout: settings.ConnectTimeout,
		},
	}, nil
}

func NewSMTPGateway(recordStore *RecordedGateway, settings SMTPSettings) (*SMTPGateway, error) {
	transport, err := NewSMTPTransport(settings)
	if err != nil {
		return nil, err
	}
	return newSMTPGateway(recordStore, transport, settings), nil
}

func newSMTPGateway(recordStore *RecordedGateway, transport Transport, settings SMTPSettings) *SMTPGateway {
	return &SMTPGateway{
		recordStore: recordStore,
		transport:   transport,
		settings:    normalizeSMTPSettings(settings),
	}
}

func (g *SMTPGateway) Send(ctx context.Context, msg model.SanitizedMessage) (model.MessageRecord, error) {
	data, err := buildRFC822Message(msg)
	if err != nil {
		return model.MessageRecord{}, err
	}

	if err := g.transport.Send(ctx, Envelope{
		From: msg.Alias.Email,
		To:   append([]string(nil), msg.To...),
		Data: data,
	}); err != nil {
		return model.MessageRecord{}, err
	}

	return g.recordStore.Send(ctx, msg)
}

func (g *SMTPGateway) ListByActor(ctx context.Context, actor model.Actor) ([]model.MessageRecord, error) {
	return g.recordStore.ListByActor(ctx, actor)
}

func (t *SMTPTransport) Send(ctx context.Context, envelope Envelope) error {
	if len(envelope.Data) > maxMessageBytes {
		return fmt.Errorf("message size %d bytes exceeds limit of %d bytes: %w", len(envelope.Data), maxMessageBytes, ErrMessageTooLarge)
	}
	address := fmt.Sprintf("%s:%d", t.settings.Host, t.settings.Port)
	client, err := t.factory.DialContext(ctx, address)
	if err != nil {
		return err
	}
	return t.sendSMTP(client, envelope)
}

func (f *netSMTPClientFactory) DialContext(ctx context.Context, address string) (smtpClient, error) {
	dialer := &net.Dialer{Timeout: f.timeout}
	conn, err := dialer.DialContext(ctx, "tcp", address)
	if err != nil {
		return nil, err
	}

	client, err := smtp.NewClient(conn, f.host)
	if err != nil {
		_ = conn.Close()
		return nil, err
	}
	return client, nil
}

func (t *SMTPTransport) sendSMTP(client smtpClient, envelope Envelope) error {
	defer client.Close()

	if t.settings.HelloDomain != "" {
		if err := client.Hello(t.settings.HelloDomain); err != nil {
			return err
		}
	}

	ok, _ := client.Extension("STARTTLS")
	if ok {
		if err := client.StartTLS(&tls.Config{
			ServerName: t.settings.Host,
			MinVersion: tls.VersionTLS12,
		}); err != nil {
			return err
		}
	} else if t.settings.RequireSTARTTLS {
		return ErrSMTPSTARTTLSRequired
	}

	if t.settings.Username != "" {
		auth := smtp.PlainAuth("", t.settings.Username, t.settings.Password, t.settings.Host)
		if err := client.Auth(auth); err != nil {
			return err
		}
	}

	if err := client.Mail(envelope.From); err != nil {
		return err
	}
	for _, recipient := range envelope.To {
		if err := client.Rcpt(recipient); err != nil {
			// RSET to abort the transaction before returning — prevents partial sends.
			_ = client.Reset()
			return fmt.Errorf("RCPT TO <%s> rejected: %w", recipient, err)
		}
	}

	writer, err := client.Data()
	if err != nil {
		return err
	}
	if _, err := writer.Write(envelope.Data); err != nil {
		_ = writer.Close()
		return err
	}
	if err := writer.Close(); err != nil {
		return err
	}

	return client.Quit()
}

func buildRFC822Message(msg model.SanitizedMessage) ([]byte, error) {
	var buffer bytes.Buffer

	from, err := formatMailbox(msg.Alias.Email)
	if err != nil {
		return nil, err
	}

	encodedRecipients := make([]string, 0, len(msg.To))
	for _, recipient := range msg.To {
		formatted, err := formatMailbox(recipient)
		if err != nil {
			return nil, err
		}
		encodedRecipients = append(encodedRecipients, formatted)
	}

	subject := encodeHeader(msg.Subject)
	messageIDDomain := domainFromAddress(msg.Alias.Email)
	if messageIDDomain == "" {
		messageIDDomain = "privacy-gateway.local"
	}

	headers := []string{
		"From: " + from,
		"To: " + strings.Join(encodedRecipients, ", "),
		"Subject: " + subject,
		"Date: " + time.Now().UTC().Format(time.RFC1123Z),
		"Message-ID: <" + messageID() + "@" + messageIDDomain + ">",
		"MIME-Version: 1.0",
		"Content-Type: text/plain; charset=UTF-8",
		"Content-Transfer-Encoding: 8bit",
	}

	for _, header := range headers {
		buffer.WriteString(header)
		buffer.WriteString("\r\n")
	}
	buffer.WriteString("\r\n")
	buffer.WriteString(normalizeSMTPBody(msg.TextBody))

	return buffer.Bytes(), nil
}

func formatMailbox(address string) (string, error) {
	mailbox, err := netmail.ParseAddress(address)
	if err != nil {
		return "", err
	}
	return mailbox.String(), nil
}

func encodeHeader(value string) string {
	if isASCII(value) {
		return value
	}
	return mime.QEncoding.Encode("utf-8", value)
}

func isASCII(value string) bool {
	for _, r := range value {
		if r > 127 {
			return false
		}
	}
	return true
}

func normalizeSMTPBody(body string) string {
	body = strings.ReplaceAll(body, "\r\n", "\n")
	body = strings.ReplaceAll(body, "\r", "\n")
	body = strings.ReplaceAll(body, "\n", "\r\n")
	if !strings.HasSuffix(body, "\r\n") {
		body += "\r\n"
	}
	return body
}

func domainFromAddress(address string) string {
	parts := strings.Split(strings.TrimSpace(address), "@")
	if len(parts) != 2 {
		return ""
	}
	return parts[1]
}

func normalizeSMTPSettings(settings SMTPSettings) SMTPSettings {
	if settings.Port <= 0 {
		settings.Port = 587
	}
	if settings.HelloDomain == "" {
		settings.HelloDomain = "privacy-gateway.local"
	}
	if settings.ConnectTimeout <= 0 {
		settings.ConnectTimeout = 10 * time.Second
	}
	return settings
}
