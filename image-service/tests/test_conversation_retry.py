"""Tests for the transient-error retry classifier added with the 502 fix.

is_retryable_error decides whether a failed image-gen attempt should be
retried against a DIFFERENT pool account (transient: timeout / 5xx /
connection reset) vs surfaced immediately (deterministic: content policy,
bad request). Getting this wrong is what produced the 502s — a single slow
account aborting the whole request while healthy accounts went untried.
"""
from __future__ import annotations

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from services.protocol.conversation import (  # noqa: E402
    is_retryable_error,
    is_token_invalid_error,
)


def test_curl_timeout_is_retryable():
    msg = "Failed to perform, curl: (28) Operation timed out after 30002 milliseconds with 0 bytes received."
    assert is_retryable_error(msg) is True


def test_upstream_5xx_is_retryable():
    assert is_retryable_error("auth_chat_requirements failed: status=502, body=") is True
    assert is_retryable_error("conversation failed: status=503") is True
    assert is_retryable_error("bad gateway") is True
    assert is_retryable_error("gateway timeout") is True


def test_connection_reset_is_retryable():
    assert is_retryable_error("curl: (56) recv failure: connection reset by peer") is True
    assert is_retryable_error("curl: (35) tls connect error") is True


def test_token_invalid_is_not_retryable():
    # Token-invalid is handled by a SEPARATE branch (evict + retry); it must
    # not be classified as a transient retry or the account never gets
    # evicted from the pool.
    msg = 'status=401, body={"code": "token_invalidated"}'
    assert is_token_invalid_error(msg) is True
    assert is_retryable_error(msg) is False


def test_content_policy_400_is_not_retryable():
    # Deterministic rejection — retrying a different account just burns
    # quota and returns the same 400.
    msg = "Image generation was rejected by upstream policy (content_policy_violation)"
    assert is_retryable_error(msg) is False


def test_plain_4xx_not_retryable():
    assert is_retryable_error("status=400, body=bad request") is False
    assert is_retryable_error("the 'gpt-5.4' model is not supported") is False
