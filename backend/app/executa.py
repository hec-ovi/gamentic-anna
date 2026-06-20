"""Anna Executa entry point: the gamentic engine, running NATIVELY on Anna.

This is the ONLY comms-layer change on the backend. The engine, repos, prompts,
creator and `main.py` are untouched: we import the existing FastAPI `app` and replay
each request against it IN-PROCESS via httpx's ASGI transport, so every route, its
validation, and its behavior are byte-for-byte what uvicorn would serve.

What is native here: for LLM text and images the engine reverse-RPCs the Anna host
(`sampling/createMessage`, `image/generate`) through `app.hostbridge`, installed below.
There is NO third-party bridge and NO bundled model server: the executa asks Anna
directly, with model selection, billing and quota owned by the host. Voice is off.

Wire shape (Anna Executa protocol v2):
  initialize -> declare host_capabilities (llm.sample, llm.image) + negotiate v2
  describe   -> the bare manifest (one tool, `request`)
  invoke     -> params.tool == "request", arguments == { path, method?, body?, query? }
                result is { success, data: { status, json } }
  (host responses to OUR reverse-RPCs arrive on the same stdin and are routed to the
   awaiting sampling/image client.)
"""
import asyncio
import base64
import io
import json
import logging
import os
import sys
import threading
import traceback
from concurrent.futures import ThreadPoolExecutor, TimeoutError as FuturesTimeoutError

import httpx

from executa_sdk import (ImageClient, InvokeContext, PROTOCOL_VERSION_V1,
                         PROTOCOL_VERSION_V2, SamplingClient)
from executa_sdk.sampling import _write_frame as _sdk_write_frame

from . import db, hostbridge
from .config import settings
from .main import app

TOOL_ID = "tool-dev-gamentic"          # dev placeholder; the real id is server-minted at publish
VERSION = "0.3.1"                      # single source of truth; mirrors pyproject + executa.json
                                       # (and the serverInfo below, so the agent stops reporting a
                                       # stale 0.1.0 next to the installed 0.2.x -> no false "upgrade")

MANIFEST = {
    "name": TOOL_ID,
    "display_name": "Gamentic",
    "version": VERSION,
    "description": "Gamentic game orchestrator, exposed as an Anna Executa. One tool, "
                   "`request`, replays an HTTP-style call against the game engine.",
    "tools": [
        {
            "name": "request",
            # The host kills an invoke at the per-tool timeout (default 60s). World
            # creation runs the world-gen + art-director LLM calls AND the opening image
            # renders inside ONE invoke (~150s with art), so the default 60s killed it
            # mid-creation: the frontend never got its reply, never transitioned into the
            # adventure, and the in-flight renders lost their invoke-scoped token. Raise it
            # to the reverse-RPC token TTL (600s) so a long turn/creation always completes.
            "timeout": 600,
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
    # Reverse host-capabilities the engine uses: host LLM sampling (text). llm.agent.auto
    # lets the host mint the per-invoke sampling token via an app session - the auth chain
    # for an app-bundled executa run by the Anna agent (app host_api.agent.session.auto ->
    # sampling token), which is what fixes the -32001 "sampling token missing". Matches the
    # anna-app-llm-demo example. Without llm.sample declared, sampling is -32008 NOT_NEGOTIATED.
    # llm.image lets the engine reverse-RPC image/generate on the AGENT path: there the host
    # gates the executa's image reverse-RPC on THIS declaration (+ the per-app image_grant),
    # not on the app manifest's ui.host_api.image (which is what the `anna-app dev` harness
    # used, masking the gap). Without llm.image declared, image/generate is NOT_NEGOTIATED on
    # an installed app even though the grant is enabled. The executa only generates (never
    # edits), so llm.image alone; initialize advertises capabilities.image={} to match.
    "host_capabilities": ["llm.sample", "llm.agent.auto", "llm.image"],
    "runtime": {"type": "uv", "min_version": "0.1.0"},
}


def _log(*a):
    print("[gamentic-executa]", *a, file=sys.stderr, flush=True)


# --- thread-safe stdout: reverse-RPC requests and tool responses share this pipe ---
_stdout_lock = threading.Lock()


def _write_frame(msg: dict) -> None:
    # Delegate to the SDK's size-aware writer: frames over the 512KB stdio cap (a tool
    # response with inlined media, or a large reverse-RPC request) spill to a temp file
    # plus a pointer the host reads, instead of being written blind and truncated. The
    # lock keeps concurrent reverse-RPC requests and tool responses from interleaving.
    with _stdout_lock:
        _sdk_write_frame(msg)


# --- media delivery: inline /media images as downscaled data: URIs -----------------
# The engine persists every generated image (whatever the provider) to disk under
# /media/<gid>/<file> and stores that ref on beats; the sandboxed iframe cannot fetch
# /media, so on the way out we replace those refs with small data: URIs (CSP allows
# data:). Bounded to stay under the stdio frame cap; over budget, refs are left as-is.
_MEDIA_PREFIX = "/media/"
# Max total data:-URI chars inlined per reply. The Anna Agent's stdio reader caps a line
# at ~64KB and a longer frame crashes it (killing the executa mid-invoke), so this stays
# well under 64KB: one image (~10-20KB at the size below) fits, and a multi-image /state
# inlines a couple then leaves the rest as /media paths for the frontend to pull one at a
# time via POST /games/{id}/render (which returns a single small image). Env-tunable.
_INLINE_BUDGET = int(os.getenv("INLINE_BUDGET", "40000"))


def _media_path(url: str) -> str | None:
    rest = url[len(_MEDIA_PREFIX):]
    gid, _, name = rest.partition("/")
    if not gid or not name or "/" in name or ".." in name:
        return None
    return os.path.join(settings.GAMES_DATA_DIR, gid, "images", name)


def _data_uri(fp: str, max_px: int = int(os.getenv("INLINE_IMAGE_MAX_PX", "400")),
              quality: int = int(os.getenv("INLINE_IMAGE_QUALITY", "58"))) -> str | None:
    # Small + lower-quality on purpose: each inlined image is ~10-20KB so a single render
    # reply (and a couple in /state) stays under the Agent's 64KB stdio frame limit.
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


# --- one shared asyncio loop (its own thread): hosts the ASGI client AND the reverse
# -RPC futures. The engine is synchronous and runs in Starlette's threadpool inside
# each request; from there hostbridge.*_sync schedules sampling/image on THIS loop and
# blocks the worker thread, while the stdin reader keeps delivering host responses. ---
_loop = asyncio.new_event_loop()
threading.Thread(target=_loop.run_forever, daemon=True, name="executa-loop").start()

_sampling = SamplingClient(write_frame=_write_frame)
_image = ImageClient(write_frame=_write_frame)

_client: httpx.AsyncClient | None = None


async def _mk_client() -> httpx.AsyncClient:
    # Long timeout: a turn is real LLM work (several reverse-RPC calls at depth); the
    # engine's own LLM_TIMEOUT governs each call, this just must not cut the turn short.
    return httpx.AsyncClient(transport=httpx.ASGITransport(app=app),
                             base_url="http://executa", timeout=httpx.Timeout(600.0))


def _ensure_client() -> None:
    """Build the warm ASGI client once (init the DB too, since ASGITransport skips
    lifespan). Does NOT install the host channel, so calling an invoke in a unit test
    never flips the engine onto the reverse-RPC path globally."""
    global _client
    if _client is None:
        db.init_db()
        _client = asyncio.run_coroutine_threadsafe(_mk_client(), _loop).result()


def _warm() -> None:
    """Startup: the warm ASGI client AND the host channel, so the engine reverse-RPCs
    Anna for LLM/images for the rest of the process's life."""
    # ASGITransport skips the app's lifespan, so the engine's loggers are never
    # configured and image/summary failures render invisibly. Configure here (to stderr,
    # which the dev harness surfaces) so detached job errors and engine logs are visible.
    logging.basicConfig(level=logging.INFO, stream=sys.stderr)
    _ensure_client()
    hostbridge.set_channel(hostbridge.HostChannel(loop=_loop, sampling=_sampling, image=_image))


def _route_response(msg: dict) -> bool:
    """A frame with no `method` is a host reply to one of our reverse RPCs: hand it to
    whichever client is awaiting that id."""
    return _sampling.dispatch_response(msg) or _image.dispatch_response(msg)


async def _run_request(path: str, method: str, body, query) -> dict:
    resp = await _client.request((method or "GET").upper(), path,
                                 json=body if body is not None else None,
                                 params=query or None)
    try:
        payload = resp.json()
    except Exception:
        payload = resp.text
    if isinstance(payload, (dict, list)):
        payload = _inline_media(payload, [_INLINE_BUDGET])
    return {"status": resp.status_code, "json": payload}


def _invoke_budget_s(params: dict) -> float:
    """Seconds this invoke may run before we MUST answer. Respect the host's own deadline
    (params.context.deadline_ms) when it sends one, minus a margin so WE reply first;
    otherwise fall back to the configured ceiling. Either way the executa never blocks long
    enough for the host to decide it is hung and recycle it - that recycle is what took the
    whole engine down when a render piled up behind the invoke."""
    try:
        rem = InvokeContext.from_params(params).remaining_s()
    except Exception:
        rem = float("inf")
    if rem == float("inf"):
        return settings.INVOKE_BUDGET_S
    return max(5.0, min(settings.INVOKE_BUDGET_S, rem - settings.INVOKE_DEADLINE_MARGIN_S))


def _do_invoke(params: dict) -> dict:
    if params.get("tool") != "request":
        return {"error": {"code": -32601, "message": f"unknown tool: {params.get('tool')}"}}
    args = params.get("arguments") or {}
    path = args.get("path")
    if not path or not isinstance(path, str):
        return {"result": {"success": False, "error": "missing 'path'"}}
    budget = _invoke_budget_s(params)
    fut = None
    try:
        _ensure_client()
        fut = asyncio.run_coroutine_threadsafe(
            _run_request(path, args.get("method", "GET"), args.get("body"), args.get("query")),
            _loop)
        out = fut.result(timeout=budget)
        # Tool-level success: the HTTP status rides inside data so the frontend can
        # branch (a 404/422 from the engine is a normal answer, not a transport fail).
        return {"result": {"success": True, "data": out, "tool": "request"}}
    except FuturesTimeoutError:
        # We hit OUR budget before the host's deadline: ANSWER NOW so the host never sees a
        # hung executa and restarts it. Cancel the in-flight request so it cannot linger on
        # the loop. The frontend treats this as "not ready" and retries (idempotent GETs)
        # or re-fires the render later - never a transport crash, never an engine recycle.
        if fut is not None:
            fut.cancel()
        _log(f"invoke over budget ({budget:.0f}s); answered gracefully path={path}")
        return {"result": {"success": False, "error": "engine busy, please retry",
                           "timeout": True, "tool": "request"}}
    except Exception as exc:
        _log("invoke crashed:", repr(exc))
        _log(traceback.format_exc())
        return {"result": {"success": False, "error": str(exc)}}


def handle(req: dict) -> dict:
    """Map one host-initiated request to its payload ({"result": ...} or {"error": ...}),
    without the JSON-RPC envelope. Pure enough to unit-test; _handle_request writes it."""
    method = req.get("method")
    if method == "initialize":
        params = req.get("params") or {}
        proto = params.get("protocolVersion") or PROTOCOL_VERSION_V1
        if proto != PROTOCOL_VERSION_V2:
            reason = (f"host did not negotiate v2 (offered {proto!r}); "
                      "reverse RPC requires Executa protocol 2.0")
            _sampling.disable(reason)
            _image.disable(reason)
        return {"result": {
            "protocolVersion": proto if proto in ("1.1", "2.0") else "2.0",
            "serverInfo": {"name": TOOL_ID, "version": VERSION},
            "capabilities": {"sampling": {}, "image": {}} if proto == PROTOCOL_VERSION_V2 else {},
        }}
    if method == "describe":
        return {"result": MANIFEST}
    if method == "health":
        return {"result": {"status": "ready"}}
    if method == "invoke":
        return _do_invoke(req.get("params") or {})
    if method == "shutdown":
        return {"result": {}}
    return {"error": {"code": -32601, "message": f"unknown method: {method}"}}


def _handle_request(msg: dict) -> None:
    """Handle one host-initiated request (off the reader thread) and write its reply."""
    rid = msg.get("id")
    payload = handle(msg)
    if rid is not None:
        _write_frame({"jsonrpc": "2.0", "id": rid, **payload})


def main() -> None:
    _log("up; warming the engine")
    _warm()
    # Invokes may run concurrently and each blocks on reverse RPCs; run them on a
    # worker pool so the reader thread stays free. Reverse-RPC RESPONSES are routed
    # INLINE on the reader (never via the pool), so a saturated pool can never stall
    # the delivery that an in-flight invoke is waiting on.
    pool = ThreadPoolExecutor(max_workers=4, thread_name_prefix="invoke")
    try:
        for raw in sys.stdin:               # loop until EOF (the host closes stdin to stop us)
            line = raw.strip()
            if not line:
                continue
            try:
                msg = json.loads(line)
            except json.JSONDecodeError as exc:
                _write_frame({"jsonrpc": "2.0", "id": None,
                              "error": {"code": -32700, "message": str(exc)}})
                continue
            if "method" not in msg:                  # host reply to our reverse RPC
                if not _route_response(msg):
                    _log("unmatched response id=", msg.get("id"))
                continue
            # initialize/describe/health/shutdown are cheap and ordering-sensitive
            # (initialize negotiates v2 before any invoke may reverse-RPC), so run them
            # inline on the reader thread; only invokes (which block on reverse RPCs) go
            # to the pool.
            if msg.get("method") in ("initialize", "describe", "health", "shutdown"):
                _handle_request(msg)
            else:
                pool.submit(_handle_request, msg)
    finally:
        pool.shutdown(wait=False, cancel_futures=True)
        _loop.call_soon_threadsafe(_loop.stop)


if __name__ == "__main__":
    main()
