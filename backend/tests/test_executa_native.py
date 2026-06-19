"""End-to-end over the REAL native comms: spawn the gamentic executa as a subprocess
and drive it over stdio exactly as Anna's runtime would, while a mock Anna host answers
the executa's reverse-RPC `sampling/createMessage` calls with canned text/tool-envelopes.

So the engine, the turn loop, tool dispatch, SQLite, AND the executa stdio + reverse-RPC
+ sync->async hop are all exercised for real; only the model's words are canned (Anna's
text backend is the one thing we cannot reach in a hermetic test). This is the native
equivalent of the in-process FakeLLM suite: same gameplay, driven through the live
Executa protocol.

Covers the gameplay checklist: create a world, change scene, place + pick up a scene
item (inventory), a character speaks, give an item to a character, a new character
arrives mid-scene, and a private whisper.
"""
import json
import os
import subprocess
import sys
import threading
import time

import pytest

BACKEND = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))

WORLD = {
    "title": "The Sunken Crypt",
    "setting": "a flooded dwarven crypt",
    "tone": "grim, tense",
    "narrator_persona": "A solemn, vivid dungeon master.",
    "opening_scenario": "Cold water laps at your boots as the crypt door groans shut behind you.",
    "start_location": "crypt entrance",
    "player_life": 20,
    "characters": [
        {"name": "Mara", "persona": "A wary dwarven scout, loyal but blunt.",
         "knowledge": "Knows a secret tunnel behind the altar."}
    ],
    "quests": [
        {"title": "Escape the Crypt", "description": "Find a way out.",
         "objectives": ["Find the altar", "Open the tunnel"]}
    ],
    "lore": [
        {"keys": ["altar"], "content": "The altar bleeds black water when touched.", "constant": False}
    ],
}


def _env(tmp):
    return dict(os.environ,
                ANNA="true", IMAGE_ENABLED="false", VOICE_ENABLED="false",
                SUMMARY_ENABLED="false", CHAR_SUMMARY_ENABLED="false",
                DB_PATH=os.path.join(tmp, "native.db"),
                GAMES_DATA_DIR=os.path.join(tmp, "games"))


class MockHost:
    """Spawns the executa and plays Anna's host: routes JSON-RPC, and answers the
    executa's reverse-RPC sampling calls. Scriptable narrator (a queue of tool
    envelopes) and per-character replies (a FIFO), branching like the in-process
    FakeLLM but at the sampling-envelope level."""

    def __init__(self, tmp):
        self.proc = subprocess.Popen(
            [sys.executable, "-m", "app.executa"], cwd=BACKEND, env=_env(tmp),
            stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
            text=True, bufsize=1)
        self.pending = {}
        self.lock = threading.Lock()
        self.narrator_script = []           # queue of {"prose":..,"tool_calls":[..]} dicts
        self.character_replies = []          # FIFO of plain strings
        self.sample_calls = 0
        threading.Thread(target=self._read, daemon=True).start()

    # -- stdio --
    def _send(self, obj):
        self.proc.stdin.write(json.dumps(obj) + "\n")
        self.proc.stdin.flush()

    def _read(self):
        for line in self.proc.stdout:
            line = line.strip()
            if not line:
                continue
            try:
                msg = json.loads(line)
            except json.JSONDecodeError:
                continue
            method = msg.get("method")
            if method == "sampling/createMessage":
                self._answer_sampling(msg)
            elif method in ("image/generate", "image/edit"):
                self._send({"jsonrpc": "2.0", "id": msg["id"], "result": {
                    "images": [{"url": "https://mock.cdn/x.png", "mimeType": "image/png"}]}})
            elif not method:                 # a response to one of MY requests
                with self.lock:
                    self.pending[msg.get("id")] = msg

    # -- the canned model --
    def _answer_sampling(self, msg):
        self.sample_calls += 1
        params = msg.get("params") or {}
        sysp = params.get("systemPrompt") or ""
        is_tool_call = params.get("responseFormat") is not None        # tools were offered
        is_interpret = "submit_segments" in sysp
        is_narrator = "cue_character" in sysp                          # narrator toolset
        is_character = sysp.startswith("You are ") and not sysp.startswith("You are a warm") \
            and not is_narrator
        if is_interpret:                                  # fall back to the raw action text
            text = json.dumps({"prose": "", "tool_calls": []})
        elif is_narrator:
            env = self.narrator_script.pop(0) if self.narrator_script else {"prose": "Time passes.", "tool_calls": []}
            text = json.dumps(env)
        elif is_character:                                # a character speaks (may carry CHARACTER_TOOLS)
            line = self.character_replies.pop(0) if self.character_replies else "\"...\" she mutters."
            text = json.dumps({"prose": line, "tool_calls": []}) if is_tool_call else line
        elif sysp.startswith("You narrate the immediate outcome"):
            text = "The crypt holds its breath."
        else:                                             # resolve / origin / fold / explain
            text = json.dumps({"prose": "", "tool_calls": []}) if is_tool_call else ""
        self._send({"jsonrpc": "2.0", "id": msg["id"], "result": {
            "content": {"type": "text", "text": text},
            "model": "mock-llm", "usage": {"inputTokens": 20, "outputTokens": 10},
            "stopReason": "stop"}})

    # -- request/response helpers --
    def call(self, rid, method, params=None, timeout=30):
        self._send({"jsonrpc": "2.0", "id": rid, "method": method, "params": params or {}})
        deadline = time.time() + timeout
        while time.time() < deadline:
            with self.lock:
                if rid in self.pending:
                    return self.pending.pop(rid)
            time.sleep(0.02)
        raise TimeoutError(f"no response to {method} (id={rid})")

    _rid = [10]

    def invoke(self, path, method="GET", body=None, timeout=60):
        self._rid[0] += 1
        r = self.call(self._rid[0], "invoke", {"tool": "request",
                      "arguments": {"path": path, "method": method, "body": body}}, timeout)
        assert r.get("result", {}).get("success") is True, r
        return r["result"]["data"]            # {status, json}

    def close(self):
        try:
            self._send({"jsonrpc": "2.0", "id": 999, "method": "shutdown"})
            time.sleep(0.2)
        finally:
            self.proc.terminate()

    def stderr(self):
        try:
            return self.proc.stderr.read()
        except Exception:
            return ""


@pytest.fixture
def host(tmp_path):
    h = MockHost(str(tmp_path))
    try:
        yield h
    finally:
        h.close()


def _blob(data):
    return json.dumps(data["json"])


def test_native_full_adventure(host):
    # handshake: v2 + the reverse capabilities the engine uses
    init = host.call(1, "initialize", {"protocolVersion": "2.0"})
    assert init["result"]["protocolVersion"] == "2.0"
    assert set(init["result"]["capabilities"]) == {"sampling", "image"}
    man = host.call(2, "describe")["result"]
    # The reverse-RPC whitelist for the app-bundled run: llm.sample (text) + llm.agent.auto
    # (host auto-mints the per-invoke sampling token via the app session, fixing -32001).
    # This is the manifest the live app uses; images are disabled in the app build.
    assert man["host_capabilities"] == ["llm.sample", "llm.agent.auto"]
    assert [t["name"] for t in man["tools"]] == ["request"]
    assert man["version"] == "0.2.8"            # synced: serverInfo + describe + pyproject + executa.json + app

    # empty library, then create a world (no LLM: the WorldSheet is posted directly)
    assert host.invoke("/games")["json"] == {"games": []}
    created = host.invoke("/games", "POST", WORLD)
    assert created["status"] == 200, created
    gid = created["json"]["game_id"]
    state = host.invoke(f"/games/{gid}/state")["json"]
    assert "crypt" in state["scene"]["name"].lower(), state["scene"]
    assert any(c["name"] == "Mara" for c in state["characters"])

    # (interactions happen while everyone is present; the scene change comes last)

    # TURN 1: cue a present character -> she speaks (dialogue through native comms)
    host.narrator_script = [{
        "prose": "Mara crouches at the waterline.",
        "tool_calls": [{"name": "cue_character", "arguments": {"name": "Mara"}}]}]
    host.character_replies = ["\"Careful. The water remembers,\" Mara says."]
    turn1 = host.invoke(f"/games/{gid}/action", "POST", {"action": "look to Mara"})
    assert "The water remembers" in _blob(turn1), "Mara's cued line did not render"

    # TURN 2: a scene item appears (scene inventory)
    host.narrator_script = [{
        "prose": "A rusted key glints in the silt.",
        "tool_calls": [{"name": "place_item", "arguments": {
            "target": "scene", "name": "rusted key", "description": "a corroded iron key"}}]}]
    turn2 = host.invoke(f"/games/{gid}/action", "POST", {"action": "search the silt"})
    scene_items = [i["name"].lower() for i in turn2["json"]["state"]["scene"]["items"]]
    assert any("rusted key" in n for n in scene_items), (scene_items, _blob(turn2))

    # TURN 3: pick it up -> it leaves the scene and lands in the player's pack
    host.narrator_script = [{
        "prose": "You pocket the rusted key.",
        "tool_calls": [{"name": "take_item", "arguments": {"name": "rusted key"}}]}]
    turn3 = host.invoke(f"/games/{gid}/action", "POST", {"action": "take the rusted key"})
    st3 = turn3["json"]["state"]
    assert any("rusted key" in i["name"].lower() for i in st3["player"]["inventory"]), _blob(turn3)
    assert not any("rusted key" in i["name"].lower() for i in st3["scene"]["items"]), "key still in scene"

    # TURN 4: give it to Mara -> leaves the pack, lands on her
    host.narrator_script = [{
        "prose": "You press the key into Mara's hand.",
        "tool_calls": [{"name": "give_item", "arguments": {"item": "rusted key", "target": "Mara"}}]}]
    turn4 = host.invoke(f"/games/{gid}/action", "POST",
                        {"segments": [{"type": "give", "item": "rusted key", "target": "Mara"}]})
    st4 = turn4["json"]["state"]
    mara = next(c for c in st4["characters"] if c["name"] == "Mara")
    assert not any("rusted key" in i["name"].lower() for i in st4["player"]["inventory"]), "still in pack"
    assert any("rusted key" in i["name"].lower() for i in (mara.get("inventory") or [])), \
        ("Mara did not receive it", _blob(turn4))

    # TURN 5: a brand-new character arrives mid-scene
    host.narrator_script = [{
        "prose": "A hooded figure steps from the dark.",
        "tool_calls": [{"name": "spawn_character", "arguments": {
            "name": "Garrok", "persona": "A grizzled gravekeeper.", "sex": "male",
            "appearance": "an old man in a tattered hood", "relation": "stranger"}}]}]
    turn5 = host.invoke(f"/games/{gid}/action", "POST", {"action": "wait and watch"})
    assert "Garrok" in [c["name"] for c in turn5["json"]["state"]["characters"]], _blob(turn5)

    # TURN 6: a private whisper to Mara -> she answers privately
    host.character_replies = ["\"The tunnel is behind the altar. Go quiet,\" Mara breathes."]
    whisper = host.invoke(f"/games/{gid}/action", "POST",
                          {"segments": [{"type": "whisper", "target": "Mara",
                                         "text": "is there another way out?", "mode": "say"}]})
    assert "tunnel is behind the altar" in _blob(whisper), \
        ("whisper reply missing", _blob(whisper)[:500])

    # TURN 7: travel -> the scene changes
    host.narrator_script = [{
        "prose": "You wade deeper, to the altar.",
        "tool_calls": [{"name": "move_location", "arguments": {"location": "the altar"}}]}]
    turn7 = host.invoke(f"/games/{gid}/action", "POST", {"action": "go to the altar"})
    assert "altar" in turn7["json"]["state"]["scene"]["name"].lower(), _blob(turn7)

    assert host.sample_calls >= 7, host.sample_calls


def test_native_engine_404_rides_in_data(host):
    host.call(1, "initialize", {"protocolVersion": "2.0"})
    data = host.invoke("/games/nope/state")
    assert data["status"] == 404            # the engine's own 404, carried, not a transport error
