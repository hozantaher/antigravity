package config

import "testing"

func TestValidateTrackingBaseURL_Valid(t *testing.T) {
	if err := validateTrackingBaseURL("https://track.example.com"); err != nil {
		t.Errorf("unexpected error: %v", err)
	}
}

func TestValidateTrackingBaseURL_Empty(t *testing.T) {
	if err := validateTrackingBaseURL(""); err == nil {
		t.Error("expected error for empty URL")
	}
}

func TestValidateTrackingBaseURL_Whitespace(t *testing.T) {
	if err := validateTrackingBaseURL("   "); err == nil {
		t.Error("expected error for whitespace-only")
	}
}

func TestValidateTrackingBaseURL_HTTP_NotHTTPS(t *testing.T) {
	if err := validateTrackingBaseURL("http://track.example.com"); err == nil {
		t.Error("expected error for http:// (not https)")
	}
}

func TestValidateTrackingBaseURL_NoScheme(t *testing.T) {
	if err := validateTrackingBaseURL("track.example.com"); err == nil {
		t.Error("expected error for URL without scheme")
	}
}

func TestValidateTrackingBaseURL_NoHost(t *testing.T) {
	// URL parses but has no host — e.g. "https://"
	if err := validateTrackingBaseURL("https://"); err == nil {
		t.Error("expected error for URL with no host")
	}
}

func TestValidateTrackingBaseURL_WithCredentials(t *testing.T) {
	if err := validateTrackingBaseURL("https://user:pass@track.example.com"); err == nil {
		t.Error("expected error for URL with userinfo credentials")
	}
}
