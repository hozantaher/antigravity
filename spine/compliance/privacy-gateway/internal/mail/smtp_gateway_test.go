package mail

import (
	"bytes"
	"context"
	"crypto/tls"
	"errors"
	"io"
	"net/smtp"
	"strings"
	"testing"
	"time"

	"privacy-gateway/internal/model"
)

type stubTransport struct {
	envelopes []Envelope
	err       error
}

type fakeSMTPFactory struct {
	client  smtpClient
	address string
	err     error
}

type fakeSMTPClient struct {
	extensions map[string]bool
	mailFrom   string
	recipients []string
	authUsed   bool
	startTLS   bool
	dataBuffer bytes.Buffer
	writerErr  error
}

type fakeWriteCloser struct {
	writer io.Writer
}

func (s *stubTransport) Send(_ context.Context, envelope Envelope) error {
	if s.err != nil {
		return s.err
	}
	s.envelopes = append(s.envelopes, envelope)
	return nil
}

func (f *fakeSMTPFactory) DialContext(_ context.Context, address string) (smtpClient, error) {
	if f.err != nil {
		return nil, f.err
	}
	f.address = address
	return f.client, nil
}

func (f *fakeSMTPClient) Hello(string) error { return nil }

func (f *fakeSMTPClient) Extension(name string) (bool, string) {
	return f.extensions[name], ""
}

func (f *fakeSMTPClient) StartTLS(*tls.Config) error {
	f.startTLS = true
	return nil
}

func (f *fakeSMTPClient) Auth(smtp.Auth) error {
	f.authUsed = true
	return nil
}

func (f *fakeSMTPClient) Mail(from string) error {
	f.mailFrom = from
	return nil
}

func (f *fakeSMTPClient) Rcpt(to string) error {
	f.recipients = append(f.recipients, to)
	return nil
}

func (f *fakeSMTPClient) Data() (io.WriteCloser, error) {
	if f.writerErr != nil {
		return nil, f.writerErr
	}
	return &fakeWriteCloser{writer: &f.dataBuffer}, nil
}

func (f *fakeSMTPClient) Reset() error { return nil }
func (f *fakeSMTPClient) Quit() error  { return nil }
func (f *fakeSMTPClient) Close() error { return nil }

func (w *fakeWriteCloser) Write(p []byte) (int, error) {
	return w.writer.Write(p)
}

func (w *fakeWriteCloser) Close() error { return nil }

func TestSMTPGatewaySendTransportsAndRecordsMessage(t *testing.T) {
	recordStore := NewRecordedGateway()
	recordStore.now = func() time.Time {
		return time.Date(2026, time.April, 3, 12, 0, 0, 0, time.UTC)
	}
	transport := &stubTransport{}
	gateway := newSMTPGateway(recordStore, transport, SMTPSettings{HelloDomain: "gateway.example.com"})

	record, err := gateway.Send(context.Background(), model.SanitizedMessage{
		Actor:    model.Actor{ID: "user-1", TenantID: "tenant-1"},
		Alias:    model.Alias{ID: "alias-1", Email: "support@relay.example"},
		To:       []string{"recipient@example.com"},
		Subject:  "Hello",
		TextBody: "Privacy-preserving hello.",
	})
	if err != nil {
		t.Fatalf("Send() error = %v", err)
	}

	if len(transport.envelopes) != 1 {
		t.Fatalf("expected 1 SMTP envelope, got %d", len(transport.envelopes))
	}
	if transport.envelopes[0].From != "support@relay.example" {
		t.Fatalf("expected envelope from support@relay.example, got %s", transport.envelopes[0].From)
	}
	if !strings.Contains(string(transport.envelopes[0].Data), "Subject: Hello\r\n") {
		t.Fatalf("expected RFC822 subject header, got %q", string(transport.envelopes[0].Data))
	}
	if record.Sender != "support@relay.example" {
		t.Fatalf("expected recorded sender support@relay.example, got %s", record.Sender)
	}

	records, err := gateway.ListByActor(context.Background(), model.Actor{ID: "user-1", TenantID: "tenant-1"})
	if err != nil {
		t.Fatalf("ListByActor() error = %v", err)
	}
	if len(records) != 1 {
		t.Fatalf("expected 1 recorded message, got %d", len(records))
	}
}

func TestSMTPGatewaySendDoesNotRecordOnTransportFailure(t *testing.T) {
	recordStore := NewRecordedGateway()
	transport := &stubTransport{err: errors.New("smtp unavailable")}
	gateway := newSMTPGateway(recordStore, transport, SMTPSettings{})

	_, err := gateway.Send(context.Background(), model.SanitizedMessage{
		Actor:    model.Actor{ID: "user-1", TenantID: "tenant-1"},
		Alias:    model.Alias{ID: "alias-1", Email: "support@relay.example"},
		To:       []string{"recipient@example.com"},
		Subject:  "Hello",
		TextBody: "Privacy-preserving hello.",
	})
	if err == nil {
		t.Fatal("expected transport failure")
	}

	records, err := gateway.ListByActor(context.Background(), model.Actor{ID: "user-1", TenantID: "tenant-1"})
	if err != nil {
		t.Fatalf("ListByActor() error = %v", err)
	}
	if len(records) != 0 {
		t.Fatalf("expected 0 recorded messages after transport failure, got %d", len(records))
	}
}

func TestNewSMTPTransportRejectsMissingHost(t *testing.T) {
	if _, err := NewSMTPTransport(SMTPSettings{}); err == nil {
		t.Fatal("expected missing host error")
	}
}

func TestNewSMTPTransportRejectsPartialCredentials(t *testing.T) {
	if _, err := NewSMTPTransport(SMTPSettings{Host: "smtp.example.com", Username: "mailer"}); err == nil {
		t.Fatal("expected partial credentials error")
	}
}

func TestNewSMTPGatewayBuildsWithValidSettings(t *testing.T) {
	recordStore := NewRecordedGateway()
	gateway, err := NewSMTPGateway(recordStore, SMTPSettings{Host: "smtp.example.com"})
	if err != nil {
		t.Fatalf("NewSMTPGateway() error = %v", err)
	}
	if gateway == nil {
		t.Fatal("expected gateway to be created")
	}
}

func TestSMTPTransportSendUsesClientFactory(t *testing.T) {
	client := &fakeSMTPClient{extensions: map[string]bool{"STARTTLS": false}}
	transport, err := NewSMTPTransport(SMTPSettings{
		Host:            "smtp.example.com",
		Port:            2525,
		HelloDomain:     "gateway.example.com",
		RequireSTARTTLS: false,
	})
	if err != nil {
		t.Fatalf("NewSMTPTransport() error = %v", err)
	}
	factory := &fakeSMTPFactory{client: client}
	transport.factory = factory

	err = transport.Send(context.Background(), Envelope{
		From: "support@relay.example",
		To:   []string{"recipient@example.com"},
		Data: []byte("Subject: Hello\r\n\r\nBody\r\n"),
	})
	if err != nil {
		t.Fatalf("Send() error = %v", err)
	}

	if factory.address != "smtp.example.com:2525" {
		t.Fatalf("expected dial address smtp.example.com:2525, got %s", factory.address)
	}
	if client.mailFrom != "support@relay.example" {
		t.Fatalf("expected sender support@relay.example, got %s", client.mailFrom)
	}
	if len(client.recipients) != 1 || client.recipients[0] != "recipient@example.com" {
		t.Fatalf("expected recipient recipient@example.com, got %+v", client.recipients)
	}
	if !strings.Contains(client.dataBuffer.String(), "Subject: Hello\r\n") {
		t.Fatalf("expected buffered data to contain subject, got %q", client.dataBuffer.String())
	}
}

func TestSMTPTransportRequiresSTARTTLSWhenConfigured(t *testing.T) {
	client := &fakeSMTPClient{extensions: map[string]bool{"STARTTLS": false}}
	transport, err := NewSMTPTransport(SMTPSettings{
		Host:            "smtp.example.com",
		RequireSTARTTLS: true,
	})
	if err != nil {
		t.Fatalf("NewSMTPTransport() error = %v", err)
	}
	transport.factory = &fakeSMTPFactory{client: client}

	err = transport.Send(context.Background(), Envelope{
		From: "support@relay.example",
		To:   []string{"recipient@example.com"},
		Data: []byte("Subject: Hello\r\n\r\nBody\r\n"),
	})
	if !errors.Is(err, ErrSMTPSTARTTLSRequired) {
		t.Fatalf("expected ErrSMTPSTARTTLSRequired, got %v", err)
	}
}

func TestSMTPTransportUsesSTARTTLSAndAuthWhenConfigured(t *testing.T) {
	client := &fakeSMTPClient{extensions: map[string]bool{"STARTTLS": true}}
	transport, err := NewSMTPTransport(SMTPSettings{
		Host:            "smtp.example.com",
		Username:        "mailer",
		Password:        "secret",
		RequireSTARTTLS: true,
	})
	if err != nil {
		t.Fatalf("NewSMTPTransport() error = %v", err)
	}
	transport.factory = &fakeSMTPFactory{client: client}

	err = transport.Send(context.Background(), Envelope{
		From: "support@relay.example",
		To:   []string{"recipient@example.com"},
		Data: []byte("Subject: Hello\r\n\r\nBody\r\n"),
	})
	if err != nil {
		t.Fatalf("Send() error = %v", err)
	}
	if !client.startTLS {
		t.Fatal("expected STARTTLS to be used")
	}
	if !client.authUsed {
		t.Fatal("expected SMTP auth to be used")
	}
}

func TestBuildRFC822MessageEncodesUTF8Subject(t *testing.T) {
	data, err := buildRFC822Message(model.SanitizedMessage{
		Alias:    model.Alias{Email: "support@relay.example"},
		To:       []string{"recipient@example.com"},
		Subject:  "Ahoj světe",
		TextBody: "Body",
	})
	if err != nil {
		t.Fatalf("buildRFC822Message() error = %v", err)
	}
	text := string(data)
	if !strings.Contains(text, "Content-Type: text/plain; charset=UTF-8\r\n") {
		t.Fatalf("expected content type header, got %q", text)
	}
	if !strings.Contains(text, "Subject: =?utf-8?") {
		t.Fatalf("expected encoded UTF-8 subject, got %q", text)
	}
}

func TestBuildRFC822MessageRejectsInvalidMailbox(t *testing.T) {
	_, err := buildRFC822Message(model.SanitizedMessage{
		Alias:    model.Alias{Email: "not-an-email"},
		To:       []string{"recipient@example.com"},
		Subject:  "Hello",
		TextBody: "Body",
	})
	if err == nil {
		t.Fatal("expected invalid mailbox error")
	}
}

func TestDomainFromAddressReturnsEmptyForInvalidInput(t *testing.T) {
	if got := domainFromAddress("not-an-email"); got != "" {
		t.Fatalf("expected empty domain, got %q", got)
	}
}
