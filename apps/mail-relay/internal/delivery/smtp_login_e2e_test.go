package delivery_test

// E2E test: real TCP mini-SMTP server that requires AUTH LOGIN.
// Verifies the full delivery path: dial → EHLO → STARTTLS-skip → AUTH LOGIN → MAIL/RCPT/DATA → QUIT.
// This test would FAIL with PlainAuth (535) and PASS with LoginAuth.

import (
	"relay/internal/delivery"
	"relay/internal/transport"
	"bufio"
	"context"
	"encoding/base64"
	"fmt"
	"net"
	"strings"
	"testing"
	"time"
)

// miniSMTPServer spawns a minimal SMTP server on a random port that:
//  - advertises AUTH LOGIN in EHLO
//  - accepts only AUTH LOGIN with specific credentials
//  - accepts MAIL/RCPT/DATA on auth success
//
// Returns the listener address and a channel that receives "ok" or "fail".
func miniSMTPServer(t *testing.T, wantUser, wantPass string) (addr string, results chan string) {
	t.Helper()
	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatalf("listen: %v", err)
	}
	results = make(chan string, 1)

	go func() {
		defer ln.Close()
		conn, err := ln.Accept()
		if err != nil {
			results <- "fail:accept:" + err.Error()
			return
		}
		defer conn.Close()
		conn.SetDeadline(time.Now().Add(10 * time.Second))

		r := bufio.NewReader(conn)
		send := func(s string) { fmt.Fprintf(conn, "%s\r\n", s) }

		send("220 mini.test ESMTP ready")

		for {
			line, err := r.ReadString('\n')
			if err != nil {
				results <- "fail:read:" + err.Error()
				return
			}
			line = strings.TrimSpace(line)

			switch {
			case strings.HasPrefix(line, "EHLO"), strings.HasPrefix(line, "HELO"):
				send("250-mini.test")
				send("250-AUTH LOGIN PLAIN")
				send("250 OK")

			case line == "AUTH LOGIN":
				send("334 VXNlcm5hbWU6") // base64("Username:")
				userB64, _ := r.ReadString('\n')
				userB64 = strings.TrimSpace(userB64)
				decoded := decodeB64(userB64)
				if decoded != wantUser {
					send("535 5.7.8 incorrect credentials (username)")
					results <- "fail:wrong_user:" + decoded
					return
				}
				send("334 UGFzc3dvcmQ6") // base64("Password:")
				passB64, _ := r.ReadString('\n')
				passB64 = strings.TrimSpace(passB64)
				decodedPass := decodeB64(passB64)
				if decodedPass != wantPass {
					send("535 5.7.8 incorrect credentials (password)")
					results <- "fail:wrong_pass"
					return
				}
				send("235 2.7.0 Authentication successful")

			case strings.HasPrefix(line, "MAIL FROM"):
				send("250 OK")

			case strings.HasPrefix(line, "RCPT TO"):
				send("250 OK")

			case line == "DATA":
				send("354 Start input")

			case line == ".":
				send("250 OK queued")

			case line == "QUIT":
				send("221 Bye")
				results <- "ok"
				return

			default:
				// ignore unknown commands
			}
		}
	}()

	return ln.Addr().String(), results
}

func decodeB64(s string) string {
	b, err := base64.StdEncoding.DecodeString(s)
	if err != nil {
		return s // return raw if not base64
	}
	return string(b)
}

func TestSMTPDeliverer_AuthLogin_Success(t *testing.T) {
	const user = "testuser@seznam.cz"
	const pass = "correctpassword"
	addr, results := miniSMTPServer(t, user, pass)

	host, portStr, _ := net.SplitHostPort(addr)
	port := 0
	fmt.Sscanf(portStr, "%d", &port)

	cfg := delivery.SMTPConfig{
		Host:     host,
		Port:     port,
		Username: user,
		Password: pass,
	}
	d := delivery.NewSMTPDeliverer(transport.NewDirectTransport(), cfg)

	msg := delivery.BuildMessage(user, []string{"recipient@example.com"}, "Test Subject", "Test body", "", nil)
	err := d.Deliver(context.Background(), user, []string{"recipient@example.com"}, msg)

	result := <-results
	if err != nil {
		t.Errorf("Deliver() error: %v (server result: %s)", err, result)
	}
	if result != "ok" {
		t.Errorf("server reported: %s", result)
	}
}

func TestSMTPDeliverer_WrongPassword_Returns535(t *testing.T) {
	addr, results := miniSMTPServer(t, "user@seznam.cz", "correctpass")

	host, portStr, _ := net.SplitHostPort(addr)
	port := 0
	fmt.Sscanf(portStr, "%d", &port)

	cfg := delivery.SMTPConfig{Host: host, Port: port, Username: "user@seznam.cz", Password: "wrongpass"}
	d := delivery.NewSMTPDeliverer(transport.NewDirectTransport(), cfg)

	msg := delivery.BuildMessage("user@seznam.cz", []string{"r@example.com"}, "S", "B", "", nil)
	err := d.Deliver(context.Background(), "user@seznam.cz", []string{"r@example.com"}, msg)

	<-results // drain server goroutine
	if err == nil {
		t.Error("expected error for wrong password, got nil")
	}
	if !strings.Contains(err.Error(), "535") && !strings.Contains(err.Error(), "auth") {
		t.Errorf("expected auth error, got: %v", err)
	}
}
