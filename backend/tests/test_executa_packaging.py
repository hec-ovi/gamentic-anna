"""The `uv` distribution contract: build the wheel, install it the way the Anna Agent
will (`uv tool install` -> a console script on PATH), and drive that INSTALLED launcher
over stdio. This is the packaging surface the in-tree native test (which runs the source
tree via `python -m app.executa`) cannot catch: a wheel that omits the `prompts/` data,
mis-names the console script, or drops a dependency would pass there and fail here.

Skipped when `uv` is absent (it builds + resolves the wheel). In CI the runner has uv.
"""
import json
import os
import shutil
import subprocess
import sys
import time

import pytest

BACKEND = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
CONSOLE = "tool-gamentic-engine-7h8aweky"      # == [project.scripts] key == executa executable_name
VERSION = "0.2.7"

pytestmark = pytest.mark.skipif(shutil.which("uv") is None, reason="uv not installed")


def _executa_json_executable_name():
    with open(os.path.join(BACKEND, "executa.json")) as f:
        dist = json.load(f)["distribution"]
    return dist["profiles"]["uv"]["executable_name"], dist["active"]


@pytest.fixture(scope="module")
def installed_console(tmp_path_factory):
    """Build the wheel and install it into an isolated venv; yield the console-script path."""
    work = tmp_path_factory.mktemp("uvpkg")
    out = work / "dist"
    subprocess.run(["uv", "build", "--wheel", "-o", str(out)], cwd=BACKEND,
                   check=True, capture_output=True, text=True)
    wheels = list(out.glob("*.whl"))
    assert wheels, "uv build produced no wheel"
    venv = work / "venv"
    subprocess.run(["uv", "venv", "-p", "3.13", str(venv)], check=True, capture_output=True, text=True)
    py = venv / "bin" / "python"
    subprocess.run(["uv", "pip", "install", "--python", str(py), str(wheels[0])],
                   check=True, capture_output=True, text=True)
    console = venv / "bin" / CONSOLE
    assert console.exists(), f"console script {CONSOLE} not installed by the wheel"
    return str(console)


def _drive(console, requests, want_id, timeout=60):
    """Feed JSON-RPC lines to the installed executa; return {id: reply} once want_id lands."""
    env = dict(os.environ, ANNA="true", IMAGE_ENABLED="false", VOICE_ENABLED="false",
               EXECUTA_DATA=os.path.join(os.path.dirname(console), "..", "data"))
    p = subprocess.Popen([console], stdin=subprocess.PIPE, stdout=subprocess.PIPE,
                         stderr=subprocess.DEVNULL, text=True, bufsize=1, env=env)
    try:
        for r in requests:
            p.stdin.write(json.dumps(r) + "\n")
        p.stdin.flush()
        got, deadline = {}, time.time() + timeout
        while time.time() < deadline:
            line = p.stdout.readline()
            if not line:
                break
            try:
                o = json.loads(line)
            except json.JSONDecodeError:
                continue
            got[o.get("id")] = o
            if want_id in got:
                break
        return got
    finally:
        try:
            p.stdin.write('{"jsonrpc":"2.0","id":99,"method":"shutdown"}\n')
            p.stdin.flush()
            p.wait(timeout=5)
        except Exception:
            p.kill()


def test_uv_profile_console_name_matches_pyproject():
    """The Agent launches `executable_name` after `uv tool install`; it must equal the
    console script the wheel actually installs (the doc's name-lockstep rule)."""
    name, active = _executa_json_executable_name()
    assert name == CONSOLE
    assert active == "uv", "executa.json should ship the uv profile active"
    with open(os.path.join(BACKEND, "pyproject.toml")) as f:
        pyproject = f.read()
    assert f'\n{CONSOLE} = "app.executa:main"' in pyproject
    assert f'name = "{CONSOLE}"' in pyproject


def test_installed_wheel_describes(installed_console):
    got = _drive(installed_console, [
        {"jsonrpc": "2.0", "id": 1, "method": "initialize", "params": {"protocolVersion": "2.0"}},
        {"jsonrpc": "2.0", "id": 2, "method": "describe"},
    ], want_id=2)
    init = got[1]["result"]
    man = got[2]["result"]
    assert init["serverInfo"]["version"] == VERSION
    assert man["version"] == VERSION
    assert [t["name"] for t in man["tools"]] == ["request"]
    assert man["host_capabilities"] == ["llm.sample", "llm.agent.auto"]


def test_installed_wheel_serves_engine_route(installed_console):
    """Proves the bundled `prompts/` resolved and the in-process ASGI engine runs from
    site-packages: an invoke that reaches a real route returns the engine's 200, no LLM."""
    got = _drive(installed_console, [
        {"jsonrpc": "2.0", "id": 1, "method": "initialize", "params": {"protocolVersion": "2.0"}},
        {"jsonrpc": "2.0", "id": 2, "method": "invoke",
         "params": {"tool": "request", "arguments": {"path": "/games", "method": "GET"}}},
    ], want_id=2)
    res = got[2]["result"]
    assert res["success"] is True, res
    assert res["data"]["status"] == 200
    assert res["data"]["json"] == {"games": []}
