package thread

import "testing"

// 2026-05-18 hardening — safeUTF8 sanitizes raw bytes before INSERT so
// Postgres TEXT columns don't raise 22021 on invalid byte sequences.
// Real bounce 2026-05-17 from testima.local triggered this with CP1250
// header bytes in body; INSERT rolled back, parkUnattributed lost message.
func TestSafeUTF8(t *testing.T) {
	tests := []struct {
		name string
		in   string
		want string
	}{
		{"empty", "", ""},
		{"ascii only", "Hello world", "Hello world"},
		{"valid utf-8 czech", "Příliš žluťoučký kůň", "Příliš žluťoučký kůň"},
		{"single invalid byte", "abc\xe8def", "abc�def"},
		{"multiple invalid bytes", "X\xe8\x65\x6eY", "X�enY"},
		{"valid + invalid mix", "Příliš \xe8 kůň", "Příliš � kůň"},
		{"emoji passes through", "test 🎉", "test 🎉"},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			got := safeUTF8(tt.in)
			if got != tt.want {
				t.Errorf("safeUTF8(%q) = %q, want %q", tt.in, got, tt.want)
			}
		})
	}
}
