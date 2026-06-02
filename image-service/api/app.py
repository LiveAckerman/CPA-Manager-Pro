"""FastAPI app for image-service.

Slim version of vendor's api/app.py: only image routes + health + read-only
accounts diagnostic. No Next.js web UI, no backup endpoints, no register
flow, no chat/responses/anthropic, no logs/settings management.
"""
from __future__ import annotations

from contextlib import asynccontextmanager

from fastapi import FastAPI, HTTPException
from fastapi.concurrency import run_in_threadpool
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse
from pydantic import BaseModel, Field

from api import ai
from services.account_service import account_service
from services.config import config


class ImportSessionRequest(BaseModel):
    # CPA file name of the account being kept alive via session cookie.
    file_name: str = Field(..., min_length=1)
    # The __Secure-next-auth.session-token cookie value the Chrome extension
    # grabbed after a browser login at chatgpt.com.
    session_cookie: str = Field(..., min_length=1)
    # Optional: an access_token the extension already minted from
    # /api/auth/session. If omitted, image-service mints one from the cookie.
    access_token: str | None = None


class ProbeCodexRequest(BaseModel):
    # CPA file name — stable identifier the image-service uses as primary
    # key in its in-memory account pool. Frontend already has this from
    # the auth-files list it loaded for the inspection page; passing it
    # avoids any authIndex translation.
    file_name: str = Field(..., min_length=1)
    # Optional override that the original codex-inspection HTTP call set
    # via Chatgpt-Account-Id header. Forwarded to ChatGPT as-is.
    chatgpt_account_id: str | None = None
    # Optional User-Agent override, mirroring the codex-inspection
    # settings page where the operator can tune this.
    user_agent: str | None = None


def create_app() -> FastAPI:
    @asynccontextmanager
    async def lifespan(_: FastAPI):
        account_service.start_background_refresh()
        try:
            yield
        finally:
            account_service.stop_background_refresh()

    app = FastAPI(title="image-service", version="0.1.0", lifespan=lifespan)
    app.add_middleware(
        CORSMiddleware,
        allow_origins=["*"],
        allow_credentials=False,
        allow_methods=["*"],
        allow_headers=["*"],
    )
    app.include_router(ai.create_router())

    @app.get("/health")
    async def health():
        return {
            "status": "ok",
            "service": "image-service",
            "accounts_cached": account_service.account_count(),
        }

    @app.get("/api/accounts")
    async def list_accounts(authorization: str | None = None):
        # Diagnostic: returns redacted account list so operators can see
        # what's in the pool without exposing access tokens.
        return {"items": account_service.list_accounts_redacted()}

    @app.get("/api/accounts/refresh-status")
    async def refresh_account_quotas_status():
        # Live in-flight refresh progress, or {"in_progress": false}. Polled
        # by the panel every 2s while the refresh button is busy so the
        # spinner can show a real "N / M" count from the server's POV
        # (client-side guesses don't work after the first startup refresh
        # because every account already has status=active by then).
        progress = account_service.get_refresh_progress()
        if progress is None:
            return {"in_progress": False}
        return {
            "in_progress": True,
            "done": progress.get("done", 0),
            "total": progress.get("total", 0),
            "started_at": progress.get("started_at"),
        }

    @app.post("/api/accounts/refresh")
    async def refresh_account_quotas(include_uncached: bool = True):
        # Force-refresh each pooled account's image_gen quota by hitting
        # ChatGPT's /backend-api/me. Pure READ — never touches refresh_token,
        # never calls any OAuth grant endpoint. See refresh_quotas() docstring
        # for the full safety argument.
        #
        # Default include_uncached=True so "fresh" accounts (no cached token
        # yet) get their token pulled from CPA and refreshed in one shot —
        # what an operator clicking the diagnostic panel's "refresh" button
        # actually wants. Pass ?include_uncached=false for the cheap "only
        # what's already warm" path.
        result = await run_in_threadpool(
            account_service.refresh_quotas, None, include_uncached
        )
        return result

    @app.post("/api/accounts/import-session")
    async def import_session_endpoint(body: ImportSessionRequest):
        # Register a browser-login session cookie for an MFA account that
        # can't use the OAuth refresh_token flow. image-service then keeps
        # the account alive by minting access_tokens from the cookie
        # (/api/auth/session) — no refresh_token, no app_session_terminated.
        # See account_service.import_session() for the full lifecycle.
        result = await run_in_threadpool(
            account_service.import_session,
            body.file_name,
            body.session_cookie,
            body.access_token or "",
        )
        return result

    @app.post("/api/accounts/probe-codex")
    async def probe_codex_endpoint(body: ProbeCodexRequest):
        # Read-only Codex usage probe for codex-inspection.
        #
        # Replaces the old CPA `/api-call` hot path that was triggering
        # OpenAI's `app_session_terminated` on free accounts. This route
        # uses the in-memory access_token directly against ChatGPT — no
        # OAuth refresh grant ever fires. See
        # account_service.probe_codex_usage() docstring for the full
        # safety argument and recovery story when a token is dead.
        result = await run_in_threadpool(
            account_service.probe_codex_usage,
            body.file_name,
            body.chatgpt_account_id or "",
            body.user_agent or "",
        )
        return result

    @app.get("/images/{image_path:path}", include_in_schema=False)
    async def serve_image(image_path: str):
        # Serve the locally-stored PNG so URLs returned by image_storage_service
        # actually work when clients fetch them.
        target = (config.images_dir / image_path).resolve()
        try:
            target.relative_to(config.images_dir.resolve())
        except ValueError:
            raise HTTPException(status_code=404, detail="not found")
        if not target.is_file():
            raise HTTPException(status_code=404, detail="not found")
        return FileResponse(target)

    return app
