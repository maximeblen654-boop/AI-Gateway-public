package mediaworkbench

import (
	"context"
	"crypto/sha256"
	"encoding/json"
	"sync"
)

type publishedValidationMemoKey struct{}

type publishedValidationMemo struct {
	mu     sync.Mutex
	values map[[sha256.Size]byte]bool
	runs   int
	reuses int
}

// WithPublishedValidationMemo starts a fresh, request-local memo of pure
// Published product validation. It never retains repository rows, resolved
// offers, admission results or reusable validation grants across requests.
func WithPublishedValidationMemo(ctx context.Context) context.Context {
	return context.WithValue(ctx, publishedValidationMemoKey{}, &publishedValidationMemo{
		values: make(map[[sha256.Size]byte]bool),
	})
}

// PublishedValidationMemoStats reports completed validation computations and
// cache hits in this request. A context without a memo reports zero counts.
func PublishedValidationMemoStats(ctx context.Context) (runs, reuses int) {
	memo, _ := ctx.Value(publishedValidationMemoKey{}).(*publishedValidationMemo)
	if memo == nil {
		return 0, 0
	}
	memo.mu.Lock()
	defer memo.mu.Unlock()
	return memo.runs, memo.reuses
}

func memoizedPublishedValidation(ctx context.Context, a *Account, productID string, validate func() bool) bool {
	memo, _ := ctx.Value(publishedValidationMemoKey{}).(*publishedValidationMemo)
	if memo == nil {
		return validate()
	}
	if ctx.Err() != nil {
		return false
	}
	// Account deliberately hides these routing fields from JSON responses.
	// Include them explicitly as well as every visible snapshot field, rather
	// than assuming an ID, revision or routing digest is a validation grant.
	var baseURL, routingFingerprint string
	var modelMapping map[string]string
	var endpointCapabilities []string
	if a != nil {
		baseURL, routingFingerprint = a.BaseURL, a.RoutingFingerprint
		modelMapping, endpointCapabilities = a.ModelMapping, a.EndpointCapabilities
	}
	snapshot, err := json.Marshal(struct {
		Account              *Account
		BaseURL              string
		ModelMapping         map[string]string
		EndpointCapabilities []string
		RoutingFingerprint   string
		ProductID            string
	}{a, baseURL, modelMapping, endpointCapabilities, routingFingerprint, productID})
	if err != nil {
		return false
	}
	key := sha256.Sum256(snapshot)
	// Serializing a request's pure computations also prevents concurrent
	// lookups of the same snapshot from redundantly running its full validator.
	memo.mu.Lock()
	defer memo.mu.Unlock()
	if ctx.Err() != nil {
		return false
	}
	if ready, ok := memo.values[key]; ok {
		if ctx.Err() != nil {
			return false
		}
		memo.reuses++
		return ready
	}
	ready := validate()
	if ctx.Err() != nil {
		return false
	}
	memo.runs++
	memo.values[key] = ready
	return ready
}
