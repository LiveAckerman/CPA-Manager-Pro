"""Tests for the web-text adapters: /v1/chat/completions + /v1/responses
served by the cookie-account pool (services.protocol.conversation
stream_text_with_pool + the two adapter modules)."""
from __future__ import annotations

import json
import sys
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from services.protocol import conversation as conv  # noqa: E402
from services.protocol import openai_v1_chat_completions as chat  # noqa: E402
from services.protocol import openai_v1_responses as resp  # noqa: E402
from services.protocol.conversation import ConversationRequest, ImageGenerationError  # noqa: E402


# --- stream_text_with_pool -------------------------------------------------

class _Acct:
    """Stub account_service for the pool wrapper."""

    def __init__(self, tokens):
        self._tokens = list(tokens)
        self.removed = []
        self.results = []

    def get_available_access_token(self):
        if not self._tokens:
            raise RuntimeError("no available image quota")
        return self._tokens[0]

    def mark_image_result(self, token, ok):
        self.results.append((token, ok))

    def release_image_slot(self, token):
        pass

    def remove_invalid_token(self, token, event):
        self.removed.append(token)
        if token in self._tokens:
            self._tokens.remove(token)


def _events(text):
    def gen(backend, **kw):
        for ch in text:
            yield {"type": "conversation.delta", "delta": ch}
    return gen


def test_pool_text_success(monkeypatch):
    acct = _Acct(["tok-1"])
    monkeypatch.setattr(conv, "account_service", acct)
    monkeypatch.setattr(conv, "conversation_events", _events("你好"))
    out = conv.collect_text_with_pool(ConversationRequest(prompt="hi", model="auto"))
    assert out == "你好"
    assert acct.results == [("tok-1", True)]


def test_pool_text_evicts_invalid_then_succeeds(monkeypatch):
    acct = _Acct(["dead", "good"])
    monkeypatch.setattr(conv, "account_service", acct)

    def events(backend, **kw):
        if backend.access_token == "dead":
            raise RuntimeError("authentication token has been invalidated")
        yield {"type": "conversation.delta", "delta": "ok"}

    monkeypatch.setattr(conv, "conversation_events", events)
    out = conv.collect_text_with_pool(ConversationRequest(prompt="hi"))
    assert out == "ok"
    assert acct.removed == ["dead"]  # dead token evicted, retried with good


def test_pool_text_no_auth_raises_503(monkeypatch):
    acct = _Acct([])  # empty pool
    monkeypatch.setattr(conv, "account_service", acct)
    with pytest.raises(ImageGenerationError) as ei:
        conv.collect_text_with_pool(ConversationRequest(prompt="hi"))
    assert ei.value.status_code == 503
    assert ei.value.code == "auth_unavailable"


# --- chat completions adapter ----------------------------------------------

def test_chat_handle_envelope(monkeypatch):
    monkeypatch.setattr(chat, "collect_text_with_pool", lambda req: "hello there")
    out = chat.handle({"model": "gpt-5.5", "messages": [{"role": "user", "content": "hi"}]})
    assert out["object"] == "chat.completion"
    assert out["model"] == "gpt-5.5"  # client model echoed
    assert out["choices"][0]["message"]["content"] == "hello there"
    assert out["choices"][0]["finish_reason"] == "stop"


def test_chat_stream_sse_shape():
    chunks = list(chat._chunks("gpt-5.5", iter(["wo", "rld"]), "hi", True))
    assert chunks[0].startswith("data: ")
    assert '"role": "assistant"' in chunks[0]
    assert any('"content": "hi"' in c for c in chunks)
    assert any('"content": "wo"' in c for c in chunks)
    assert any('"content": "rld"' in c for c in chunks)
    assert any('"finish_reason":"stop"' in c.replace(" ", "") for c in chunks)
    assert chunks[-1] == "data: [DONE]\n\n"


def test_chat_start_stream_raises_on_no_auth(monkeypatch):
    def boom(req):
        raise ImageGenerationError("no auth", status_code=503, code="auth_unavailable")

    monkeypatch.setattr(chat, "stream_text_with_pool", lambda req: boom(req))
    with pytest.raises(ImageGenerationError):
        chat.start_stream({"model": "x", "messages": [{"role": "user", "content": "hi"}]})


# --- responses adapter -----------------------------------------------------

def test_responses_input_string():
    msgs = resp._input_to_messages({"input": "hello"})
    assert msgs == [{"role": "user", "content": "hello"}]


def test_responses_input_list_with_parts():
    body = {
        "instructions": "be brief",
        "input": [
            {"role": "user", "content": [{"type": "input_text", "text": "part-a"}, {"type": "input_text", "text": "part-b"}]},
        ],
    }
    msgs = resp._input_to_messages(body)
    assert msgs[0] == {"role": "system", "content": "be brief"}
    assert msgs[1] == {"role": "user", "content": "part-apart-b"}


def test_responses_handle_envelope(monkeypatch):
    monkeypatch.setattr(resp, "collect_text_with_pool", lambda req: "the answer")
    out = resp.handle({"model": "gpt-5.5", "input": "q?"})
    assert out["object"] == "response"
    assert out["status"] == "completed"
    assert out["model"] == "gpt-5.5"
    assert out["output_text"] == "the answer"
    assert out["output"][0]["content"][0]["text"] == "the answer"


def test_responses_stream_events_ordered():
    events = list(resp._events("gpt-5.5", iter(["lo"]), "hel", True))
    joined = "".join(events)
    assert "event: response.created" in events[0]
    assert "event: response.output_text.delta" in joined
    assert "event: response.completed" in events[-1]


def test_responses_stream_data_has_type_and_sequence():
    # Regression: Codex CLI dispatches on data.type + needs sequence_number.
    # Missing them => "stream closed before response.completed".
    events = list(resp._events("gpt-5.5", iter([]), "hi", True))
    for ev in events:
        data = ev.split("data: ", 1)[1]
        obj = json.loads(data)
        assert "type" in obj, f"event missing data.type: {ev!r}"
        assert "sequence_number" in obj, f"event missing sequence_number: {ev!r}"
    # sequence numbers are monotonic from 0
    seqs = [json.loads(ev.split("data: ", 1)[1])["sequence_number"] for ev in events]
    assert seqs == list(range(len(events)))
    # the completed event echoes the full text
    last = json.loads(events[-1].split("data: ", 1)[1])
    assert last["type"] == "response.completed"
    assert last["response"]["output_text"] == "hi"


def test_responses_start_stream_finalizes_on_midstream_error(monkeypatch):
    # First delta ok, then the pool raises mid-stream → must still emit
    # response.completed so the client never sees a truncated stream.
    def flaky(req):
        yield "par"
        raise RuntimeError("upstream reset")

    monkeypatch.setattr(resp, "stream_text_with_pool", flaky)
    events = list(resp.start_stream({"model": "x", "input": "hi"}))
    assert "event: response.completed" in events[-1]
    last = json.loads(events[-1].split("data: ", 1)[1])
    assert last["response"]["output_text"] == "par"  # partial text preserved
