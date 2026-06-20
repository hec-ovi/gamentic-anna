"""The executa must NEVER let the Anna host think it is hung and recycle it.

Every invoke answers within a bounded budget: the host's own per-invoke deadline
(``params.context.deadline_ms``, derived from the iframe's ``timeoutMs``) minus a
margin so WE reply first, or a configured ceiling when the host sends no deadline.
A request that outruns the budget returns ``{success: false, timeout: true}`` and
the in-flight work is cancelled, instead of blocking until the host gives up and
restarts the executa (which dropped every other in-flight call and surfaced
"executa process exited" in the UI).
"""
import asyncio
import threading
import time

import pytest

from app import executa
from app.config import settings


def test_budget_defaults_to_ceiling_without_host_deadline(monkeypatch):
    monkeypatch.setattr(settings, "INVOKE_BUDGET_S", 175.0)
    # No deadline from the host -> never inf; fall back to our own ceiling.
    assert executa._invoke_budget_s({}) == 175.0
    assert executa._invoke_budget_s({"context": {}}) == 175.0


def test_budget_respects_host_deadline(monkeypatch):
    monkeypatch.setattr(settings, "INVOKE_BUDGET_S", 175.0)
    monkeypatch.setattr(settings, "INVOKE_DEADLINE_MARGIN_S", 6.0)
    params = {"context": {"deadline_ms": int((time.time() + 30) * 1000)}}
    budget = executa._invoke_budget_s(params)
    # ~30s remaining, minus the 6s margin, and under the 175s ceiling.
    assert 22.0 <= budget <= 25.0


def test_budget_caps_a_huge_host_deadline(monkeypatch):
    monkeypatch.setattr(settings, "INVOKE_BUDGET_S", 175.0)
    monkeypatch.setattr(settings, "INVOKE_DEADLINE_MARGIN_S", 6.0)
    params = {"context": {"deadline_ms": int((time.time() + 9000) * 1000)}}
    assert executa._invoke_budget_s(params) == 175.0


@pytest.fixture
def bg_loop():
    loop = asyncio.new_event_loop()
    threading.Thread(target=loop.run_forever, daemon=True).start()
    yield loop
    loop.call_soon_threadsafe(loop.stop)


def test_invoke_answers_gracefully_when_over_budget(monkeypatch, bg_loop):
    monkeypatch.setattr(executa, "_loop", bg_loop)
    monkeypatch.setattr(executa, "_ensure_client", lambda: None)
    monkeypatch.setattr(settings, "INVOKE_BUDGET_S", 0.2)

    async def _slow(path, method, body, query):
        await asyncio.sleep(5)            # outruns the 0.2s budget
        return {"status": 200, "json": {"never": "returned"}}

    monkeypatch.setattr(executa, "_run_request", _slow)
    out = executa._do_invoke({"tool": "request", "arguments": {"path": "/health"}})
    assert out["result"]["success"] is False
    assert out["result"].get("timeout") is True


def test_invoke_returns_normally_under_budget(monkeypatch, bg_loop):
    monkeypatch.setattr(executa, "_loop", bg_loop)
    monkeypatch.setattr(executa, "_ensure_client", lambda: None)
    monkeypatch.setattr(settings, "INVOKE_BUDGET_S", 10.0)

    async def _fast(path, method, body, query):
        return {"status": 200, "json": {"ok": True}}

    monkeypatch.setattr(executa, "_run_request", _fast)
    out = executa._do_invoke({"tool": "request", "arguments": {"path": "/health"}})
    assert out["result"]["success"] is True
    assert out["result"]["data"]["json"] == {"ok": True}
