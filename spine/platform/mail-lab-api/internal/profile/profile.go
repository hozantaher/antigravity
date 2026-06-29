// Package profile implements per-provider acceptance rules for Mail Lab
// (initiative ML2.2). Profiles are loaded from JSON at boot and held in
// memory; runtime overrides via Apply(...) merge new values on top
// without persistence — operator restarts the API to reset to baseline.
//
// Three providers ship with the default install (seznam.lab, gmail.lab,
// outlook.lab) but the API surface is open to any domain so test
// scenarios can register synthetic providers if needed.
package profile

import (
	"embed"
	"encoding/json"
	"errors"
	"fmt"
	"io/fs"
	"strings"
	"sync"
	"time"
)

// Profile is the declarative behavior contract for one mail provider.
//
// Pointer-typed bool fields would let an override leave a field unchanged
// vs. set-to-false, but since chaos tests overwhelmingly toggle fields
// to specific values, we use plain types and treat zero-values as
// "explicit false / no list". The override-tracking flag is the per-key
// presence in the request JSON, not a tri-state pointer.
type Profile struct {
	Domain                string   `json:"domain"`
	MaxMessageSizeBytes   int64    `json:"max_message_size_bytes"`
	MailboxQuotaBytes     int64    `json:"mailbox_quota_bytes"`
	RateLimitPerHour      int      `json:"rate_limit_per_hour"`
	RejectNonCzOrigin     bool     `json:"reject_non_cz_origin"`
	GreylistUnknownSender bool     `json:"greylist_unknown_sender"`
	SpamClassifyLinkRatio float64  `json:"spam_classify_link_ratio"`
	RejectProxyIpsCidr    []string `json:"reject_proxy_ips_cidr"`
	BounceKindOnReject    string   `json:"bounce_kind_on_reject"`
	DkimStrictness        string   `json:"dkim_strictness"`
	AutoReplyEnabled      bool     `json:"auto_reply_enabled"`
}

// ErrUnknownDomain is returned when the registry has no profile for a
// requested domain. Callers map this to HTTP 404.
var ErrUnknownDomain = errors.New("profile: unknown domain")

//go:embed defaults/*.json
var embeddedDefaults embed.FS

// Registry holds the active profile set, guarded by RWMutex so chaos
// scenarios can reset / override concurrently without races.
//
// Tracker (ML2.5) is composed in to give a single source of truth for
// the per-mailbox sliding-window send counter. Lives alongside the
// profile map so callers don't have to plumb two dependencies.
type Registry struct {
	mu       sync.RWMutex
	profiles map[string]*Profile
	tracker  *Tracker
	greylist *GreylistTracker
	quota    *QuotaTracker
}

// NewRegistry creates an empty registry. Use Load(...) to populate from
// disk before serving requests.
func NewRegistry() *Registry {
	return &Registry{
		profiles: map[string]*Profile{},
		tracker:  NewTracker(time.Hour),
		greylist: NewGreylistTracker(5*time.Minute, 35*24*time.Hour),
		quota:    NewQuotaTracker(),
	}
}

// Load reads every *.json file from the given directory, parses each as
// a Profile, and registers it under its `domain` field. Returns the
// number of profiles loaded plus any error from the FIRST file that
// failed (subsequent files are skipped on error to avoid masking).
//
// Files with no `domain` are skipped with a non-fatal warning result —
// the caller can decide whether an empty profile is worth aborting boot.
func (r *Registry) Load(dir string) (int, error) {
	entries, err := readJSONDir(dir)
	if err != nil {
		return 0, fmt.Errorf("profile: read dir %s: %w", dir, err)
	}
	r.mu.Lock()
	defer r.mu.Unlock()
	for _, e := range entries {
		var p Profile
		if err := json.Unmarshal(e.data, &p); err != nil {
			return 0, fmt.Errorf("profile: parse %s: %w", e.name, err)
		}
		if p.Domain == "" {
			continue
		}
		r.profiles[strings.ToLower(p.Domain)] = &p
	}
	return len(r.profiles), nil
}

// LoadEmbedded falls back to compiled-in defaults — useful when the
// service runs in a container without the profile directory mounted.
// Looks up files at defaults/*.json relative to the package.
func (r *Registry) LoadEmbedded() (int, error) {
	files, err := fs.ReadDir(embeddedDefaults, "defaults")
	if err != nil {
		return 0, fmt.Errorf("profile: read embedded defaults: %w", err)
	}
	r.mu.Lock()
	defer r.mu.Unlock()
	for _, f := range files {
		if !strings.HasSuffix(f.Name(), ".json") {
			continue
		}
		data, err := fs.ReadFile(embeddedDefaults, "defaults/"+f.Name())
		if err != nil {
			return 0, fmt.Errorf("profile: read embedded %s: %w", f.Name(), err)
		}
		var p Profile
		if err := json.Unmarshal(data, &p); err != nil {
			return 0, fmt.Errorf("profile: parse embedded %s: %w", f.Name(), err)
		}
		if p.Domain == "" {
			continue
		}
		r.profiles[strings.ToLower(p.Domain)] = &p
	}
	return len(r.profiles), nil
}

// Get returns a copy of the profile for a domain (case-insensitive).
// Return type is `any` to satisfy the HTTP handler's ProfileRegistry
// interface without an adapter; callers needing the concrete type can
// type-assert via *profile.Profile.
//
// Returning a copy prevents callers from accidentally mutating the
// in-memory registry without going through Apply.
func (r *Registry) Get(domain string) (any, error) {
	r.mu.RLock()
	defer r.mu.RUnlock()
	p, ok := r.profiles[strings.ToLower(domain)]
	if !ok {
		return nil, ErrUnknownDomain
	}
	clone := *p
	if p.RejectProxyIpsCidr != nil {
		clone.RejectProxyIpsCidr = append([]string{}, p.RejectProxyIpsCidr...)
	}
	return &clone, nil
}

// List returns every registered profile (as []any so callers can pass
// straight to JSON marshaling without a copy step).
func (r *Registry) List() []any {
	r.mu.RLock()
	defer r.mu.RUnlock()
	out := make([]any, 0, len(r.profiles))
	for _, p := range r.profiles {
		clone := *p
		if p.RejectProxyIpsCidr != nil {
			clone.RejectProxyIpsCidr = append([]string{}, p.RejectProxyIpsCidr...)
		}
		out = append(out, &clone)
	}
	return out
}

// Apply merges the override map into the profile. Only fields present in
// the override map (decoded raw JSON keys) are touched; everything else
// retains its previous value. Returns the post-override profile.
//
// We re-marshal the existing profile, merge the override JSON on top,
// then unmarshal back. This is a tiny perf hit but keeps the merge
// strict: any new field added to Profile picks up override behavior
// automatically.
func (r *Registry) Apply(domain string, override map[string]interface{}) (any, error) {
	r.mu.Lock()
	defer r.mu.Unlock()
	p, ok := r.profiles[strings.ToLower(domain)]
	if !ok {
		return nil, ErrUnknownDomain
	}
	base, err := json.Marshal(p)
	if err != nil {
		return nil, fmt.Errorf("profile: marshal base: %w", err)
	}
	var merged map[string]interface{}
	if err := json.Unmarshal(base, &merged); err != nil {
		return nil, fmt.Errorf("profile: unmarshal base: %w", err)
	}
	for k, v := range override {
		merged[k] = v
	}
	mb, err := json.Marshal(merged)
	if err != nil {
		return nil, fmt.Errorf("profile: marshal merged: %w", err)
	}
	var next Profile
	if err := json.Unmarshal(mb, &next); err != nil {
		return nil, fmt.Errorf("profile: unmarshal merged: %w", err)
	}
	r.profiles[strings.ToLower(domain)] = &next
	clone := next
	if next.RejectProxyIpsCidr != nil {
		clone.RejectProxyIpsCidr = append([]string{}, next.RejectProxyIpsCidr...)
	}
	return &clone, nil
}

// Reset reverts the registry to its boot state by re-reading the source
// files. Used by chaos-test cleanup so each scenario starts on a fresh
// profile baseline.
func (r *Registry) Reset(dir string) error {
	r.mu.Lock()
	r.profiles = map[string]*Profile{}
	r.mu.Unlock()
	_, err := r.Load(dir)
	return err
}

// ResetAll clears every runtime tracker (rate, greylist, quota) and
// reloads profiles from `source`. When source is "embedded", the
// compiled-in defaults are used; otherwise it's treated as a directory
// path and re-read with Load. Used by the operator /v1/profile/reset
// endpoint between chaos scenarios.
func (r *Registry) ResetAll(source string) error {
	r.RateReset()
	r.GreylistReset()
	r.QuotaReset()
	r.mu.Lock()
	r.profiles = map[string]*Profile{}
	r.mu.Unlock()
	if source == "embedded" {
		_, err := r.LoadEmbedded()
		return err
	}
	_, err := r.Load(source)
	return err
}
