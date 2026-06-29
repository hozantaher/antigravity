package metamin

import (
	"testing"
)

// FuzzUnpadFromSizeClass drives arbitrary bytes through UnpadFromSizeClass,
// which is the boundary-of-system parser for received padded envelopes.
//
// Invariants:
//   - never panics (no OOB on short inputs, no int overflow from the 4-byte
//     big-endian length prefix),
//   - returns either nil OR a slice whose length matches the uint32 length
//     declared by the first 4 bytes of the input,
//   - the returned slice (if non-nil) is a copy of padded[4:4+declaredLen]
//     and must lie within padded.
//
// Seeds: empty, single byte, exactly 4 bytes (zero-length declared), a valid
// round-tripped padded envelope, and a deliberately mis-framed input whose
// declared length exceeds the buffer.
func FuzzUnpadFromSizeClass(f *testing.F) {
	m := NewMinimizer()

	// Seed 1: empty.
	f.Add([]byte{})

	// Seed 2: single byte.
	f.Add([]byte{0x01})

	// Seed 3: exactly 4 bytes, declares zero-length payload.
	f.Add([]byte{0x00, 0x00, 0x00, 0x00})

	// Seed 4: a valid envelope produced by PadToSizeClass.
	valid, _ := m.PadToSizeClass([]byte("hello world"))
	f.Add(valid)

	// Seed 5: deliberately mis-framed — claims 1 GiB payload but only 8 bytes.
	f.Add([]byte{0x3f, 0xff, 0xff, 0xff, 0, 0, 0, 0})

	// Seed 6: declared length matches remaining buffer (boundary case).
	f.Add([]byte{0x00, 0x00, 0x00, 0x04, 'a', 'b', 'c', 'd'})

	f.Fuzz(func(t *testing.T, padded []byte) {
		out := m.UnpadFromSizeClass(padded)
		if out == nil {
			return
		}
		if len(padded) < 4 {
			t.Fatalf("UnpadFromSizeClass returned non-nil slice for input shorter than 4 bytes (len=%d)", len(padded))
		}
		declared := int(padded[0])<<24 | int(padded[1])<<16 | int(padded[2])<<8 | int(padded[3])
		if declared < 0 {
			t.Fatalf("declared length negative: %d", declared)
		}
		if len(out) != declared {
			t.Fatalf("length mis-framing: declared=%d output=%d", declared, len(out))
		}
		if 4+declared > len(padded) {
			t.Fatalf("accepted declared length %d that exceeds buffer %d", declared, len(padded))
		}
		// Must be a copy of padded[4:4+declared].
		for i := 0; i < declared; i++ {
			if out[i] != padded[4+i] {
				t.Fatalf("unpad output diverges from source at index %d: got=%x want=%x", i, out[i], padded[4+i])
			}
		}
	})
}
