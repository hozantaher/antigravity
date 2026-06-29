package probe

import "encoding/json"

// countWorkingProxies extracts the length of the "working" array from a
// BFF /api/proxy-pool response. Tolerant of missing / malformed bodies:
// on any parse error it returns 0 (surfaces as status=err upstream).
func countWorkingProxies(body []byte) int {
	var payload struct {
		Working []json.RawMessage `json:"working"`
	}
	if err := json.Unmarshal(body, &payload); err != nil {
		return 0
	}
	return len(payload.Working)
}
