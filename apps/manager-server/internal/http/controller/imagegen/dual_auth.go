package imagegen

import (
	"context"
	"errors"
	"fmt"
	"net/http"
	"strings"
	"sync"
	"time"

	"github.com/seakee/cpa-manager-plus/apps/manager-server/internal/http/response"
)

// /v1/images/* dual-auth: accept either the panel's Management Key OR a
// CPA-issued client API key. Matches the auth shape clients already use
// for /v1/responses + /v1/chat/completions via cpapassthrough — operators
// configure their OpenAI SDK / sub2api with a regular sk-... key and
// image-gen "just works" without holding the admin token.
//
// Validating CPA client keys
//
// We don't have CPA's signing secret, so offline validation isn't an
// option. Instead, on first sight of a candidate key, we issue a GET to
// CPA's /v1/models with that key's Authorization header. 200 = valid;
// 4xx = invalid; 5xx / network = "couldn't validate" -> 503. A small
// TTL cache (5 min) memoises positive validations, so a key only causes
// one extra round trip per validity window. Negatives are NOT cached:
// a freshly-provisioned key works immediately; a revoked one starts
// failing within seconds.
//
// Safety
//
// Both probes (panel Management Key + CPA /v1/models with client key) are
// pure read operations. No OAuth grant endpoint is ever invoked from this
// path, and CPA's silent refresh_token rotation runs on its own schedule
// completely independent of our action.

const (
	apiKeyCacheTTL        = 5 * time.Minute
	apiKeyValidateTimeout = 8 * time.Second
)

type apiKeyValidator struct {
	httpClient *http.Client
	cache      sync.Map // key string -> time.Time expiresAt
	ttl        time.Duration
}

func newAPIKeyValidator() *apiKeyValidator {
	return &apiKeyValidator{
		httpClient: &http.Client{Timeout: apiKeyValidateTimeout},
		ttl:        apiKeyCacheTTL,
	}
}

// Validate asks CPA whether the given client API key is recognised.
// Returns (true, nil) for valid, (false, nil) for confirmed invalid,
// (false, err) when validation itself couldn't complete (CPA unreachable
// / 5xx) — callers should distinguish the third case so they can respond
// 503 rather than 401.
func (v *apiKeyValidator) Validate(ctx context.Context, cpaBaseURL, key string) (bool, error) {
	if strings.TrimSpace(key) == "" {
		return false, nil
	}
	if exp, ok := v.cache.Load(key); ok {
		if expAt, ok2 := exp.(time.Time); ok2 && time.Now().Before(expAt) {
			return true, nil
		}
		v.cache.Delete(key)
	}

	cpaBaseURL = strings.TrimRight(strings.TrimSpace(cpaBaseURL), "/")
	if cpaBaseURL == "" {
		return false, errors.New("CPA upstream URL is not configured")
	}

	req, err := http.NewRequestWithContext(ctx, http.MethodGet, cpaBaseURL+"/v1/models", nil)
	if err != nil {
		return false, err
	}
	req.Header.Set("Authorization", "Bearer "+key)
	resp, err := v.httpClient.Do(req)
	if err != nil {
		return false, err
	}
	defer resp.Body.Close()

	switch {
	case resp.StatusCode == http.StatusOK:
		v.cache.Store(key, time.Now().Add(v.ttl))
		return true, nil
	case resp.StatusCode >= 400 && resp.StatusCode < 500:
		return false, nil
	default:
		return false, fmt.Errorf("CPA returned status %d during key validation", resp.StatusCode)
	}
}

// authorize is the dual-auth entry point. Returns true if the request
// should proceed; otherwise writes the appropriate error response and
// returns false.
func (h *Handler) authorize(w http.ResponseWriter, r *http.Request) bool {
	authHeader := r.Header.Get("Authorization")

	// Path 1: panel Management Key match — fast, no upstream call.
	ok, err := h.App.AdminAuthService.VerifyPanelHeader(r.Context(), authHeader)
	if err != nil {
		response.Error(w, http.StatusInternalServerError, err)
		return false
	}
	if ok {
		return true
	}

	// Path 2: treat as CPA client API key + validate against CPA.
	const prefix = "Bearer "
	trimmed := strings.TrimSpace(authHeader)
	if len(trimmed) <= len(prefix) || !strings.EqualFold(trimmed[:len(prefix)], prefix) {
		response.Error(w, http.StatusUnauthorized,
			errors.New("missing or malformed Authorization header"))
		return false
	}
	key := strings.TrimSpace(trimmed[len(prefix):])

	setup, setupOK, err := h.App.ManagerConfigService.ResolveSetup(r.Context())
	if err != nil {
		response.Error(w, http.StatusInternalServerError, err)
		return false
	}
	if !setupOK || strings.TrimSpace(setup.CPAUpstreamURL) == "" {
		response.Error(w, http.StatusUnauthorized, errors.New("invalid api key"))
		return false
	}

	valid, err := h.validator.Validate(r.Context(), setup.CPAUpstreamURL, key)
	if err != nil {
		w.Header().Set("Retry-After", "5")
		response.Error(w, http.StatusServiceUnavailable,
			fmt.Errorf("could not validate api key against CPA upstream: %w", err))
		return false
	}
	if !valid {
		response.Error(w, http.StatusUnauthorized, errors.New("invalid api key"))
		return false
	}
	return true
}

