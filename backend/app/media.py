"""Best-effort facade over the accessory media providers (image, voice).

These functions keep their historical signatures (tests and integrate/jobs.py call
them directly) but now dispatch to the ACTIVE provider from app/providers/, resolved
at call time (env -> default). With the default local stack the
wire behavior is byte-identical to what this module always did.

Every call is wrapped so a missing/slow/erroring service NEVER breaks the game:
on any failure these return empty/None and the game stays fully playable text-only.
Gated by IMAGE_ENABLED / voice_enabled() (VOICE_ENABLED, and quiet in Anna mode).
"""
import base64
import io
import logging
import os
import threading
from urllib.parse import parse_qs, urlsplit

import httpx

from . import hostbridge
from .config import settings
from .providers import base as providers
from .providers import image as image_providers


# ---------- voice-api (local registry back-compat; the engine composes voice
# designs itself now and no longer registers them here) ----------

def list_voice_ids() -> list[str]:
    if not providers.voice_enabled():
        return []
    try:
        r = httpx.get(f"{settings.VOICE_API_URL}/voices", timeout=5)
        r.raise_for_status()
        return [v["voice_id"] for v in r.json().get("voices", []) if v.get("voice_id")]
    except Exception:
        return []


def register_character_voice(char_id: str, name: str, description: str,
                             gender: str = "") -> str | None:
    """DEPRECATED for the engine (voice identity lives in OUR DB now; see
    integrate/voice.py). Kept for back-compat with anything still calling it."""
    if not providers.voice_enabled() or not (description or name).strip():
        return None
    body = {"id": char_id, "name": name, "description": description}
    if gender:
        body["gender"] = gender
    try:
        r = httpx.post(f"{settings.VOICE_API_URL}/characters", json=body, timeout=10)
        r.raise_for_status()
        return r.json().get("voice_id")
    except Exception:
        return None


def delete_character_voice(char_id: str) -> None:
    """Release a character's legacy registry entry (called on game wipe so old
    voice-api state never piles up). Best-effort."""
    if not providers.voice_enabled():
        return
    try:
        httpx.delete(f"{settings.VOICE_API_URL}/characters/{char_id}", timeout=5)
    except Exception:
        pass


# ---------- ownership-based cleanup (owner decision 2026-06-11: NO retention
# timers, NO schedulers - when our copy of a file is the truth the staging copy
# dies that instant, and when an adventure dies every file it produced dies with
# it, ComfyUI staging folder and wav cache included) ----------

def delete_staging_image(url: str | None) -> None:
    """Free ONE staging file in the image-api's ComfyUI output dir. Only
    '/image/file?' URLs qualify: data: payloads and cloud-provider URLs leave no
    staging file behind, so they skip silently. Best-effort: a dead image-api
    never breaks the render (or the delete) that triggered this."""
    if not settings.IMAGE_ENABLED or not url or "/image/file?" not in url:
        return
    try:
        # keep_blank_values: the image-api emits 'subfolder=' explicitly; without it
        # parse_qs would drop the key and we could not echo the exact coordinates back
        q = parse_qs(urlsplit(url).query, keep_blank_values=True)
        filename = (q.get("filename") or [""])[0]
        if not filename:
            return
        httpx.delete(f"{settings.IMAGE_API_URL}/image/file",
                     params={"filename": filename,
                             "subfolder": (q.get("subfolder") or [""])[0],
                             "type": (q.get("type") or ["output"])[0]},
                     timeout=5)
    except Exception:
        pass


def purge_all_staging_images() -> int | None:
    """Empty the image-api's ENTIRE staging folder (the settings 'wipe all memory'
    button). Returns the file count the service reports, or None when it could not
    confirm (service down, images disabled, malformed reply). Best-effort."""
    if not settings.IMAGE_ENABLED:
        return None
    try:
        r = httpx.delete(f"{settings.IMAGE_API_URL}/image/files",
                         params={"confirm": "all"}, timeout=10)
        r.raise_for_status()
        return int(r.json().get("deleted", 0))
    except Exception:
        return None


def purge_game_audio(gid: str) -> None:
    """Drop the cached wavs that ONLY this game claims in the voice-api manifest
    (a wav shared with another game just loses this game's claim). Called on game
    delete so a dead adventure's dialogue never lingers in the cache. Best-effort."""
    if not providers.voice_enabled():
        return
    try:
        httpx.delete(f"{settings.VOICE_API_URL}/voice/games/{gid}", timeout=5)
    except Exception:
        pass


def purge_all_audio() -> int | None:
    """Empty the voice-api's whole wav cache + manifest ('wipe all memory').
    Returns the count the service reports, or None when it could not confirm
    (service down, voice disabled, malformed reply). Best-effort."""
    if not providers.voice_enabled():
        return None
    try:
        r = httpx.delete(f"{settings.VOICE_API_URL}/audio",
                         params={"confirm": "all"}, timeout=10)
        r.raise_for_status()
        return int(r.json().get("deleted", 0))
    except Exception:
        return None


# ---------- image ----------

# Render gating is LANE- and PROVIDER-aware.
#
# Local stack (comfy / cloud dialects): ONE render at a time, orchestrator-wide
# (owner decision, 2026-06-11) - background tasks already serialize within a request
# and ComfyUI queues internally, but two requests (a creation and a turn, two games)
# could still overlap renders. The single lock makes "submit, wait, next" a guarantee.
#
# Anna host path: the host takes concurrent image/generate reverse-RPCs (each is its
# own pending future in the SDK), and every render rides a per-invoke token that dies
# ~600s after its invoke - strict serialization of a creation pass (3 renders per
# character + item cards + the scene) blows that TTL and the tail renders fail with
# auth errors. So ambient renders (portraits, scene art, item cards) share a semaphore
# of IMAGE_CONCURRENCY slots, and player-facing renders (a look's view snapshot, the
# narrator's show_image shot) get their OWN single-slot lane so they never queue
# behind a long background backlog.
_LOCAL_GATE = threading.Lock()
_INTERACTIVE_GATE = threading.Lock()
_ambient_gate = None
_ambient_width = None
_ambient_lock = threading.Lock()


def _render_gate(interactive: bool = False):
    if not hostbridge.active():
        return _LOCAL_GATE
    if interactive:
        return _INTERACTIVE_GATE
    global _ambient_gate, _ambient_width
    with _ambient_lock:
        # rebuilt if the width setting changed (tests); cheap either way
        if _ambient_gate is None or _ambient_width != settings.IMAGE_CONCURRENCY:
            _ambient_width = settings.IMAGE_CONCURRENCY
            _ambient_gate = threading.BoundedSemaphore(_ambient_width)
        return _ambient_gate


def _provider() -> image_providers.ImageProvider:
    cfg = providers.resolve("image")
    # Native Anna path: route image generation through the executa's reverse-RPC to
    # the host (no HTTP image service). Falls through to the configured provider
    # (comfy / openai / ...) outside an executa.
    if hostbridge.active():
        return image_providers.AnnaImageProvider(cfg)
    return image_providers.get_provider(cfg)


def generate_character_images(descriptor: str, style: str = "", seed: int | None = None) -> dict | None:
    """Returns {face_url, body_front_url, body_side_url, seed} or None."""
    if not settings.IMAGE_ENABLED or not descriptor.strip():
        return None
    try:
        with _render_gate():
            return _provider().character_set(descriptor, style, seed=seed)
    except Exception as exc:
        logging.getLogger("gamentic.image").warning("character_set swallowed: %r", exc)
        return None


def generate_character_view(descriptor: str, style: str, view: str,
                            reference: str | None = None,
                            seed: int | None = None) -> str | None:
    """ONE missing view of a character's reference set (the heal path). Returns the
    image url or None; failures are swallowed like every other render."""
    if not settings.IMAGE_ENABLED or not descriptor.strip():
        return None
    try:
        with _render_gate():
            return _provider().character_view(descriptor, style, view,
                                              reference=reference, seed=seed)
    except Exception as exc:
        logging.getLogger("gamentic.image").warning("character_view(%s) swallowed: %r", view, exc)
        return None


# ---------- data-URI delivery (the Anna iframe cannot fetch /media over HTTP; it
# pulls each image ONCE through GET /media64/{gid}/{name} and caches it browser-side.
# This replaced the executa inlining every /media ref into every reply, which
# re-encoded and re-shipped megabytes of base64 on each /state poll.) ----------

_DATA_URI_MAX_PX = 768     # display size; the stdio writer spills >512KB frames to a file
_DATA_URI_QUALITY = 78
_data_uri_cache: dict[str, tuple[float, str]] = {}   # path -> (mtime, uri)
_data_uri_lock = threading.Lock()


def image_data_uri(path: str) -> str | None:
    """A downscaled JPEG data: URI for one persisted image file, cached by mtime so
    repeat requests never re-encode. None when the file is unreadable."""
    try:
        mtime = os.path.getmtime(path)
    except OSError:
        return None
    with _data_uri_lock:
        hit = _data_uri_cache.get(path)
        if hit and hit[0] == mtime:
            return hit[1]
    try:
        from PIL import Image
        im = Image.open(path)
        if im.mode not in ("RGB", "L"):
            im = im.convert("RGB")
        im.thumbnail((_DATA_URI_MAX_PX, _DATA_URI_MAX_PX))
        buf = io.BytesIO()
        im.save(buf, "JPEG", quality=_DATA_URI_QUALITY)
        uri = "data:image/jpeg;base64," + base64.b64encode(buf.getvalue()).decode("ascii")
    except Exception as exc:
        logging.getLogger("gamentic.image").warning("data-uri encode failed for %s: %r", path, exc)
        return None
    with _data_uri_lock:
        if len(_data_uri_cache) >= 256:     # a full game set is way under this
            _data_uri_cache.clear()
        _data_uri_cache[path] = (mtime, uri)
    return uri


def fetch_image_bytes(url: str | None) -> bytes | None:
    """Materialize a provider image (data: URL, absolute URL, or a path relative to
    the active image provider's base) so we can persist it per-game."""
    if not url:
        return None
    try:
        if url.startswith("data:"):
            return base64.b64decode(url.split(",", 1)[1])
        if not url.startswith("http"):
            base = providers.resolve("image").base_url
            url = f"{base}{url}"
        r = httpx.get(url, timeout=60)
        r.raise_for_status()
        return r.content
    except Exception:
        return None


def generate_scene_image(prompt: str, seed: int | None = None,
                         width: int | None = None, height: int | None = None,
                         references: list[str] | None = None,
                         interactive: bool = False) -> dict | None:
    """Returns {image_url, ...} or None. Optional; off the turn hot-path by default.
    width/height override the scene defaults (the 'See' snapshot uses a landscape frame).
    references are fetchable image URLs (characters' stored views): providers that
    support them condition the render so existing characters keep their identity;
    providers that don't silently fall back to plain t2i. interactive=True takes the
    player-facing lane (a look/show_image the player is watching for) so it never
    waits behind the ambient render backlog on the Anna path."""
    if not settings.IMAGE_ENABLED or not prompt.strip():
        return None
    try:
        with _render_gate(interactive):
            return _provider().generate(
                prompt, (width or settings.IMAGE_SCENE_W, height or settings.IMAGE_SCENE_H),
                seed=seed, references=references)
    except Exception as exc:
        logging.getLogger("gamentic.image").warning("scene image gen swallowed: %r", exc)
        return None
