package traffic

import (
	"relay/internal/model"
	"crypto/rand"
	"encoding/hex"
	"time"
)

// CoverGenerator produces dummy envelopes indistinguishable from real ones by size.
type CoverGenerator struct {
	now func() time.Time
}

func NewCoverGenerator() *CoverGenerator {
	return &CoverGenerator{now: time.Now}
}

// Generate creates a cover envelope of the given size class.
// Cover envelopes have IsCover=true and contain random data.
func (g *CoverGenerator) Generate(sizeClass int) model.Envelope {
	content := make([]byte, sizeClass)
	rand.Read(content)

	id := make([]byte, 8)
	rand.Read(id)

	token := make([]byte, 16)
	rand.Read(token)

	return model.Envelope{
		ID:            "env_" + hex.EncodeToString(id),
		AliasToken:    hex.EncodeToString(token),
		SealedContent: content,
		SizeClass:     sizeClass,
		BucketedAt:    g.now().UTC().Truncate(15 * time.Minute),
		IntakeChannel: "cover",
		Status:        model.StatusScheduled,
		IsCover:       true,
	}
}

// GenerateBatch creates multiple cover envelopes distributed across size classes.
func (g *CoverGenerator) GenerateBatch(count int) []model.Envelope {
	classes := model.SizeClasses()
	result := make([]model.Envelope, count)
	for i := 0; i < count; i++ {
		sc := classes[i%len(classes)]
		result[i] = g.Generate(sc)
	}
	return result
}
