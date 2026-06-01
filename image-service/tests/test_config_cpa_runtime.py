"""Tests for dynamic CPA config resolution.

image-service no longer requires CPA_BASE_URL / CPA_MANAGEMENT_KEY env vars:
manager-server drops the wizard-entered connection into a tmpfs JSON file
(/run/cpa_runtime.json) and config reads it as a fallback. Env vars still
win when set (explicit override / backward compat).
"""
from __future__ import annotations

import json
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

import services.config as config_mod  # noqa: E402


def _fresh_config(tmp_path, monkeypatch, *, env_url=None, env_key=None, file_payload=None):
    runtime = tmp_path / "cpa_runtime.json"
    if file_payload is not None:
        runtime.write_text(json.dumps(file_payload), encoding="utf-8")
    monkeypatch.setattr(config_mod, "_CPA_RUNTIME_PATH", str(runtime))
    if env_url is None:
        monkeypatch.delenv("CPA_BASE_URL", raising=False)
    else:
        monkeypatch.setenv("CPA_BASE_URL", env_url)
    if env_key is None:
        monkeypatch.delenv("CPA_MANAGEMENT_KEY", raising=False)
    else:
        monkeypatch.setenv("CPA_MANAGEMENT_KEY", env_key)
    return config_mod._Config()


def test_reads_from_runtime_file_when_no_env(tmp_path, monkeypatch):
    cfg = _fresh_config(
        tmp_path, monkeypatch,
        file_payload={"cpa_base_url": "https://cpa.example.com", "cpa_management_key": "secret-k"},
    )
    assert cfg.cpa_base_url == "https://cpa.example.com"
    assert cfg.cpa_management_key == "secret-k"


def test_env_wins_over_runtime_file(tmp_path, monkeypatch):
    cfg = _fresh_config(
        tmp_path, monkeypatch,
        env_url="https://env.example.com", env_key="env-key",
        file_payload={"cpa_base_url": "https://file.example.com", "cpa_management_key": "file-key"},
    )
    assert cfg.cpa_base_url == "https://env.example.com"
    assert cfg.cpa_management_key == "env-key"


def test_empty_when_neither_present(tmp_path, monkeypatch):
    cfg = _fresh_config(tmp_path, monkeypatch)  # no env, no file
    assert cfg.cpa_base_url == ""
    assert cfg.cpa_management_key == ""


def test_picks_up_file_written_after_init(tmp_path, monkeypatch):
    # Models the real flow: image-service starts before the wizard runs, so
    # the file doesn't exist yet; once manager-server writes it, the next
    # property read sees it (dynamic, not frozen at import).
    runtime = tmp_path / "cpa_runtime.json"
    monkeypatch.setattr(config_mod, "_CPA_RUNTIME_PATH", str(runtime))
    monkeypatch.delenv("CPA_BASE_URL", raising=False)
    monkeypatch.delenv("CPA_MANAGEMENT_KEY", raising=False)
    cfg = config_mod._Config()
    assert cfg.cpa_base_url == ""  # wizard not run yet
    runtime.write_text(
        json.dumps({"cpa_base_url": "https://late.example.com", "cpa_management_key": "late-k"}),
        encoding="utf-8",
    )
    assert cfg.cpa_base_url == "https://late.example.com"  # picked up live
    assert cfg.cpa_management_key == "late-k"
