"""Tests for session-cookie account management (MFA accounts, no refresh_token).

Covers fetch_session() parsing + the account_service import_session /
needs_relogin / cookie-mint integration.
"""
from __future__ import annotations

import sys
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from services.account_service import AccountService, _CPAFile, _jwt_exp  # noqa: E402
from services.openai_backend_api import (  # noqa: E402
    InvalidAccessTokenError,
    OpenAIBackendAPI,
)


def _mkfile(name: str) -> _CPAFile:
    return _CPAFile({"name": name, "email": name, "modtime": ""})


def _svc(tmp_path, monkeypatch):
    monkeypatch.setenv("CHATGPT2API_DATA_DIR", str(tmp_path))
    svc = AccountService()
    svc._fetch_cpa_file_list = lambda: [_mkfile("codex-a@x.com-free.json")]  # type: ignore
    svc._download_token_from_cpa = lambda fn: "cpa-token"  # type: ignore
    svc._refresh_file_list_now()
    return svc


# --- fetch_session parsing -------------------------------------------------

class _FakeCookies:
    def __init__(self, value):
        self._value = value

    def get(self, key):
        return self._value


class _FakeResp:
    def __init__(self, status, payload, rolled_cookie=None):
        self.status_code = status
        self._payload = payload
        self.headers = {"content-type": "application/json"}
        self.cookies = _FakeCookies(rolled_cookie)

    def json(self):
        return self._payload


def test_fetch_session_ok(monkeypatch):
    api = OpenAIBackendAPI()
    monkeypatch.setattr(
        api.session, "get",
        lambda url, **kw: _FakeResp(200, {
            "accessToken": "tok-123",
            "expires": "2026-08-31T02:30:21.393Z",
            "account": {"id": "acc-1", "planType": "free"},
            "user": {"email": "able@duck.com"},
        }, rolled_cookie="rolled-cookie-xyz"),
    )
    r = api.fetch_session("orig-cookie")
    assert r["access_token"] == "tok-123"
    assert r["account_id"] == "acc-1"
    assert r["email"] == "able@duck.com"
    assert r["plan_type"] == "free"
    # rolled cookie captured for sliding-session continuity
    assert r["session_cookie"] == "rolled-cookie-xyz"


def test_fetch_session_no_roll_keeps_input(monkeypatch):
    api = OpenAIBackendAPI()
    monkeypatch.setattr(
        api.session, "get",
        lambda url, **kw: _FakeResp(200, {"accessToken": "tok"}, rolled_cookie=None),
    )
    r = api.fetch_session("orig-cookie")
    assert r["session_cookie"] == "orig-cookie"


def test_fetch_session_401_is_dead(monkeypatch):
    api = OpenAIBackendAPI()
    monkeypatch.setattr(api.session, "get", lambda url, **kw: _FakeResp(401, {}))
    with pytest.raises(InvalidAccessTokenError):
        api.fetch_session("dead-cookie")


def test_fetch_session_200_empty_token_is_dead(monkeypatch):
    # /api/auth/session returns 200 {} once the session is invalidated.
    api = OpenAIBackendAPI()
    monkeypatch.setattr(api.session, "get", lambda url, **kw: _FakeResp(200, {}))
    with pytest.raises(InvalidAccessTokenError):
        api.fetch_session("invalidated-cookie")


# --- import_session + needs_relogin ---------------------------------------

def test_import_session_mints_from_cookie(tmp_path, monkeypatch):
    # import_session ALWAYS mints from the cookie (the extension's provided
    # token can be an invalidated pwd-only one) — stub the mint to avoid HTTP.
    svc = _svc(tmp_path, monkeypatch)
    monkeypatch.setattr(
        svc, "_mint_session_token",
        lambda fn, cookie: {"access_token": "minted-tok", "email": "able@duck.com", "session_cookie": cookie},
    )
    res = svc.import_session("codex-a@x.com-free.json", "cookie-val", access_token="h.p.s")
    assert res["ok"] is True
    a = next(i for i in svc.list_accounts_redacted() if i["file_name"] == "codex-a@x.com-free.json")
    assert a["session_managed"] is True
    assert a["needs_relogin"] is False
    assert a["status"] == "active"


def test_import_session_mints_when_no_token(tmp_path, monkeypatch):
    svc = _svc(tmp_path, monkeypatch)
    # Mint path: stub _mint_session_token to avoid real HTTP.
    monkeypatch.setattr(
        svc, "_mint_session_token",
        lambda fn, cookie: {"access_token": "minted-tok", "email": "able@duck.com", "session_cookie": cookie},
    )
    res = svc.import_session("codex-a@x.com-free.json", "cookie-val")
    assert res["ok"] is True
    a = next(i for i in svc.list_accounts_redacted() if i["file_name"] == "codex-a@x.com-free.json")
    assert a["status"] == "active" and a["session_managed"] is True


def test_import_session_dead_cookie_flags_relogin(tmp_path, monkeypatch):
    svc = _svc(tmp_path, monkeypatch)

    def _raise(fn, cookie):
        raise InvalidAccessTokenError("session cookie dead")

    monkeypatch.setattr(svc, "_mint_session_token", _raise)
    res = svc.import_session("codex-a@x.com-free.json", "dead-cookie")
    assert res["ok"] is False
    assert res.get("needs_relogin") is True
    relogin = svc.needs_relogin_list()
    assert any(r["file_name"] == "codex-a@x.com-free.json" for r in relogin)


def test_import_session_account_not_found(tmp_path, monkeypatch):
    svc = _svc(tmp_path, monkeypatch)
    res = svc.import_session("codex-missing.json", "cookie-val", access_token="h.p.s")
    assert res["ok"] is False
    assert res.get("cookie_stored") is True  # cookie kept for later


def test_cookie_persisted_across_instances(tmp_path, monkeypatch):
    svc = _svc(tmp_path, monkeypatch)
    monkeypatch.setattr(
        svc, "_mint_session_token",
        lambda fn, cookie: {"access_token": "minted-tok", "email": "", "session_cookie": cookie},
    )
    svc.import_session("codex-a@x.com-free.json", "persist-cookie")
    # New instance loads the same data dir → cookie store survives.
    svc2 = _svc(tmp_path, monkeypatch)
    a = next(i for i in svc2.list_accounts_redacted() if i["file_name"] == "codex-a@x.com-free.json")
    assert a["session_managed"] is True


def test_probe_cookie_recovers_session_account(tmp_path, monkeypatch):
    # MFA account: CPA token is dead (401) but the session cookie still mints
    # a working token → the inspection probe must report it HEALTHY (200),
    # NOT flag it for delete. This is the fix for the false-positive on
    # session-cookie accounts in server/local inspection.
    svc = _svc(tmp_path, monkeypatch)
    fn = "codex-a@x.com-free.json"
    monkeypatch.setattr(
        svc, "_mint_session_token",
        lambda f, c: {"access_token": "minted-good", "email": "", "session_cookie": c},
    )
    svc.import_session(fn, "good-cookie")  # registers cookie + session-managed

    from services import openai_backend_api as oba

    def fake_usage(self, **kw):
        ok = self.access_token == "minted-good"
        return {
            "status_code": 200 if ok else 401,
            "body": {} if ok else None,
            "body_text": "{}" if ok else "invalidated",
            "has_status_code": True,
        }

    monkeypatch.setattr(oba.OpenAIBackendAPI, "get_codex_usage", fake_usage)
    monkeypatch.setattr(svc, "_download_token_from_cpa", lambda f: "dead-cpa-token")
    svc._accounts[fn].access_token = ""  # force CPA download path
    res = svc.probe_codex_usage(fn)
    assert res["status_code"] == 200
    assert res["needs_reauth"] is False
    assert svc.needs_relogin_list() == []  # not flagged for re-login


def test_probe_cookie_dead_flags_reauth(tmp_path, monkeypatch):
    # CPA token dead AND cookie dead → genuinely needs browser re-login.
    svc = _svc(tmp_path, monkeypatch)
    fn = "codex-a@x.com-free.json"
    monkeypatch.setattr(
        svc, "_mint_session_token",
        lambda f, c: {"access_token": "minted", "email": "", "session_cookie": c},
    )
    svc.import_session(fn, "cookie")  # session-managed

    def dead_mint(f, c):
        raise InvalidAccessTokenError("cookie dead")

    monkeypatch.setattr(svc, "_mint_session_token", dead_mint)
    from services import openai_backend_api as oba
    monkeypatch.setattr(
        oba.OpenAIBackendAPI, "get_codex_usage",
        lambda self, **kw: {"status_code": 401, "body": None, "body_text": "x", "has_status_code": True},
    )
    monkeypatch.setattr(svc, "_download_token_from_cpa", lambda f: "dead")
    svc._accounts[fn].access_token = ""
    res = svc.probe_codex_usage(fn)
    assert res["needs_reauth"] is True
    assert any(r["file_name"] == fn for r in svc.needs_relogin_list())


def test_probe_sets_needs_relogin_on_truly_dead(tmp_path, monkeypatch):
    # An inspection probe that 401s on a fresh CPA token must flag the
    # account into needs_relogin_list() so the extension can find it.
    svc = _svc(tmp_path, monkeypatch)
    from services import openai_backend_api as oba
    monkeypatch.setattr(
        oba.OpenAIBackendAPI, "get_codex_usage",
        lambda self, **kw: {"status_code": 401, "body": None, "body_text": "", "has_status_code": True},
    )
    res = svc.probe_codex_usage("codex-a@x.com-free.json")
    assert res["needs_reauth"] is True
    relogin = svc.needs_relogin_list()
    assert any(r["file_name"] == "codex-a@x.com-free.json" for r in relogin)


def test_probe_clears_needs_relogin_on_success(tmp_path, monkeypatch):
    svc = _svc(tmp_path, monkeypatch)
    svc._accounts["codex-a@x.com-free.json"].needs_relogin = True  # pre-flag dead
    from services import openai_backend_api as oba
    monkeypatch.setattr(
        oba.OpenAIBackendAPI, "get_codex_usage",
        lambda self, **kw: {"status_code": 200, "body": {}, "body_text": "{}", "has_status_code": True},
    )
    res = svc.probe_codex_usage("codex-a@x.com-free.json")
    assert res["status_code"] == 200
    assert svc.needs_relogin_list() == []  # recovered → cleared


def test_jwt_exp_parses_real_claim():
    # exp=9999999999 base64url-encoded payload.
    import base64, json
    payload = base64.urlsafe_b64encode(json.dumps({"exp": 9999999999}).encode()).decode().rstrip("=")
    token = f"header.{payload}.sig"
    assert _jwt_exp(token) == 9999999999.0
    assert _jwt_exp("not-a-jwt") == 0.0
