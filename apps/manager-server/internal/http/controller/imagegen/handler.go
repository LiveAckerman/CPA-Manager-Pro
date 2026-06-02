// Package imagegen exposes a smart router behind /v1/images/generations
// and /v1/images/edits that prefers the in-container chatgpt2api /
// image-service backend and optionally falls back to the CPA upstream
// when chatgpt2api is unhealthy.
//
// Routing logic:
//
//  1. Always try chatgpt2api first — that's where free GPT accounts live
//     and it's the only path for ChatGPT-web-only models like gpt-image-2.
//  2. If chatgpt2api responds 5xx (or the connection fails altogether)
//     OR responds 429 (insufficient_quota — every pool account out)
//     AND the operator has enabled fallback AND a CPA-issued client API
//     key is configured, retry the same request against the CPA upstream's
//     /v1/images/... endpoint. CPA is expected to route to a Plus/Pro
//     account that can call the OpenAI image API directly.
//  3. Other 4xx (bad prompt, unknown model, content policy) pass through
//     untouched: silent retry on CPA would just double the cost.
//
// Today's deployment has chatgpt2api only — the fallback path lies
// dormant until the operator adds Plus/Pro accounts to CPA and signs an
// image-capable client API key. Flipping IMAGE_CPA_FALLBACK_ENABLED=true
// + setting CPA_IMAGE_API_KEY activates fallback with no client change.
//
// Observability headers on every response:
//
//	X-Image-Resolved-Backend: chatgpt2api | cpa
//	X-Image-Fallback-Trigger: status-503 | status-429 | upstream-unreachable
//	X-Image-Fallback-Skipped: disabled | no-cpa-key | no-cpa-upstream
//
// Dual auth: see dual_auth.go.
package imagegen

import (
	"bytes"
	"context"
	"errors"
	"fmt"
	"io"
	"net/http"
	"strings"
	"time"

	"github.com/seakee/cpa-manager-plus/apps/manager-server/internal/app"
	"github.com/seakee/cpa-manager-plus/apps/manager-server/internal/http/response"
)

const (
	// maxRequestBytes caps how much of an inbound /v1/images/* body we'll
	// buffer. We must buffer to replay the request on fallback. 50 MiB
	// comfortably covers high-res / multi-reference image-edit uploads
	// while still protecting the proxy from accidental gigabyte uploads.
	maxRequestBytes = 50 * 1024 * 1024

	// requestTimeout bounds the wall-clock time for a single upstream
	// attempt. Image generation is slow; 5 minutes accommodates the worst
	// case.
	requestTimeout = 5 * time.Minute
)

// Handler is constructed once at router setup with a shared http.Client
// (one timeout, pooled connections) and the upstream addresses pulled
// from app.Context. The validator inside the dual-auth check has its own
// 5-minute TTL cache for positive CPA key validations.
type Handler struct {
	App        *app.Context
	httpClient *http.Client
	validator  *apiKeyValidator
}

func New(appCtx *app.Context) *Handler {
	return &Handler{
		App:        appCtx,
		httpClient: &http.Client{Timeout: requestTimeout},
		validator:  newAPIKeyValidator(),
	}
}

// Handle is the HTTP entry point bound in the router under both
// /v1/images/generations and /v1/images/edits.
func (h *Handler) Handle(w http.ResponseWriter, r *http.Request) {
	if !h.authorize(w, r) {
		return
	}
	if r.Method != http.MethodPost {
		response.MethodNotAllowed(w)
		return
	}
	body, ok := readBodyWithCap(w, r)
	if !ok {
		return
	}
	h.dispatch(w, r, body)
}

func readBodyWithCap(w http.ResponseWriter, r *http.Request) ([]byte, bool) {
	body, err := io.ReadAll(io.LimitReader(r.Body, int64(maxRequestBytes)+1))
	_ = r.Body.Close()
	if err != nil {
		response.Error(w, http.StatusBadRequest, err)
		return nil, false
	}
	if len(body) > maxRequestBytes {
		response.Error(w, http.StatusRequestEntityTooLarge,
			fmt.Errorf("request body exceeds %d-byte limit", maxRequestBytes))
		return nil, false
	}
	return body, true
}

func (h *Handler) dispatch(w http.ResponseWriter, r *http.Request, body []byte) {
	chatResp, chatErr := h.forwardToChatGPT2API(r, body)
	chatStatus := 0
	if chatResp != nil {
		chatStatus = chatResp.StatusCode
		defer chatResp.Body.Close()
	}
	primaryFailed := chatErr != nil || shouldFallbackOnStatus(chatStatus)
	if !primaryFailed {
		// chatgpt2api succeeded (2xx) or returned a client-side error we
		// shouldn't second-guess (most 4xx). Pass through untouched.
		w.Header().Set("X-Image-Resolved-Backend", "chatgpt2api")
		copyResponse(w, chatResp)
		return
	}

	if reason := h.fallbackIneligibleReason(r.Context()); reason != "" {
		// Fallback unavailable. Surface chatgpt2api's verdict verbatim (or
		// synthesise 503 if it never even managed to respond), and explain
		// in a header why we didn't try CPA.
		w.Header().Set("X-Image-Resolved-Backend", "chatgpt2api")
		w.Header().Set("X-Image-Fallback-Skipped", reason)
		if chatErr != nil {
			w.Header().Set("Retry-After", "5")
			response.Error(w, http.StatusServiceUnavailable, chatErr)
			return
		}
		copyResponse(w, chatResp)
		return
	}

	// Retry on CPA. Always announce that this response came from the
	// fallback path so callers can attribute the cost / latency / model
	// difference correctly.
	cpaResp, cpaErr := h.forwardToCPA(r, body)
	w.Header().Set("X-Image-Resolved-Backend", "cpa")
	w.Header().Set("X-Image-Fallback-Trigger", fallbackTriggerLabel(chatStatus, chatErr))
	if cpaErr != nil {
		w.Header().Set("Retry-After", "5")
		response.Error(w, http.StatusServiceUnavailable, cpaErr)
		return
	}
	defer cpaResp.Body.Close()
	copyResponse(w, cpaResp)
}

// shouldFallbackOnStatus decides whether a given chatgpt2api response
// status should trigger a CPA retry.
//
//   - 5xx: chatgpt2api itself is broken (process down, internal error).
//     CPA is genuinely different infra and worth trying.
//   - 429: rate-limit / quota exhaustion. chatgpt2api emits
//     "insufficient_quota" as 429 when every pool account is either
//     rate-limited or absent — exactly the "no chatgpt2api channel"
//     condition where CPA's Plus/Pro path is the intended fallback.
//
// All other 4xx pass through untouched.
func shouldFallbackOnStatus(status int) bool {
	return status >= 500 || status == http.StatusTooManyRequests
}

func fallbackTriggerLabel(chatStatus int, chatErr error) string {
	if chatErr != nil {
		return "upstream-unreachable"
	}
	return fmt.Sprintf("status-%d", chatStatus)
}

// fallbackIneligibleReason returns "" when fallback can fire, or a short
// tag explaining the missing prerequisite. Order matters: cheapest check
// (in-process bool) runs first.
func (h *Handler) fallbackIneligibleReason(ctx context.Context) string {
	if !h.App.Config.ImageCPAFallbackEnabled {
		return "disabled"
	}
	if strings.TrimSpace(h.App.Config.CPAImageAPIKey) == "" {
		return "no-cpa-key"
	}
	setup, ok, err := h.App.ManagerConfigService.ResolveSetup(ctx)
	if err != nil {
		return "setup-load-error"
	}
	if !ok || strings.TrimSpace(setup.CPAUpstreamURL) == "" {
		return "no-cpa-upstream"
	}
	return ""
}

func (h *Handler) forwardToChatGPT2API(r *http.Request, body []byte) (*http.Response, error) {
	upstreamURL := strings.TrimSpace(h.App.Config.ChatGPT2APIUpstreamURL)
	if upstreamURL == "" {
		return nil, errors.New("chatgpt2api upstream URL not configured")
	}
	target := strings.TrimRight(upstreamURL, "/") + r.URL.Path
	if r.URL.RawQuery != "" {
		target += "?" + r.URL.RawQuery
	}
	req, err := http.NewRequestWithContext(r.Context(), r.Method, target, bytes.NewReader(body))
	if err != nil {
		return nil, err
	}
	copyForwardedHeaders(req.Header, r.Header)
	if k := strings.TrimSpace(h.App.Config.ChatGPT2APIInternalKey); k != "" {
		req.Header.Set("Authorization", "Bearer "+k)
	}
	return h.httpClient.Do(req)
}

func (h *Handler) forwardToCPA(r *http.Request, body []byte) (*http.Response, error) {
	setup, _, err := h.App.ManagerConfigService.ResolveSetup(r.Context())
	if err != nil {
		return nil, err
	}
	target := strings.TrimRight(setup.CPAUpstreamURL, "/") + r.URL.Path
	if r.URL.RawQuery != "" {
		target += "?" + r.URL.RawQuery
	}
	req, err := http.NewRequestWithContext(r.Context(), r.Method, target, bytes.NewReader(body))
	if err != nil {
		return nil, err
	}
	copyForwardedHeaders(req.Header, r.Header)
	req.Header.Set("Authorization", "Bearer "+h.App.Config.CPAImageAPIKey)
	return h.httpClient.Do(req)
}

// hopByHopHeaders are RFC 7230 §6.1 headers that must NOT cross a proxy
// boundary. Plus "Host", which net/http sets correctly from the URL.
var hopByHopHeaders = map[string]struct{}{
	"connection":          {},
	"proxy-connection":    {},
	"keep-alive":          {},
	"proxy-authenticate":  {},
	"proxy-authorization": {},
	"te":                  {},
	"trailer":             {},
	"transfer-encoding":   {},
	"upgrade":             {},
	"host":                {},
}

// copyForwardedHeaders copies request headers from src into dst, omitting
// Authorization (we always set our own) and hop-by-hop headers.
func copyForwardedHeaders(dst, src http.Header) {
	for k, v := range src {
		if strings.EqualFold(k, "Authorization") {
			continue
		}
		if _, hop := hopByHopHeaders[strings.ToLower(k)]; hop {
			continue
		}
		for _, vv := range v {
			dst.Add(k, vv)
		}
	}
}

// copyResponse mirrors the upstream response (sans hop-by-hop headers)
// into the client response. Caller is expected to have already set any
// X-Image-* informational headers before invoking.
func copyResponse(w http.ResponseWriter, src *http.Response) {
	for k, v := range src.Header {
		if _, hop := hopByHopHeaders[strings.ToLower(k)]; hop {
			continue
		}
		for _, vv := range v {
			w.Header().Add(k, vv)
		}
	}
	w.WriteHeader(src.StatusCode)
	_, _ = io.Copy(w, src.Body)
}
