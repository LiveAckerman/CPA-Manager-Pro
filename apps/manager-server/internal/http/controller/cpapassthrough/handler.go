// Package cpapassthrough is a transparent reverse proxy for OpenAI-API
// shaped routes (/v1/responses, /v1/chat/completions, /v1/embeddings,
// /v1/audio/*, /v1/files/*, /v1/threads/*, /v1/vector_stores/*, ...).
//
// Each request is forwarded to the configured CPA upstream with the
// client's Authorization header preserved verbatim. Unlike the admin
// /v0/management/* proxy (which substitutes the stored Management Key),
// this surface is meant for downstream API consumers — they hold a
// CPA-issued client API key, CPA validates it itself.
//
// Why this exists
//
// Upstream CPA-Manager only proxied /v0/management/* + /v1/models.
// Tools like sub2api probe additional /v1/* paths (typically
// /v1/responses) to detect upstream capabilities; the panel used to
// return 404 for every unknown path and the aggregator concluded the
// upstream didn't support the Responses API even though CPA itself does.
// This closes that gap so callers can point at the panel URL the same
// way they'd point at CPA.
//
// Routes that pre-empt this passthrough (matched earlier in handleRoot):
//   - /v1/models                  ->  ProxyService.ProxyModelList
//   - /v1/images/generations|edits -> smart router (imagegen package)
//   - /openai/v1/...              ->  chatgpt2api passthrough (imageproxy)
//   - /v0/management/*            ->  admin proxy / handlers
//
// Streaming: chat completions and Responses API commonly use SSE.
// httputil.ReverseProxy flushes streamed bytes automatically.
package cpapassthrough

import (
	"errors"
	"net/http"
	"net/http/httputil"
	"net/url"
	"strings"

	"github.com/seakee/cpa-manager-plus/apps/manager-server/internal/app"
	"github.com/seakee/cpa-manager-plus/apps/manager-server/internal/http/response"
)

type Handler struct {
	App *app.Context
}

// IsPath reports whether the given request path is one this passthrough
// should handle. Called from handleRoot AFTER more specific dispatchers
// (model-list shortcut, image routes, etc.) have had their chance.
func IsPath(path string) bool {
	return strings.HasPrefix(path, "/v1/")
}

func (h *Handler) Handle(w http.ResponseWriter, r *http.Request) {
	// Resolve CPA upstream the same way ProxyService does — via the saved
	// setup row. We don't need ManagementKey here (client supplies its own
	// CPA-issued API key), so we re-implement the lookup rather than reusing
	// proxyWithSavedManagementKey (which force-overrides Authorization).
	setup, ok, err := h.App.ManagerConfigService.ResolveSetup(r.Context())
	if err != nil {
		response.Error(w, http.StatusInternalServerError, err)
		return
	}
	if !ok || strings.TrimSpace(setup.CPAUpstreamURL) == "" {
		response.Error(w, http.StatusPreconditionRequired,
			errors.New("usage service is not configured"))
		return
	}
	target, err := url.Parse(setup.CPAUpstreamURL)
	if err != nil {
		response.Error(w, http.StatusInternalServerError, err)
		return
	}
	proxy := httputil.NewSingleHostReverseProxy(target)
	originalDirector := proxy.Director
	proxy.Director = func(req *http.Request) {
		originalDirector(req)
		req.URL.Scheme = target.Scheme
		req.URL.Host = target.Host
		req.Host = target.Host
		// Authorization is intentionally NOT modified — we forward the
		// client's CPA-issued API key as-is; CPA validates it itself.
	}
	proxy.ErrorHandler = func(w http.ResponseWriter, _ *http.Request, err error) {
		response.Error(w, http.StatusBadGateway, err)
	}
	proxy.ServeHTTP(w, r)
}
