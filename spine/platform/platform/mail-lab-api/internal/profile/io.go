package profile

import (
	"os"
	"path/filepath"
	"strings"
)

// readJSONDir reads every *.json entry in dir. Sorted by filename so
// load order is deterministic across runs (matters for repeatable
// chaos-test seeds).
type jsonFile struct {
	name string
	data []byte
}

func readJSONDir(dir string) ([]jsonFile, error) {
	if _, err := os.Stat(dir); err != nil {
		return nil, err
	}
	matches, err := filepath.Glob(filepath.Join(dir, "*.json"))
	if err != nil {
		return nil, err
	}
	out := make([]jsonFile, 0, len(matches))
	for _, path := range matches {
		// Skip hidden files (operator might `cp default.json .swp` mid-edit).
		if strings.HasPrefix(filepath.Base(path), ".") {
			continue
		}
		data, err := os.ReadFile(path)
		if err != nil {
			return nil, err
		}
		out = append(out, jsonFile{name: path, data: data})
	}
	return out, nil
}
