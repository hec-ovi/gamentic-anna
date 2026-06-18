"""LLM transport resilience (seen live): a redeploy of the llama.cpp container kills
in-flight requests, so chat() retries ONCE on connection-level errors. Timeouts are
never retried (a 180s timeout means the box is busy; retrying doubles the pain)."""
import httpx
import pytest

from app import llm

_PAYLOAD = {
    "choices": [{"message": {"content": "The dust settles."}, "finish_reason": "stop"}],
    "usage": {"prompt_tokens": 10, "completion_tokens": 4, "total_tokens": 14},
}


class _Resp:
    def raise_for_status(self):
        return None

    def json(self):
        return _PAYLOAD


def test_one_connection_drop_is_retried_and_the_turn_completes(client, world, monkeypatch):
    gid = client.post("/games", json=world).json()["game_id"]
    monkeypatch.setattr(llm.time, "sleep", lambda s: None)
    calls = {"n": 0}

    def _post(url, json=None, timeout=None):
        calls["n"] += 1
        if calls["n"] == 1:
            raise httpx.ConnectError("container restarting")
        return _Resp()
    monkeypatch.setattr(llm.httpx, "post", _post)
    d = client.post(f"/games/{gid}/action", json={"action": "I look around."}).json()
    assert any(b["kind"] == "narration" and "dust settles" in b["text"] for b in d["beats"])
    assert calls["n"] >= 2                       # the dropped call plus its retry


def test_persistent_connection_failure_still_raises(client, world, monkeypatch):
    gid = client.post("/games", json=world).json()["game_id"]
    monkeypatch.setattr(llm.time, "sleep", lambda s: None)

    def _post(url, json=None, timeout=None):
        raise httpx.ConnectError("llm down")
    monkeypatch.setattr(llm.httpx, "post", _post)
    with pytest.raises(httpx.ConnectError):
        client.post(f"/games/{gid}/action", json={"action": "I look around."})


def test_timeouts_are_never_retried(client, world, monkeypatch):
    gid = client.post("/games", json=world).json()["game_id"]
    monkeypatch.setattr(llm.time, "sleep", lambda s: None)
    calls = {"n": 0}

    def _post(url, json=None, timeout=None):
        calls["n"] += 1
        raise httpx.ReadTimeout("box is busy")
    monkeypatch.setattr(llm.httpx, "post", _post)
    with pytest.raises(httpx.ReadTimeout):
        client.post(f"/games/{gid}/action", json={"action": "I look around."})
    # one call from the interpreter (swallowed), one from the narrator: no retries
    assert calls["n"] == 2


# ---------- structured-JSON output threads through (the no-tools path) ----------

def _capture_post(monkeypatch):
    """Mock httpx.post and return a dict that captures the JSON payload chat() sends."""
    seen = {}

    def _post(url, json=None, timeout=None, headers=None):
        seen["payload"] = json
        return _Resp()
    monkeypatch.setattr(llm.httpx, "post", _post)
    return seen


def test_response_format_is_sent_on_the_no_tools_path(monkeypatch):
    # quick_create's contract: structured-JSON output rides the HTTP payload as
    # response_format even with no tools offered (this used to be impossible).
    seen = _capture_post(monkeypatch)
    llm.chat([{"role": "user", "content": "make a world"}],
             response_format={"type": "json_object"})
    assert seen["payload"]["response_format"] == {"type": "json_object"}
    assert "tools" not in seen["payload"]                     # genuinely a tool-less call


def test_no_response_format_means_no_field_unchanged_behavior(monkeypatch):
    # backward-compat: a plain tool-less call still sends NO response_format key, exactly
    # as before (the existing tests rely on this).
    seen = _capture_post(monkeypatch)
    llm.chat([{"role": "user", "content": "narrate"}])
    assert "response_format" not in seen["payload"]
