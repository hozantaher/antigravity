package relay

import (
	"relay/internal/deaddrop"
	"relay/internal/transport/fragment"
	"relay/internal/shamir"
	"bytes"
	"context"
	"crypto/tls"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"time"
)

// RelayEndpoint represents one independent relay in the multi-path network.
type RelayEndpoint struct {
	URL         string `json:"url"`
	InsecureTLS bool   `json:"insecure_tls,omitempty"`
}

// MultiPathRouter distributes message fragments across multiple independent relays.
// Each relay receives a disjoint subset of Shamir shares. No single relay
// sees enough shares to reconstruct the message.
type MultiPathRouter struct {
	relays []RelayEndpoint
	client *http.Client
}

// NewMultiPathRouter creates a router with the given relay endpoints.
func NewMultiPathRouter(relays []RelayEndpoint) *MultiPathRouter {
	transport := &http.Transport{
		TLSClientConfig: &tls.Config{InsecureSkipVerify: false},
	}
	return &MultiPathRouter{
		relays: relays,
		client: &http.Client{Timeout: 30 * time.Second, Transport: transport},
	}
}

// Route distributes fragments across relays using round-robin assignment.
// share[0] → relay[0], share[1] → relay[1], etc.
func (r *MultiPathRouter) Route(ctx context.Context, fragments []fragment.FragmentedShare) error {
	if len(r.relays) == 0 {
		return fmt.Errorf("no relay endpoints configured")
	}

	for i, frag := range fragments {
		relay := r.relays[i%len(r.relays)]
		if err := r.postToRelay(ctx, relay, frag); err != nil {
			return fmt.Errorf("relay %d (%s): %w", i, relay.URL, err)
		}
	}

	return nil
}

// postToRelay posts one fragment's share data to a relay's dead drop slot.
func (r *MultiPathRouter) postToRelay(ctx context.Context, relay RelayEndpoint, frag fragment.FragmentedShare) error {
	slotHex := hex.EncodeToString(frag.SlotID[:])
	url := relay.URL + "/v1/drop/" + slotHex

	payload, err := json.Marshal(map[string]string{
		"data": hex.EncodeToString(frag.Share.Data),
	})
	if err != nil {
		return err
	}

	req, err := http.NewRequestWithContext(ctx, http.MethodPost, url, bytes.NewReader(payload))
	if err != nil {
		return err
	}
	req.Header.Set("Content-Type", "application/json")

	resp, err := r.client.Do(req)
	if err != nil {
		return err
	}
	defer resp.Body.Close()
	io.ReadAll(io.LimitReader(resp.Body, 256))

	if resp.StatusCode >= 400 {
		return fmt.Errorf("relay returned %d", resp.StatusCode)
	}

	return nil
}

// PollFromRelays collects fragment shares from multiple relays.
func (r *MultiPathRouter) PollFromRelays(ctx context.Context, slotIDs []deaddrop.SlotID) ([]fragment.FragmentedShare, error) {
	var collected []fragment.FragmentedShare

	for i, slotID := range slotIDs {
		relay := r.relays[i%len(r.relays)]
		shares, err := r.pollRelay(ctx, relay, slotID, i)
		if err != nil {
			continue // some relays may be down -- collect what we can
		}
		collected = append(collected, shares...)
	}

	return collected, nil
}

func (r *MultiPathRouter) pollRelay(ctx context.Context, relay RelayEndpoint, slotID deaddrop.SlotID, index int) ([]fragment.FragmentedShare, error) {
	slotHex := hex.EncodeToString(slotID[:])
	url := relay.URL + "/v1/drop/" + slotHex

	req, err := http.NewRequestWithContext(ctx, http.MethodGet, url, nil)
	if err != nil {
		return nil, err
	}

	resp, err := r.client.Do(req)
	if err != nil {
		return nil, err
	}
	defer resp.Body.Close()

	body, err := io.ReadAll(io.LimitReader(resp.Body, 1024*1024))
	if err != nil {
		return nil, err
	}

	var pollResp struct {
		Messages []string `json:"messages"`
	}
	if err := json.Unmarshal(body, &pollResp); err != nil {
		return nil, err
	}

	var fragments []fragment.FragmentedShare
	for _, hexMsg := range pollResp.Messages {
		data, err := hex.DecodeString(hexMsg)
		if err != nil {
			continue
		}
		fragments = append(fragments, fragment.FragmentedShare{
			Index:  index,
			SlotID: slotID,
			Share:  shamir.Share{X: byte(index + 1), Data: data},
		})
	}

	return fragments, nil
}
