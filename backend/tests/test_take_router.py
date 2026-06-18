"""Deterministic TAKE router + world seeding of scene items/exits. Mirrors the movement
router's contract: the player's explicit pickup of a revealed scene item is applied BEFORE
the narrator call, so the inventory loop works without the model emitting take_item (Anna
has no native function-calling, so the narrator usually just NARRATES the pickup).
"""
from app import llm


def _world(scene_items=None, exits=None, chars=None):
    return {
        "title": "Loot Hall", "setting": "a quiet vault", "tone": "still",
        "narrator_persona": "Terse.", "opening_scenario": "Dust settles.",
        "start_location": "vault", "player_life": 20,
        "characters": chars or [],
        "quests": [{"title": "Loot", "description": "Grab it.", "objectives": ["Take the key"]}],
        "lore": [],
        "scene_items": scene_items or [],
        "exits": exits or [],
    }


def _new(client, **kw):
    return client.post("/games", json=_world(**kw)).json()["game_id"]


def test_seeded_scene_item_is_taken_deterministically(client, fake_llm):
    """A seeded loot item is pocketed even when the narrator calls NOTHING (plain prose):
    the engine's take router fires before the narrator, proving pickup needs no tool call."""
    gid = _new(client, scene_items=[{"name": "rusted key"}])
    # the model narrates the pickup but emits no tool_calls at all
    fake_llm.narrator = llm.LLMReply(content="Your fingers close around the cold metal.")
    d = client.post(f"/games/{gid}/action",
                    json={"segments": [{"type": "do", "text": "take the rusted key"}]}).json()
    inv = [i["name"] for i in d["state"]["player"]["inventory"]]
    assert "rusted key" in inv                                      # pocketed without a tool call
    assert "rusted key" not in [i["name"] for i in d["state"]["scene"]["items"]]  # gone from scene
    assert any(b["kind"] == "system" and "rusted key" in b["text"] for b in d["beats"])  # receipt


def test_fixed_scenery_is_not_pocketed(client, fake_llm):
    """Fixed scenery can be reached for but never pocketed: inventory unchanged, and an
    in-world system beat says it stays put."""
    gid = _new(client, scene_items=[{"name": "stone altar", "fixed": True}])
    fake_llm.narrator = llm.LLMReply(content="The altar does not budge.")
    d = client.post(f"/games/{gid}/action",
                    json={"segments": [{"type": "do", "text": "take the altar"}]}).json()
    assert d["state"]["player"]["inventory"] == []                  # nothing pocketed
    assert any(b["kind"] == "system" and "part of the place" in b["text"] for b in d["beats"])
    # the altar is still in the scene, marked fixed
    altar = next(i for i in d["state"]["scene"]["items"] if i["name"] == "stone altar")
    assert altar["fixed"] is True


def test_world_seeding_exposes_scene_items_and_exits(client, fake_llm):
    """Seeded scene_items + exits show up in the served state's scene.items / scene.exits."""
    gid = _new(client,
               scene_items=[{"name": "brass lantern"}, {"name": "iron lever", "fixed": True}],
               exits=[{"label": "the north door", "target": "corridor"}])
    s = client.get(f"/games/{gid}/state").json()
    names = {i["name"] for i in s["scene"]["items"]}
    assert {"brass lantern", "iron lever"} <= names
    assert any(e["label"] == "the north door" and e["target"] == "corridor"
               for e in s["scene"]["exits"])


def test_take_intent_with_no_scene_item_picks_nothing(client, fake_llm):
    """Take-intent that names no present scene item ('take a look around') pockets nothing
    and does not crash; the turn resolves normally."""
    gid = _new(client, scene_items=[{"name": "rusted key"}])
    fake_llm.narrator = llm.LLMReply(content="You scan the empty vault.")
    d = client.post(f"/games/{gid}/action",
                    json={"segments": [{"type": "do", "text": "take a look around"}]}).json()
    assert d["state"]["player"]["inventory"] == []                  # nothing pocketed
    # the seeded key is untouched, still in the scene
    assert "rusted key" in [i["name"] for i in d["state"]["scene"]["items"]]
