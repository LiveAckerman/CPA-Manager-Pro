"""Adapter: OpenAI /v1/responses  ->  web ChatGPT conversation pool.

This is the endpoint sub2api-style capability probes hit. The Codex
`/v1/responses` API needs a refresh_token OAuth token (which cookie accounts
don't have), so when CPA's codex provider has no auth this adapter lets the
free cookie accounts answer with the consumer ChatGPT web model instead.

Text-only. The client-requested model name is echoed back; the actual brain
is the web model (model=auto).

v1 streaming note: text is generated to completion first (so a pool failure
surfaces as a proper HTTP status before the stream starts), then replayed as
typed Responses SSE events.
"""
from __future__ import annotations

import json
import time
import uuid
from typing import Any, Iterator

import itertools

from services.protocol.conversation import (
    ConversationRequest,
    collect_text_with_pool,
    stream_text_with_pool,
)


def _id(prefix: str) -> str:
    return f"{prefix}_" + uuid.uuid4().hex


def _text_from_content(content: Any) -> str:
    """Flatten a Responses `content` value (str | list of parts) to text."""
    if isinstance(content, str):
        return content
    if isinstance(content, list):
        parts: list[str] = []
        for part in content:
            if isinstance(part, str):
                parts.append(part)
            elif isinstance(part, dict):
                t = part.get("text")
                if isinstance(t, str):
                    parts.append(t)
        return "".join(parts)
    return ""


def _input_to_messages(body: dict[str, Any]) -> list[dict[str, Any]]:
    messages: list[dict[str, Any]] = []
    instructions = body.get("instructions")
    if isinstance(instructions, str) and instructions.strip():
        messages.append({"role": "system", "content": instructions})

    value = body.get("input")
    if isinstance(value, str):
        messages.append({"role": "user", "content": value})
    elif isinstance(value, list):
        for item in value:
            if isinstance(item, str):
                messages.append({"role": "user", "content": item})
            elif isinstance(item, dict):
                role = item.get("role") or "user"
                content = item.get("content")
                if content is None and item.get("type") in ("input_text", "output_text", "text"):
                    content = item.get("text")
                text = _text_from_content(content)
                if text:
                    messages.append({"role": role, "content": text})
    if not messages:
        messages.append({"role": "user", "content": ""})
    return messages


def _request(body: dict[str, Any]) -> tuple[ConversationRequest, str]:
    messages = _input_to_messages(body)
    model = str(body.get("model") or "auto")
    return ConversationRequest(messages=messages, model=model), model


def compute(body: dict[str, Any]) -> tuple[str, str]:
    """Run the pooled text conversation. Returns (text, echoed_model).
    Raises ImageGenerationError on pool failure."""
    req, model = _request(body)
    return collect_text_with_pool(req), model


def _envelope(rid: str, model: str, created: int, text: str) -> dict[str, Any]:
    return {
        "id": rid,
        "object": "response",
        "created_at": created,
        "status": "completed",
        "model": model,
        "output": [
            {
                "type": "message",
                "id": _id("msg"),
                "status": "completed",
                "role": "assistant",
                "content": [{"type": "output_text", "text": text, "annotations": []}],
            }
        ],
        "output_text": text,
        "usage": {"input_tokens": 0, "output_tokens": 0, "total_tokens": 0},
    }


def handle(body: dict[str, Any]) -> dict[str, Any]:
    """Non-streaming response."""
    text, model = compute(body)
    return _envelope(_id("resp"), model, int(time.time()), text)


def _sse(event: str, seq: int, data: dict[str, Any]) -> str:
    # The Responses API carries the event name AND a sequence_number INSIDE
    # the data JSON; strict clients (Codex CLI) dispatch on data.type, not the
    # `event:` line. Omitting these makes them ignore every event and report
    # "stream closed before response.completed".
    payload = {"type": event, "sequence_number": seq, **data}
    return f"event: {event}\ndata: " + json.dumps(payload, ensure_ascii=False) + "\n\n"


def start_stream(body: dict[str, Any]) -> Iterator[str]:
    """Real token-by-token Responses SSE.

    Acquires the pool token and the first delta eagerly (so a no-auth failure
    raises ImageGenerationError BEFORE the 200 stream starts and the route can
    return a proper status), then streams the rest. Once the stream has begun,
    response.completed is ALWAYS emitted — even on a mid-stream upstream hiccup
    — so the client never sees a truncated stream.
    """
    req, model = _request(body)
    pool = stream_text_with_pool(req)
    try:
        first = next(pool)
        has_first = True
    except StopIteration:
        first, has_first = "", False
    # (ImageGenerationError from the pool propagates here, before any yield.)
    return _events(model, pool, first, has_first)


def _events(model: str, pool: Iterator[str], first: str, has_first: bool) -> Iterator[str]:
    rid = _id("resp")
    msg_id = _id("msg")
    created = int(time.time())
    seq = itertools.count()
    base = {"id": rid, "object": "response", "created_at": created, "status": "in_progress", "model": model}

    yield _sse("response.created", next(seq), {"response": {**base, "output": []}})
    yield _sse("response.output_item.added", next(seq), {
        "output_index": 0,
        "item": {"type": "message", "id": msg_id, "status": "in_progress", "role": "assistant", "content": []},
    })
    yield _sse("response.content_part.added", next(seq), {
        "item_id": msg_id, "output_index": 0, "content_index": 0,
        "part": {"type": "output_text", "text": "", "annotations": []},
    })

    full: list[str] = []

    def emit_delta(piece: str) -> str:
        full.append(piece)
        return _sse("response.output_text.delta", next(seq), {
            "item_id": msg_id, "output_index": 0, "content_index": 0, "delta": piece,
        })

    if has_first and first:
        yield emit_delta(first)
    try:
        for piece in pool:
            if piece:
                yield emit_delta(piece)
    except Exception:  # noqa: BLE001 — finalize the stream regardless
        pass

    text = "".join(full)
    yield _sse("response.output_text.done", next(seq), {
        "item_id": msg_id, "output_index": 0, "content_index": 0, "text": text,
    })
    yield _sse("response.content_part.done", next(seq), {
        "item_id": msg_id, "output_index": 0, "content_index": 0,
        "part": {"type": "output_text", "text": text, "annotations": []},
    })
    yield _sse("response.output_item.done", next(seq), {
        "output_index": 0,
        "item": {
            "type": "message", "id": msg_id, "status": "completed", "role": "assistant",
            "content": [{"type": "output_text", "text": text, "annotations": []}],
        },
    })
    yield _sse("response.completed", next(seq), {"response": _envelope(rid, model, created, text)})
