package filestore

import (
	"encoding/json"
	"fmt"
	"os"
)

// VersionedEnvelope wraps encrypted data with a key ID for rotation support.
type VersionedEnvelope struct {
	KeyID string          `json:"key_id"`
	Data  json.RawMessage `json:"data"`
}

// KeyRing manages multiple encryption keys for rotation.
// The current key is used for encryption, all keys can decrypt.
type KeyRing struct {
	currentKeyID string
	keys         map[string]Codec
}

// NewKeyRing creates a key ring with the given keys. currentID is used for encryption.
func NewKeyRing(currentID string, keys map[string]Codec) *KeyRing {
	return &KeyRing{
		currentKeyID: currentID,
		keys:         keys,
	}
}

// CurrentCodec returns the codec for the current encryption key.
func (kr *KeyRing) CurrentCodec() Codec {
	return kr.keys[kr.currentKeyID]
}

// CurrentKeyID returns the ID of the current encryption key.
func (kr *KeyRing) CurrentKeyID() string {
	return kr.currentKeyID
}

// CodecForKey returns the codec for a specific key ID.
func (kr *KeyRing) CodecForKey(keyID string) (Codec, bool) {
	c, ok := kr.keys[keyID]
	return c, ok
}

// RotateFile re-encrypts a file from oldKeyID to the current key.
func (kr *KeyRing) RotateFile(path string) error {
	data, err := os.ReadFile(path)
	if err != nil {
		if os.IsNotExist(err) {
			return nil
		}
		return err
	}
	if len(data) == 0 {
		return nil
	}

	// Try to detect which key was used (try each key)
	var plaintext []byte
	for _, codec := range kr.keys {
		pt, err := codec.Decrypt(data)
		if err == nil {
			plaintext = pt
			break
		}
	}
	if plaintext == nil {
		return fmt.Errorf("could not decrypt %s with any known key", path)
	}

	// Re-encrypt with current key
	currentCodec := kr.keys[kr.currentKeyID]
	encrypted, err := currentCodec.Encrypt(plaintext)
	if err != nil {
		return fmt.Errorf("re-encrypt %s: %w", path, err)
	}

	// Atomic write
	return writeAtomic(path, encrypted)
}

func writeAtomic(path string, data []byte) error {
	tmp := path + ".tmp"
	if err := os.WriteFile(tmp, data, 0600); err != nil {
		return err
	}
	return os.Rename(tmp, path)
}
