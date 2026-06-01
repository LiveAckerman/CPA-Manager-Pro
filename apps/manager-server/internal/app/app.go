package app

import (
	"context"
	"io/fs"
	"path/filepath"
	"time"

	"github.com/seakee/cpa-manager-plus/apps/manager-server/internal/collector"
	"github.com/seakee/cpa-manager-plus/apps/manager-server/internal/config"
	"github.com/seakee/cpa-manager-plus/apps/manager-server/internal/cparuntime"
	"github.com/seakee/cpa-manager-plus/apps/manager-server/internal/security"
	bootstrapsvc "github.com/seakee/cpa-manager-plus/apps/manager-server/internal/service/bootstrap"
	"github.com/seakee/cpa-manager-plus/apps/manager-server/internal/store"
)

type Options struct {
	EmbeddedPanel               fs.FS
	ModelPriceSyncURL           *string
	OpenRouterModelPriceSyncURL *string
	ServiceID                   string
	StartedAt                   int64
}

func New(ctx context.Context, cfg config.Config, options Options) (*Context, error) {
	if cfg.DataKey == "" && cfg.DataKeyPath == "" {
		cfg.DataKeyPath = filepath.Join(filepath.Dir(cfg.DBPath), "data.key")
	}
	dataKey, dataKeyCreated, err := security.LoadOrCreateDataKey(cfg.DataKey, cfg.DataKeyPath)
	if err != nil {
		return nil, err
	}
	protector, err := security.NewProtector(dataKey)
	if err != nil {
		return nil, err
	}
	st, err := store.Open(cfg.DBPath, protector)
	if err != nil {
		return nil, err
	}
	bootstrapResult, err := bootstrapsvc.Run(ctx, cfg, st, dataKeyCreated)
	if err != nil {
		_ = st.Close()
		return nil, err
	}
	manager := collector.NewManager(cfg, st)
	serviceID := options.ServiceID
	if serviceID == "" {
		serviceID = "cpa-manager-plus"
	}
	startedAt := options.StartedAt
	if startedAt <= 0 {
		startedAt = time.Now().UnixMilli()
	}
	appCtx := FromExisting(
		cfg,
		st,
		manager,
		startedAt,
		options.EmbeddedPanel,
		options.ModelPriceSyncURL,
		options.OpenRouterModelPriceSyncURL,
		serviceID,
	)
	appCtx.Bootstrap = bootstrapResult

	// Share the (decrypted) CPA connection with the in-container
	// image-service so it doesn't need its own CPA_BASE_URL /
	// CPA_MANAGEMENT_KEY env vars — the web wizard the operator already
	// filled in is the single source of truth. Best-effort: a fresh
	// install with no setup yet just clears the file, and image-service
	// keeps warning "cpa not configured" until the wizard runs and the
	// save hook re-syncs.
	if setup, ok, loadErr := st.LoadSetup(ctx); loadErr == nil && ok {
		_ = cparuntime.Sync(setup)
	}

	return appCtx, nil
}
