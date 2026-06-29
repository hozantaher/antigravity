package contentenc

import (
	"bytes"
	"crypto/rand"
	"testing"
)

// FuzzOpen exercises Open against arbitrary ciphertext with a random 32-byte
// X25519 private key. Open is the untrusted-input parser that receives data
// off the wire, so it must:
//
//   - never panic (no OOB slicing on short inputs, no nil deref on malformed
//     ephemeral public keys),
//   - always return (nil, err) on any invalid input — i.e. must not leak
//     plaintext-looking bytes on a failure path,
//   - reject wrong-length keys and short sealed buffers cleanly.
//
// Seeds: empty, single byte, min-length sealed buffer, real round-tripped
// sealed buffer, and a deliberately truncated real sealed buffer.
func FuzzOpen(f *testing.F) {
	// Produce one real round-tripped sealed buffer for seeding.
	sealer := NewSealer()
	priv, pub, err := GenerateKeyPair()
	if err != nil {
		f.Fatalf("seed keygen: %v", err)
	}
	validSealed, err := sealer.Seal([]byte("fuzz-seed-plaintext"), pub)
	if err != nil {
		f.Fatalf("seed seal: %v", err)
	}

	// A fixed 32-byte seed key for the seed corpus (the fuzzer mutates it).
	seedKey := make([]byte, 32)
	for i := range seedKey {
		seedKey[i] = byte(i + 1)
	}

	seeds := [][]byte{
		nil,
		{},
		{0x00},
		make([]byte, 32+12+16), // exactly minimum length, all zeroes
		validSealed,
		validSealed[:len(validSealed)-1], // truncated GCM tag
	}

	for _, s := range seeds {
		f.Add(s, seedKey)
		f.Add(s, priv)
	}

	f.Fuzz(func(t *testing.T, sealed, rawPriv []byte) {
		// Normalize private key length so we also exercise wrong-length paths.
		var privKey []byte
		switch {
		case len(rawPriv) == 32:
			privKey = rawPriv
		case len(rawPriv) > 32:
			privKey = rawPriv[:32]
		default:
			// Pad short inputs with random bytes to occasionally hit a
			// structurally valid (but still wrong) key.
			privKey = make([]byte, 32)
			copy(privKey, rawPriv)
			if _, err := rand.Read(privKey[len(rawPriv):]); err != nil {
				t.Fatalf("rand: %v", err)
			}
		}

		// Also run once with the exact raw length to exercise ErrInvalidKey.
		if out, err := sealer.Open(sealed, rawPriv); err == nil {
			// On success (extremely unlikely under random fuzzing) the output
			// must be well-formed — we cannot assert specific bytes, but it
			// must not be nil.
			if out == nil {
				t.Fatalf("Open returned nil plaintext with nil error")
			}
		} else if out != nil {
			t.Fatalf("Open returned non-nil plaintext %x alongside error %v (possible plaintext leak)", out, err)
		}

		out, err := sealer.Open(sealed, privKey)
		if err != nil {
			// On failure the returned plaintext MUST be nil — no partial
			// plaintext on any error path.
			if out != nil {
				t.Fatalf("Open returned non-nil plaintext %x alongside error %v (possible plaintext leak)", out, err)
			}
			return
		}

		// Sanity: if Open succeeded (practically impossible for random fuzz
		// input unless the fuzzer reconstructs a valid sealed buffer), the
		// output must not alias the input storage.
		if len(out) > 0 && len(sealed) > 0 && &out[0] == &sealed[0] {
			t.Fatalf("Open output aliases input buffer")
		}
		// And it must not just echo the raw sealed bytes back.
		if bytes.Equal(out, sealed) {
			t.Fatalf("Open output identical to input sealed buffer")
		}
	})
}
