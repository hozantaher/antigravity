package intake

import (
	"strings"
	"testing"
	"testing/quick"
)

// ── Property: generateEnvelopeID never panics ─────────────────
func TestProperty_GenerateEnvelopeID_NoPanic(t *testing.T) {
	for i := 0; i < 500; i++ {
		id, err := generateEnvelopeID()
		if err != nil {
			t.Fatalf("iteration %d: unexpected error: %v", i, err)
		}
		if id == "" {
			t.Fatal("empty envelope ID")
		}
	}
}

// ── Property: generateEnvelopeID always "env_" prefix ────────
func TestProperty_GenerateEnvelopeID_Prefix(t *testing.T) {
	for i := 0; i < 200; i++ {
		id, _ := generateEnvelopeID()
		if !strings.HasPrefix(id, "env_") {
			t.Fatalf("ID %q missing env_ prefix", id)
		}
	}
}

// ── Property: generateEnvelopeID length = 28 ─────────────────
// "env_" (4) + hex(12 bytes) (24) = 28
func TestProperty_GenerateEnvelopeID_Length(t *testing.T) {
	for i := 0; i < 200; i++ {
		id, _ := generateEnvelopeID()
		if len(id) != 28 {
			t.Fatalf("ID %q: want len 28, got %d", id, len(id))
		}
	}
}

// ── Property: generateEnvelopeID hex suffix is lowercase ─────
func TestProperty_GenerateEnvelopeID_HexChars(t *testing.T) {
	for i := 0; i < 200; i++ {
		id, _ := generateEnvelopeID()
		hex := id[4:]
		for _, ch := range hex {
			if !((ch >= '0' && ch <= '9') || (ch >= 'a' && ch <= 'f')) {
				t.Fatalf("ID %q: non-hex char %q in suffix", id, ch)
			}
		}
	}
}

// ── Property: generateEnvelopeID uniqueness ───────────────────
func TestProperty_GenerateEnvelopeID_Unique(t *testing.T) {
	seen := make(map[string]bool, 1000)
	for i := 0; i < 1000; i++ {
		id, _ := generateEnvelopeID()
		if seen[id] {
			t.Fatalf("duplicate ID %q at iteration %d", id, i)
		}
		seen[id] = true
	}
}

// ── Property: intToStr never panics ──────────────────────────
func TestProperty_IntToStr_NoPanic(t *testing.T) {
	f := func(n int) bool {
		defer func() {
			if r := recover(); r != nil {
				t.Errorf("panic on %d: %v", n, r)
			}
		}()
		_ = intToStr(n)
		return true
	}
	if err := quick.Check(f, &quick.Config{MaxCount: 500}); err != nil {
		t.Fatal(err)
	}
}

// ── Property: intToStr length always 4 ───────────────────────
// Always encodes 2 bytes = 4 hex chars.
func TestProperty_IntToStr_Length(t *testing.T) {
	f := func(n uint16) bool {
		return len(intToStr(int(n))) == 4
	}
	if err := quick.Check(f, &quick.Config{MaxCount: 500}); err != nil {
		t.Fatal(err)
	}
}

// ── Property: intToStr hex chars only ────────────────────────
func TestProperty_IntToStr_HexOnly(t *testing.T) {
	f := func(n uint16) bool {
		s := intToStr(int(n))
		for _, ch := range s {
			if !((ch >= '0' && ch <= '9') || (ch >= 'a' && ch <= 'f')) {
				return false
			}
		}
		return true
	}
	if err := quick.Check(f, &quick.Config{MaxCount: 500}); err != nil {
		t.Fatal(err)
	}
}

// ── Property: intToStr encodes big-endian low 16 bits ────────
func TestProperty_IntToStr_BigEndian(t *testing.T) {
	cases := map[int]string{
		0x0000: "0000",
		0x0001: "0001",
		0x00ff: "00ff",
		0x0100: "0100",
		0xff00: "ff00",
		0xffff: "ffff",
		0xabcd: "abcd",
	}
	for in, want := range cases {
		if got := intToStr(in); got != want {
			t.Fatalf("intToStr(0x%04x) = %q, want %q", in, got, want)
		}
	}
}

// ── Property: intToStr ignores bits above 16 ─────────────────
func TestProperty_IntToStr_MaskHigh(t *testing.T) {
	// High bits beyond uint16 are masked by byte(n>>8) and byte(n)
	low := intToStr(0x00ab)
	high := intToStr(0x10000 | 0x00ab)
	if low != high {
		t.Fatalf("high bits changed result: %q vs %q", low, high)
	}
}
