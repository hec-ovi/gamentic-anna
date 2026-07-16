"""Render dedup + lanes. The per-turn self-heal re-schedules a render job for every
asset still missing from the DB, but a render takes 35-90s and nothing used to mark
"already rendering" - so overlapping jobs re-rendered the same asset (live: the same
item unlock card landed TWICE as two beats). Jobs now claim an in-flight key; a
duplicate schedule sees the claim and returns without rendering. Separately, render
gating is lane- and provider-aware: the local stack keeps its strict one-at-a-time
lock, the Anna path renders concurrently within the ambient lane and gives
player-facing renders (look / show_image) their own lane.
"""
import threading

import pytest

from app import db, llm, integrate, media, repo
from app.config import settings
from app.integrate import jobs


def T(_tool, **args):
    return llm.ToolCall(_tool, args)


def _nar(*calls, content="..."):
    return llm.LLMReply(content=content, tool_calls=list(calls))


def _images_on(monkeypatch, tmp_path):
    monkeypatch.setattr(settings, "IMAGE_ENABLED", True)
    monkeypatch.setattr(settings, "GAMES_DATA_DIR", str(tmp_path))
    monkeypatch.setattr(media, "fetch_image_bytes", lambda url: b"PNG")


def _make_game_with_item(client, fake_llm, world, monkeypatch, item="brass key"):
    """A game with one visible, un-carded item (images stay off while it is made)."""
    monkeypatch.setattr(settings, "IMAGE_ENABLED", False)
    gid = client.post("/games", json=world).json()["game_id"]
    fake_llm.narrator = _nar(T("add_item", name=item, description="a small tarnished key"),
                             content="A key glints in the silt.")
    client.post(f"/games/{gid}/action", json={"action": "I search the silt."})
    return gid


def _item_beats(client, gid):
    return [b for b in client.get(f"/games/{gid}/beats").json()["beats"]
            if b["kind"] == "image" and b["speaker"] == "system"]


def _run_threads(fns, timeout=10):
    ts = [threading.Thread(target=f) for f in fns]
    for t in ts:
        t.start()
    for t in ts:
        t.join(timeout)
        assert not t.is_alive(), "worker thread hung"


# ---------------------------------------------------------------------------
# in-flight claims: overlapping jobs never double-render or double-post
# ---------------------------------------------------------------------------

def test_overlapping_item_jobs_render_once(client, fake_llm, world, monkeypatch, tmp_path):
    gid = _make_game_with_item(client, fake_llm, world, monkeypatch)
    _images_on(monkeypatch, tmp_path)

    renders = []
    first_in = threading.Event()
    release = threading.Event()

    def _gen(prompt, seed=None, width=None, height=None, references=None, interactive=False):
        renders.append(prompt)
        first_in.set()
        release.wait(5)
        return {"image_url": "data:image/png;base64,aGk="}

    monkeypatch.setattr(media, "generate_scene_image", _gen)

    second_result = []

    def _first():
        integrate.generate_item_image(gid, "brass key")

    def _second():
        first_in.wait(5)                       # the first job is mid-render
        second_result.append(integrate.generate_item_image(gid, "brass key"))
        release.set()                          # now let the first finish

    _run_threads([_first, _second])
    assert len(renders) == 1                   # ONE render, not two
    assert second_result == [None]             # the duplicate schedule was a no-op
    assert len(_item_beats(client, gid)) == 1  # and ONE unlock card in the chat


def test_distinct_items_do_not_block_each_other(client, fake_llm, world, monkeypatch, tmp_path):
    gid = _make_game_with_item(client, fake_llm, world, monkeypatch)
    monkeypatch.setattr(settings, "IMAGE_ENABLED", True)
    fake_llm.narrator = _nar(T("add_item", name="silver coin", description="an old coin"),
                             content="A coin rolls free.")
    monkeypatch.setattr(settings, "IMAGE_ENABLED", False)
    client.post(f"/games/{gid}/action", json={"action": "I keep digging."})
    _images_on(monkeypatch, tmp_path)

    renders = []
    both_in = threading.Barrier(2, timeout=5)

    def _gen(prompt, seed=None, width=None, height=None, references=None, interactive=False):
        renders.append(prompt)
        both_in.wait()                         # requires BOTH renders in flight at once
        return {"image_url": "data:image/png;base64,aGk="}

    monkeypatch.setattr(media, "generate_scene_image", _gen)
    _run_threads([lambda: integrate.generate_item_image(gid, "brass key"),
                  lambda: integrate.generate_item_image(gid, "silver coin")])
    assert len(renders) == 2                   # different assets, different claims
    assert len(_item_beats(client, gid)) == 2


def test_failed_render_releases_the_claim(client, fake_llm, world, monkeypatch, tmp_path):
    gid = _make_game_with_item(client, fake_llm, world, monkeypatch)
    _images_on(monkeypatch, tmp_path)

    attempts = []

    def _gen(prompt, **kw):
        attempts.append(prompt)
        return None if len(attempts) == 1 else {"image_url": "data:image/png;base64,aGk="}

    monkeypatch.setattr(media, "generate_scene_image", _gen)
    assert integrate.generate_item_image(gid, "brass key") is None   # render failed
    beat = integrate.generate_item_image(gid, "brass key")           # self-heal retries
    assert beat and len(attempts) == 2
    assert len(_item_beats(client, gid)) == 1


def test_overlapping_portrait_jobs_render_each_character_once(client, fake_llm, world,
                                                              monkeypatch, tmp_path):
    monkeypatch.setattr(settings, "IMAGE_ENABLED", False)
    gid = client.post("/games", json=world).json()["game_id"]
    _images_on(monkeypatch, tmp_path)

    renders = []
    first_in = threading.Event()
    release = threading.Event()

    def _char_set(descriptor, style="", seed=None):
        renders.append(descriptor)
        first_in.set()
        release.wait(5)
        return {"face_url": "data:image/png;base64,aGk=",
                "body_front_url": "data:image/png;base64,aGk=",
                "body_side_url": "data:image/png;base64,aGk="}

    monkeypatch.setattr(media, "generate_character_images", _char_set)

    def _first():
        integrate.generate_images_for_game(gid)

    def _second():
        first_in.wait(5)
        integrate.generate_images_for_game(gid)   # overlaps: must be a claimed no-op
        release.set()

    _run_threads([_first, _second])
    assert len(renders) == 1                      # one character, one render
    with db.get_conn() as conn:
        c = repo.get_characters(conn, gid)[0]
    assert c["face_url"].startswith(f"/media/{gid}/char-")


def test_overlapping_scene_jobs_render_once(client, fake_llm, world, monkeypatch, tmp_path):
    monkeypatch.setattr(settings, "IMAGE_ENABLED", False)
    gid = client.post("/games", json=world).json()["game_id"]
    with db.get_conn() as conn:
        scene_id = repo.current_scene(conn, gid)["id"]
    _images_on(monkeypatch, tmp_path)

    renders = []
    first_in = threading.Event()
    release = threading.Event()

    def _gen(prompt, seed=None, width=None, height=None, references=None, interactive=False):
        renders.append(prompt)
        first_in.set()
        release.wait(5)
        return {"image_url": "data:image/png;base64,aGk="}

    monkeypatch.setattr(media, "generate_scene_image", _gen)

    def _first():
        integrate.generate_scene_image(gid, scene_id)

    def _second():
        first_in.wait(5)
        integrate.generate_scene_image(gid, scene_id)
        release.set()

    _run_threads([_first, _second])
    assert len(renders) == 1
    with db.get_conn() as conn:
        assert repo.get_scene_by_id(conn, scene_id)["image_url"].startswith("/media/")


# ---------------------------------------------------------------------------
# render lanes: local = one lock for everything; Anna = ambient width + a
# separate player-facing lane
# ---------------------------------------------------------------------------

def test_local_stack_keeps_the_single_render_lock():
    assert media._render_gate(False) is media._LOCAL_GATE
    assert media._render_gate(True) is media._LOCAL_GATE


def test_anna_lanes_split_and_honor_the_width_setting(monkeypatch):
    monkeypatch.setattr(media.hostbridge, "active", lambda: True)
    monkeypatch.setattr(settings, "IMAGE_CONCURRENCY", 2)
    ambient = media._render_gate(False)
    assert ambient is not media._LOCAL_GATE
    assert media._render_gate(True) is media._INTERACTIVE_GATE
    assert media._render_gate(False) is ambient          # stable while width holds
    monkeypatch.setattr(settings, "IMAGE_CONCURRENCY", 3)
    assert media._render_gate(False) is not ambient      # rebuilt on width change


def test_anna_ambient_lane_renders_concurrently(monkeypatch):
    monkeypatch.setattr(media.hostbridge, "active", lambda: True)
    monkeypatch.setattr(settings, "IMAGE_ENABLED", True)
    monkeypatch.setattr(settings, "IMAGE_CONCURRENCY", 2)
    both_in = threading.Barrier(2, timeout=5)

    class P:
        def generate(self, prompt, size, seed=None, references=None):
            both_in.wait()                     # both renders must overlap in time
            return {"image_url": "u"}

    monkeypatch.setattr(media, "_provider", lambda: P())
    out = []
    _run_threads([lambda: out.append(media.generate_scene_image("a")),
                  lambda: out.append(media.generate_scene_image("b"))])
    assert out == [{"image_url": "u"}, {"image_url": "u"}]  # neither timed out at the gate


def test_interactive_lane_bypasses_a_busy_ambient_lane(monkeypatch):
    monkeypatch.setattr(media.hostbridge, "active", lambda: True)
    monkeypatch.setattr(settings, "IMAGE_ENABLED", True)
    monkeypatch.setattr(settings, "IMAGE_CONCURRENCY", 1)
    ambient_in = threading.Event()
    release = threading.Event()
    done = []

    class P:
        def generate(self, prompt, size, seed=None, references=None):
            if prompt == "ambient":
                ambient_in.set()
                release.wait(5)
            done.append(prompt)
            return {"image_url": "u"}

    monkeypatch.setattr(media, "_provider", lambda: P())

    def _ambient():
        media.generate_scene_image("ambient")

    def _interactive():
        ambient_in.wait(5)                     # ambient lane is saturated (width 1)
        media.generate_scene_image("look", interactive=True)
        release.set()                          # the look finished FIRST, then unblock

    _run_threads([_ambient, _interactive])
    assert done == ["look", "ambient"]         # the player's look never queued behind it


# ---------------------------------------------------------------------------
# /media64: data-URI delivery for the Anna iframe, encoded once per file
# ---------------------------------------------------------------------------

def _write_png(path, color="red", size=(64, 64)):
    from PIL import Image
    path.parent.mkdir(parents=True, exist_ok=True)
    Image.new("RGB", size, color).save(path)


def test_media64_serves_a_downscaled_data_uri(client, monkeypatch, tmp_path):
    monkeypatch.setattr(settings, "GAMES_DATA_DIR", str(tmp_path))
    _write_png(tmp_path / "g1" / "images" / "scene-x.png")
    r = client.get("/media64/g1/scene-x.png")
    assert r.status_code == 200
    assert r.json()["uri"].startswith("data:image/jpeg;base64,")
    assert client.get("/media64/g1/nope.png").status_code == 404
    assert client.get("/media64/g1/no%2Fslash.png").status_code == 404


def test_media_paths_reject_dot_traversal(monkeypatch, tmp_path):
    from fastapi import HTTPException
    from app import main as appmain
    monkeypatch.setattr(settings, "GAMES_DATA_DIR", str(tmp_path))
    _write_png(tmp_path / "g1" / "images" / "ok.png")
    assert appmain._media_file_path("g1", "ok.png").endswith("ok.png")
    for gid, name in ((".", "ok.png"), ("..", "ok.png"), ("g1", ".."), ("g1", "...")):
        with pytest.raises(HTTPException):
            appmain._media_file_path(gid, name)


def test_data_uri_encodes_once_per_file_version(monkeypatch, tmp_path):
    import os
    import PIL.Image
    p = tmp_path / "g1" / "images" / "item.png"
    _write_png(p)
    opens = []
    real_open = PIL.Image.open
    monkeypatch.setattr(PIL.Image, "open", lambda fp: opens.append(fp) or real_open(fp))

    first = media.image_data_uri(str(p))
    again = media.image_data_uri(str(p))
    assert first.startswith("data:image/jpeg;base64,") and again == first
    assert len(opens) == 1                          # the second hit came from the cache

    _write_png(p, color="blue")                     # the file changed on disk
    os.utime(p, (1e9, 1e9))                         # force a distinct mtime
    assert media.image_data_uri(str(p)) != first    # re-encoded, new content
    assert len(opens) == 2

    assert media.image_data_uri(str(tmp_path / "missing.png")) is None
