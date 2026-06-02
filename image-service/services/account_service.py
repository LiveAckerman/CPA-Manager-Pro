"""CPA-backed account pool.

This is the heart of why we forked: chatgpt2api originally maintained its own
accounts.json on disk, synced periodically from CPA. That meant two copies of
the same data, drifting between syncs, and silent staleness after CPA's
background OAuth refresh rotated an access_token.

This rewrite makes CPA the single source of truth:

  * The pool of *which* accounts exist comes from CPA's
    /v0/management/auth-files endpoint. We never persist this locally; we
    cache the list in memory and use CPA's per-file `modtime` to avoid
    re-fetching unchanged files.

  * For each account, we lazily download the current access_token from
    CPA's /v0/management/auth-files/download endpoint on first use, then
    cache that token + its ChatGPT-side runtime state (image_gen quota
    remaining, last-used timestamp, success/fail counters) in memory.

  * When ChatGPT returns 401 on a token (CPA's silent refresh wrote a new
    one), we mark the token stale and re-download from CPA on the next
    pick. No external sync job required — every pool change converges
    within one image-gen attempt.

  * Account state (quota / last_used / success / fail) is process-local and
    rebuilt from ChatGPT on startup; nothing is persisted. A restart costs
    one ChatGPT round-trip per active account to re-warm. That's
    acceptable for a daemon that restarts on the order of weeks.

What this module deliberately does NOT do:

  * No local accounts.json. CPA is canonical.
  * No CPA-sync background job. The CPA list is pulled on demand with a
    short TTL (config.cpa_list_cache_secs, default 15s) plus a periodic
    refresh of in-flight token state every config.refresh_account_interval_minute.
  * No multi-pool support. We use the single CPA configured via
    CPA_BASE_URL + CPA_MANAGEMENT_KEY env vars (the same ones the Go
    usage-service uses).
"""
from __future__ import annotations

import threading
import time
from dataclasses import dataclass, field
from typing import Any, Iterable

from curl_cffi import requests

from services.config import config
from utils.log import logger


# ---------------------------------------------------------------------------
# Per-account runtime state held in memory. Mirrors the fields the original
# chatgpt2api stored in accounts.json, minus the fields we don't care about
# (recent_requests, limits_progress fully — we keep just image_gen remaining).
# ---------------------------------------------------------------------------


@dataclass
class _AccountState:
    file_name: str                 # CPA file name (e.g. "codex-x@y.com-free.json")
    email: str                     # extracted from CPA's file metadata
    access_token: str = ""         # the JWT — lazily downloaded from CPA
    cpa_modtime: float = 0.0       # CPA's last-modified UNIX timestamp for this file
    quota: int = 0                 # image_gen remaining (refreshed via ChatGPT)
    quota_unknown: bool = True     # True until we've successfully called ChatGPT once
    last_used_at: float = 0.0      # for round-robin / least-recently-used picking
    success: int = 0
    fail: int = 0
    inflight: int = 0              # concurrent image-gen calls in progress
    in_use: bool = False           # short-term lock — only one picker at a time per account
    status: str = "fresh"          # fresh | active | invalid
    token_exp: float = 0.0         # access_token expiry (unix secs); 0 = unknown
    needs_relogin: bool = False    # session-managed account whose cookie died


class _CPAFile:
    """Light projection of one row out of /v0/management/auth-files."""

    __slots__ = ("name", "email", "modtime", "disabled", "unavailable")

    def __init__(self, raw: dict[str, Any]) -> None:
        self.name: str = str(raw.get("name") or raw.get("id") or "").strip()
        self.email: str = str(raw.get("email") or raw.get("account") or "").strip()
        modtime_str = str(raw.get("modtime") or "").strip()
        self.modtime: float = _parse_iso(modtime_str)
        self.disabled: bool = bool(raw.get("disabled"))
        self.unavailable: bool = bool(raw.get("unavailable"))


def _parse_iso(value: str) -> float:
    """CPA emits Go-formatted RFC3339 timestamps with sub-microsecond precision
    and offsets like +08:00. Python's datetime.fromisoformat handles both
    since 3.11."""
    if not value:
        return 0.0
    try:
        # strip nanosecond fraction if present (datetime supports microseconds only)
        if "." in value:
            head, _, tail = value.partition(".")
            # tail looks like "571509766+08:00"; keep first 6 digits of frac
            digits = ""
            i = 0
            while i < len(tail) and tail[i].isdigit():
                digits += tail[i]
                i += 1
            digits = (digits + "000000")[:6]
            value = f"{head}.{digits}{tail[i:]}"
        from datetime import datetime
        return datetime.fromisoformat(value).timestamp()
    except Exception:
        return 0.0


def _jwt_exp(token: str) -> float:
    """Best-effort parse of a JWT's `exp` claim (unix secs). Returns 0 on
    any failure — callers treat 0 as 'unknown expiry' and re-mint eagerly."""
    try:
        import base64
        import json as _json
        payload_b64 = token.split(".")[1]
        payload_b64 += "=" * (-len(payload_b64) % 4)  # pad base64url
        payload = _json.loads(base64.urlsafe_b64decode(payload_b64))
        exp = payload.get("exp")
        return float(exp) if exp is not None else 0.0
    except Exception:
        return 0.0


# How early (secs) before access_token expiry we re-mint a session-managed
# account's token from its cookie. Token life is ~10 days; with a 2-day
# margin we re-mint roughly every 8 days — low enough frequency that the
# /api/auth/session calls don't look like abuse to OpenAI's risk engine.
SESSION_REMINT_MARGIN_SECS = 2 * 24 * 60 * 60


# ---------------------------------------------------------------------------
# The service singleton. Keeps state under a single mutex; image gen calls
# acquire briefly to pick an account, then release while making the slow
# ChatGPT round-trip.
# ---------------------------------------------------------------------------


class AccountService:
    def __init__(self) -> None:
        self._lock = threading.Lock()
        self._cond = threading.Condition(self._lock)
        # Keyed by CPA filename so we can update via the file list cleanly.
        self._accounts: dict[str, _AccountState] = {}
        # Modtime-cached file list from CPA. Refreshed when stale or on 401.
        self._cpa_files_ts: float = 0.0
        # http client; long-lived so it can keep CPA-side keepalive sockets.
        self._cpa_session = requests.Session()
        self._stop_event = threading.Event()
        self._refresh_thread: threading.Thread | None = None
        # Server-side progress for the panel's "refresh quotas" spinner.
        # None when no refresh is running; otherwise {done, total, started_at}.
        # Updated under self._lock from refresh_quotas().
        self._refresh_progress: dict | None = None
        # Session-cookie store for MFA accounts that can't use the OAuth
        # refresh_token flow. Keyed by CPA file_name → {"cookie": str,
        # "updated_at": float, "email": str}. Persisted to disk so it
        # survives restarts (the account pool itself is rebuilt from CPA,
        # but cookies are ours). Loaded lazily on first use.
        self._session_cookies: dict[str, dict[str, Any]] = {}
        self._session_loaded = False

    # ----- public API consumed by openai_backend_api + conversation -----

    def get_account(self, access_token: str) -> dict[str, Any] | None:
        """Used by openai_backend_api._build_fp() to look up an account's
        cached fingerprint. We don't persist fingerprints, so return a
        minimal dict that lets _build_fp generate fresh defaults."""
        with self._lock:
            for acct in self._accounts.values():
                if acct.access_token == access_token:
                    return {"access_token": access_token, "email": acct.email}
        return {"access_token": access_token} if access_token else None

    def get_available_access_token(self) -> str:
        """Pick the best access_token from the pool. Strategy:
          1. Refresh CPA file list if cache is stale.
          2. Among accounts that are non-disabled and have quota>0 (or unknown),
             pick the one with the smallest last_used_at + smallest inflight.
          3. Lazily download a token from CPA if we have a file slot but no
             cached token for it.
          4. If no account qualifies, raise — caller surfaces as 429.
        """
        self._refresh_file_list_if_stale()

        with self._cond:
            while True:
                candidate = self._pick_locked()
                if candidate is not None:
                    candidate.in_use = True
                    candidate.inflight += 1
                    candidate.last_used_at = time.time()
                    return self._ensure_token_locked(candidate)
                # No available account right now. Wait briefly for one to be
                # released (could be inflight slots clearing).
                if not self._cond.wait(timeout=5.0):
                    break

        raise RuntimeError("no available image quota")

    def release_image_slot(self, access_token: str) -> None:
        with self._cond:
            acct = self._find_by_token_locked(access_token)
            if acct is None:
                return
            acct.in_use = False
            if acct.inflight > 0:
                acct.inflight -= 1
            self._cond.notify_all()

    def mark_image_result(self, access_token: str, success: bool) -> dict[str, Any] | None:
        """Bookkeeping after one image-gen attempt. Returns the post-update
        per-account state dict, mostly for diagnostics."""
        with self._lock:
            acct = self._find_by_token_locked(access_token)
            if acct is None:
                return None
            if success:
                acct.success += 1
                if acct.quota > 0:
                    acct.quota -= 1
            else:
                acct.fail += 1
            return self._to_dict_locked(acct)

    def remove_invalid_token(self, access_token: str, event: str) -> bool:
        """Called when ChatGPT 401s. Most likely cause: CPA refreshed the
        OAuth flow and our cached access_token is stale. Drop the cached
        token (NOT the account itself); next pick will re-download from CPA."""
        with self._cond:
            acct = self._find_by_token_locked(access_token)
            if acct is None:
                return False
            logger.warning(
                "account %s invalidated (event=%s), will redownload from CPA",
                acct.email or acct.file_name, event,
            )
            acct.access_token = ""
            acct.status = "invalid"
            acct.in_use = False
            if acct.inflight > 0:
                acct.inflight -= 1
            self._cond.notify_all()
            # Force a fresh CPA file-list pull on next pick to pick up any rotation.
            self._cpa_files_ts = 0.0
            return True

    # ----- background refresh -----

    def start_background_refresh(self) -> None:
        """Spawned from FastAPI's lifespan. Two daemons:

          1. cpa-pool-refresh — periodically re-pulls the CPA file list so
             we discover new / disabled / refreshed accounts even without
             traffic.
          2. cpa-pool-startup-quota-refresh — one-shot, runs ~5s after
             boot. Hits ChatGPT /backend-api/me for every cached account
             so /api/accounts shows real `image_gen.remaining` numbers on
             first panel open. Without this, every "fresh" account stays
             quota_unknown=True until the operator clicks the manual
             refresh button.
        """
        if self._refresh_thread is not None:
            return
        self._stop_event.clear()
        self._refresh_thread = threading.Thread(
            target=self._background_loop, name="cpa-pool-refresh", daemon=True,
        )
        self._refresh_thread.start()

        # Separate daemon so the container becomes healthy immediately —
        # this one runs 30-60s for ~130 accounts and we don't want
        # /health blocked on it.
        threading.Thread(
            target=self._startup_quota_refresh,
            name="cpa-pool-startup-quota-refresh",
            daemon=True,
        ).start()

    def _startup_quota_refresh(self) -> None:
        # Wait 5s for _background_loop's initial CPA file list pull to
        # populate the in-memory account dict — otherwise the refresh
        # would target zero accounts. _stop_event.wait() returns True
        # on stop signal so we exit early during a shutdown race.
        if self._stop_event.wait(5):
            return
        try:
            result = self.refresh_quotas(tokens=None, include_uncached=True)
            logger.info(
                "startup quota refresh: refreshed=%s invalidated=%s errors=%s skipped=%s",
                result.get("refreshed"),
                result.get("invalidated"),
                result.get("errors"),
                result.get("skipped"),
            )
        except Exception as exc:
            logger.warning("startup quota refresh failed: %s", exc)

    def stop_background_refresh(self) -> None:
        self._stop_event.set()
        thread = self._refresh_thread
        self._refresh_thread = None
        if thread is not None:
            thread.join(timeout=2.0)

    def _background_loop(self) -> None:
        interval = max(30, config.refresh_account_interval_minute * 60)
        # Do an immediate first pull so /api/accounts shows non-empty
        # within a second of startup.
        try:
            self._refresh_file_list_now()
        except Exception as exc:
            logger.warning("initial CPA refresh failed: %s", exc)
        while not self._stop_event.wait(interval):
            try:
                self._refresh_file_list_now()
            except Exception as exc:
                logger.warning("periodic CPA refresh failed: %s", exc)

    # ----- diagnostics -----

    def account_count(self) -> int:
        with self._lock:
            return len(self._accounts)

    def list_accounts_redacted(self) -> list[dict[str, Any]]:
        with self._lock:
            self._load_session_cookies_locked()
            return [self._to_dict_redacted_locked(a) for a in self._accounts.values()]

    def list_limited_tokens(self) -> list[str]:
        """Compat with vendor's start_limited_account_watcher. We no longer
        run that watcher (refresh is unified), but tests may call this."""
        with self._lock:
            return [a.access_token for a in self._accounts.values() if a.quota == 0 and a.access_token]

    def refresh_accounts(self, tokens: Iterable[str]) -> dict[str, Any]:
        """Compat shim for callers that supply an explicit token list."""
        return self.refresh_quotas(tokens=list(tokens), include_uncached=False)

    # ----- session-cookie accounts (MFA accounts, no refresh_token) -----

    def _session_store_path(self):
        return config.data_dir / "session_cookies.json"

    def _load_session_cookies_locked(self) -> None:
        """Lock-held. Lazily load the persisted cookie store once."""
        if self._session_loaded:
            return
        self._session_loaded = True
        try:
            import json as _json
            path = self._session_store_path()
            if path.exists():
                data = _json.loads(path.read_text(encoding="utf-8"))
                if isinstance(data, dict):
                    self._session_cookies = {
                        str(k): v for k, v in data.items() if isinstance(v, dict)
                    }
                    logger.info("loaded %d session cookies from disk", len(self._session_cookies))
        except Exception as exc:
            logger.warning("failed to load session cookies: %s", exc)

    def _save_session_cookies_locked(self) -> None:
        """Lock-held. Persist the cookie store atomically."""
        try:
            import json as _json
            import os as _os
            path = self._session_store_path()
            tmp = path.with_suffix(".json.tmp")
            tmp.write_text(_json.dumps(self._session_cookies), encoding="utf-8")
            _os.replace(tmp, path)
        except Exception as exc:
            logger.warning("failed to persist session cookies: %s", exc)

    def import_session(
        self,
        file_name: str,
        session_cookie: str,
        access_token: str = "",
    ) -> dict[str, Any]:
        """Register a browser-login session cookie for an account so it can
        be kept alive WITHOUT a refresh_token. Called by the Chrome
        extension (via cpa-manager /v0/image/accounts/import-session) after
        it re-logs-in a 401'd MFA account.

        Stores the cookie (persisted), then immediately mints a fresh
        access_token from it (or uses the one the extension already grabbed)
        and marks the account active. From here the background refresher
        keeps the token fresh from the cookie until the cookie itself dies,
        at which point the account surfaces in needs_relogin_list().

        The account must already exist in the pool (i.e. CPA still lists the
        auth file). Returns a small status dict.
        """
        file_name = (file_name or "").strip()
        cookie = (session_cookie or "").strip()
        if not file_name:
            return {"ok": False, "error": "file_name required"}
        if not cookie:
            return {"ok": False, "error": "session_cookie required"}

        with self._lock:
            self._load_session_cookies_locked()
            acct = self._accounts.get(file_name)
            if acct is None:
                # Account not in pool — CPA may not list it. Still store the
                # cookie so a later list-refresh picks it up; but report it.
                self._session_cookies[file_name] = {
                    "cookie": cookie,
                    "updated_at": time.time(),
                    "email": "",
                }
                self._save_session_cookies_locked()
                return {"ok": False, "error": f"account not found in pool: {file_name}", "cookie_stored": True}
            self._session_cookies[file_name] = {
                "cookie": cookie,
                "updated_at": time.time(),
                "email": acct.email,
            }
            self._save_session_cookies_locked()

        # If the extension already grabbed a token, trust it (saves a call);
        # otherwise mint one from the cookie now to validate the cookie works.
        from services.openai_backend_api import InvalidAccessTokenError
        token = (access_token or "").strip()
        minted_email = ""
        try:
            if not token:
                result = self._mint_session_token(file_name, cookie)
                token = result["access_token"]
                minted_email = result.get("email", "")
            with self._lock:
                acct = self._accounts.get(file_name)
                if acct is not None:
                    acct.access_token = token
                    acct.token_exp = _jwt_exp(token)
                    acct.status = "active"
                    acct.needs_relogin = False
                    if minted_email and not acct.email:
                        acct.email = minted_email
            return {"ok": True, "file_name": file_name, "token_exp": _jwt_exp(token)}
        except InvalidAccessTokenError as exc:
            with self._lock:
                acct = self._accounts.get(file_name)
                if acct is not None:
                    acct.needs_relogin = True
            return {"ok": False, "error": f"cookie rejected: {exc}", "needs_relogin": True}
        except Exception as exc:
            return {"ok": False, "error": f"mint failed: {exc}"}

    def _mint_session_token(self, file_name: str, cookie: str) -> dict[str, Any]:
        """Call /api/auth/session with the cookie to mint a fresh token.
        NOT lock-held (does HTTP). On success persists the rolled cookie.
        Raises InvalidAccessTokenError if the cookie is dead."""
        from services.openai_backend_api import OpenAIBackendAPI
        result = OpenAIBackendAPI().fetch_session(cookie)
        rolled = result.get("session_cookie") or cookie
        with self._lock:
            entry = self._session_cookies.get(file_name)
            if entry is not None and rolled and rolled != entry.get("cookie"):
                entry["cookie"] = rolled
                entry["updated_at"] = time.time()
                self._save_session_cookies_locked()
        return result

    def needs_relogin_list(self) -> list[dict[str, Any]]:
        """Accounts whose session cookie has died (mint returned 401) — the
        Chrome extension targets exactly these for browser re-login, instead
        of guessing from raw 401s (which include recoverable stale-cache)."""
        with self._lock:
            self._load_session_cookies_locked()
            out = []
            for acct in self._accounts.values():
                if acct.needs_relogin:
                    out.append({
                        "file_name": acct.file_name,
                        "email": acct.email,
                        "reason": "session_cookie_dead",
                    })
            return out

    def probe_codex_usage(
        self,
        file_name: str,
        chatgpt_account_id: str = "",
        user_agent: str = "",
    ) -> dict[str, Any]:
        """Read-only Codex usage probe for one account.

        Designed to replace the codex-inspection page's old hot path:
        old path was `frontend → cpa-manager → CPA /api-call → CPA refreshes
        access_token via refresh_token → ChatGPT`. The refresh-token step
        was getting many accounts session_terminated (CPA logs showed
        800-1100 daily after heavy inspection runs). This path skips CPA
        entirely:

          1. Look up the cached access_token from the in-memory pool (or
             download it once from CPA's auth-files/download endpoint —
             that's a plain file fetch, NOT a refresh-token grant).
          2. Hit ChatGPT's /backend-api/wham/usage directly with that
             token.
          3. On HTTP 401 (or other "this token is dead" signal), return
             needs_reauth=true and clear the cached token. We do NOT
             call any OAuth refresh endpoint — that's the whole point.
             Recovery is the operator's job: re-authenticate the account
             in a browser and re-upload the auth file via CPA.

        Returns a dict matching the apiCallApi.request() response shape
        the frontend already consumes, plus an extra `needs_reauth` flag
        the inspection logic uses to classify accounts.
        """
        from services.openai_backend_api import (
            InvalidAccessTokenError,
            OpenAIBackendAPI,
        )

        with self._lock:
            acct = self._accounts.get(file_name)
        if acct is None:
            return {
                "status_code": 404,
                "body": None,
                "body_text": "",
                "has_status_code": False,
                "needs_reauth": False,
                "error": f"account not found: {file_name}",
            }

        def _download() -> str | None:
            try:
                tok = self._download_token_from_cpa(acct.file_name)
            except Exception:
                return None
            with self._lock:
                acct.access_token = tok
            return tok

        def _probe_once(token: str) -> dict[str, Any] | None:
            """Returns the raw get_codex_usage dict, or None on network error."""
            try:
                return OpenAIBackendAPI(access_token=token).get_codex_usage(
                    chatgpt_account_id=chatgpt_account_id,
                    user_agent=user_agent,
                )
            except InvalidAccessTokenError:
                return {"status_code": 401, "body": None, "body_text": "", "has_status_code": True}
            except Exception as exc:
                return {"_network_error": str(exc)}

        # --- Attempt 1: use the cached token, or download once if missing ---
        token = acct.access_token
        freshly_downloaded = False
        if not token:
            token = _download()
            freshly_downloaded = True
            if not token:
                return {
                    "status_code": 0, "body": None, "body_text": "",
                    "has_status_code": False, "needs_reauth": False,
                    "error": "CPA download failed",
                }

        result = _probe_once(token)
        if result is not None and result.get("_network_error"):
            return {
                "status_code": 0, "body": None, "body_text": "",
                "has_status_code": False, "needs_reauth": False,
                "error": f"network error: {result['_network_error']}",
            }

        status_code = int((result or {}).get("status_code") or 0)

        # --- 401 on a CACHED token: don't trust it yet. CPA may have rotated
        # to a new token after our last cache. Force a fresh download and
        # re-probe ONCE. Only if the FRESH token also 401s is the account
        # truly dead (refresh_token revoked → needs browser re-login). This
        # is what makes needs_reauth authoritative: "even a fresh CPA token
        # 401s". We still never call an OAuth refresh grant ourselves. ---
        if status_code == 401 and not freshly_downloaded:
            fresh = _download()
            if fresh and fresh != token:
                token = fresh
                result = _probe_once(token)
                if result is not None and result.get("_network_error"):
                    return {
                        "status_code": 0, "body": None, "body_text": "",
                        "has_status_code": False, "needs_reauth": False,
                        "error": f"network error: {result['_network_error']}",
                    }
                status_code = int((result or {}).get("status_code") or 0)

        # 401 after a fresh-token retry = the credential itself is dead.
        needs_reauth = status_code == 401
        if needs_reauth:
            self.remove_invalid_token(token, "probe_codex_usage:401")
        elif status_code and 200 <= status_code < 300:
            # Probe succeeded with this token, so the account is healthy.
            # Clear any stale "invalid" / "fresh" label and cache the
            # working token so the panel stops showing a phantom 失效.
            with self._lock:
                if acct.status in ("fresh", "invalid"):
                    acct.status = "active"
                if token:
                    acct.access_token = token

        return {
            "status_code": status_code,
            "body": (result or {}).get("body"),
            "body_text": (result or {}).get("body_text") or "",
            "has_status_code": bool((result or {}).get("has_status_code")),
            "needs_reauth": needs_reauth,
            "error": None,
        }

    def refresh_quotas(
        self,
        tokens: list[str] | None = None,
        include_uncached: bool = True,
    ) -> dict[str, Any]:
        """Force a quota refresh against ChatGPT for each pooled account.

        Mirrors the vendor chatgpt2api refresh path (parallel /backend-api/me
        calls with bounded concurrency) so the diagnostic panel can show real
        `image_gen.remaining` numbers instead of perpetual "unknown".

        Safety: this method is read-only with respect to refresh_token. It
        calls ChatGPT's `/backend-api/me` (an info endpoint that issues no
        new tokens) and optionally CPA's `/v0/management/auth-files/download`
        (which returns the access_token CPA already holds — it does NOT ask
        CPA to rotate anything). The OAuth refresh_token grant endpoint
        (`auth.openai.com/oauth/token`) is never called from this path.

        Parameters
        ----------
        tokens : list[str] | None
            If provided, refresh only the accounts whose currently-cached
            access_token is in this list. If None, refresh every account.
        include_uncached : bool
            When True and `tokens` is None, "fresh" accounts (no cached
            access_token yet) are eagerly downloaded from CPA before being
            refreshed. Default True so a single button click populates the
            whole pool. Pass False for the cheap "refresh what we have"
            mode used by the legacy compat shim.

        Concurrency is capped at 10 workers — same ceiling as the vendor
        used. /backend-api/me calls take ~0.5-2s each; 130 accounts at 10
        concurrent finishes in roughly 10-30s.

        Returns a summary dict with success / invalid / error / skipped
        counts plus the total pool size, suitable for direct JSON return.
        """
        from concurrent.futures import ThreadPoolExecutor, as_completed
        from services.openai_backend_api import (
            InvalidAccessTokenError,
            OpenAIBackendAPI,
        )

        with self._lock:
            all_accts = list(self._accounts.values())

        if tokens is not None:
            wanted = {t for t in tokens if t}
            targets = [a for a in all_accts if a.access_token and a.access_token in wanted]
            uncached: list[_AccountState] = []
        else:
            targets = [a for a in all_accts if a.access_token]
            uncached = [a for a in all_accts if not a.access_token] if include_uncached else []

        # Phase 1: download access_tokens for "fresh" accounts so we have
        # something to call /me with. Bounded by the same worker pool — CPA
        # is local-network and quick, but no need to hammer it either.
        downloaded = 0
        download_failed = 0
        if uncached:
            def _ensure_token(acct: _AccountState) -> _AccountState | None:
                try:
                    token = self._download_token_from_cpa(acct.file_name)
                except Exception as exc:
                    logger.warning("refresh: CPA download failed for %s: %s", acct.email, exc)
                    return None
                with self._lock:
                    acct.access_token = token
                return acct

            with ThreadPoolExecutor(max_workers=min(10, len(uncached))) as ex:
                for fut in as_completed({ex.submit(_ensure_token, a): a for a in uncached}):
                    result = fut.result()
                    if result is not None:
                        downloaded += 1
                        targets.append(result)
                    else:
                        download_failed += 1

        # Phase 2: hit /backend-api/me per account, extract image_gen quota,
        # update in-memory state. Invalid tokens just get their access_token
        # cleared via the existing remove_invalid_token() helper — that does
        # NOT touch CPA or the refresh_token.
        success = 0
        invalidated = 0
        errors = 0

        def _refresh_one(acct: _AccountState) -> str:
            token = acct.access_token
            if not token:
                return "skipped"
            try:
                # IMPORTANT: image_gen.remaining lives in /backend-api/conversation/init,
                # NOT /backend-api/me. get_user_info() fans out to /me + /init +
                # /accounts/check in parallel and merges them; we only need the
                # quota fields it extracts. Matches the vendor refresh path.
                info = OpenAIBackendAPI(access_token=token).get_user_info()
            except InvalidAccessTokenError:
                self.remove_invalid_token(token, "refresh_quotas")
                return "invalid"
            except Exception as exc:
                logger.warning("refresh: get_user_info failed for %s: %s", acct.email, exc)
                return "error"
            remaining = int(info.get("quota") or 0)
            unknown = bool(info.get("image_quota_unknown", True))
            with self._lock:
                acct.quota = remaining
                acct.quota_unknown = unknown
                # Promote to "active" once ChatGPT answers successfully.
                # Crucially this also clears a stale "invalid" label: an
                # account gets marked invalid when its CACHED token 401s,
                # but include_uncached re-downloads a fresh token from CPA
                # first — so if that fresh token now works, the account is
                # healthy and must not keep showing as 失效 in the panel.
                # (Only "disabled" is left untouched — that's CPA's call,
                # set from the auth-file unavailable/disabled flag.)
                if acct.status in ("fresh", "invalid"):
                    acct.status = "active"
            return "ok"

        # Single-flight guard: if a refresh is already running (e.g. the
        # startup auto-refresh from _startup_quota_refresh has overlapped
        # with an operator-triggered manual one), bail out immediately
        # rather than letting two refreshes share the _refresh_progress
        # dict and produce non-monotonic counts. The caller gets an
        # explicit "skipped, already in progress" result.
        total = len(targets)
        with self._lock:
            if self._refresh_progress is not None:
                return {
                    "total_accounts": len(all_accts),
                    "refreshed": 0,
                    "invalidated": 0,
                    "errors": 0,
                    "downloaded_from_cpa": downloaded,
                    "download_failed": download_failed,
                    "skipped": len(all_accts) - downloaded,
                    "already_in_progress": True,
                }
            # Surface live progress so the panel's spinner can show "N / M"
            # while this is running. Updated under the same lock that
            # protects the account dict so callers reading via
            # /api/accounts/refresh-status always see a consistent snapshot.
            self._refresh_progress = {
                "done": 0,
                "total": total,
                "started_at": time.time(),
            }

        try:
            if targets:
                with ThreadPoolExecutor(max_workers=min(10, len(targets))) as ex:
                    for fut in as_completed({ex.submit(_refresh_one, a): a for a in targets}):
                        outcome = fut.result()
                        if outcome == "ok":
                            success += 1
                        elif outcome == "invalid":
                            invalidated += 1
                        elif outcome == "error":
                            errors += 1
                        with self._lock:
                            if self._refresh_progress is not None:
                                self._refresh_progress["done"] = (
                                    success + invalidated + errors
                                )
        finally:
            with self._lock:
                self._refresh_progress = None

        return {
            "total_accounts": len(all_accts),
            "refreshed": success,
            "invalidated": invalidated,
            "errors": errors,
            "downloaded_from_cpa": downloaded,
            "download_failed": download_failed,
            "skipped": len(all_accts) - success - invalidated - errors - download_failed,
        }

    def get_refresh_progress(self) -> dict | None:
        """Return the in-flight refresh progress snapshot, or None when no
        refresh is currently running. Cheap — just a locked dict read."""
        with self._lock:
            if self._refresh_progress is None:
                return None
            # Return a copy so callers don't see mutations after they've read.
            return dict(self._refresh_progress)

    # ----- internal helpers -----

    def _refresh_file_list_if_stale(self) -> None:
        with self._lock:
            stale = (time.time() - self._cpa_files_ts) > config.cpa_list_cache_secs
        if stale:
            try:
                self._refresh_file_list_now()
            except Exception as exc:
                logger.warning("CPA list refresh failed: %s", exc)

    def _refresh_file_list_now(self) -> None:
        files = self._fetch_cpa_file_list()
        with self._lock:
            seen = set()
            for f in files:
                if not f.name or not f.email:
                    continue
                seen.add(f.name)
                acct = self._accounts.get(f.name)
                if acct is None:
                    # Brand new account — no cached token, quota unknown.
                    # Respect only the user's explicit disabled toggle (not
                    # CPA's unreliable unavailable flag — see the update
                    # branch below for the full rationale).
                    new_acct = _AccountState(
                        file_name=f.name, email=f.email, cpa_modtime=f.modtime,
                    )
                    if f.disabled:
                        new_acct.status = "disabled"
                    self._accounts[f.name] = new_acct
                    logger.info("added CPA account: %s", f.email)
                else:
                    # Update mutable per-file metadata. If modtime bumped,
                    # CPA likely rotated the token — invalidate our copy
                    # so the next pick re-downloads.
                    if f.modtime > acct.cpa_modtime > 0:
                        acct.access_token = ""
                        acct.status = "invalid"
                        logger.info("CPA modtime bumped for %s; will re-download token", f.email)
                    acct.cpa_modtime = f.modtime
                    acct.email = f.email
                    # Only the user's explicit `disabled` toggle parks an
                    # account. We deliberately IGNORE CPA's `unavailable`
                    # flag here: for free ChatGPT accounts CPA's background
                    # health probe (refresh-token path) over-marks healthy
                    # accounts as unavailable — a probe sweep found 12/12
                    # CPA-unavailable accounts actually returned 200 via the
                    # safe path. Trusting that flag was excluding ~55 healthy
                    # accounts (a third of the pool) from image generation.
                    #
                    # image-service does its OWN health tracking: a real 401
                    # during image-gen or refresh marks the account "invalid"
                    # (remove_invalid_token) and the picker retries another,
                    # so we don't need — and can't trust — CPA's unavailable
                    # signal. The user's manual `disabled` toggle is the only
                    # authoritative "park this account" instruction.
                    if f.disabled:
                        acct.status = "disabled"
                    elif acct.status == "disabled":
                        # Was parked (by us, from an old disabled/unavailable
                        # read); CPA now reports it not-user-disabled, so let
                        # it back into rotation as fresh — next pick/refresh
                        # re-downloads a token and promotes to active.
                        acct.status = "fresh"
            # Drop accounts CPA no longer lists.
            for name in list(self._accounts.keys()):
                if name not in seen:
                    removed = self._accounts.pop(name)
                    logger.info("removed CPA account: %s", removed.email or name)
            self._cpa_files_ts = time.time()

    def _fetch_cpa_file_list(self) -> list[_CPAFile]:
        if not config.cpa_base_url or not config.cpa_management_key:
            raise RuntimeError("cpa not configured (CPA_BASE_URL / CPA_MANAGEMENT_KEY missing)")
        url = config.cpa_base_url.rstrip("/") + "/v0/management/auth-files"
        r = self._cpa_session.get(
            url,
            headers={"Authorization": f"Bearer {config.cpa_management_key}", "Accept": "application/json"},
            timeout=15,
        )
        if r.status_code // 100 != 2:
            raise RuntimeError(f"CPA list failed: HTTP {r.status_code}")
        payload = r.json() or {}
        raw_files = payload.get("files") or []
        return [_CPAFile(item) for item in raw_files if isinstance(item, dict)]

    def _download_token_from_cpa(self, file_name: str) -> str:
        # CPA's download endpoint takes the file name as `?name=` (NOT ?file=)
        # and responds with text/plain whose body is a JSON document like:
        #   {"access_token": "eyJ...", "refresh_token": "...", "id_token": "..."}
        # curl_cffi's .json() parses regardless of Content-Type.
        url = config.cpa_base_url.rstrip("/") + "/v0/management/auth-files/download"
        r = self._cpa_session.get(
            url,
            params={"name": file_name},
            headers={"Authorization": f"Bearer {config.cpa_management_key}"},
            timeout=15,
        )
        if r.status_code // 100 != 2:
            raise RuntimeError(f"CPA download {file_name} failed: HTTP {r.status_code}")
        try:
            body = r.json() or {}
        except Exception as exc:
            raise RuntimeError(f"CPA download {file_name}: non-JSON body ({exc})")
        token = (
            body.get("access_token")
            or body.get("token")
            or (body.get("tokens") or {}).get("access_token")
            or ""
        )
        token = (token or "").strip() if isinstance(token, str) else ""
        if not token:
            raise RuntimeError(f"CPA download {file_name}: no access_token in response")
        return token

    def _pick_locked(self) -> _AccountState | None:
        """Lock-held; picks the best account or returns None.

        Before applying the eligibility filter, sweep accounts whose
        `inflight` slot was incremented but never released. This happens
        when a worker dies (SIGKILL / OOM / container restart / abandoned
        SSH) between get_available_access_token() and mark_image_result()
        / release_image_slot(). Without this, even one orphaned slot per
        account permanently shrinks the usable pool — observed in
        production when paragen feasibility tests were killed mid-poll,
        leaving 51 phantom slots that needed an image-service restart to
        clear.

        Reaping at pick-time (lazy) instead of via a background thread
        keeps the fix simple and lock-free: every selector pass naturally
        gets a chance to recover stuck slots. Cost is one wall-clock
        comparison per account; negligible at pool sizes <10K.
        """
        now = time.time()
        reap_after = max(60, int(config.image_inflight_reap_after_secs))
        reaped = 0
        for acct in self._accounts.values():
            if acct.inflight > 0 and (now - acct.last_used_at) > reap_after:
                logger.warning({
                    "event": "inflight_reaped",
                    "file_name": acct.file_name,
                    "email": acct.email,
                    "inflight_was": acct.inflight,
                    "idle_secs": int(now - acct.last_used_at),
                })
                acct.inflight = 0
                acct.in_use = False
                reaped += 1
        if reaped:
            # Some slots came back; wake any waiters in case they were
            # blocked on the (now-stale) inflight ceiling.
            self._cond.notify_all()

        max_inflight = max(1, config.image_account_concurrency)
        eligible = [
            a for a in self._accounts.values()
            if a.status != "disabled"
            and not a.in_use
            and a.inflight < max_inflight
            and (a.quota_unknown or a.quota > 0)
        ]
        if not eligible:
            return None
        # Round-robin: least-recently-used wins.
        eligible.sort(key=lambda a: (a.inflight, a.last_used_at))
        return eligible[0]

    def _ensure_token_locked(self, acct: _AccountState) -> str:
        """Lock-held during call; releases briefly for the HTTP fetch, then
        re-acquires. For session-cookie accounts, mints from the cookie via
        /api/auth/session; otherwise downloads the token from CPA."""
        file_name = acct.file_name
        self._load_session_cookies_locked()
        cookie_entry = self._session_cookies.get(file_name)
        cookie = (cookie_entry or {}).get("cookie") if cookie_entry else None

        if cookie:
            # Session-managed: reuse the cached token unless it's missing or
            # within the re-mint margin of expiry; otherwise mint a fresh one
            # from the cookie. No refresh_token, no CPA download involved.
            from services.openai_backend_api import InvalidAccessTokenError
            now = time.time()
            if acct.access_token and acct.token_exp - now > SESSION_REMINT_MARGIN_SECS:
                return acct.access_token
            self._lock.release()
            reacquired = False
            try:
                result = self._mint_session_token(file_name, cookie)
            except InvalidAccessTokenError:
                self._lock.acquire()
                reacquired = True
                a = self._accounts.get(file_name)
                if a is not None:
                    a.needs_relogin = True
                    a.access_token = ""
                    a.status = "invalid"
                raise
            finally:
                if not reacquired:
                    self._lock.acquire()
            a = self._accounts.get(file_name)
            if a is None:
                raise RuntimeError("no available image quota")
            a.access_token = result["access_token"]
            a.token_exp = _jwt_exp(result["access_token"])
            a.status = "active"
            a.needs_relogin = False
            return a.access_token

        # Non-session account: existing CPA-download path.
        if acct.access_token:
            return acct.access_token
        self._lock.release()
        try:
            token = self._download_token_from_cpa(file_name)
        finally:
            self._lock.acquire()
        acct = self._accounts.get(file_name)
        if acct is None:
            # File disappeared while we were downloading. Reraise as no-quota
            # so the picker tries another account.
            raise RuntimeError("no available image quota")
        acct.access_token = token
        acct.status = "active"
        return token

    def _find_by_token_locked(self, access_token: str) -> _AccountState | None:
        if not access_token:
            return None
        for acct in self._accounts.values():
            if acct.access_token == access_token:
                return acct
        return None

    def _to_dict_locked(self, acct: _AccountState) -> dict[str, Any]:
        return {
            "file_name": acct.file_name,
            "email": acct.email,
            "status": acct.status,
            "quota": acct.quota,
            "quota_unknown": acct.quota_unknown,
            "last_used_at": acct.last_used_at,
            "success": acct.success,
            "fail": acct.fail,
            "inflight": acct.inflight,
        }

    def _to_dict_redacted_locked(self, acct: _AccountState) -> dict[str, Any]:
        d = self._to_dict_locked(acct)
        d["has_access_token"] = bool(acct.access_token)
        # Session-cookie accounts (MFA, no refresh_token): surface whether
        # they're cookie-managed and whether the cookie has died so the
        # panel / extension can show "needs re-login" precisely.
        d["session_managed"] = acct.file_name in self._session_cookies
        d["needs_relogin"] = bool(acct.needs_relogin)
        return d


account_service = AccountService()
