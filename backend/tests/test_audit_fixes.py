"""Regression tests for the 2026-07-01 end-to-end audit fixes: the look/take router,
turn resilience to secondary LLM failures, quick_create's never-raise contract, tool
guards (heal-the-dead, negative-qty remove, absorb overreach, rollback image loss),
per-game turn serialization, the render-vs-turn inventory lost-update, template export
cast fidelity, and the returning-note clobber."""
import threading
import time

import pytest

from app import db, llm, repo
from app.config import settings
from app.main import _turn_lock


def T(_tool, **args):
    return llm.ToolCall(_tool, args)


def _nar(*calls, content="..."):
    return llm.LLMReply(content=content, tool_calls=list(calls))


def _pack(client, gid):
    return client.get(f"/games/{gid}/state").json()["player"]["inventory"]


def _scene_items(client, gid):
    return client.get(f"/games/{gid}/state").json()["scene"]["items"]


# ---------------------------------------------------------------------------
# the deterministic take router vs look-intent
# ---------------------------------------------------------------------------

def test_take_a_look_at_an_item_does_not_pocket_it(client, fake_llm, world):
    gid = client.post("/games", json=world).json()["game_id"]
    fake_llm.narrator = _nar(T("place_item", target="scene", name="sword",
                               description="a notched blade"), content="A sword lies here.")
    client.post(f"/games/{gid}/action", json={"action": "I scan the room."})
    assert any(i["name"] == "sword" for i in _scene_items(client, gid))

    fake_llm.narrator = _nar(content="You study the notches along its edge.")
    client.post(f"/games/{gid}/action", json={"action": "take a look at the sword"})
    assert any(i["name"] == "sword" for i in _scene_items(client, gid))  # still in the scene
    assert not any(i["name"] == "sword" for i in _pack(client, gid))     # never pocketed

    # real take-intent still routes deterministically
    client.post(f"/games/{gid}/action", json={"action": "take the sword"})
    assert any(i["name"] == "sword" for i in _pack(client, gid))


# ---------------------------------------------------------------------------
# turn resilience: secondary LLM failures never roll back a resolved turn
# ---------------------------------------------------------------------------

def _flaky_llm(fake_llm, monkeypatch, match):
    """llm.chat that raises for calls whose system prompt matches, else delegates."""
    def chat(messages, **kw):
        sys = messages[0]["content"] if messages else ""
        if match(sys):
            raise RuntimeError("provider went away")
        return fake_llm(messages, **kw)
    monkeypatch.setattr(llm, "chat", chat)


def test_character_reply_failure_keeps_the_resolved_turn(client, fake_llm, world, monkeypatch):
    gid = client.post("/games", json=world).json()["game_id"]
    fake_llm.narrator = _nar(T("add_item", name="brass key", description="a key"),
                             T("cue_character", name="Mara"),
                             content="A key falls; Mara stirs.")
    _flaky_llm(fake_llm, monkeypatch, lambda sys: sys.startswith("You are Mara"))
    r = client.post(f"/games/{gid}/action", json={"action": "I search."})
    assert r.status_code == 200                              # no 500, no rollback
    assert any(i["name"] == "brass key" for i in _pack(client, gid))   # the state held
    texts = [b["text"] for b in r.json()["beats"]]
    assert any("key falls" in t for t in texts)              # the narrator prose held


def test_resolve_pass_failure_keeps_the_resolved_turn(client, fake_llm, world, monkeypatch):
    gid = client.post("/games", json=world).json()["game_id"]
    # narrator changes state but writes NO prose -> the resolve pass runs (and dies)
    fake_llm.narrator = _nar(T("add_item", name="old coin", description="a coin"), content="")
    _flaky_llm(fake_llm, monkeypatch,
               lambda sys: sys.startswith("You narrate the immediate outcome"))
    r = client.post(f"/games/{gid}/action", json={"action": "I dig."})
    assert r.status_code == 200
    assert any(i["name"] == "old coin" for i in _pack(client, gid))


# ---------------------------------------------------------------------------
# quick_create never raises
# ---------------------------------------------------------------------------

def test_quick_create_falls_back_when_coercion_raises(client, fake_llm, monkeypatch):
    from app import creator
    fake_llm.quick = llm.LLMReply(content='{"title": "Broken World"}')
    orig = creator._coerce_quick_sheet

    def flaky(prompt, data):
        if data:                       # the model's shape blows up in coercion...
            raise ValueError("objectives came back as a plain string")
        return orig(prompt, data)      # ...the deterministic fallback still builds

    monkeypatch.setattr(creator, "_coerce_quick_sheet", flaky)
    r = client.post("/create/quick", json={"prompt": "a lighthouse mystery"})
    assert r.status_code == 200 and r.json()["game_id"]


# ---------------------------------------------------------------------------
# tool guards
# ---------------------------------------------------------------------------

def test_heal_never_resurrects_the_dead(client, fake_llm, world):
    gid = client.post("/games", json=world).json()["game_id"]
    fake_llm.narrator = _nar(T("kill_character", name="Mara"), content="Mara falls.")
    client.post(f"/games/{gid}/action", json={"action": "watch"})
    with db.get_conn() as conn:
        mara = next(c for c in repo.get_characters(conn, gid) if c["name"] == "Mara")
    assert not mara["alive"]

    fake_llm.narrator = _nar(T("heal", target="Mara", amount=8), content="Light pours out.")
    client.post(f"/games/{gid}/action", json={"action": "pray"})
    with db.get_conn() as conn:
        mara = next(c for c in repo.get_characters(conn, gid) if c["name"] == "Mara")
    assert not mara["alive"] and mara["life"] == 0           # death stays permanent


def test_remove_item_bounces_negative_qty(client, fake_llm, world):
    gid = client.post("/games", json=world).json()["game_id"]
    fake_llm.narrator = _nar(T("add_item", name="gold coin", description="", qty=5),
                             content="Coins!")
    client.post(f"/games/{gid}/action", json={"action": "loot"})
    fake_llm.narrator = _nar(T("remove_item", name="gold coin", qty=-3),
                             content="Some coins go missing.")
    client.post(f"/games/{gid}/action", json={"action": "wait"})
    coins = next(i for i in _pack(client, gid) if i["name"] == "gold coin")
    assert coins["qty"] == 5                                 # the stack never inflated


def test_spawn_does_not_swallow_a_shared_token_scene_item(client, fake_llm, world):
    gid = client.post("/games", json=world).json()["game_id"]
    fake_llm.narrator = _nar(T("place_item", target="scene", name="guard dog",
                               description="a chained hound"), content="A hound growls.")
    client.post(f"/games/{gid}/action", json={"action": "look"})
    fake_llm.narrator = _nar(T("spawn_character", name="Guard", persona="a bored sentry",
                               appearance="a man in mail", relation="stranger"),
                             content="A guard rounds the corner.")
    client.post(f"/games/{gid}/action", json={"action": "wait"})
    assert any(i["name"] == "guard dog" for i in _scene_items(client, gid))  # the dog stays


def test_spawn_still_absorbs_their_own_scenery_ghost(client, fake_llm, world):
    gid = client.post("/games", json=world).json()["game_id"]
    fake_llm.narrator = _nar(T("place_item", target="scene", name="a sleeping camel driver",
                               description="an old man dozing"), content="A man dozes.")
    client.post(f"/games/{gid}/action", json={"action": "look"})
    fake_llm.narrator = _nar(T("spawn_character", name="Camel Driver", persona="a dozing guide",
                               appearance="an old man", relation="stranger"),
                             content="He wakes.")
    client.post(f"/games/{gid}/action", json={"action": "approach"})
    assert not any("camel driver" in i["name"] for i in _scene_items(client, gid))


def test_place_item_rollback_keeps_the_items_image(client, fake_llm, world, monkeypatch):
    monkeypatch.setattr(settings, "SCENE_INVENTORY_CAP", 1)
    gid = client.post("/games", json=world).json()["game_id"]
    fake_llm.narrator = _nar(T("place_item", target="scene", name="boulder",
                               description="a huge rock"),
                             T("add_item", name="jade amulet", description="a green charm"),
                             content="You pocket a charm; a boulder blocks the way.")
    client.post(f"/games/{gid}/action", json={"action": "explore"})
    with db.get_conn() as conn:
        assert repo.set_item_image(conn, gid, "jade amulet", "/media/x/amulet.png")
    # the scene is at cap (boulder), so placing the amulet there must roll back WHOLE
    fake_llm.narrator = _nar(T("place_item", target="scene", name="jade amulet"),
                             content="You set the amulet down.")
    client.post(f"/games/{gid}/action", json={"action": "put the amulet down"})
    amulet = next(i for i in _pack(client, gid) if i["name"] == "jade amulet")
    assert amulet["image_url"] == "/media/x/amulet.png"      # the card survived the bounce


# ---------------------------------------------------------------------------
# concurrency: per-game turn lock + render-vs-turn inventory writes
# ---------------------------------------------------------------------------

def test_turn_lock_is_per_game():
    assert _turn_lock("g1") is _turn_lock("g1")
    assert _turn_lock("g1") is not _turn_lock("g2")


def test_item_image_attach_never_clobbers_a_concurrent_turn_write(client, fake_llm, world):
    gid = client.post("/games", json=world).json()["game_id"]
    fake_llm.narrator = _nar(T("add_item", name="iron sword", description="a blade"),
                             content="A sword!")
    client.post(f"/games/{gid}/action", json={"action": "loot"})

    holding = threading.Event()

    def turn_writer():
        # a turn-shaped writer: takes the write lock, adds an item, holds, commits
        with db.get_conn() as conn:
            conn.execute("BEGIN IMMEDIATE")
            repo.add_item(conn, gid, "gold key", "shiny")
            holding.set()
            time.sleep(0.6)

    def attach():
        holding.wait(5)
        with db.get_conn() as conn:   # must SEE the committed gold key, not a stale blob
            assert repo.set_item_image(conn, gid, "iron sword", "/media/x/sword.png")

    ts = [threading.Thread(target=turn_writer), threading.Thread(target=attach)]
    for t in ts:
        t.start()
    for t in ts:
        t.join(10)
        assert not t.is_alive()
    pack = _pack(client, gid)
    assert any(i["name"] == "gold key" for i in pack)        # the turn's item SURVIVED
    sword = next(i for i in pack if i["name"] == "iron sword")
    assert sword["image_url"] == "/media/x/sword.png"        # and the image attached


# ---------------------------------------------------------------------------
# template export: designed cast fidelity
# ---------------------------------------------------------------------------

def test_template_export_round_trips_origin_relation_gender(client, fake_llm, world):
    world = dict(world)
    world["characters"] = [{"name": "Mara", "persona": "A wary dwarven scout.",
                            "knowledge": "Knows a tunnel.", "gender": "female",
                            "relation": "sister", "origin": "Raised in the deep halls."}]
    gid = client.post("/games", json=world).json()["game_id"]
    data = client.get(f"/games/{gid}/export?kind=template").json()
    c = data["world"]["characters"][0] if "world" in data else data["characters"][0]
    assert c["origin"] == "Raised in the deep halls."
    assert c["relation"] == "sister" and c["gender"] == "female"

    gid2 = client.post("/games/import", json=data).json()["game_id"]
    with db.get_conn() as conn:
        mara = next(ch for ch in repo.get_characters(conn, gid2) if ch["name"] == "Mara")
    assert mara["origin"] == "Raised in the deep halls."
    assert mara["relation"] == "sister" and mara["gender"] == "female"


# ---------------------------------------------------------------------------
# the returning-note: back-to-back returning moves keep the SECOND note
# ---------------------------------------------------------------------------

def test_back_to_back_returning_moves_keep_the_fresh_arrival_note(client, fake_llm, world):
    gid = client.post("/games", json=world).json()["game_id"]
    start = client.get(f"/games/{gid}/state").json()["scene"]["name"]

    def move(where):
        fake_llm.narrator = _nar(T("move_location", location=where), content=f"To {where}.")
        client.post(f"/games/{gid}/action", json={"action": f"go to {where}"})

    move("the altar")            # first visit: no returning note
    move(start)                  # RETURNING to start: its note is set this turn
    move("the altar")            # RETURNING to the altar: a fresh note is set...
    with db.get_conn() as conn:
        note = (repo.get_game(conn, gid)["arrival_note"] or "").strip()
    assert note                  # ...and the end-of-turn expiry must NOT clobber it
