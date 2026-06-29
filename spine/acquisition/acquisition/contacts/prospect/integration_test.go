package prospect

import (
	"context"
	"os"
	"testing"

	_ "github.com/lib/pq"
)

// Integration tests — only run when FIRMY_DSN is set.
// Usage: FIRMY_DSN="postgresql://..." go test -run TestIntegration -v ./internal/prospect/

func skipIfNoFirmyDSN(t *testing.T) {
	if os.Getenv("FIRMY_DSN") == "" {
		t.Skip("FIRMY_DSN not set — skipping integration test")
	}
}

func TestIntegration_Connect(t *testing.T) {
	skipIfNoFirmyDSN(t)
	src, err := NewFirmySource(os.Getenv("FIRMY_DSN"))
	if err != nil { t.Fatalf("connect: %v", err) }
	defer src.Close()
}

func TestIntegration_Count_All(t *testing.T) {
	skipIfNoFirmyDSN(t)
	src, err := NewFirmySource(os.Getenv("FIRMY_DSN"))
	if err != nil { t.Fatalf("connect: %v", err) }
	defer src.Close()

	count, err := src.Count(context.Background(), FirmyFilter{HasEmail: true})
	if err != nil { t.Fatalf("count: %v", err) }
	if count < 100000 { t.Errorf("expected >100K businesses with email, got %d", count) }
}

func TestIntegration_Count_Region(t *testing.T) {
	skipIfNoFirmyDSN(t)
	src, err := NewFirmySource(os.Getenv("FIRMY_DSN"))
	if err != nil { t.Fatalf("connect: %v", err) }
	defer src.Close()

	count, err := src.Count(context.Background(), FirmyFilter{HasEmail: true, HasICO: true, Region: "Praha"})
	if err != nil { t.Fatalf("count: %v", err) }
	if count < 10000 { t.Errorf("expected >10K Praha businesses, got %d", count) }
}

func TestIntegration_Fetch_Limit(t *testing.T) {
	skipIfNoFirmyDSN(t)
	src, err := NewFirmySource(os.Getenv("FIRMY_DSN"))
	if err != nil { t.Fatalf("connect: %v", err) }
	defer src.Close()

	businesses, err := src.Fetch(context.Background(), FirmyFilter{HasEmail: true, Limit: 5})
	if err != nil { t.Fatalf("fetch: %v", err) }
	if len(businesses) != 5 { t.Errorf("expected 5 businesses, got %d", len(businesses)) }

	for _, b := range businesses {
		if b.Email == "" { t.Error("fetched business without email despite HasEmail filter") }
		if b.Name == "" { t.Error("business has no name") }
	}
}

func TestIntegration_Fetch_Region(t *testing.T) {
	skipIfNoFirmyDSN(t)
	src, err := NewFirmySource(os.Getenv("FIRMY_DSN"))
	if err != nil { t.Fatalf("connect: %v", err) }
	defer src.Close()

	businesses, err := src.Fetch(context.Background(), FirmyFilter{
		HasEmail: true, Region: "Brno", Limit: 3,
	})
	if err != nil { t.Fatalf("fetch: %v", err) }
	if len(businesses) == 0 { t.Error("expected businesses in Brno") }
	for _, b := range businesses {
		if b.Region == "" { t.Error("missing region") }
	}
}

func TestIntegration_Fetch_HasICO(t *testing.T) {
	skipIfNoFirmyDSN(t)
	src, err := NewFirmySource(os.Getenv("FIRMY_DSN"))
	if err != nil { t.Fatalf("connect: %v", err) }
	defer src.Close()

	businesses, err := src.Fetch(context.Background(), FirmyFilter{
		HasEmail: true, HasICO: true, Limit: 5,
	})
	if err != nil { t.Fatalf("fetch: %v", err) }
	for _, b := range businesses {
		if b.ICO == "" { t.Error("fetched business without ICO despite HasICO filter") }
	}
}

func TestIntegration_ConnectBadDSN(t *testing.T) {
	_, err := NewFirmySource("postgresql://bad:bad@localhost:1/nonexistent?sslmode=disable&connect_timeout=2")
	if err == nil { t.Error("expected error for bad DSN") }
}
