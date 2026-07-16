"""The stateful generate_* orchestrators: each opens its own DB conns around the slow
render call (never across it), re-checks the game still exists before persisting (a
wipe mid-render must never resurrect a media folder), and lands results as beats or
row updates. All run as background tasks except the synchronous See snapshot."""
import contextlib
import logging
import os
import threading
import time
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime

from .. import db, repo, media, llm, prompts, hostbridge
from ..config import settings
from . import events, image_prompts, storage


# ---------------------------------------------------------------------------
# In-flight job registry. The per-turn self-heal re-schedules a render job for
# every asset still missing from the DB, but a render takes 35-90s and nothing
# marked "already being rendered" - so a second job would re-render the same
# asset the moment the first released the gate (live: the same item unlock card
# landed TWICE as two beats, and portrait sets rendered twice per character).
# A job claims its key at entry and releases in finally; a duplicate schedule
# sees the claim and returns without rendering. Keys are per-asset, so a scene
# job never blocks an item job.
# ---------------------------------------------------------------------------
_inflight: set[tuple] = set()
_inflight_lock = threading.Lock()


@contextlib.contextmanager
def _claim(*key):
    with _inflight_lock:
        won = key not in _inflight
        if won:
            _inflight.add(key)
    try:
        yield won
    finally:
        if won:
            with _inflight_lock:
                _inflight.discard(key)


# ---------------------------------------------------------------------------
# Bounded self-healing. The per-turn heal re-schedules any asset still missing,
# which used to LOOP: an asset whose render kept failing the same way (a view
# the host kept rejecting, an item whose attach kept missing) re-rendered every
# turn forever. Each asset now gets IMAGE_HEAL_MAX_ATTEMPTS failed passes per
# process life, then the heal leaves it alone (the UI keeps its fallback). A
# success clears the meter; an executa restart grants a fresh allowance.
# ---------------------------------------------------------------------------
_heal_attempts: dict[tuple, int] = {}


def _heal_exhausted(*key) -> bool:
    with _inflight_lock:
        return _heal_attempts.get(key, 0) >= settings.IMAGE_HEAL_MAX_ATTEMPTS


def _heal_charge(*key) -> None:
    with _inflight_lock:
        _heal_attempts[key] = _heal_attempts.get(key, 0) + 1


def _heal_clear(*key) -> None:
    with _inflight_lock:
        _heal_attempts.pop(key, None)


# ---------------------------------------------------------------------------
# Host-fetchable identity references. Under Anna the host fetches
# reference_image_urls itself, over HTTPS - a /media path (or a compose-internal
# hostname) lives on the executa's disk and can never resolve there. Each local
# reference uploads ONCE via host/uploadFile (transient R2 URL) and is cached
# until shortly before it expires. Any upload failure degrades to NO reference:
# identity softens, the render still happens.
# ---------------------------------------------------------------------------
_uploaded_refs: dict[str, tuple[float, str]] = {}   # stored url -> (expiry ts, hosted url)
_UPLOAD_REF_TTL_NET = 480.0                          # assumed usable window (s) when the
                                                     # host's expires_at is absent/unparsable


def _hosted_reference(stored: str) -> str | None:
    with _inflight_lock:
        hit = _uploaded_refs.get(stored)
        if hit and hit[0] > time.time():
            return hit[1]
    rel = stored[len("/media/"):]
    gid, _, name = rel.partition("/")
    path = os.path.join(settings.GAMES_DATA_DIR, gid, "images", name)
    try:
        with open(path, "rb") as f:
            content = f.read()
        out = hostbridge.upload_file_sync(filename=name, content=content)
    except Exception as exc:
        logging.getLogger("gamentic.image").warning("reference upload skipped: %r", exc)
        return None
    url = (out or {}).get("download_url")
    if not url:
        return None
    expiry = time.time() + _UPLOAD_REF_TTL_NET
    try:                       # trust the host's own expiry when it is SOONER
        raw = str((out or {}).get("expires_at") or "")
        if raw:
            expiry = min(expiry, datetime.fromisoformat(raw.replace("Z", "+00:00")).timestamp() - 60)
    except Exception:
        pass
    with _inflight_lock:
        if len(_uploaded_refs) >= 128:
            _uploaded_refs.clear()
        _uploaded_refs[stored] = (expiry, url)
    return url


def _reference_url(stored: str | None) -> str | None:
    """Make a stored character image URL fetchable by whoever renders. Local stack:
    absolutize for the image-api (our /media files via the compose-internal hostname;
    its own /image/file paths via IMAGE_API_URL). Anna: the HOST fetches references,
    over HTTPS only - /media paths upload once (host/uploadFile) and ride the
    transient hosted URL; unresolvable refs drop to None (render unreferenced)."""
    if not stored:
        return None
    if stored.startswith("http"):
        return stored
    if hostbridge.active():
        return _hosted_reference(stored) if stored.startswith("/media/") else None
    if stored.startswith("/media/"):
        return f"{settings.MEDIA_INTERNAL_BASE}{stored}"
    return f"{settings.IMAGE_API_URL}{stored}"


def generate_view_snapshot(gid: str, focus: str | None = None,
                           private_with: str | None = None) -> dict | None:
    """The 'See' button: render the scene WITH the characters present in it, as it is NOW.
    Synchronous (the player watches a loader); persists the image and lands it as an image
    beat in the story flow (the focus, when given, becomes the beat's caption text).
    Identity references follow the subject: looking at a named character sends ONLY their
    stored view; looking at a thing sends none; no focus sends every present character's."""
    focus = (focus or "").strip()
    with db.get_conn() as conn:
        if not repo.get_game(conn, gid):
            return None
        prompt = image_prompts.view_prompt(conn, gid, focus=focus or None)
        context = image_prompts._image_context(conn, gid, include_chars=True, focus=focus or None) \
            if settings.IMAGE_AGENTIC_PROMPTS else ""
        loc = repo.get_player(conn, gid)["location"]
        if focus:
            fc = image_prompts._focus_character(conn, gid, focus)
            if not fc and private_with:
                # a PRIVATE look is always a study of that character, whatever the
                # focus words say (live: "any picture of you and your brother?" named
                # nobody, so the render went out with no identity reference and came
                # back a stranger)
                fc = repo.get_character(conn, private_with)
            chars = [fc] if fc else []
        elif private_with:
            chars = [repo.get_character(conn, private_with)]
        else:
            chars = list(repo.present_characters(conn, gid, loc))[:3]
        chars = [c for c in chars if c]
        refs = [u for u in (_reference_url(c["body_front_url"]) for c in chars) if u]
    if context:
        prompt = image_prompts._agentic_prompt(context, fallback=prompt)   # LLM call outside the DB conn
    result = media.generate_scene_image(prompt, width=settings.IMAGE_VIEW_W,
                                        height=settings.IMAGE_VIEW_H,
                                        references=refs or None, interactive=True)
    if not result or not result.get("image_url"):
        return None
    with db.get_conn() as conn:
        if not repo.get_game(conn, gid):
            return None    # game wiped while rendering: never re-create its media folder
        sc = repo.current_scene(conn, gid)
        t = repo.game_time(conn, gid)
        caption = image_prompts._concept(
            focus, f"{sc['name']}, {t['label']}",
            image_prompts._clip(image_prompts._strip_quoted(sc["description"]), 30))
        turn = repo.next_turn_index(conn, gid)
        # unique suffix: two renders can persist while the turn counter reads the same
        # value (live: two beats pointed at one overwritten view-t7.png, two captions)
        url = storage._persist(gid, result["image_url"], f"view-t{turn}-{repo._id()}")
        # private_with: a quiet study from the private panel lands IN that thread
        beat = repo.add_beat(conn, gid, "narrator", None, "image", caption, loc,
                             turn_index=turn, image_url=url, private_with=private_with)
    events.publish(gid, "beat", private_with=private_with)
    return beat


def generate_directed_image(gid: str, description: str, caption: str = "") -> dict | None:
    """Background: the narrator fired show_image (answering a player look, or its own
    dramatic choice). The narrator's visual description IS the shot; code enforces the
    invariants (quoted spans stripped, length clipped, style + no-text guard appended)
    and conditions on the identity references of present characters named in it. The
    image lands as its own image beat, picked up by the frontend's beats polling."""
    description = (description or "").strip()
    if not description:
        return None
    with db.get_conn() as conn:
        g = repo.get_game(conn, gid)
        if not g:
            return None
        loc = repo.get_player(conn, gid)["location"]
        style = g["art_style"] or g["tone"] or ""
        named = [c for c in repo.present_characters(conn, gid, loc)
                 if c["name"] and c["name"].lower() in description.lower()][:3]
        refs = [u for u in (_reference_url(c["body_front_url"]) for c in named) if u]
        prompt = image_prompts._harden_image_prompt(
            f"{image_prompts._strip_quoted(description)} {style}".strip())
    result = media.generate_scene_image(prompt, width=settings.IMAGE_VIEW_W,
                                        height=settings.IMAGE_VIEW_H,
                                        references=refs or None, interactive=True)
    if not result or not result.get("image_url"):
        return None
    with db.get_conn() as conn:
        if not repo.get_game(conn, gid):
            return None    # game wiped while rendering: never re-create its media folder
        turn = repo.next_turn_index(conn, gid)
        url = storage._persist(gid, result["image_url"], f"shot-t{turn}-{repo._id()}")
        # the narrator's own visual description IS the moment's concept
        beat = repo.add_beat(conn, gid, "narrator", None, "image",
                             image_prompts._concept(caption, description), loc,
                             turn_index=turn, image_url=url)
    events.publish(gid, "beat")
    return beat


def generate_item_image(gid: str, name: str) -> dict | None:
    """Background: render the small unlock image of a newly visible item, attach it to the
    item wherever it now lives, and land it as a SYSTEM image beat (small card in the chat;
    system image beats don't count against the narrator's show_image pacing)."""
    with _claim(gid, "item", repo.item_key(name)) as won:
        if not won:
            return None    # a render for this exact item is already in flight
        return _generate_item_image(gid, name)


def _generate_item_image(gid: str, name: str) -> dict | None:
    key = repo.item_key(name)
    if _heal_exhausted(gid, "item", key):
        return None    # this card kept failing; stop re-rendering it every turn
    with db.get_conn() as conn:
        g = repo.get_game(conn, gid)
        if not g:
            return None
        # the index keys are article-blind item_keys; norm_name kept the article, so an
        # article-led name ("a heavy iron key") missed its OWN entry and the card job
        # silently bailed forever (live: the key showed bare initials in the pack)
        entry = repo.visible_item_index(conn, gid).get(key)
        if not entry or entry.get("image_url"):       # gone from view, or already pictured
            return None
        style = g["art_style"] or g["tone"] or ""
        loc = repo.get_player(conn, gid)["location"]
        prompt = image_prompts.item_prompt(entry["name"], entry["description"], style)
    result = media.generate_scene_image(prompt, width=settings.IMAGE_ITEM_SIZE,
                                        height=settings.IMAGE_ITEM_SIZE)
    if not result or not result.get("image_url"):
        _heal_charge(gid, "item", key)
        return None
    with db.get_conn() as conn:
        if not repo.get_game(conn, gid):
            return None    # game wiped while rendering: never re-create its media folder
        url = storage._persist(gid, result["image_url"], f"item-{image_prompts._slug(name)}")
        if not repo.set_item_image(conn, gid, name, url):
            _heal_charge(gid, "item", key)             # the item vanished mid-render
            return None
        beat = repo.add_beat(conn, gid, "system", None, "image",
                             image_prompts._concept(entry["name"], entry["description"]), loc,
                             image_url=url)
    _heal_clear(gid, "item", key)
    events.publish(gid, "item", name=name)
    return beat


def art_direction(gid: str) -> dict | None:
    """ONE art-director call at creation (owner direction 2026-06-11): the agent reads
    the whole world bible and writes the first-sight prompts - a reference descriptor
    per character plus the main opening image - so the adventure's first impression
    never depends on a thin per-render template. Guarded like every agentic prompt:
    any failure returns None and the deterministic templates carry the renders."""
    with db.get_conn() as conn:
        g = repo.get_game(conn, gid)
        if not g:
            return None
        chars = repo.get_characters(conn, gid)
        part = repo.game_time(conn, gid).get("part") or ""
        start = repo.current_scene(conn, gid)["name"]
        messages = prompts.build_artdirector_messages(g, chars, time_of_day=part,
                                                      start_location=start)
    try:
        reply = llm.chat(messages, temperature=0.4, max_tokens=0)
    except Exception:
        return None
    # Tolerant parse (json_repair): the art bible is large, so recover a fenced or
    # slightly-malformed reply instead of dropping every render to the generic template.
    data = llm._loads_lenient(reply.content or "")
    if not isinstance(data, dict) or not data:
        return None
    main_raw = str(data.get("main_image") or "").strip()
    main = image_prompts._harden_image_prompt(main_raw) if main_raw else ""
    cast = {}
    for entry in data.get("characters") or []:
        if not isinstance(entry, dict):
            continue
        name = str(entry.get("name") or "").strip()
        desc = str(entry.get("descriptor") or "").strip()
        if name and desc:
            cast[name.lower()] = image_prompts._clip(desc, 90)
    if not main and not cast:
        return None
    return {"main_image": main, "characters": cast}


def generate_images_for_game(gid: str, direction: dict | None = None) -> None:
    """Background: generate + persist the 3-image reference set for each character.
    Resilient (live bug: a 'database is locked' on ONE character's commit killed the
    whole loop, leaving every portrait null): each character is independent, files
    already on disk are RELINKED instead of re-rendered, and the per-turn self-heal
    re-schedules this job until every character has their set. An art-director
    `direction` (creation only) supplies the descriptor; the sheet template is the net."""
    with _claim(gid, "portraits") as won:
        if not won:
            return    # a portrait pass for this game is already in flight
        _generate_images_for_game(gid, direction)


_VIEW_KEYS = (("face", "face_url"), ("front", "body_front_url"), ("side", "body_side_url"))


def _generate_images_for_game(gid: str, direction: dict | None = None) -> None:
    with db.get_conn() as conn:
        g = repo.get_game(conn, gid)
        if not g:
            return
        style = g["art_style"] or g["tone"] or ""
        chars = repo.get_characters(conn, gid)
    directed = (direction or {}).get("characters") or {}

    def _one(c) -> None:
        try:
            cid = c["id"]
            # what this character already HAS: DB truth merged with disk truth (a
            # crashed run may have written files without committing the row)
            have = {key: c[key] for _, key in _VIEW_KEYS if c[key]}
            have.update(storage._existing_char_urls(gid, cid))
            missing = [(view, key) for view, key in _VIEW_KEYS if not have.get(key)]
            if missing and _heal_exhausted(gid, "char", cid):
                return   # this set kept failing; stop re-rendering it every turn
            rendered: dict = {}
            if len(missing) == 3:
                # nothing yet: the one-shot set render (comfy's server-side 3-view
                # unit / the cloud face->front/side chain). PARTIAL results persist:
                # the heal completes the rest view by view on a later pass.
                descriptor = (directed.get((c["name"] or "").strip().lower())
                              or image_prompts.character_descriptor(c))
                rendered = media.generate_character_images(descriptor, style) or {}
            elif missing:
                # a partial set: render ONLY the missing views, identity-conditioned
                # on the face we already have (never re-render what landed)
                descriptor = (directed.get((c["name"] or "").strip().lower())
                              or image_prompts.character_descriptor(c))
                face_ref = have.get("face_url")
                for view, key in missing:
                    ref = _reference_url(face_ref) if view != "face" else None
                    url = media.generate_character_view(descriptor, style, view, reference=ref)
                    if url:
                        rendered[key] = url
                        if view == "face":
                            face_ref = url   # front/side condition on the fresh face
            with db.get_conn() as conn:
                if not repo.get_game(conn, gid):
                    return   # game wiped while rendering: never re-create its folder
                for view, key in _VIEW_KEYS:
                    if rendered.get(key):
                        have[key] = storage._persist(gid, rendered[key], f"char-{cid}-{view}")
                if not have:
                    _heal_charge(gid, "char", cid)   # a fully-failed pass burns one try
                    return
                repo.set_character_images(conn, cid, **{key: have.get(key) for _, key in _VIEW_KEYS})
            if all(have.get(key) for _, key in _VIEW_KEYS):
                _heal_clear(gid, "char", cid)
            elif missing:
                _heal_charge(gid, "char", cid)       # progressed but still partial
            if rendered:
                events.publish(gid, "portrait", char_id=cid)
        except Exception:
            pass   # one character's failure never costs the others their portraits

    todo = [c for c in chars if not repo.character_has_images(c)]
    if not todo:
        return
    if hostbridge.active() and settings.IMAGE_CONCURRENCY > 1 and len(todo) > 1:
        # Anna path: characters render concurrently up to the ambient lane width
        # (each character_set still holds ONE ambient slot for its 3 views). This is
        # what keeps a whole cast inside the ~600s reverse-RPC token TTL.
        with ThreadPoolExecutor(max_workers=settings.IMAGE_CONCURRENCY,
                                thread_name_prefix="portrait") as pool:
            list(pool.map(_one, todo))
    else:
        for c in todo:
            _one(c)


def generate_scene_image(gid: str, scene_id: str, prompt_override: str = "") -> None:
    """Background: generate + persist art for one scene (skips if it already has an
    image). `prompt_override` (the art director's main-image prompt, creation only)
    wins outright; otherwise template, agentically rewritten when current."""
    with _claim(gid, "scene", scene_id) as won:
        if not won:
            return    # a render for this exact scene is already in flight
        _generate_scene_image(gid, scene_id, prompt_override)


def _generate_scene_image(gid: str, scene_id: str, prompt_override: str = "") -> None:
    if _heal_exhausted(gid, "scene", scene_id):
        return    # this scene's art kept failing; stop re-rendering it every turn
    with db.get_conn() as conn:
        sc = repo.get_scene_by_id(conn, scene_id)
        g = repo.get_game(conn, gid)
        if not sc or not g or sc["image_url"]:
            return
        style = g["art_style"] or g["tone"] or ""
        prompt = prompt_override or image_prompts.scene_prompt(sc, style)
        # agentic context only if this is still the CURRENT scene (this runs in the
        # background; the player may have moved on, and the context follows the player)
        context = image_prompts._image_context(conn, gid, include_chars=False) \
            if settings.IMAGE_AGENTIC_PROMPTS and not prompt_override \
            and sc["id"] == repo.current_scene(conn, gid)["id"] else ""
    if context:
        prompt = image_prompts._agentic_prompt(context, fallback=prompt)   # LLM call outside the DB conn
    result = media.generate_scene_image(prompt)
    if not result:
        _heal_charge(gid, "scene", scene_id)
        return
    with db.get_conn() as conn:
        if not repo.get_game(conn, gid):
            return         # game wiped while rendering: never re-create its media folder
        url = storage._persist(gid, result.get("image_url"), f"scene-{scene_id}")
        repo.set_scene_image(conn, scene_id, url)
    _heal_clear(gid, "scene", scene_id)
    events.publish(gid, "scene", scene_id=scene_id)


def generate_creation_art(gid: str, scene_id: str) -> None:
    """The whole first-sight art pass, one background task (both creation routes call
    this). Order is the owner's law: the art director writes the prompts, then
    portraits render FIRST (they are the identity references), then the seeded item
    cards, then the main opening image. Every stage degrades gracefully - a dead
    director or a failed render never costs the later stages."""
    direction = art_direction(gid) if settings.IMAGE_ART_DIRECTOR else None
    generate_images_for_game(gid, direction)
    if settings.IMAGE_ITEMS:
        # seeded possessions get their unlock card NOW: cards otherwise render only on
        # the action route's new-item diff, and a turn-0 item is never "new" there
        with db.get_conn() as conn:
            if not repo.get_game(conn, gid):
                return
            seeded = [v["name"] for v in repo.visible_item_index(conn, gid).values()
                      if not v.get("image_url")]
        for name in seeded[: settings.IMAGE_MAX_ITEMS_PER_TURN]:
            generate_item_image(gid, name)
    generate_scene_image(gid, scene_id, prompt_override=(direction or {}).get("main_image", ""))
