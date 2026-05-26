package router

import (
	"log"
	"net/http"
	"strings"

	"github.com/seakee/cpa-manager-plus/apps/manager-server/internal/app"
	apikeyaliascontroller "github.com/seakee/cpa-manager-plus/apps/manager-server/internal/http/controller/apikeyalias"
	codexinspectioncontroller "github.com/seakee/cpa-manager-plus/apps/manager-server/internal/http/controller/codexinspection"
	cpapassthroughcontroller "github.com/seakee/cpa-manager-plus/apps/manager-server/internal/http/controller/cpapassthrough"
	dashboardcontroller "github.com/seakee/cpa-manager-plus/apps/manager-server/internal/http/controller/dashboard"
	healthcontroller "github.com/seakee/cpa-manager-plus/apps/manager-server/internal/http/controller/health"
	imagegencontroller "github.com/seakee/cpa-manager-plus/apps/manager-server/internal/http/controller/imagegen"
	imageproxycontroller "github.com/seakee/cpa-manager-plus/apps/manager-server/internal/http/controller/imageproxy"
	managerconfigcontroller "github.com/seakee/cpa-manager-plus/apps/manager-server/internal/http/controller/managerconfig"
	modelpricecontroller "github.com/seakee/cpa-manager-plus/apps/manager-server/internal/http/controller/modelprice"
	monitoringcontroller "github.com/seakee/cpa-manager-plus/apps/manager-server/internal/http/controller/monitoring"
	panelcontroller "github.com/seakee/cpa-manager-plus/apps/manager-server/internal/http/controller/panel"
	proxycontroller "github.com/seakee/cpa-manager-plus/apps/manager-server/internal/http/controller/proxy"
	setupcontroller "github.com/seakee/cpa-manager-plus/apps/manager-server/internal/http/controller/setup"
	systemcontroller "github.com/seakee/cpa-manager-plus/apps/manager-server/internal/http/controller/system"
	usagecontroller "github.com/seakee/cpa-manager-plus/apps/manager-server/internal/http/controller/usage"
	"github.com/seakee/cpa-manager-plus/apps/manager-server/internal/http/middleware"
	proxysvc "github.com/seakee/cpa-manager-plus/apps/manager-server/internal/service/proxy"
)

func New(appCtx *app.Context) http.Handler {
	healthHandler := &healthcontroller.Handler{ServiceID: appCtx.ServiceID}
	systemHandler := &systemcontroller.Handler{App: appCtx}
	setupHandler := &setupcontroller.Handler{App: appCtx}
	managerConfigHandler := &managerconfigcontroller.Handler{App: appCtx}
	usageHandler := &usagecontroller.Handler{App: appCtx}
	modelPriceHandler := &modelpricecontroller.Handler{App: appCtx}
	apiKeyAliasHandler := &apikeyaliascontroller.Handler{App: appCtx}
	codexInspectionHandler := &codexinspectioncontroller.Handler{App: appCtx}
	dashboardHandler := &dashboardcontroller.Handler{App: appCtx}
	monitoringHandler := &monitoringcontroller.Handler{App: appCtx}
	proxyHandler := &proxycontroller.Handler{App: appCtx}
	panelHandler := &panelcontroller.Handler{App: appCtx}
	// Plus-fork additions: chatgpt2api passthrough, /v1/* CPA passthrough,
	// smart image-gen router with dual-auth + optional CPA fallback.
	imageProxyHandler, err := imageproxycontroller.New(appCtx)
	if err != nil {
		log.Printf("chatgpt2api image proxy disabled: %v", err)
	}
	cpaPassthroughHandler := &cpapassthroughcontroller.Handler{App: appCtx}
	imageGenHandler := imagegencontroller.New(appCtx)

	mux := http.NewServeMux()
	mux.HandleFunc("/health", middleware.WithCORS(appCtx.Config, healthHandler.Health))
	mux.HandleFunc("/status", middleware.WithCORS(appCtx.Config, systemHandler.Status))
	mux.HandleFunc("/usage-service/info", middleware.WithCORS(appCtx.Config, systemHandler.Info))
	mux.HandleFunc("/usage-service/config", middleware.WithCORS(appCtx.Config, managerConfigHandler.Handle))
	mux.HandleFunc("/setup", middleware.WithCORS(appCtx.Config, setupHandler.Setup))
	mux.HandleFunc("/management.html", panelHandler.ManagementHTML)
	// Smart image router — exact paths so they always win over the generic
	// /v1/* CPA passthrough that lives in handleRoot.
	mux.HandleFunc("/v1/images/generations", middleware.WithCORS(appCtx.Config, imageGenHandler.Handle))
	mux.HandleFunc("/v1/images/edits", middleware.WithCORS(appCtx.Config, imageGenHandler.Handle))
	// chatgpt2api reverse-proxy prefixes.
	if imageProxyHandler != nil {
		mux.HandleFunc("/openai/", middleware.WithCORS(appCtx.Config, imageProxyHandler.Handle))
		mux.HandleFunc("/v0/image/", middleware.WithCORS(appCtx.Config, imageProxyHandler.Handle))
	}
	mux.HandleFunc("/", rootHandler(appCtx, usageHandler, modelPriceHandler, apiKeyAliasHandler, codexInspectionHandler, dashboardHandler, monitoringHandler, proxyHandler, cpaPassthroughHandler))

	return middleware.Recovery(middleware.RequestLogger(mux))
}

func rootHandler(
	appCtx *app.Context,
	usageHandler *usagecontroller.Handler,
	modelPriceHandler *modelpricecontroller.Handler,
	apiKeyAliasHandler *apikeyaliascontroller.Handler,
	codexInspectionHandler *codexinspectioncontroller.Handler,
	dashboardHandler *dashboardcontroller.Handler,
	monitoringHandler *monitoringcontroller.Handler,
	proxyHandler *proxycontroller.Handler,
	cpaPassthroughHandler *cpapassthroughcontroller.Handler,
) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		if r.Method == http.MethodOptions {
			middleware.WriteCORS(appCtx.Config, w, r)
			w.WriteHeader(http.StatusNoContent)
			return
		}
		if strings.HasPrefix(r.URL.Path, "/v0/management/model-prices") {
			middleware.WithCORS(appCtx.Config, modelPriceHandler.Handle)(w, r)
			return
		}
		if strings.HasPrefix(r.URL.Path, "/v0/management/api-key-aliases") {
			middleware.WithCORS(appCtx.Config, apiKeyAliasHandler.Handle)(w, r)
			return
		}
		if strings.HasPrefix(r.URL.Path, "/v0/management/codex-inspection") {
			middleware.WithCORS(appCtx.Config, codexInspectionHandler.Handle)(w, r)
			return
		}
		if strings.HasPrefix(r.URL.Path, "/v0/management/dashboard/") {
			middleware.WithCORS(appCtx.Config, dashboardHandler.Handle)(w, r)
			return
		}
		if strings.HasPrefix(r.URL.Path, "/v0/management/monitoring/") {
			middleware.WithCORS(appCtx.Config, monitoringHandler.Handle)(w, r)
			return
		}
		cleanUsagePath := strings.TrimRight(r.URL.Path, "/")
		if cleanUsagePath == "/v0/management/usage" || strings.HasPrefix(cleanUsagePath, "/v0/management/usage/") {
			middleware.WithCORS(appCtx.Config, usageHandler.Handle)(w, r)
			return
		}
		if strings.HasPrefix(r.URL.Path, "/v0/management/") {
			middleware.WithCORS(appCtx.Config, proxyHandler.Management)(w, r)
			return
		}
		if proxysvc.IsModelListPath(r.URL.Path) {
			middleware.WithCORS(appCtx.Config, proxyHandler.ModelList)(w, r)
			return
		}
		if proxysvc.IsCPAProxyPath(r.URL.Path) {
			middleware.WithCORS(appCtx.Config, proxyHandler.CPA)(w, r)
			return
		}
		// Plus-fork: anything else under /v1/ that wasn't claimed above
		// (e.g. /v1/responses, /v1/chat/completions, /v1/embeddings, ...)
		// transparently passes through to CPA with the client's own
		// Authorization preserved. Closes the gap that made sub2api-style
		// capability probes report "Responses API not supported".
		if cpapassthroughcontroller.IsPath(r.URL.Path) {
			middleware.WithCORS(appCtx.Config, cpaPassthroughHandler.Handle)(w, r)
			return
		}
		if r.URL.Path == "/" {
			http.Redirect(w, r, "/management.html", http.StatusTemporaryRedirect)
			return
		}
		http.NotFound(w, r)
	}
}
