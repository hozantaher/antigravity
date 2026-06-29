package amnesic

import (
	"relay/internal/deaddrop"
	"relay/internal/ephemeral"
	"crypto/ed25519"
	"crypto/hmac"
	"crypto/sha256"
	"encoding/binary"
)

var pbkdf2Iterations = 600_000

// DerivedIdentity holds all material needed for one submission session.
// Everything is derived deterministically from the passphrase.
// Nothing is stored on disk. The same passphrase always produces the same identity.
type DerivedIdentity struct {
	EncryptionKey *ephemeral.SecureBuffer // 32-byte AES key
	SigningKey    *ephemeral.SecureBuffer // 64-byte Ed25519 private key
	PublicKey     []byte                  // 32-byte Ed25519 public key
	SlotID        deaddrop.SlotID         // dead drop slot for current epoch
}

// Derive produces a full identity from a passphrase.
// Uses PBKDF2 via repeated HMAC-SHA256 (stdlib only, no x/crypto).
//
// Derivation chain:
//
//	master = PBKDF2(passphrase, "anti-trace-amnesic-v1", 600_000, 64)
//	encKey = HKDF-Expand(master, "encryption", 32)
//	signSeed = HKDF-Expand(master, "signing", 32)
//	signKey = ed25519.NewKeyFromSeed(signSeed)
//	slotID = HMAC-SHA256(master[:32], "deaddrop-slot" || epoch)
//
// The passphrase is zeroed from memory after derivation.
func Derive(passphrase []byte) *DerivedIdentity {
	// PBKDF2 with 600,000 iterations
	salt := []byte("anti-trace-amnesic-v1")
	master := pbkdf2HMACSHA256(passphrase, salt, pbkdf2Iterations, 64)

	// Zero passphrase immediately
	ephemeral.WipeSlice(passphrase)

	// Derive encryption key
	encKeyBytes := hkdfExpand(master, []byte("encryption"), 32)
	encKey := ephemeral.Alloc(32)
	ephemeral.Register(encKey)
	encKey.Write(0, encKeyBytes)
	ephemeral.WipeSlice(encKeyBytes)

	// Derive signing seed and create Ed25519 key
	signSeed := hkdfExpand(master, []byte("signing"), ed25519.SeedSize)
	privKey := ed25519.NewKeyFromSeed(signSeed)
	pubKey := privKey.Public().(ed25519.PublicKey)

	signKey := ephemeral.Alloc(ed25519.PrivateKeySize)
	ephemeral.Register(signKey)
	signKey.Write(0, privKey)
	ephemeral.WipeSlice(signSeed)
	ephemeral.WipeSlice([]byte(privKey))

	// Derive dead drop slot ID
	slotID := deaddrop.DeriveSlotID(master[:32], deaddrop.CurrentEpoch())

	// Zero master key
	ephemeral.WipeSlice(master)

	return &DerivedIdentity{
		EncryptionKey: encKey,
		PublicKey:     pubKey,
		SlotID:        slotID,
		SigningKey:    signKey,
	}
}

// Zero wipes all key material from memory. Must be called on every exit path.
func (d *DerivedIdentity) Zero() {
	if d.EncryptionKey != nil {
		d.EncryptionKey.Zero()
	}
	if d.SigningKey != nil {
		d.SigningKey.Zero()
	}
	ephemeral.WipeSlice(d.PublicKey)
}

// pbkdf2HMACSHA256 implements PBKDF2 with HMAC-SHA256 (RFC 2898).
// Go stdlib only -- no x/crypto dependency.
func pbkdf2HMACSHA256(password, salt []byte, iterations, keyLen int) []byte {
	numBlocks := (keyLen + sha256.Size - 1) / sha256.Size
	result := make([]byte, 0, numBlocks*sha256.Size)

	for block := 1; block <= numBlocks; block++ {
		// U1 = HMAC(password, salt || INT_32_BE(block))
		blockBuf := make([]byte, 4)
		binary.BigEndian.PutUint32(blockBuf, uint32(block))

		h := hmac.New(sha256.New, password)
		h.Write(salt)
		h.Write(blockBuf)
		u := h.Sum(nil)

		t := make([]byte, len(u))
		copy(t, u)

		for i := 1; i < iterations; i++ {
			h.Reset()
			h.Write(u)
			u = h.Sum(u[:0])
			for j := range t {
				t[j] ^= u[j]
			}
		}

		result = append(result, t...)
	}

	return result[:keyLen]
}

// hkdfExpand implements HKDF-Expand (RFC 5869) with SHA-256.
func hkdfExpand(prk, info []byte, length int) []byte {
	result := make([]byte, 0, length)
	prev := []byte{}
	counter := byte(1)
	for len(result) < length {
		h := hmac.New(sha256.New, prk)
		h.Write(prev)
		h.Write(info)
		h.Write([]byte{counter})
		prev = h.Sum(nil)
		result = append(result, prev...)
		counter++
	}
	return result[:length]
}
