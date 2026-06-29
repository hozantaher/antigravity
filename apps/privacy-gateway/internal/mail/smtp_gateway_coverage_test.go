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

	"privacy-gateway/internal/model"
)

type erroringClient struct {
	failOn string // "hello", "startTLS", "auth", "mail", "rcpt", "data", "write", "writerClose", "quit"
}

func (c *erroringClient) Hello(string) error {
	if c.failOn == "hello" {
		return errors.New("hello failed")
	}
	return nil
}

func (c *erroringClient) Extension(name string) (bool, string) {
	// Pretend STARTTLS is available only when we actually want to test it.
	if name == "STARTTLS" && (c.failOn == "startTLS") {
		return true, ""
	}
	return false, ""
}

func (c *erroringClient) StartTLS(*tls.Config) error {
	if c.failOn == "startTLS" {
		return errors.New("starttls failed")
	}
	return nil
}

func (c *erroringClient) Auth(smtp.Auth) error {
	if c.failOn == "auth" {
		return errors.New("auth failed")
	}
	return nil
}

func (c *erroringClient) Mail(string) error {
	if c.failOn == "mail" {
		return errors.New("mail failed")
	}
	return nil
}

func (c *erroringClient) Rcpt(string) error {
	if c.failOn == "rcpt" {
		return errors.New("rcpt failed")
	}
	return nil
}

func (c *erroringClient) Reset() error { return nil }
func (c *erroringClient) Quit() error {
	if c.failOn == "quit" {
		return errors.New("quit failed")
	}
	return nil
}
func (c *erroringClient) Close() error { return nil }

type failingWriter struct{ err error }

func (f *failingWriter) Write(p []byte) (int, error) { return 0, f.err }
func (f *failingWriter) Close() error                { return nil }

type erroringWriterClient struct {
	erroringClient
	writer     io.WriteCloser
	dataErr    error
	closeErr   error
	dataBuffer bytes.Buffer
}

func (c *erroringWriterClient) Data() (io.WriteCloser, error) {
	if c.dataErr != nil {
		return nil, c.dataErr
	}
	return c.writer, nil
}

// closingWriter implements WriteCloser with a custom Close error.
type closingWriter struct {
	buf      *bytes.Buffer
	closeErr error
}

func (w *closingWriter) Write(p []byte) (int, error) { return w.buf.Write(p) }
func (w *closingWriter) Close() error                { return w.closeErr }

// Data() only — reuse erroringClient for the rest.
func (c *erroringClient) Data() (io.WriteCloser, error) {
	return nil, errors.New("Data not implemented on erroringClient")
}

// TestSMTPTransportSendMessageTooLarge covers the size-limit branch.
func TestSMTPTransportSendMessageTooLarge(t *testing.T) {
	transport, err := NewSMTPTransport(SMTPSettings{Host: "smtp.example.com"})
	if err != nil {
		t.Fatalf("NewSMTPTransport() error = %v", err)
	}
	err = transport.Send(context.Background(), Envelope{
		Data: make([]byte, maxMessageBytes+1),
	})
	if !errors.Is(err, ErrMessageTooLarge) {
		t.Fatalf("expected ErrMessageTooLarge, got %v", err)
	}
}

// TestSMTPTransportSendDialError covers the DialContext error branch.
func TestSMTPTransportSendDialError(t *testing.T) {
	transport, err := NewSMTPTransport(SMTPSettings{Host: "smtp.example.com"})
	if err != nil {
		t.Fatalf("NewSMTPTransport() error = %v", err)
	}
	transport.factory = &fakeSMTPFactory{err: errors.New("dial failed")}

	err = transport.Send(context.Background(), Envelope{
		Data: []byte("x"),
	})
	if err == nil || !strings.Contains(err.Error(), "dial failed") {
		t.Fatalf("expected dial error, got %v", err)
	}
}

// TestSMTPTransportSendPropagatesHelloError covers the Hello error branch.
func TestSMTPTransportSendPropagatesHelloError(t *testing.T) {
	transport, err := NewSMTPTransport(SMTPSettings{Host: "smtp.example.com", HelloDomain: "gateway.local"})
	if err != nil {
		t.Fatalf("NewSMTPTransport() error = %v", err)
	}
	transport.factory = &fakeSMTPFactory{client: &erroringClient{failOn: "hello"}}
	err = transport.Send(context.Background(), Envelope{Data: []byte("x")})
	if err == nil || !strings.Contains(err.Error(), "hello failed") {
		t.Fatalf("expected hello error, got %v", err)
	}
}

// TestSMTPTransportSendPropagatesStartTLSError covers the StartTLS error branch.
func TestSMTPTransportSendPropagatesStartTLSError(t *testing.T) {
	transport, err := NewSMTPTransport(SMTPSettings{Host: "smtp.example.com"})
	if err != nil {
		t.Fatalf("NewSMTPTransport() error = %v", err)
	}
	transport.factory = &fakeSMTPFactory{client: &erroringClient{failOn: "startTLS"}}
	err = transport.Send(context.Background(), Envelope{Data: []byte("x")})
	if err == nil || !strings.Contains(err.Error(), "starttls failed") {
		t.Fatalf("expected starttls error, got %v", err)
	}
}

// TestSMTPTransportSendPropagatesAuthError covers the Auth error branch.
func TestSMTPTransportSendPropagatesAuthError(t *testing.T) {
	transport, err := NewSMTPTransport(SMTPSettings{Host: "smtp.example.com", Username: "u", Password: "p"})
	if err != nil {
		t.Fatalf("NewSMTPTransport() error = %v", err)
	}
	transport.factory = &fakeSMTPFactory{client: &erroringClient{failOn: "auth"}}
	err = transport.Send(context.Background(), Envelope{Data: []byte("x")})
	if err == nil || !strings.Contains(err.Error(), "auth failed") {
		t.Fatalf("expected auth error, got %v", err)
	}
}

// TestSMTPTransportSendPropagatesMailError covers the Mail error branch.
func TestSMTPTransportSendPropagatesMailError(t *testing.T) {
	transport, err := NewSMTPTransport(SMTPSettings{Host: "smtp.example.com"})
	if err != nil {
		t.Fatalf("NewSMTPTransport() error = %v", err)
	}
	transport.factory = &fakeSMTPFactory{client: &erroringClient{failOn: "mail"}}
	err = transport.Send(context.Background(), Envelope{From: "a@b.com", To: []string{"c@d.com"}, Data: []byte("x")})
	if err == nil || !strings.Contains(err.Error(), "mail failed") {
		t.Fatalf("expected mail error, got %v", err)
	}
}

// TestSMTPTransportSendPropagatesRcptError covers the Rcpt error branch,
// including the wrapped format string.
func TestSMTPTransportSendPropagatesRcptError(t *testing.T) {
	transport, err := NewSMTPTransport(SMTPSettings{Host: "smtp.example.com"})
	if err != nil {
		t.Fatalf("NewSMTPTransport() error = %v", err)
	}
	transport.factory = &fakeSMTPFactory{client: &erroringClient{failOn: "rcpt"}}
	err = transport.Send(context.Background(), Envelope{From: "a@b.com", To: []string{"c@d.com"}, Data: []byte("x")})
	if err == nil || !strings.Contains(err.Error(), "RCPT TO <c@d.com>") {
		t.Fatalf("expected wrapped rcpt error, got %v", err)
	}
}

// TestSMTPTransportSendPropagatesDataError covers the Data error branch.
func TestSMTPTransportSendPropagatesDataError(t *testing.T) {
	transport, err := NewSMTPTransport(SMTPSettings{Host: "smtp.example.com"})
	if err != nil {
		t.Fatalf("NewSMTPTransport() error = %v", err)
	}

	client := &erroringWriterClient{dataErr: errors.New("data failed")}
	transport.factory = &fakeSMTPFactory{client: client}

	err = transport.Send(context.Background(), Envelope{From: "a@b.com", To: []string{"c@d.com"}, Data: []byte("x")})
	if err == nil || !strings.Contains(err.Error(), "data failed") {
		t.Fatalf("expected data error, got %v", err)
	}
}

// TestSMTPTransportSendPropagatesWriteError covers the Write error branch.
func TestSMTPTransportSendPropagatesWriteError(t *testing.T) {
	transport, err := NewSMTPTransport(SMTPSettings{Host: "smtp.example.com"})
	if err != nil {
		t.Fatalf("NewSMTPTransport() error = %v", err)
	}

	client := &erroringWriterClient{writer: &failingWriter{err: errors.New("write failed")}}
	transport.factory = &fakeSMTPFactory{client: client}

	err = transport.Send(context.Background(), Envelope{From: "a@b.com", To: []string{"c@d.com"}, Data: []byte("x")})
	if err == nil || !strings.Contains(err.Error(), "write failed") {
		t.Fatalf("expected write error, got %v", err)
	}
}

// TestSMTPTransportSendPropagatesWriterCloseError covers the writer.Close() branch.
func TestSMTPTransportSendPropagatesWriterCloseError(t *testing.T) {
	transport, err := NewSMTPTransport(SMTPSettings{Host: "smtp.example.com"})
	if err != nil {
		t.Fatalf("NewSMTPTransport() error = %v", err)
	}

	buf := &bytes.Buffer{}
	client := &erroringWriterClient{writer: &closingWriter{buf: buf, closeErr: errors.New("close failed")}}
	transport.factory = &fakeSMTPFactory{client: client}

	err = transport.Send(context.Background(), Envelope{From: "a@b.com", To: []string{"c@d.com"}, Data: []byte("body")})
	if err == nil || !strings.Contains(err.Error(), "close failed") {
		t.Fatalf("expected writer close error, got %v", err)
	}
}

// TestSMTPGatewaySendBuildFailure covers the buildRFC822Message error branch
// by supplying an invalid From address.
func TestSMTPGatewaySendBuildFailure(t *testing.T) {
	gateway := newSMTPGateway(NewRecordedGateway(), &stubTransport{}, SMTPSettings{})
	_, err := gateway.Send(context.Background(), model.SanitizedMessage{
		Alias:    model.Alias{Email: "not-an-email"},
		To:       []string{"dest@example.com"},
		Subject:  "Hi",
		TextBody: "Body",
	})
	if err == nil {
		t.Fatal("expected buildRFC822Message error for invalid From address")
	}
}
