package metamin

import (
	"relay/internal/model"
	"crypto/rand"
	"time"
)

// Minimizer reduces metadata to prevent correlation and fingerprinting.
type Minimizer struct {
	bucketDuration time.Duration
}

// NewMinimizer creates a minimizer with 15-minute timestamp bucketing.
func NewMinimizer() *Minimizer {
	return &Minimizer{bucketDuration: 15 * time.Minute}
}

// BucketTime truncates a timestamp to the configured boundary.
func (m *Minimizer) BucketTime(t time.Time) time.Time {
	return t.UTC().Truncate(m.bucketDuration)
}

// PadToSizeClass pads data to the selected size class with random bytes.
// This ensures all envelopes of the same class are indistinguishable by size.
//
// Oversize handling: the largest size class is SizeClass32K, which fits at most
// SizeClass32K-4 bytes of payload alongside the 4-byte length prefix. When the
// payload exceeds that, the content cannot be represented — PadToSizeClass
// returns (nil, 0) rather than silently truncating the data and writing a
// length prefix larger than the buffer (which UnpadFromSizeClass would later
// reject, dropping an already-accepted envelope). Callers MUST treat a (nil, 0)
// result / sizeClass == 0 as an oversize rejection and refuse the content up
// front instead of enqueueing it.
func (m *Minimizer) PadToSizeClass(data []byte) ([]byte, int) {
	if len(data)+4 > model.SizeClass32K {
		return nil, 0
	}
	sc := model.SelectSizeClass(len(data) + 4) // 4 bytes for length prefix
	padded := make([]byte, sc)

	// First 4 bytes: big-endian length of actual data
	dataLen := len(data)
	padded[0] = byte(dataLen >> 24)
	padded[1] = byte(dataLen >> 16)
	padded[2] = byte(dataLen >> 8)
	padded[3] = byte(dataLen)

	copy(padded[4:], data)

	// Fill remainder with random padding
	if remaining := sc - 4 - dataLen; remaining > 0 {
		rand.Read(padded[4+dataLen:])
	}

	return padded, sc
}

// UnpadFromSizeClass extracts the original data from a padded envelope.
func (m *Minimizer) UnpadFromSizeClass(padded []byte) []byte {
	if len(padded) < 4 {
		return nil
	}
	dataLen := int(padded[0])<<24 | int(padded[1])<<16 | int(padded[2])<<8 | int(padded[3])
	if dataLen < 0 || dataLen+4 > len(padded) {
		return nil
	}
	result := make([]byte, dataLen)
	copy(result, padded[4:4+dataLen])
	return result
}

// MinimizeEnvelope applies metadata minimization to an envelope.
func (m *Minimizer) MinimizeEnvelope(env *model.Envelope) {
	env.BucketedAt = m.BucketTime(time.Now())
}
