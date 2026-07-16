"""Quota-aware rendering + the install-wide images switch.

The Anna host's image quota is a rolling per-invoke window (default ~4 images/30min):
exhausting it fails renders through no fault of the asset, so those failures must
pause ambient rendering and charge NO heal attempts (the window clears on its own).
Deterministic failures still burn the per-asset heal meter, which now lives in app_kv
so an executa restart cannot re-open a poisoned asset's allowance. The images switch
is a stored per-install setting layered over the IMAGE_ENABLED env default, exposed
and flipped through /settings/app, and reflected in /state for the UI.
"""
import pytest

from app import db, hostbridge, media, repo
from app.config import settings
from app.integrate import jobs


class FakeProvider:
    """Scriptable provider: .result is a url string, an Exception to raise, or None."""

    def __init__(self, result="http://img/x.png"):
        self.result = result
        self.calls = []

    def _out(self, tag):
        self.calls.append(tag)
        if isinstance(self.result, Exception):
            raise self.result
        return self.result

    def generate(self, prompt, size, seed=None, references=None):
        url = self._out(("generate", prompt))
        return {"image_url": url} if url else None

    def character_set(self, descriptor, style="", seed=None):
        url = self._out(("set", descriptor))
        return {"face_url": url, "body_front_url": url, "body_side_url": url} if url else None

    def character_view(self, descriptor, style="", view="face", reference=None, seed=None):
        return self._out(("view", view))


class HostError(RuntimeError):
    def __init__(self, code, msg="host error"):
        super().__init__(msg)
        self.code = code


@pytest.fixture
def provider(monkeypatch, tmp_path):
    monkeypatch.setattr(settings, "IMAGE_ENABLED", True)
    monkeypatch.setattr(settings, "GAMES_DATA_DIR", str(tmp_path))
    monkeypatch.setattr(media, "fetch_image_bytes", lambda url: b"PNG")
    fake = FakeProvider()
    monkeypatch.setattr(media, "_provider", lambda: fake)
    return fake


def _heal_keys():
    with db.get_conn() as conn:
        return [r["key"] for r in conn.execute(
            "SELECT key FROM app_kv WHERE key LIKE 'heal:%'").fetchall()]


# ---------------------------------------------------------------------------
# quota exhaustion: pause, don't charge
# ---------------------------------------------------------------------------

def test_quota_failure_pauses_ambient_and_charges_no_heal(client, fake_llm, world,
                                                          provider, monkeypatch):
    gid = client.post("/games", json=world).json()["game_id"]
    provider.result = hostbridge.ImageQuotaExhausted("window exhausted")

    assert media.generate_scene_image("a crypt") is None
    assert media.images_paused()
    assert media.images_status() == "paused_quota"
    assert _heal_keys() == []                       # the window's fault, not the asset's

    # ambient jobs skip entirely while paused: the provider is never even called
    provider.calls.clear()
    jobs.generate_item_image(gid, "brass key")
    jobs.generate_scene_image(gid, repo_scene_id(gid))
    assert provider.calls == []
    assert _heal_keys() == []

    # the pause is visible to the UI through /state
    st = client.get(f"/games/{gid}/state").json()
    assert st["images_status"] == "paused_quota"

    # the window cleared: rendering and status recover on the next success
    media.reset_image_state()
    provider.result = "http://img/ok.png"
    assert media.generate_scene_image("a crypt")["image_url"]
    assert media.images_status() == "ok"


def repo_scene_id(gid):
    with db.get_conn() as conn:
        return repo.current_scene(conn, gid)["id"]


# ---------------------------------------------------------------------------
# deterministic failures: durable heal meters (survive a restart)
# ---------------------------------------------------------------------------

def test_heal_meter_persists_across_process_state_resets(client, fake_llm, world,
                                                         provider, monkeypatch):
    monkeypatch.setattr(settings, "IMAGE_HEAL_MAX_ATTEMPTS", 2)
    monkeypatch.setattr(settings, "IMAGE_ENABLED", False)   # creation renders nothing
    gid = client.post("/games", json=world).json()["game_id"]
    monkeypatch.setattr(settings, "IMAGE_ENABLED", True)
    scene_id = repo_scene_id(gid)
    provider.result = HostError(-32103, "provider down")

    jobs.generate_scene_image(gid, scene_id)
    assert len(_heal_keys()) == 1                   # one failed pass charged

    # a "restart": every in-memory registry resets, the DB meter stays
    jobs._inflight.clear()
    jobs._uploaded_refs.clear()
    media.reset_image_state()
    jobs.generate_scene_image(gid, scene_id)        # second (and last allowed) pass
    provider.calls.clear()
    jobs.generate_scene_image(gid, scene_id)        # ceiling reached: silent
    assert provider.calls == []

    # a success on another path clears the meter (fresh asset, fresh allowance)
    provider.result = "http://img/ok.png"
    jobs._inflight.clear()
    with db.get_conn() as conn:
        repo.kv_delete(conn, jobs._heal_key(gid, "scene", scene_id))
    jobs.generate_scene_image(gid, scene_id)
    with db.get_conn() as conn:
        assert repo.current_scene(conn, gid)["image_url"]


def test_not_granted_status_surfaces_and_recovers(client, fake_llm, world, provider):
    gid = client.post("/games", json=world).json()["game_id"]
    provider.result = HostError(hostbridge.IMG_NOT_GRANTED, "image grant missing")
    media.generate_scene_image("a crypt")
    assert client.get(f"/games/{gid}/state").json()["images_status"] == "not_granted"

    provider.result = "http://img/ok.png"
    media.generate_scene_image("a crypt")
    assert client.get(f"/games/{gid}/state").json()["images_status"] == "ok"


# ---------------------------------------------------------------------------
# /media64/batch: many images, one round-trip
# ---------------------------------------------------------------------------

def _write_png(path):
    from PIL import Image
    path.parent.mkdir(parents=True, exist_ok=True)
    Image.new("RGB", (4, 4), "red").save(path, "PNG")


def test_media64_batch_resolves_many_and_nulls_bad_entries(client, monkeypatch, tmp_path):
    monkeypatch.setattr(settings, "GAMES_DATA_DIR", str(tmp_path))
    _write_png(tmp_path / "g1" / "images" / "a.png")
    _write_png(tmp_path / "g1" / "images" / "b.png")

    res = client.post("/media64/batch", json={"urls": [
        "/media/g1/a.png", "/media/g1/b.png",
        "/media/g1/missing.png", "/media/../etc/passwd", 42]})
    assert res.status_code == 200
    uris = res.json()["uris"]
    assert uris["/media/g1/a.png"].startswith("data:image/jpeg;base64,")
    assert uris["/media/g1/b.png"].startswith("data:image/jpeg;base64,")
    assert uris["/media/g1/missing.png"] is None
    assert uris["/media/../etc/passwd"] is None
    assert uris["42"] is None

    assert client.post("/media64/batch", json={"urls": []}).status_code == 422
    too_many = [f"/media/g1/{i}.png" for i in range(13)]
    assert client.post("/media64/batch", json={"urls": too_many}).status_code == 422


# ---------------------------------------------------------------------------
# the install-wide images switch
# ---------------------------------------------------------------------------

def test_images_toggle_overrides_env_and_gates_everything(client, fake_llm, world,
                                                          provider, monkeypatch):
    # env default ON (fixture) but the STORED value wins once set
    assert client.get("/settings/app").json()["images_enabled"] is True
    assert client.patch("/settings/app",
                        json={"images_enabled": False}).json()["images_enabled"] is False
    assert client.get("/settings/app").json()["images_enabled"] is False

    provider.calls.clear()
    gid = client.post("/games", json=world).json()["game_id"]      # schedules no art
    assert provider.calls == []
    st = client.get(f"/games/{gid}/state").json()
    assert st["images_enabled"] is False
    assert client.post(f"/games/{gid}/view", json={}).status_code == 409

    # flipping back on restores rendering (the heal picks the game up next turn)
    client.patch("/settings/app", json={"images_enabled": True})
    assert client.get(f"/games/{gid}/state").json()["images_enabled"] is True
    assert media.generate_scene_image("a crypt")["image_url"]

    assert client.patch("/settings/app", json={"images_enabled": "yes"}).status_code == 422
    assert client.patch("/settings/app", json={}).status_code == 422
