// Text smart router — companion to the image router in handler.go.
//
// /v1/responses and /v1/chat/completions normally pass straight through to
// CPA's codex provider (cpapassthrough). But the free ChatGPT *cookie*
// accounts can't drive the Codex `/v1/responses` API (that needs a
// refresh_token OAuth token), so when CPA has no auth for the requested
// model it answers 503 "no auth available". This router catches that:
//
//  1. Try CPA first (client's own CPA-issued key preserved) — real codex
//     models served by refresh_token accounts win here.
//  2. If CPA responds 5xx (e.g. 503 no-auth) or 429 (quota), fall back to
//     the in-container image-service, which serves plain text from the
//     ChatGPT *web* conversation API using the cookie-account pool.
//  3. Any other status (2xx success, 4xx client error like a bad key) passes
//     through untouched — no second-guessing, no auth bypass.
//
// Dual-auth (handler.authorize) runs first, so even the fallback path is
// only reachable by a valid Management Key or CPA client key.
//
// Observability:
//
//	X-Text-Resolved-Backend: cpa | chatgpt2api
//	X-Text-Fallback-Trigger: status-503 | status-429 | upstream-unreachable
package imagegen

import (
	"bytes"
	"errors"
	"net/http"
	"strings"

	"github.com/seakee/cpa-manager-plus/apps/manager-server/internal/http/response"
)

// IsTextPath reports the two text routes this smart router serves. Used by
// the router to register exact paths that win over the generic /v1/* CPA
// passthrough.
func IsTextPath(path string) bool {
	return path == "/v1/responses" || path == "/v1/chat/completions"
}

// HandleText is the HTTP entry point bound under /v1/responses and
// /v1/chat/completions.
func (h *Handler) HandleText(w http.ResponseWriter, r *http.Request) {
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

	// 1. CPA codex first (real models). Preserve the client's own key.
	cpaResp, cpaErr := h.forwardToCPAClientAuth(r, body)
	if cpaErr == nil {
		defer cpaResp.Body.Close()
		if !shouldFallbackText(cpaResp.StatusCode) {
			// 2xx success or a client-side error (bad request, content
			// policy) we must not paper over. Stream through (SSE-safe).
			w.Header().Set("X-Text-Resolved-Backend", "cpa")
			flushCopyResponse(w, cpaResp)
			return
		}
	}

	// 2. CPA had no auth (5xx) / was rate-limited (429) / was unreachable.
	// Fall back to image-service web text (cookie accounts).
	chatResp, chatErr := h.forwardToChatGPT2API(r, body)
	if chatErr != nil {
		// Fallback also failed. Prefer surfacing CPA's real verdict if we
		// got one; otherwise synthesise a 503.
		if cpaErr == nil {
			w.Header().Set("X-Text-Resolved-Backend", "cpa")
			flushCopyResponse(w, cpaResp)
			return
		}
		w.Header().Set("Retry-After", "5")
		response.Error(w, http.StatusServiceUnavailable, chatErr)
		return
	}
	defer chatResp.Body.Close()
	w.Header().Set("X-Text-Resolved-Backend", "chatgpt2api")
	w.Header().Set("X-Text-Fallback-Trigger", fallbackTriggerLabel(statusOf(cpaResp), cpaErr))
	flushCopyResponse(w, chatResp)
}

// forwardToCPAClientAuth forwards to CPA's upstream preserving the client's
// own Authorization (a CPA-issued API key, which CPA validates itself).
func (h *Handler) forwardToCPAClientAuth(r *http.Request, body []byte) (*http.Response, error) {
	setup, ok, err := h.App.ManagerConfigService.ResolveSetup(r.Context())
	if err != nil {
		return nil, err
	}
	if !ok || strings.TrimSpace(setup.CPAUpstreamURL) == "" {
		return nil, errors.New("CPA upstream URL not configured")
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
	if auth := strings.TrimSpace(r.Header.Get("Authorization")); auth != "" {
		req.Header.Set("Authorization", auth)
	}
	return h.httpClient.Do(req)
}

// shouldFallbackText decides when a CPA text response should fall back to the
// image-service web-text path. Beyond the image router's 5xx/429 set, it adds
// 401: CPA emits 401 when it tries a codex account whose token is invalid for
// the Codex API (e.g. cookie accounts, which only work on the web path). This
// is safe because authorize() has already validated the client's key against
// CPA before we forward — so a 401 here is never a bad-client-key rejection,
// only a missing/dead upstream codex auth.
func shouldFallbackText(status int) bool {
	return status == http.StatusUnauthorized || shouldFallbackOnStatus(status)
}

func statusOf(resp *http.Response) int {
	if resp == nil {
		return 0
	}
	return resp.StatusCode
}

// flushCopyResponse mirrors the upstream response into the client response,
// flushing after each chunk so SSE token streams reach the client in real
// time (plain copyResponse buffers, which would stall streamed text).
func flushCopyResponse(w http.ResponseWriter, src *http.Response) {
	for k, v := range src.Header {
		if _, hop := hopByHopHeaders[strings.ToLower(k)]; hop {
			continue
		}
		for _, vv := range v {
			w.Header().Add(k, vv)
		}
	}
	w.WriteHeader(src.StatusCode)
	flusher, _ := w.(http.Flusher)
	buf := make([]byte, 4096)
	for {
		n, rerr := src.Body.Read(buf)
		if n > 0 {
			if _, werr := w.Write(buf[:n]); werr != nil {
				return
			}
			if flusher != nil {
				flusher.Flush()
			}
		}
		if rerr != nil {
			return
		}
	}
}
