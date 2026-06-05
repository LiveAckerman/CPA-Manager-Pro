"""Adapter: OpenAI /v1/chat/completions  ->  web ChatGPT conversation pool.

Lets the free cookie accounts serve plain-text chat. The actual brain is the
consumer ChatGPT web model (model=auto); the client-requested model name is
only echoed back in the response. Text-only — no tools / function calling /
JSON mode / reasoning controls.

v1 streaming note: the text is generated to completion first (so a pool
failure surfaces as a proper HTTP status before the stream starts), then
replayed as SSE chunks. Token-by-token real-time streaming is a later
improvement.
"""
from __future__ import annotations

import json
import time
import uuid
from typing import Any, Iterator

from services.protocol.conversation import (
    ConversationRequest,
    collect_text_with_pool,
    stream_text_with_pool,
)


def _id() -> str:
    return "chatcmpl-" + uuid.uuid4().hex


def _request(body: dict[str, Any]) -> tuple[ConversationRequest, str]:
    messages = body.get("messages") or []
    if not isinstance(messages, list):
        messages = []
    model = str(body.get("model") or "auto")
    return ConversationRequest(messages=messages, model=model), model


def compute(body: dict[str, Any]) -> tuple[str, str]:
    """Run the pooled text conversation. Returns (text, echoed_model).
    Raises ImageGenerationError on pool failure."""
    req, model = _request(body)
    return collect_text_with_pool(req), model


def _completion(text: str, model: str) -> dict[str, Any]:
    return {
        "id": _id(),
        "object": "chat.completion",
        "created": int(time.time()),
        "model": model,
        "choices": [
            {
                "index": 0,
                "message": {"role": "assistant", "content": text},
                "finish_reason": "stop",
            }
        ],
        "usage": {"prompt_tokens": 0, "completion_tokens": 0, "total_tokens": 0},
    }


def handle(body: dict[str, Any]) -> dict[str, Any]:
    """Non-streaming chat completion."""
    text, model = compute(body)
    return _completion(text, model)


def start_stream(body: dict[str, Any]) -> Iterator[str]:
    """Real token-by-token chat-completion SSE.

    Acquires the pool token + first delta eagerly so a no-auth failure raises
    BEFORE the 200 stream starts (route returns a proper status); once started,
    the stream is always finalized with a stop chunk + [DONE].
    """
    req, model = _request(body)
    pool = stream_text_with_pool(req)
    try:
        first = next(pool)
        has_first = True
    except StopIteration:
        first, has_first = "", False
    # (ImageGenerationError from the pool propagates here, before any yield.)
    return _chunks(model, pool, first, has_first)


def _chunks(model: str, pool: Iterator[str], first: str, has_first: bool) -> Iterator[str]:
    cid = _id()
    created = int(time.time())

    def chunk(delta: dict[str, Any], finish: str | None = None) -> str:
        payload = {
            "id": cid,
            "object": "chat.completion.chunk",
            "created": created,
            "model": model,
            "choices": [{"index": 0, "delta": delta, "finish_reason": finish}],
        }
        return "data: " + json.dumps(payload, ensure_ascii=False) + "\n\n"

    yield chunk({"role": "assistant"})
    if has_first and first:
        yield chunk({"content": first})
    try:
        for piece in pool:
            if piece:
                yield chunk({"content": piece})
    except Exception:  # noqa: BLE001 — finalize the stream regardless
        pass
    yield chunk({}, finish="stop")
    yield "data: [DONE]\n\n"
