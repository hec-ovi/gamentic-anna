"""The native LLM path: llm.chat() routes through the Anna host's reverse-RPC sampling
when running as an Executa (hostbridge active). Anna sampling has no OpenAI-style
function calling, so chat() asks for a {prose, tool_calls} JSON envelope and parses it
back into the SAME LLMReply / ToolCall the engine already consumes. These tests fake the
host at hostbridge.sample_sync and assert the mapping, the json-repair recovery, the
prose fallback, and the no-tools / stop-reason handling.
"""
import pytest

from app import hostbridge, llm

TOOLS = [{"type": "function", "function": {
    "name": "attack", "description": "attack a target",
    "parameters": {"type": "object", "properties": {"target": {"type": "string"}}}}}]


@pytest.fixture
def anna(monkeypatch):
    """Activate the native path with a fake host channel + a settable sample result."""
    monkeypatch.setattr(hostbridge, "_channel",
                        hostbridge.HostChannel(loop=None, sampling=None, image=None))
    box = {}

    def fake_sample_sync(**kw):
        box["kw"] = kw
        return box["result"]

    monkeypatch.setattr(hostbridge, "sample_sync", fake_sample_sync)
    return box


def _sampled(text, usage=None, stop="stop"):
    return {"content": {"type": "text", "text": text},
            "usage": usage or {"inputTokens": 5, "outputTokens": 7}, "stopReason": stop}


def test_clean_tool_envelope_parses_into_toolcalls(anna):
    anna["result"] = _sampled(
        '{"prose":"You draw your blade.","tool_calls":[{"name":"attack","arguments":{"target":"goblin"}}]}')
    r = llm.chat([{"role": "system", "content": "sys"}, {"role": "user", "content": "hit it"}], tools=TOOLS)
    assert r.content == "You draw your blade."
    assert len(r.tool_calls) == 1
    assert r.tool_calls[0].name == "attack"
    assert r.tool_calls[0].arguments == {"target": "goblin"}
    # OpenAI->MCP message mapping + the tool directive land in the sampling call
    assert anna["kw"]["response_format"] == {"type": "json_object"}
    assert "attack" in anna["kw"]["system_prompt"]
    assert anna["kw"]["messages"][-1]["content"]["text"] == "hit it"


def test_usage_is_mapped_to_openai_shape(anna):
    anna["result"] = _sampled('{"prose":"hi","tool_calls":[]}', usage={"inputTokens": 11, "outputTokens": 4})
    r = llm.chat([{"role": "user", "content": "x"}], tools=TOOLS)
    assert r.usage["prompt_tokens"] == 11 and r.usage["completion_tokens"] == 4
    assert r.usage["total_tokens"] == 15


def test_malformed_json_is_repaired(anna):
    # trailing comma + unclosed brackets: strict json.loads fails, json-repair recovers
    anna["result"] = _sampled('{"prose":"hi","tool_calls":[{"name":"attack","arguments":{"target":"orc",}}]')
    r = llm.chat([{"role": "user", "content": "x"}], tools=TOOLS)
    assert r.tool_calls and r.tool_calls[0].name == "attack"
    assert r.tool_calls[0].arguments.get("target") == "orc"


def test_plain_prose_when_tools_offered_falls_back(anna):
    # model ignores the envelope and just narrates: no crash, prose preserved, no tool calls
    anna["result"] = _sampled("The goblin lunges at you.")
    r = llm.chat([{"role": "user", "content": "x"}], tools=TOOLS)
    assert r.content == "The goblin lunges at you."
    assert r.tool_calls == []


def test_bare_json_array_is_accepted_as_tool_calls(anna):
    # a forced single-tool call (e.g. save_world) emitted as a bare array, not an envelope
    anna["result"] = _sampled('[{"name":"attack","arguments":{"target":"troll"}}]')
    r = llm.chat([{"role": "user", "content": "finish it"}], tools=TOOLS)
    assert len(r.tool_calls) == 1 and r.tool_calls[0].name == "attack"
    assert r.tool_calls[0].arguments == {"target": "troll"}


def test_no_tools_returns_prose_and_normalizes_length(anna):
    anna["result"] = _sampled("  narration  ", stop="max_tokens")
    r = llm.chat([{"role": "user", "content": "x"}])
    assert r.content == "narration"
    assert r.tool_calls == []
    assert r.finish_reason == "length"      # Anna's stopReason normalized for the engine


def test_inactive_channel_does_not_take_the_native_path(monkeypatch):
    # With no host channel installed, chat() must NOT call sample_sync (it uses HTTP).
    monkeypatch.setattr(hostbridge, "_channel", None)
    called = {"n": 0}
    monkeypatch.setattr(hostbridge, "sample_sync", lambda **k: called.__setitem__("n", called["n"] + 1))
    assert hostbridge.active() is False
    # Point the HTTP path at a dead port so we fail fast instead of reaching a real model.
    monkeypatch.setenv("ANNA", "")
    monkeypatch.setenv("TEXT_BASE_URL", "http://127.0.0.1:9/v1")
    with pytest.raises(Exception):
        llm.chat([{"role": "user", "content": "x"}])
    assert called["n"] == 0
