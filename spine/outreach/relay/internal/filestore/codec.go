package filestore

import (
	"crypto/aes"
	"crypto/cipher"
	"crypto/rand"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"path/filepath"
)

// OS seam variables — overridden in tests to inject errors.
var (
	osCreateTemp = os.CreateTemp
	osRename     = os.Rename
	randRead     = io.ReadFull
	newAESCipher = aes.NewCipher
	newGCM       = cipher.NewGCM
	tmpClose     = func(f *os.File) error { return f.Close() }
)

// Codec provides optional AES-256-GCM encryption for stored data.
type Codec struct {
	key []byte
}

// DefaultCodec returns a codec that stores data without encryption.
func DefaultCodec() Codec {
	return Codec{}
}

// NewCodecFromBase64 creates an encrypting codec from a base64-encoded 32-byte key.
// Returns DefaultCodec if the key is empty.
func NewCodecFromBase64(value string) (Codec, error) {
	if value == "" {
		return DefaultCodec(), nil
	}
	key, err := base64.StdEncoding.DecodeString(value)
	if err != nil {
		return Codec{}, fmt.Errorf("invalid encryption key: %w", err)
	}
	if len(key) != 32 {
		return Codec{}, fmt.Errorf("encryption key must be 32 bytes, got %d", len(key))
	}
	return Codec{key: key}, nil
}

func (c Codec) encrypted() bool {
	return len(c.key) == 32
}

type encryptedEnvelope struct {
	Version    int    `json:"version"`
	Algorithm  string `json:"algorithm"`
	Nonce      string `json:"nonce"`
	Ciphertext string `json:"ciphertext"`
}

// Encrypt encrypts plaintext using AES-256-GCM. Returns plaintext if no key set.
func (c Codec) Encrypt(plaintext []byte) ([]byte, error) {
	if !c.encrypted() {
		return plaintext, nil
	}
	block, err := newAESCipher(c.key)
	if err != nil {
		return nil, err
	}
	gcm, err := newGCM(block)
	if err != nil {
		return nil, err
	}
	nonce := make([]byte, gcm.NonceSize())
	if _, err := randRead(rand.Reader, nonce); err != nil {
		return nil, err
	}
	ciphertext := gcm.Seal(nil, nonce, plaintext, nil)
	env := encryptedEnvelope{
		Version:    1,
		Algorithm:  "aes-256-gcm",
		Nonce:      base64.StdEncoding.EncodeToString(nonce),
		Ciphertext: base64.StdEncoding.EncodeToString(ciphertext),
	}
	return json.Marshal(env)
}

// Decrypt decrypts ciphertext using AES-256-GCM. Returns input if no key set.
func (c Codec) Decrypt(data []byte) ([]byte, error) {
	if !c.encrypted() {
		return data, nil
	}
	var env encryptedEnvelope
	if err := json.Unmarshal(data, &env); err != nil {
		return nil, fmt.Errorf("invalid encrypted envelope: %w", err)
	}
	if env.Version != 1 || env.Algorithm != "aes-256-gcm" {
		return nil, errors.New("unsupported encryption format")
	}
	nonce, err := base64.StdEncoding.DecodeString(env.Nonce)
	if err != nil {
		return nil, err
	}
	ciphertext, err := base64.StdEncoding.DecodeString(env.Ciphertext)
	if err != nil {
		return nil, err
	}
	block, err := newAESCipher(c.key)
	if err != nil {
		return nil, err
	}
	gcm, err := newGCM(block)
	if err != nil {
		return nil, err
	}
	return gcm.Open(nil, nonce, ciphertext, nil)
}

// ReadJSON reads and optionally decrypts a JSON file into target.
func ReadJSON(path string, codec Codec, target any) error {
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
	plain, err := codec.Decrypt(data)
	if err != nil {
		return fmt.Errorf("decrypt %s: %w", path, err)
	}
	return json.Unmarshal(plain, target)
}

// WriteJSONAtomic writes value as JSON to path atomically (temp file + rename),
// optionally encrypting with the codec.
func WriteJSONAtomic(path string, codec Codec, value any) error {
	data, err := json.MarshalIndent(value, "", "  ")
	if err != nil {
		return err
	}
	encrypted, err := codec.Encrypt(data)
	if err != nil {
		return err
	}
	dir := filepath.Dir(path)
	if err := os.MkdirAll(dir, 0700); err != nil {
		return err
	}
	tmp, err := osCreateTemp(dir, ".tmp-*")
	if err != nil {
		return err
	}
	tmpName := tmp.Name()
	if _, err := tmp.Write(encrypted); err != nil {
		tmp.Close()
		os.Remove(tmpName)
		return err
	}
	if err := tmpClose(tmp); err != nil {
		os.Remove(tmpName)
		return err
	}
	return osRename(tmpName, path)
}
