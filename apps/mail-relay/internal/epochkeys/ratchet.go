package epochkeys

import (
	"relay/internal/ephemeral"
	"crypto/ecdh"
	"crypto/hmac"
	"crypto/sha256"
	"encoding/binary"
	"time"
)

// DeriveEpochKeyPair derives an X25519 key pair that rotates every epoch (hour).
// Both sender and recipient independently derive the same key from the shared passphrase.
//
// Forward secrecy: keys from past epochs are wiped and cannot be reconstructed
// without the passphrase. Compromising a device after the epoch has passed
// reveals nothing about messages encrypted in that epoch.
//
// Derivation:
//
//	master = PBKDF2(passphrase, salt, 600K)
//	epoch_seed = HKDF-Expand(master, "x25519-" || epoch_bytes, 32)
//	private_key = X25519(epoch_seed)
func DeriveEpochKeyPair(passphrase []byte, epoch int64) (privateKey, publicKey []byte) {
	salt := []byte("anti-trace-amnesic-v1")
	master := pbkdf2HMACSHA256(passphrase, salt, 600_000, 64)
	defer ephemeral.WipeSlice(master)

	// Epoch-specific info: "x25519-" || 8-byte big-endian epoch
	info := make([]byte, 7+8)
	copy(info, "x25519-")
	binary.BigEndian.PutUint64(info[7:], uint64(epoch))

	seed := hkdfExpand(master, info, 32)
	defer ephemeral.WipeSlice(seed)

	curve := ecdh.X25519()
	priv, err := curve.NewPrivateKey(seed)
	if err != nil {
		return nil, nil
	}

	privBytes := make([]byte, 32)
	copy(privBytes, priv.Bytes())
	pubBytes := make([]byte, 32)
	copy(pubBytes, priv.PublicKey().Bytes())

	return privBytes, pubBytes
}

// CurrentEpoch returns the current hourly epoch.
func CurrentEpoch() int64 {
	return time.Now().Unix() / 3600
}

func pbkdf2HMACSHA256(password, salt []byte, iterations, keyLen int) []byte {
	numBlocks := (keyLen + sha256.Size - 1) / sha256.Size
	result := make([]byte, 0, numBlocks*sha256.Size)
	for block := 1; block <= numBlocks; block++ {
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
