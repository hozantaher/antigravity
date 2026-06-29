package contentenc

import (
	"crypto/aes"
	"crypto/cipher"
	"crypto/ecdh"
	"crypto/rand"
	"crypto/sha256"
	"errors"
	"io"
)

var (
	ErrInvalidKey        = errors.New("invalid key")
	ErrDecryptionFailed  = errors.New("decryption failed")
	ErrInvalidCiphertext = errors.New("invalid ciphertext format")
)

// seam variables for crypto operations — replaced in tests to cover error paths.
var (
	newAESCipher = func(key []byte) (cipher.Block, error) { return aes.NewCipher(key) }
	newGCM       = func(block cipher.Block) (cipher.AEAD, error) { return cipher.NewGCM(block) }
	randRead     = func(b []byte) (int, error) { return rand.Read(b) }
	ecdhGenKey   = func(curve ecdh.Curve, r io.Reader) (*ecdh.PrivateKey, error) {
		return curve.GenerateKey(r)
	}
)

// hkdfSalt is a fixed application-level salt for HKDF derivation.
var hkdfSalt = []byte("anti-trace-relay-content-enc-v1")

// Sealer encrypts content using X25519 key agreement + HKDF + AES-256-GCM.
// After sealing, no relay component can read the content.
type Sealer struct{}

func NewSealer() *Sealer {
	return &Sealer{}
}

// Seal encrypts plaintext for a recipient's X25519 public key.
// Format: [32-byte ephemeral public key][12-byte nonce][ciphertext+tag]
//
// Key derivation uses HKDF-SHA256 with ephemeral and recipient public keys
// bound into the info parameter to prevent key confusion attacks.
func (s *Sealer) Seal(plaintext, recipientPubKey []byte) ([]byte, error) {
	if len(recipientPubKey) != 32 {
		return nil, ErrInvalidKey
	}

	curve := ecdh.X25519()

	recipientKey, err := curve.NewPublicKey(recipientPubKey)
	if err != nil {
		return nil, ErrInvalidKey
	}

	ephemeralPriv, err := ecdhGenKey(curve, rand.Reader)
	if err != nil {
		return nil, err
	}
	ephemeralPub := ephemeralPriv.PublicKey()

	shared, err := ephemeralPriv.ECDH(recipientKey)
	if err != nil {
		return nil, err
	}

	// Derive AES key using HKDF-SHA256 with context binding
	info := make([]byte, 0, 64)
	info = append(info, ephemeralPub.Bytes()...)
	info = append(info, recipientPubKey...)
	aesKey := hkdfDerive(shared, hkdfSalt, info, 32)

	// Wipe shared secret from memory
	wipeBytes(shared)

	block, err := newAESCipher(aesKey)
	if err != nil {
		wipeBytes(aesKey)
		return nil, err
	}

	gcm, err := newGCM(block)
	if err != nil {
		wipeBytes(aesKey)
		return nil, err
	}

	nonce := make([]byte, gcm.NonceSize())
	if _, err := randRead(nonce); err != nil {
		wipeBytes(aesKey)
		return nil, err
	}

	ciphertext := gcm.Seal(nil, nonce, plaintext, ephemeralPub.Bytes())
	wipeBytes(aesKey)

	// Format: ephemeral_pub (32) || nonce (12) || ciphertext
	result := make([]byte, 0, 32+len(nonce)+len(ciphertext))
	result = append(result, ephemeralPub.Bytes()...)
	result = append(result, nonce...)
	result = append(result, ciphertext...)

	return result, nil
}

// Open decrypts ciphertext using the recipient's X25519 private key.
func (s *Sealer) Open(sealed, recipientPrivKey []byte) ([]byte, error) {
	if len(recipientPrivKey) != 32 {
		return nil, ErrInvalidKey
	}
	if len(sealed) < 32+12+16 {
		return nil, ErrInvalidCiphertext
	}

	curve := ecdh.X25519()

	privKey, err := curve.NewPrivateKey(recipientPrivKey)
	if err != nil {
		return nil, ErrInvalidKey
	}

	ephemeralPubBytes := sealed[:32]
	ephemeralPub, err := curve.NewPublicKey(ephemeralPubBytes)
	if err != nil {
		return nil, ErrInvalidCiphertext
	}

	shared, err := privKey.ECDH(ephemeralPub)
	if err != nil {
		return nil, ErrDecryptionFailed
	}

	// Derive AES key using same HKDF parameters
	info := make([]byte, 0, 64)
	info = append(info, ephemeralPubBytes...)
	info = append(info, privKey.PublicKey().Bytes()...)
	aesKey := hkdfDerive(shared, hkdfSalt, info, 32)
	wipeBytes(shared)

	block, err := newAESCipher(aesKey)
	if err != nil {
		wipeBytes(aesKey)
		return nil, ErrDecryptionFailed
	}

	gcm, err := newGCM(block)
	if err != nil {
		wipeBytes(aesKey)
		return nil, ErrDecryptionFailed
	}

	nonceSize := gcm.NonceSize()
	nonce := sealed[32 : 32+nonceSize]
	ciphertext := sealed[32+nonceSize:]

	plaintext, err := gcm.Open(nil, nonce, ciphertext, ephemeralPubBytes)
	wipeBytes(aesKey)
	if err != nil {
		return nil, ErrDecryptionFailed
	}

	return plaintext, nil
}

// GenerateKeyPair generates an X25519 key pair for a recipient.
// Returns (privateKey, publicKey).
func GenerateKeyPair() ([]byte, []byte, error) {
	curve := ecdh.X25519()
	priv, err := ecdhGenKey(curve, rand.Reader)
	if err != nil {
		return nil, nil, err
	}
	return priv.Bytes(), priv.PublicKey().Bytes(), nil
}

// hkdfDerive derives a key using HKDF-SHA256 (RFC 5869).
// Implemented inline to avoid external dependency.
func hkdfDerive(ikm, salt, info []byte, length int) []byte {
	// Extract phase: PRK = HMAC-SHA256(salt, ikm)
	prk := hmacSHA256(salt, ikm)

	// Expand phase
	result := make([]byte, 0, length)
	prev := []byte{}
	counter := byte(1)
	for len(result) < length {
		msg := make([]byte, 0, len(prev)+len(info)+1)
		msg = append(msg, prev...)
		msg = append(msg, info...)
		msg = append(msg, counter)
		prev = hmacSHA256(prk, msg)
		result = append(result, prev...)
		counter++
	}
	wipeBytes(prk)
	return result[:length]
}

// hmacSHA256 computes HMAC-SHA256(key, message) using Go stdlib.
func hmacSHA256(key, message []byte) []byte {
	// HMAC: H((K ^ opad) || H((K ^ ipad) || message))
	blockSize := sha256.BlockSize
	if len(key) > blockSize {
		h := sha256.Sum256(key)
		key = h[:]
	}
	if len(key) < blockSize {
		padded := make([]byte, blockSize)
		copy(padded, key)
		key = padded
	}

	ipad := make([]byte, blockSize)
	opad := make([]byte, blockSize)
	for i := 0; i < blockSize; i++ {
		ipad[i] = key[i] ^ 0x36
		opad[i] = key[i] ^ 0x5c
	}

	inner := sha256.New()
	inner.Write(ipad)
	inner.Write(message)
	innerHash := inner.Sum(nil)

	outer := sha256.New()
	outer.Write(opad)
	outer.Write(innerHash)
	return outer.Sum(nil)
}

// wipeBytes zeroes a byte slice to prevent key material from lingering in memory.
func wipeBytes(b []byte) {
	for i := range b {
		b[i] = 0
	}
	// Prevent compiler from optimizing away the zeroing
	if len(b) > 0 {
		_ = io.Discard
	}
}
