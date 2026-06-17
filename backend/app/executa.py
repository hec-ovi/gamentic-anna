"""Anna Executa entry point: the SAME orchestrator, spoken over stdio instead of HTTP.

This is the ONLY comms-layer change on the backend. Nothing in the engine, repos,
prompts, creator, or `main.py` is touched: we import the existing FastAPI `app` and
replay each request against it IN-PROCESS via httpx's ASGI transport. So every route,
its validation, and its behavior are byte-for-byte what uvicorn would serve; only the
transport is stdio JSON-RPC (the Anna Executa protocol) rather than TCP.

Wire shape (Anna Executa protocol, docs/anna/executa-protocol):
  describe -> the bare manifest (one tool, `request`)
  invoke   -> params.tool == "request", params.arguments == { path, method?, body?, query? }
              result is the InvokeResult envelope { success, data: { status, json } }

The frontend's `api.js` funnels all 18 endpoints through one `request(path, opts)`
call, so the matching `anna.tools.invoke({ path, method, body })` lands here and is
dispatched to the identical route. Text/image are routed to Anna by the engine's own
provider layer (ANNA=true env); voice is silenced the same way. No GPU.
"""
import asyncio
import base64
import io
import json
import os
import sys
import traceback

import httpx

from . import db
from .config import settings
from .main import app

TOOL_ID = "tool-dev-gamentic"          # dev placeholder; the real id is server-minted at publish

MANIFEST = {
    "name": TOOL_ID,
    "display_name": "Gamentic",
    "version": "0.1.0",
    "description": "Gamentic game orchestrator, exposed as an Anna Executa. One tool, "
                   "`request`, replays an HTTP-style call against the game engine.",
    "tools": [
        {
            "name": "request",
            "description": "Invoke a game-engine operation. Mirrors the orchestrator's REST "
                           "surface: pass the path, the HTTP method, and an optional JSON body.",
            "parameters": [
                {"name": "path", "type": "string", "required": True,
                 "description": "Engine path, e.g. /games or /games/{id}/action."},
                {"name": "method", "type": "string", "required": False, "default": "GET",
                 "description": "HTTP verb: GET | POST | PATCH | DELETE."},
                {"name": "body", "type": "object", "required": False,
                 "description": "JSON request body for POST/PATCH."},
            ],
        }
    ],
    # No reverse host-capabilities: the engine reaches Anna over HTTP (anna-api), not
    # via executa reverse-RPC, so nothing to negotiate here.
    "host_capabilities": [],
    "runtime": {"type": "uv", "min_version": "0.1.0"},
}


def _log(*a):
    print("[gamentic-executa]", *a, file=sys.stderr, flush=True)


# --- media delivery: inline /media images as downscaled data: URIs ---------------
# The engine serves images at /media/<gid>/<file> over HTTP, but here the backend is a
# stdio Executa with no HTTP server, and the sandboxed iframe cannot fetch /media. So
# on the way out we replace /media image refs with small data: URIs (CSP allows data:).
# Bounded to stay under the stdio readline cap; over budget, refs are left as-is.
_MEDIA_PREFIX = "/media/"
_INLINE_BUDGET = 1_400_000   # max total data:-URI chars per reply (under the 2 MiB cap)


def _media_path(url: str) -> str | None:
    rest = url[len(_MEDIA_PREFIX):]
    gid, _, name = rest.partition("/")
    if not gid or not name or "/" in name or ".." in name:
        return None
    return os.path.join(settings.GAMES_DATA_DIR, gid, "images", name)


def _data_uri(fp: str, max_px: int = 512, quality: int = 72) -> str | None:
    try:
        from PIL import Image
        im = Image.open(fp)
        if im.mode not in ("RGB", "L"):
            im = im.convert("RGB")
        im.thumbnail((max_px, max_px))
        buf = io.BytesIO()
        im.save(buf, "JPEG", quality=quality)
        return "data:image/jpeg;base64," + base64.b64encode(buf.getvalue()).decode("ascii")
    except Exception as exc:
        _log("inline-media failed for", fp, repr(exc))
        return None


def _inline_media(obj, budget: list[int]):
    if isinstance(obj, dict):
        return {k: _inline_media(v, budget) for k, v in obj.items()}
    if isinstance(obj, list):
        return [_inline_media(v, budget) for v in obj]
    if isinstance(obj, str) and obj.startswith(_MEDIA_PREFIX) and budget[0] > 0:
        fp = _media_path(obj)
        if fp and os.path.isfile(fp):
            uri = _data_uri(fp)
            if uri and len(uri) <= budget[0]:
                budget[0] -= len(uri)
                return uri
    return obj


class Bridge:
    """One warm ASGI client over the imported app, reused for every invoke (keeps the
    SQLite connection pool and any module state hot across calls, like a long-running
    server). The Executa process is long-lived by contract, so we never tear this down."""

    def __init__(self):
        self._loop = asyncio.new_event_loop()
        # init_db() normally runs in the app's lifespan; ASGITransport does not run
        # lifespan, so we do it once here (idempotent).
        db.init_db()
        transport = httpx.ASGITransport(app=app)
        self._client = self._loop.run_until_complete(
            self._mk_client(transport))

    async def _mk_client(self, transport):
        # Long read timeout: a turn is a real LLM call (minutes at depth); the engine's
        # own ceiling governs, this just must not cut it short.
        return httpx.AsyncClient(transport=transport, base_url="http://executa",
                                 timeout=httpx.Timeout(330.0))

    def request(self, path: str, method: str = "GET", body=None, query=None) -> dict:
        method = (method or "GET").upper()
        coro = self._client.request(method, path, json=body if body is not None else None,
                                    params=query or None)
        resp = self._loop.run_until_complete(coro)
        try:
            payload = resp.json()
        except Exception:
            payload = resp.text
        if isinstance(payload, (dict, list)):
            payload = _inline_media(payload, [_INLINE_BUDGET])
        return {"status": resp.status_code, "json": payload}


_bridge: Bridge | None = None


def _get_bridge() -> Bridge:
    global _bridge
    if _bridge is None:
        _bridge = Bridge()
    return _bridge


def handle(req: dict) -> dict:
    """Map one JSON-RPC request to its result/error payload (without the envelope)."""
    method = req.get("method")
    if method == "initialize":
        return {"result": {"protocolVersion": "2.0",
                           "server_info": {"name": TOOL_ID, "version": "0.1.0"},
                           "capabilities": {}}}
    if method == "describe":
        return {"result": MANIFEST}
    if method == "health":
        return {"result": {"status": "ready"}}
    if method == "invoke":
        params = req.get("params") or {}
        tool = params.get("tool")
        if tool != "request":
            return {"error": {"code": -32601, "message": f"unknown tool: {tool}"}}
        args = params.get("arguments") or {}
        path = args.get("path")
        if not path or not isinstance(path, str):
            return {"result": {"success": False, "error": "missing 'path'"}}
        try:
            out = _get_bridge().request(path, args.get("method", "GET"),
                                        args.get("body"), args.get("query"))
            # Tool-level success: the HTTP status rides inside data so the frontend can
            # branch (a 404/422 from the engine is a normal answer, not a transport fail).
            return {"result": {"success": True, "data": out, "tool": "request"}}
        except Exception as exc:                       # transport/engine crash: real error
            _log("invoke crashed:", repr(exc))
            _log(traceback.format_exc())
            return {"result": {"success": False, "error": str(exc)}}
    if method == "shutdown":
        return {"result": {}}
    return {"error": {"code": -32601, "message": f"unknown method: {method}"}}


def main() -> None:
    _log("up; warming the engine")
    for line in sys.stdin:                  # loop until EOF (the host closes stdin to stop us)
        line = line.strip()
        if not line:
            continue
        try:
            req = json.loads(line)
        except json.JSONDecodeError as exc:
            payload, rid = {"error": {"code": -32700, "message": str(exc)}}, None
        else:
            payload, rid = handle(req), req.get("id")
        sys.stdout.write(json.dumps({"jsonrpc": "2.0", "id": rid, **payload}) + "\n")
        sys.stdout.flush()                  # required after every write


if __name__ == "__main__":
    main()
