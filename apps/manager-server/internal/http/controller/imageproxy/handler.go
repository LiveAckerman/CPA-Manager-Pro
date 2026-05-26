// Package imageproxy reverse-proxies a curated subset of routes to the
// chatgpt2api / image-service FastAPI process that runs alongside
// cpa-manager-plus inside the same container.
//
// Three invariants:
//
//  1. The outside world authenticates with the panel's Management Key
//     (same bearer token the rest of the admin surface uses). That
//     check happens before this proxy sees the request via
//     middleware.AuthorizePanel.
//  2. Whatever Authorization header the client supplied is dropped and
//     replaced with the per-boot internal key from config. chatgpt2api
//     never sees, accepts, or trusts the user's Management Key.
//  3. Two prefix conventions land here:
//       /openai/v1/...  -> /v1/...    (OpenAI-compatible API surface)
//       /v0/image/...   -> /api/...   (chatgpt2api admin: account pool etc.)
//     The first lets users point an OpenAI SDK at
//     base_url=http://host:18317/openai without disturbing the panel's
//     own /v1/models route. The second is reserved for the React panel's
//     image-pool page; chatgpt2api admin routes live under /api/*
//     internally, so we rewrite /v0/image/foo -> /api/foo.
package imageproxy

import (
	"errors"
	"net"
	"net/http"
	"net/http/httputil"
	"net/url"
	"strings"
	"time"

	"github.com/seakee/cpa-manager-plus/apps/manager-server/internal/app"
	"github.com/seakee/cpa-manager-plus/apps/manager-server/internal/http/middleware"
	"github.com/seakee/cpa-manager-plus/apps/manager-server/internal/http/response"
)

// Handler binds a chatGPT2APIProxy backed by app.Context's config.
// Constructed once at router setup; the inner proxy.Director closes over
// the parsed upstream URL + internal key.
type Handler struct {
	App   *app.Context
	proxy *chatGPT2APIProxy
}

// New returns (handler, nil) on success. If the upstream URL is empty
// (operator disabled the integration), returns (handler-with-nil-proxy, nil)
// — requests then short-circuit to 503 instead of NPEing.
func New(appCtx *app.Context) (*Handler, error) {
	p, err := newChatGPT2APIProxy(
		appCtx.Config.ChatGPT2APIUpstreamURL,
		appCtx.Config.ChatGPT2APIInternalKey,
	)
	if err != nil {
		return nil, err
	}
	return &Handler{App: appCtx, proxy: p}, nil
}

// Handle is the HTTP entry point bound under both /openai/ and /v0/image/
// route prefixes in router.go.
func (h *Handler) Handle(w http.ResponseWriter, r *http.Request) {
	if !middleware.AuthorizePanel(w, r, h.App.AdminAuthService) {
		return
	}
	if h.proxy == nil {
		w.Header().Set("Retry-After", "5")
		response.Error(w, http.StatusServiceUnavailable,
			errors.New("chatgpt2api proxy disabled"))
		return
	}
	h.proxy.proxy.ServeHTTP(w, r)
}

// --- internals ---------------------------------------------------------

type chatGPT2APIProxy struct {
	upstream    *url.URL
	internalKey string
	proxy       *httputil.ReverseProxy
}

func newChatGPT2APIProxy(upstreamURL, internalKey string) (*chatGPT2APIProxy, error) {
	upstreamURL = strings.TrimSpace(upstreamURL)
	if upstreamURL == "" {
		return nil, nil
	}
	u, err := url.Parse(upstreamURL)
	if err != nil {
		return nil, err
	}
	if u.Scheme == "" || u.Host == "" {
		return nil, errors.New("chatgpt2api upstream URL must include scheme and host")
	}

	p := &chatGPT2APIProxy{upstream: u, internalKey: internalKey}
	p.proxy = &httputil.ReverseProxy{
		Director:     p.director,
		ErrorHandler: p.errorHandler,
		Transport: &http.Transport{
			DialContext: (&net.Dialer{
				Timeout:   2 * time.Second,
				KeepAlive: 30 * time.Second,
			}).DialContext,
			MaxIdleConns:        100,
			MaxIdleConnsPerHost: 10,
			IdleConnTimeout:     90 * time.Second,
			// Image generation can take >30s; allow up to two minutes
			// before declaring upstream unresponsive.
			ResponseHeaderTimeout: 120 * time.Second,
		},
	}
	return p, nil
}

// StripPrefix rewrites a request path to what chatgpt2api expects, or
// returns (path, false) when no known prefix matches.
//
//	/openai/v1/foo  ->  /v1/foo     (OpenAI-compatible routes live at /v1)
//	/v0/image/foo   ->  /api/foo    (chatgpt2api admin routes live under /api)
//
// Exported so router-level matching can stay in router.go.
func StripPrefix(path string) (string, bool) {
	switch {
	case strings.HasPrefix(path, "/openai/"):
		return path[len("/openai"):], true
	case path == "/openai":
		return "/", true
	case strings.HasPrefix(path, "/v0/image/"):
		return "/api/" + path[len("/v0/image/"):], true
	case path == "/v0/image":
		return "/api", true
	}
	return path, false
}

func (p *chatGPT2APIProxy) director(req *http.Request) {
	if stripped, ok := StripPrefix(req.URL.Path); ok {
		req.URL.Path = stripped
	}
	req.URL.Scheme = p.upstream.Scheme
	req.URL.Host = p.upstream.Host
	req.Host = p.upstream.Host

	// Strip any client-supplied auth, then inject our internal token so
	// chatgpt2api accepts the request. Never forward the Management Key.
	req.Header.Del("Authorization")
	if p.internalKey != "" {
		req.Header.Set("Authorization", "Bearer "+p.internalKey)
	}
	// Drop cookies / proxy-auth that could otherwise carry user-side state
	// we don't want bridged into the in-process Python service.
	req.Header.Del("Cookie")
	req.Header.Del("Proxy-Authorization")
}

func (p *chatGPT2APIProxy) errorHandler(w http.ResponseWriter, _ *http.Request, _ error) {
	w.Header().Set("Retry-After", "5")
	response.Error(w, http.StatusServiceUnavailable,
		errors.New("chatgpt2api upstream not ready"))
}
