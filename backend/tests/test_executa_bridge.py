"""The backend comms-layer swap: the Executa stdio bridge must replay {path, method,
body} against the UNMODIFIED FastAPI app and return its responses, with describe/invoke
following the Anna Executa protocol. No LLM is exercised here (health/list/404 only)."""
import os

# These tests exercise only the stdio bridge (describe / invoke / health / 404); no LLM
# or provider resolution runs, so ANNA mode is intentionally NOT set here. Setting it at
# import time would flip Anna mode on globally for the whole session and break the
# provider/voice tests that resolve against the real (non-Anna) dialects.
os.environ.setdefault("DB_PATH", "/tmp/gamentic-test-executa.db")

import app.executa as ex  # noqa: E402


def _invoke(path, method="GET", body=None):
    req = {"jsonrpc": "2.0", "id": 1, "method": "invoke",
           "params": {"tool": "request",
                      "arguments": {"path": path, "method": method, "body": body}}}
    return ex.handle(req)["result"]


def test_describe_returns_bare_manifest():
    m = ex.handle({"jsonrpc": "2.0", "id": 1, "method": "describe"})["result"]
    assert m["name"].startswith("tool-")
    assert [t["name"] for t in m["tools"]] == ["request"]


def test_invoke_health_and_list():
    r = _invoke("/health")
    assert r["success"] is True
    assert r["data"] == {"status": 200, "json": {"status": "ok"}}
    g = _invoke("/games")
    assert g["data"]["json"] == {"games": []}


def test_engine_404_rides_in_data_not_a_transport_error():
    r = _invoke("/games/does-not-exist/state")
    assert r["success"] is True          # the stdio call itself succeeded
    assert r["data"]["status"] == 404    # the engine's own 404 is carried, not raised


def test_missing_path_is_a_tool_level_failure():
    r = ex.handle({"method": "invoke",
                   "params": {"tool": "request", "arguments": {}}})["result"]
    assert r["success"] is False


def test_unknown_method_returns_minus_32601():
    out = ex.handle({"method": "totally-unknown"})
    assert out["error"]["code"] == -32601
