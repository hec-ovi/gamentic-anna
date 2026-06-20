"""POST /games/{gid}/render: render ONE image synchronously inside the invoke. On the Anna
agent the executa is torn down per-invoke, so the engine's detached render jobs never run
there; the frontend pumps this route once per missing image (scene, then each character)
so each render happens in its own short invoke. Idempotent; gated on IMAGE_ENABLED."""
from app import media


WORLD = {
    "title": "Renderport", "setting": "a port town", "tone": "warm",
    "art_style": "painterly dark-fantasy illustration",
    "narrator_persona": "x", "opening_scenario": "Gulls wheel overhead.",
    "start_location": "harbor", "player_life": 20,
    "characters": [
        {"name": "Vex", "persona": "a scout", "description": "A sharp-eyed woman.",
         "appearance": "tall, scarred, wears leather armor"},
        {"name": "Bron", "persona": "a bored guard",
         "appearance": "broad-shouldered, shaved head"},
    ],
    "quests": [{"title": "x", "objectives": ["x"]}], "lore": [],
}


def _enable(monkeypatch, tmp_path):
    """Turn images on AFTER creation (so creation art doesn't pre-render) and fake the
    provider. Returns a per-kind render counter so a test can assert one render happened."""
    from app.config import settings
    monkeypatch.setattr(settings, "IMAGE_ENABLED", True)
    monkeypatch.setattr(settings, "GAMES_DATA_DIR", str(tmp_path))
    monkeypatch.setattr(media, "fetch_image_bytes", lambda url: b"PNG")
    calls = {"scene": 0, "char": 0}

    def _scene(prompt, seed=None, width=None, height=None, references=None):
        calls["scene"] += 1
        return {"image_url": "/image/file?filename=scene"}

    def _chars(descriptor, style="", seed=None):
        calls["char"] += 1
        return {"face_url": "/image/file?filename=face",
                "body_front_url": "/image/file?filename=front",
                "body_side_url": "/image/file?filename=side"}

    monkeypatch.setattr(media, "generate_scene_image", _scene)
    monkeypatch.setattr(media, "generate_character_images", _chars)
    return calls


def test_render_disabled_returns_409(client, fake_llm, monkeypatch):
    from app.config import settings
    monkeypatch.setattr(settings, "IMAGE_ENABLED", False)
    gid = client.post("/games", json=WORLD).json()["game_id"]
    assert client.post(f"/games/{gid}/render", json={"kind": "scene"}).status_code == 409


def test_render_scene_synchronously_and_idempotently(client, fake_llm, monkeypatch, tmp_path):
    from app.config import settings
    monkeypatch.setattr(settings, "IMAGE_ENABLED", False)          # create with no creation art
    gid = client.post("/games", json=WORLD).json()["game_id"]
    calls = _enable(monkeypatch, tmp_path)

    r = client.post(f"/games/{gid}/render", json={"kind": "scene"})
    assert r.status_code == 200
    body = r.json()
    assert body["kind"] == "scene"
    assert body["image_url"].startswith(f"/media/{gid}/")
    assert calls["scene"] == 1

    # idempotent: a second call returns the same image without re-rendering
    r2 = client.post(f"/games/{gid}/render", json={"kind": "scene"})
    assert r2.json()["image_url"] == body["image_url"]
    assert calls["scene"] == 1


def test_render_one_character_only(client, fake_llm, monkeypatch, tmp_path):
    from app.config import settings
    monkeypatch.setattr(settings, "IMAGE_ENABLED", False)
    gid = client.post("/games", json=WORLD).json()["game_id"]
    calls = _enable(monkeypatch, tmp_path)
    cid = client.get(f"/games/{gid}/state").json()["characters"][0]["id"]

    r = client.post(f"/games/{gid}/render", json={"kind": "character", "id": cid})
    assert r.status_code == 200
    body = r.json()
    assert body["id"] == cid
    assert body["face_url"].startswith(f"/media/{gid}/")
    assert body["body_front_url"].startswith(f"/media/{gid}/")
    assert calls["char"] == 1                                       # exactly one character rendered

    st = client.get(f"/games/{gid}/state").json()
    other = [c for c in st["characters"] if c["id"] != cid][0]
    assert other["face_url"] is None                               # the others stay unrendered


def test_render_item_returns_image_url_for_slotting(client, fake_llm, monkeypatch, tmp_path):
    # The item branch returns the item's image_url so the frontend can slot the inlined
    # thumbnail (a missing/unknown item just returns null, never an error).
    from app.config import settings
    monkeypatch.setattr(settings, "IMAGE_ENABLED", True)
    monkeypatch.setattr(settings, "GAMES_DATA_DIR", str(tmp_path))
    gid = client.post("/games", json=WORLD).json()["game_id"]
    r = client.post(f"/games/{gid}/render", json={"kind": "item", "id": "no-such-item"})
    assert r.status_code == 200
    body = r.json()
    assert body["kind"] == "item" and "image_url" in body


def test_render_rejects_bad_kind_and_missing_id(client, fake_llm, monkeypatch, tmp_path):
    from app.config import settings
    monkeypatch.setattr(settings, "IMAGE_ENABLED", True)
    monkeypatch.setattr(settings, "GAMES_DATA_DIR", str(tmp_path))
    gid = client.post("/games", json=WORLD).json()["game_id"]
    assert client.post(f"/games/{gid}/render", json={"kind": "nope"}).status_code == 422
    assert client.post(f"/games/{gid}/render", json={"kind": "character"}).status_code == 422
    assert client.post(f"/games/{gid}/render", json={"kind": "item"}).status_code == 422
