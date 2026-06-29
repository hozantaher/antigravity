package filestore

import (
	"crypto/aes"
	"crypto/cipher"
	"crypto/rand"
	"encoding/base64"
	"encoding/json"
	"errors"
	"io"
	"os"
	"path/filepath"
)

var (
	ErrInvalidEncryptionKey     = errors.New("data encryption key must decode to 32 bytes")
	ErrEncryptedFileRequiresKey = errors.New("encrypted file requires a configured data encryption key")
	ErrUnsupportedEnvelope      = errors.New("unsupported encrypted file envelope")
)

type Codec struct {
	key []byte
}

type encryptedEnvelope struct {
	Version    int    `json:"version"`
	Algorithm  string `json:"algorithm"`
	Nonce      string `json:"nonce"`
	Ciphertext string `json:"ciphertext"`
}

func DefaultCodec() Codec {
	return Codec{}
}

func NewCodec(key []byte) (Codec, error) {
	if len(key) == 0 {
		return Codec{}, nil
	}
	if len(key) != 32 {
		return Codec{}, ErrInvalidEncryptionKey
	}
	return Codec{key: append([]byte(nil), key...)}, nil
}

func NewCodecFromBase64(value string) (Codec, error) {
	if value == "" {
		return DefaultCodec(), nil
	}
	key, err := base64.StdEncoding.DecodeString(value)
	if err != nil {
		return Codec{}, ErrInvalidEncryptionKey
	}
	return NewCodec(key)
}

func ReadJSON(path string, target any) error {
	return ReadJSONWithCodec(path, target, DefaultCodec())
}

func ReadJSONWithCodec(path string, target any, codec Codec) error {
	if path == "" {
		return errors.New("json file path is required")
	}

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

	plaintext, err := codec.decode(data)
	if err != nil {
		return err
	}

	return json.Unmarshal(plaintext, target)
}

func WriteJSONAtomic(path string, value any) error {
	return WriteJSONAtomicWithCodec(path, value, DefaultCodec())
}

func WriteJSONAtomicWithCodec(path string, value any, codec Codec) error {
	if path == "" {
		return errors.New("json file path is required")
	}

	dir := filepath.Dir(path)
	if err := os.MkdirAll(dir, 0o700); err != nil {
		return err
	}

	data, err := json.MarshalIndent(value, "", "  ")
	if err != nil {
		return err
	}
	data = append(data, '\n')

	data, err = codec.encode(data)
	if err != nil {
		return err
	}

	tmpFile, err := os.CreateTemp(dir, ".tmp-*.json")
	if err != nil {
		return err
	}
	tmpName := tmpFile.Name()

	cleanup := func() {
		_ = tmpFile.Close()
		_ = os.Remove(tmpName)
	}

	if err := tmpFile.Chmod(0o600); err != nil {
		cleanup()
		return err
	}
	if _, err := tmpFile.Write(data); err != nil {
		cleanup()
		return err
	}
	if err := tmpFile.Sync(); err != nil {
		cleanup()
		return err
	}
	if err := tmpFile.Close(); err != nil {
		_ = os.Remove(tmpName)
		return err
	}

	if err := os.Rename(tmpName, path); err != nil {
		_ = os.Remove(tmpName)
		return err
	}

	return nil
}

func (c Codec) decode(data []byte) ([]byte, error) {
	envelope, encrypted, err := parseEnvelope(data)
	if err != nil {
		return nil, err
	}
	if !encrypted {
		return data, nil
	}
	if len(c.key) == 0 {
		return nil, ErrEncryptedFileRequiresKey
	}
	if envelope.Version != 1 || envelope.Algorithm != "aes-256-gcm" {
		return nil, ErrUnsupportedEnvelope
	}

	nonce, err := base64.StdEncoding.DecodeString(envelope.Nonce)
	if err != nil {
		return nil, err
	}
	ciphertext, err := base64.StdEncoding.DecodeString(envelope.Ciphertext)
	if err != nil {
		return nil, err
	}

	block, err := aes.NewCipher(c.key)
	if err != nil {
		return nil, err
	}
	gcm, err := cipher.NewGCM(block)
	if err != nil {
		return nil, err
	}

	return gcm.Open(nil, nonce, ciphertext, nil)
}

func (c Codec) encode(data []byte) ([]byte, error) {
	if len(c.key) == 0 {
		return data, nil
	}

	block, err := aes.NewCipher(c.key)
	if err != nil {
		return nil, err
	}
	gcm, err := cipher.NewGCM(block)
	if err != nil {
		return nil, err
	}

	nonce := make([]byte, gcm.NonceSize())
	if _, err := io.ReadFull(rand.Reader, nonce); err != nil {
		return nil, err
	}
	ciphertext := gcm.Seal(nil, nonce, data, nil)

	envelope := encryptedEnvelope{
		Version:    1,
		Algorithm:  "aes-256-gcm",
		Nonce:      base64.StdEncoding.EncodeToString(nonce),
		Ciphertext: base64.StdEncoding.EncodeToString(ciphertext),
	}

	encoded, err := json.MarshalIndent(envelope, "", "  ")
	if err != nil {
		return nil, err
	}
	return append(encoded, '\n'), nil
}

func parseEnvelope(data []byte) (encryptedEnvelope, bool, error) {
	var envelope encryptedEnvelope
	if err := json.Unmarshal(data, &envelope); err != nil {
		return encryptedEnvelope{}, false, nil
	}
	if envelope.Nonce == "" || envelope.Ciphertext == "" {
		return encryptedEnvelope{}, false, nil
	}
	return envelope, true, nil
}
