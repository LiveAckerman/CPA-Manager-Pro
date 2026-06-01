package cparuntime

import (
	"encoding/json"
	"os"
	"path/filepath"
	"testing"

	"github.com/seakee/cpa-manager-plus/apps/manager-server/internal/model"
)

func TestSyncWritesDecryptedConfig(t *testing.T) {
	path := filepath.Join(t.TempDir(), "cpa_runtime.json")
	t.Setenv("CPA_RUNTIME_CONFIG_PATH", path)

	if err := Sync(model.Setup{CPAUpstreamURL: "https://cpa.example.com", ManagementKey: "k123"}); err != nil {
		t.Fatalf("Sync: %v", err)
	}

	raw, err := os.ReadFile(path)
	if err != nil {
		t.Fatalf("read: %v", err)
	}
	var got runtimeConfig
	if err := json.Unmarshal(raw, &got); err != nil {
		t.Fatalf("unmarshal: %v", err)
	}
	if got.CPABaseURL != "https://cpa.example.com" || got.CPAManagementKey != "k123" {
		t.Fatalf("unexpected payload: %+v", got)
	}
	// 0600, root-only.
	info, _ := os.Stat(path)
	if perm := info.Mode().Perm(); perm != 0o600 {
		t.Fatalf("perm = %o, want 600", perm)
	}
}

func TestSyncRemovesFileWhenIncomplete(t *testing.T) {
	path := filepath.Join(t.TempDir(), "cpa_runtime.json")
	t.Setenv("CPA_RUNTIME_CONFIG_PATH", path)

	// Pre-write a stale file.
	if err := os.WriteFile(path, []byte(`{"cpa_base_url":"x","cpa_management_key":"y"}`), 0o600); err != nil {
		t.Fatalf("seed: %v", err)
	}
	// Incomplete setup (missing key) → file should be removed, not left stale.
	if err := Sync(model.Setup{CPAUpstreamURL: "https://cpa.example.com"}); err != nil {
		t.Fatalf("Sync: %v", err)
	}
	if _, err := os.Stat(path); !os.IsNotExist(err) {
		t.Fatalf("expected file removed, stat err = %v", err)
	}
}

func TestSyncNoErrorWhenAlreadyAbsent(t *testing.T) {
	path := filepath.Join(t.TempDir(), "cpa_runtime.json")
	t.Setenv("CPA_RUNTIME_CONFIG_PATH", path)
	// Empty setup, file never existed → no error.
	if err := Sync(model.Setup{}); err != nil {
		t.Fatalf("Sync on absent: %v", err)
	}
}
