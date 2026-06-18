"""One-shot quick creation (Anna has NO function-calling, so the chat finalize abstains
and 409s). quick_create takes ONE sentence and returns a complete, seeded, playable game
in a single pass: the model emits the WorldSheet as JSON (not a tool call), we parse it
leniently, fill every required piece with a themed default, and fall back to a fully
deterministic world if the call raises or yields garbage. Creation must NEVER fail.
"""
import json

from app import creator, db, llm


def _world_json(**extra):
    world = {
        "title": "Embers of the Hollow King",
        "setting": "a cursed forest kingdom",
        "tone": "grim, mythic",
        "narrator_persona": "Low, foreboding, vivid.",
        "opening_scenario": "Ash drifts over the throne room as the old crown smolders.",
        "start_location": "the ruined throne room",
        "player_life": 20,
        "characters": [
            {"name": "Brenna", "relation": "ally", "persona": "A scarred knight who kept her oath.",
             "knowledge": "Knows the secret stair beneath the dais."},
        ],
        "quests": [
            {"title": "Reclaim the Crown", "description": "Lift the curse on the kingdom.",
             "objectives": ["Find the crown", "Break the seal"]},
        ],
        "scene_items": [
            {"name": "smoldering crown", "description": "Still warm, faintly humming.", "fixed": False},
            {"name": "stone dais", "description": "An ancient raised platform.", "fixed": True},
        ],
        "exits": [{"label": "the shattered archway", "target": "the great hall"}],
        "player_items": [{"name": "torch", "description": "A guttering pitch torch."}],
    }
    world.update(extra)
    return json.dumps(world)


def _state(client, gid):
    return client.get(f"/games/{gid}/state").json()


# ---------- the happy path: a valid world JSON -> a playable game ----------

def test_quick_create_builds_a_playable_game_from_model_json(fake_llm):
    fake_llm.quick = llm.LLMReply(content=_world_json())
    with db.get_conn() as conn:
        gid = creator.quick_create(conn, "A cursed forest kingdom and a fallen crown.")
    # the model's JSON drove the world; the call asked for json_object output
    qcalls = [c for c in fake_llm.calls if c["system"].startswith("You are a story-designer")]
    assert qcalls and qcalls[0]["response_format"] == {"type": "json_object"}
    assert qcalls[0]["max_tokens"] == 0                      # uncapped, per the no-cap rule

    from fastapi.testclient import TestClient
    from app import main
    s = _state(TestClient(main.app), gid)
    assert s["title"] == "Embers of the Hollow King"
    assert len(s["characters"]) >= 1                          # >=1 character
    assert len(s["quests"]) >= 1                              # >=1 quest
    assert len(s["scene"]["items"]) >= 1                      # >=1 scene item revealed
    assert len(s["scene"]["exits"]) >= 1                      # >=1 exit revealed
    # the takeable loot exists and is NOT fixed scenery
    names = {i["name"] for i in s["scene"]["items"]}
    assert "smoldering crown" in names
    assert [i["name"] for i in s["player"]["inventory"]] == ["torch"]


def test_quick_create_route_returns_a_playable_game(client, fake_llm):
    fake_llm.quick = llm.LLMReply(content=_world_json())
    r = client.post("/create/quick", json={"prompt": "A cursed forest kingdom."})
    assert r.status_code == 200
    gid = r.json()["game_id"]
    s = _state(client, gid)
    assert len(s["characters"]) >= 1 and len(s["quests"]) >= 1
    assert len(s["scene"]["items"]) >= 1 and len(s["scene"]["exits"]) >= 1


# ---------- never fails: a raising / garbage / empty model still yields a game ----------

def test_quick_create_falls_back_when_the_model_raises(fake_llm):
    fake_llm.quick = RuntimeError("anna sampling 502")
    with db.get_conn() as conn:
        gid = creator.quick_create(conn, "A neon city drowning in rain.")  # must not raise
    from fastapi.testclient import TestClient
    from app import main
    s = _state(TestClient(main.app), gid)
    # the deterministic fallback is fully playable: title + the seeded minimums
    assert s["title"]
    assert len(s["characters"]) >= 1
    assert len(s["quests"]) >= 1
    assert len(s["scene"]["items"]) >= 1                      # a takeable item was seeded
    assert len(s["scene"]["exits"]) >= 1


def test_quick_create_falls_back_on_garbage_and_empty(fake_llm):
    for junk in ("not json at all {{{", "", "null", "[]"):
        fake_llm.quick = llm.LLMReply(content=junk)
        with db.get_conn() as conn:
            gid = creator.quick_create(conn, "A haunted lighthouse.")
        from fastapi.testclient import TestClient
        from app import main
        s = _state(TestClient(main.app), gid)
        assert len(s["characters"]) >= 1, junk
        assert len(s["quests"]) >= 1, junk
        assert len(s["scene"]["items"]) >= 1, junk
        assert len(s["scene"]["exits"]) >= 1, junk


def test_quick_create_route_handles_an_empty_prompt(client, fake_llm):
    # an empty prompt is a surprise-me; the deterministic fallback still produces a game
    fake_llm.quick = llm.LLMReply(content="")
    r = client.post("/create/quick", json={})
    assert r.status_code == 200
    s = _state(client, r.json()["game_id"])
    assert len(s["characters"]) >= 1 and len(s["scene"]["exits"]) >= 1


# ---------- partial JSON: missing pieces are backfilled, never dropped ----------

def test_quick_create_backfills_missing_required_pieces(fake_llm):
    # the model returns ONLY a title + setting; everything else must be filled in
    fake_llm.quick = llm.LLMReply(content=json.dumps(
        {"title": "Saltmarsh Vigil", "setting": "a sinking fen town"}))
    with db.get_conn() as conn:
        gid = creator.quick_create(conn, "A sinking fen town under siege.")
    from fastapi.testclient import TestClient
    from app import main
    s = _state(TestClient(main.app), gid)
    assert s["title"] == "Saltmarsh Vigil"
    assert len(s["characters"]) >= 1                          # default companion
    assert len(s["quests"]) >= 1                              # default quest
    assert len(s["scene"]["items"]) >= 1                      # default takeable loot
    assert len(s["scene"]["exits"]) >= 1                      # default exit


def test_quick_create_guarantees_a_takeable_item_when_model_sends_only_fixed(fake_llm):
    # all scene_items fixed=True (no loot): a takeable one must be added so the take
    # router works from turn one
    fake_llm.quick = llm.LLMReply(content=_world_json(scene_items=[
        {"name": "stone altar", "description": "Immovable.", "fixed": True}]))
    with db.get_conn() as conn:
        gid = creator.quick_create(conn, "A temple of fixed stone.")
    from app import repo
    with db.get_conn() as conn:
        sc = repo.current_scene(conn, gid)
        items = repo.db.loads(sc["items"], [])
    assert any(not it.get("fixed") for it in items)           # a loose item exists


def test_quick_create_carries_raw_prompt_as_constant_lore():
    # the player's exact words ride a constant lore entry so the narrator honors the theme
    # every turn and never drifts genre ("asked cyberpunk, got medieval")
    sheet = creator._coerce_quick_sheet("a neon cyberpunk heist in rain-soaked Tokyo", {})
    premise = [lo for lo in sheet.lore if lo.constant and "cyberpunk" in lo.content.lower()]
    assert premise, "raw prompt must ride a constant lore entry"
    assert "neon cyberpunk heist" in premise[0].content
    assert "cyberpunk" in sheet.setting.lower()               # and the setting reflects it too
