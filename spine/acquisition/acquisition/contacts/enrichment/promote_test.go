package enrich

import (
	"testing"
)

func TestParsePgArray_Empty(t *testing.T) {
	if r := parsePgArray(""); r != nil {
		t.Errorf("empty string: want nil, got %v", r)
	}
	if r := parsePgArray("{}"); r != nil {
		t.Errorf("{}: want nil, got %v", r)
	}
}

func TestParsePgArray_Single(t *testing.T) {
	r := parsePgArray("{machinery}")
	if len(r) != 1 || r[0] != "machinery" {
		t.Errorf("single element: got %v", r)
	}
}

func TestParsePgArray_Multiple(t *testing.T) {
	r := parsePgArray("{machinery,metalwork,construction}")
	if len(r) != 3 {
		t.Fatalf("expected 3, got %d: %v", len(r), r)
	}
	if r[0] != "machinery" { t.Errorf("r[0]: %s", r[0]) }
	if r[1] != "metalwork" { t.Errorf("r[1]: %s", r[1]) }
	if r[2] != "construction" { t.Errorf("r[2]: %s", r[2]) }
}

func TestParsePgArray_WithSpaces(t *testing.T) {
	r := parsePgArray("{ machinery , metalwork }")
	if len(r) != 2 {
		t.Fatalf("expected 2, got %d: %v", len(r), r)
	}
	if r[0] != "machinery" { t.Errorf("r[0]: %q", r[0]) }
	if r[1] != "metalwork" { t.Errorf("r[1]: %q", r[1]) }
}

func TestParsePgArray_SingleElement(t *testing.T) {
	r := parsePgArray("{automotive}")
	if len(r) != 1 || r[0] != "automotive" {
		t.Errorf("got %v", r)
	}
}

func TestTagsFromStrings_Empty(t *testing.T) {
	r := tagsFromStrings(nil, 0.9)
	if r != nil {
		t.Errorf("nil input: want nil, got %v", r)
	}
}

func TestTagsFromStrings_Single(t *testing.T) {
	r := tagsFromStrings([]string{"machinery"}, 0.85)
	if len(r) != 1 {
		t.Fatalf("expected 1, got %d", len(r))
	}
	if r[0].Tag != "machinery" {
		t.Errorf("tag: %s", r[0].Tag)
	}
	if r[0].Confidence != 0.85 {
		t.Errorf("confidence: %f", r[0].Confidence)
	}
}

func TestTagsFromStrings_Multiple(t *testing.T) {
	r := tagsFromStrings([]string{"machinery", "metalwork", "construction"}, 0.7)
	if len(r) != 3 {
		t.Fatalf("expected 3, got %d", len(r))
	}
	// All should share the same confidence
	for i, tag := range r {
		if tag.Confidence != 0.7 {
			t.Errorf("r[%d].Confidence = %f, want 0.7", i, tag.Confidence)
		}
	}
	if r[0].Tag != "machinery" { t.Errorf("r[0]: %s", r[0].Tag) }
	if r[1].Tag != "metalwork" { t.Errorf("r[1]: %s", r[1].Tag) }
	if r[2].Tag != "construction" { t.Errorf("r[2]: %s", r[2].Tag) }
}

func TestTagsFromStrings_ZeroConfidence(t *testing.T) {
	r := tagsFromStrings([]string{"machinery"}, 0.0)
	if len(r) != 1 || r[0].Confidence != 0.0 {
		t.Errorf("zero confidence not preserved: %v", r)
	}
}

func TestPromoteConfig_Defaults(t *testing.T) {
	cfg := PromoteConfig{}
	// BatchSize default is 5000
	if cfg.BatchSize != 0 {
		t.Errorf("unset BatchSize: %d", cfg.BatchSize)
	}
	// ICPTiers default is empty (applied inside PromoteCompanies)
	if len(cfg.ICPTiers) != 0 {
		t.Errorf("ICPTiers should start empty")
	}
}

func TestPromoteResult_ZeroValue(t *testing.T) {
	r := PromoteResult{}
	if r.Queried != 0 || r.Created != 0 || r.Updated != 0 || r.Skipped != 0 || r.Errors != 0 {
		t.Error("zero value should have all counters at 0")
	}
}
