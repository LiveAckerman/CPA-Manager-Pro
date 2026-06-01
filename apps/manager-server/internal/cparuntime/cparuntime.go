// Package cparuntime bridges the operator's web-wizard CPA connection
// (stored encrypted in manager-server's SQLite) to the in-container
// image-service, which is a separate Python process that cannot decrypt
// SQLite.
//
// Instead of asking the operator to ALSO set CPA_BASE_URL /
// CPA_MANAGEMENT_KEY as environment variables (duplicate config — the
// exact thing they complained about), manager-server drops the decrypted
// CPA connection into a small tmpfs file that image-service reads as a
// fallback. The web wizard stays the single source of truth.
//
// Security posture mirrors the per-boot internal auth key already living in
// /run: the file is on tmpfs (RAM, never persisted to the data volume),
// written 0600 (root-only), and contains a secret that manager-server
// already holds decrypted in memory. `docker exec ... env` never sees it
// because it's a file, not an env var.
package cparuntime

import (
	"encoding/json"
	"os"
	"path/filepath"
	"strings"

	"github.com/seakee/cpa-manager-plus/apps/manager-server/internal/model"
)

// DefaultPath is where image-service looks unless CPA_RUNTIME_CONFIG_PATH
// overrides it (the Python side reads the same env var).
const DefaultPath = "/run/cpa_runtime.json"

type runtimeConfig struct {
	CPABaseURL       string `json:"cpa_base_url"`
	CPAManagementKey string `json:"cpa_management_key"`
}

// Path resolves the runtime-config file path, honoring an override env var
// so both sides (Go writer + Python reader) can be pointed elsewhere in
// tests or non-container deploys.
func Path() string {
	if p := strings.TrimSpace(os.Getenv("CPA_RUNTIME_CONFIG_PATH")); p != "" {
		return p
	}
	return DefaultPath
}

// Sync writes the decrypted CPA connection to the runtime file so
// image-service can pick it up without env vars. It is best-effort and
// returns an error only so callers may log it; a failure here never breaks
// the panel (image-service simply keeps warning "cpa not configured" until
// the next successful sync, exactly as before).
//
// If the setup is incomplete (no URL or no key — e.g. a fresh install
// before the wizard runs) the file is removed rather than written partial,
// so a half-configured file can't mislead image-service.
func Sync(setup model.Setup) error {
	url := strings.TrimSpace(setup.CPAUpstreamURL)
	key := strings.TrimSpace(setup.ManagementKey)
	path := Path()

	if url == "" || key == "" {
		// Nothing usable to share yet; clear any stale file.
		if err := os.Remove(path); err != nil && !os.IsNotExist(err) {
			return err
		}
		return nil
	}

	payload, err := json.Marshal(runtimeConfig{CPABaseURL: url, CPAManagementKey: key})
	if err != nil {
		return err
	}

	// Atomic write: temp file in the same dir + rename, so a reader never
	// sees a torn/partial file. 0600 = root-only.
	dir := filepath.Dir(path)
	tmp, err := os.CreateTemp(dir, ".cpa_runtime-*.tmp")
	if err != nil {
		return err
	}
	tmpName := tmp.Name()
	defer os.Remove(tmpName) // no-op if the rename below already moved it

	if err := tmp.Chmod(0o600); err != nil {
		tmp.Close()
		return err
	}
	if _, err := tmp.Write(payload); err != nil {
		tmp.Close()
		return err
	}
	if err := tmp.Close(); err != nil {
		return err
	}
	return os.Rename(tmpName, path)
}
