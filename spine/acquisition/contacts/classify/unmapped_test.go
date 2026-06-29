package classify

import "testing"

func TestRecordUnmappedCategoryPath_NoPanic(t *testing.T) {
	// Exercises slog.Debug call — ensures no panic on various inputs.
	recordUnmappedCategoryPath("Strojirenstvi > Nezname > Odvetvi")
	recordUnmappedCategoryPath("")
}
