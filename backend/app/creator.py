"""Story-creator agent: interview the user, then emit a structured WorldSheet.

Sessions are persisted in SQLite (they used to be an in-memory dict, which meant any
orchestrator restart silently killed an in-progress creation and finalize failed with
"unknown session"). The conversation is free-form; the output of record is structured
JSON produced by a final tool call, then persisted by repo.create_game.
"""
import json
import re

from . import engine, prompts, llm, repo, db
from .config import settings
from .engine import parsing
from .llm import _loads_lenient
from .models import WorldSheet

ORIGIN_MIN_CHARS = 220   # ~3 short sentences; anything thinner gets the enrichment pass

# The creator's readiness signal (owner: the begin button stays LOCKED until the
# world-builder is genuinely ready - it used to sit clickable the whole chat and
# bounce with a 409). The prompt asks for the exact marker [ready]; the prose
# fallback honors the house rule - parse the intent, never demand the protocol
# (the prompt has always made the model SAY it is ready in words).
_READY_MARK = re.compile(r"\[\s*ready\s*\]", re.I)
_READY_PROSE = re.compile(r"\bready\b[^.!?\n]{0,60}\b(?:start|begin|forge)\b", re.I)


def is_ready(text: str) -> bool:
    """Does this creator reply signal the world is complete enough to forge?"""
    return bool(_READY_MARK.search(text or "") or _READY_PROSE.search(text or ""))


def strip_ready(text: str) -> str:
    """Display form of a stored creator reply: the marker is plumbing, never prose."""
    return _READY_MARK.sub("", text or "").strip()


def enrich_origins(gid: str) -> None:
    """Background (scheduled at every creation path): give each character with a thin
    backstory a real one, one focused LLM call each. Never blocks or fails creation;
    a character whose call fails simply keeps the thin origin."""
    with db.get_conn() as conn:
        g = repo.get_game(conn, gid)
        if not g:
            return
        work = [(c["id"], prompts.build_origin_messages(g, c))
                for c in repo.get_characters(conn, gid)
                if c["alive"] and len((c["origin"] or "").strip()) < ORIGIN_MIN_CHARS]
    for cid, messages in work:
        try:
            reply = llm.chat(messages, temperature=0.7, max_tokens=400)
        except Exception:
            continue
        text = engine.clean_prose(reply.content or "")
        if reply.finish_reason == "length":
            text = engine.trim_to_sentence(text)   # a cut biography ends on a sentence
        with db.get_conn() as conn:
            c = repo.get_character(conn, cid)
            # only ever upgrade: never downgrade a richer origin (idempotent, race-safe)
            if c and text and len(text) > len((c["origin"] or "").strip()):
                repo.set_character_origin(conn, cid, text)


def _history(conn, session_id: str) -> list[dict]:
    row = conn.execute("SELECT history FROM creator_sessions WHERE id=?", (session_id,)).fetchone()
    return db.loads(row["history"], []) if row else []


def _save(conn, session_id: str, history: list[dict]) -> None:
    conn.execute(
        "INSERT INTO creator_sessions (id, history, updated_at) VALUES (?,?,datetime('now')) "
        "ON CONFLICT(id) DO UPDATE SET history=excluded.history, updated_at=excluded.updated_at",
        (session_id, json.dumps(history)))


def message(session_id: str, user_message: str) -> dict:
    with db.get_conn() as conn:
        history = _history(conn, session_id)
    reply = llm.chat(
        prompts.build_creator_messages(history, user_message),
        temperature=0.8,
        max_tokens=400,
    )
    # Sanitize BEFORE storing or returning (static-confirmed: this path shipped raw model
    # content): a leaked think-span or tool-call line would otherwise reach the player AND
    # persist in the session history, re-fed to the model on every later creator turn.
    # Readiness reads the RAW reply first: clean_prose would eat a lone "[ready]" line
    # (it looks like a JSON line), and the marker must never reach the display anyway.
    raw = parsing._strip_think(reply.content or "")
    ready = is_ready(raw)
    text = engine.clean_prose(_READY_MARK.sub("", raw)).strip()
    history.append({"role": "user", "content": user_message})
    # The marker is RE-APPENDED to the stored copy (live: the model said "when YOU are
    # ready" - no prose signal - so a refresh lost the unlocked button; the stored
    # marker is the durable truth, stripped again at every display edge).
    history.append({"role": "assistant", "content": text + ("\n[ready]" if ready else "")})
    with db.get_conn() as conn:
        _save(conn, session_id, history)
    return {"reply": text, "ready": ready}


def get_session(conn, session_id: str) -> list[dict] | None:
    row = conn.execute("SELECT history FROM creator_sessions WHERE id=?", (session_id,)).fetchone()
    return db.loads(row["history"], []) if row else None


def _seed_sheet_extras(conn, gid: str, sheet: WorldSheet) -> None:
    """Make the sheet's opening fiction TRUE in state at creation (live 2026-06-11: the
    creator's opening prose put a sealed ledger in the player's satchel and quested about
    it, but the inventory started empty and the narrator never managed to reify it; and
    the clock sat at its default morning while the established fiction was a rainy
    evening). Validated-tool doctrine: the sheet declares, code seeds."""
    for it in sheet.player_items:
        repo.add_item(conn, gid, it.name, it.description)
    # The opening scene's furniture, seeded REVEALED (hidden=False) so the player sees it
    # and the deterministic take/move routers work from turn one (Anna has no native
    # function-calling, so the narrator can't be relied on to furnish the room). current_scene
    # is the start_location here; same repo calls the add_scene_item/add_exit tools use.
    for si in sheet.scene_items:
        repo.add_scene_item(conn, gid, si.name, si.description, False,
                            settings.SCENE_INVENTORY_CAP, si.fixed)
    for ex in sheet.exits:
        repo.add_exit(conn, gid, ex.label, ex.target, settings.SCENE_EXIT_CAP)
    minutes = repo.start_minutes(sheet.start_time_of_day)
    if minutes:
        repo.advance_time(conn, gid, minutes)


def finalize(conn, session_id: str) -> str:
    history = _history(conn, session_id)
    if not history:
        raise ValueError("unknown or empty creator session")
    reply = llm.chat(
        prompts.build_finalize_messages(history),
        tools=prompts.FINALIZE_TOOL,
        tool_choice="auto",
        temperature=0.4,
        max_tokens=1200,
    )
    call = next((tc for tc in reply.tool_calls if tc.name == "save_world"), None)
    if not call:
        raise ValueError("creator did not produce a world; keep chatting and try again")
    sheet = WorldSheet(**call.arguments)
    gid = repo.create_game(conn, sheet)
    _seed_sheet_extras(conn, gid, sheet)
    conn.execute("DELETE FROM creator_sessions WHERE id=?", (session_id,))
    return gid


# ---------- one-shot quick creation (no function-calling, never fails) ----------
# Anna has no OpenAI-style tool calls, so the chat finalize (which asks the model to CALL
# save_world) abstains and 409s. quick_create takes ONE sentence and returns a complete,
# seeded, playable game in a single pass: the model emits the WorldSheet as a JSON object
# (json_object output, the word "JSON" must appear for Anna's L1 mode), we parse leniently,
# fill every required piece with a themed default, and if anything at all goes wrong we
# build the world deterministically from the prompt. Creation MUST NOT raise.

# The directive that asks for the WorldSheet as plain JSON (mirrors FINALIZE_TOOL's field
# list and guidance, recast as a JSON request). "JSON" is named outright: Anna's L1
# json_object mode rejects a request whose text never mentions it.
QUICK_DIRECTIVE = (
    "You are a story-designer that turns one short idea into a complete, immediately "
    "playable text-adventure world in a single shot.\n"
    "Reply with ONLY a single JSON object (no prose before or after, no code fences) "
    "describing the world, with exactly these fields:\n"
    '- "title": a short evocative name for the adventure.\n'
    '- "setting": one or two sentences placing the world (where and what).\n'
    '- "tone": a few mood words (e.g. "grim, tense" or "whimsical, bright").\n'
    '- "narrator_persona": voice/style guidance for the narrator.\n'
    '- "opening_scenario": the opening narration shown to the player (a vivid paragraph '
    "that drops them into the scene; PUBLIC, so never name a character's secret here).\n"
    '- "start_location": the name of the place the story opens in.\n'
    '- "player_life": starting hit points, an integer (20 for an ordinary hero).\n'
    '- "characters": an array of 1 to 3 objects, each {"name", "persona" (who they are '
    'and how they behave), "relation" (what they are to the player: stranger, sister, '
    'rival...), "knowledge" (a private fact they hold)}.\n'
    '- "quests": an array of at least one object {"title", "description", "objectives" '
    "(an array of short objective strings)}.\n"
    '- "scene_items": an array of at least one object {"name", "description", "fixed"} - '
    "items already in the opening scene; leave \"fixed\": false on at least one piece of "
    "takeable loot so the player can pick it up from turn one.\n"
    '- "exits": an array of at least one object {"label" (e.g. "the oak door"), "target" '
    '(the place it leads to)} - a way out of the opening scene.\n'
    '- "player_items": an array of 0 to 2 objects {"name", "description"} the player '
    "already carries (only if it fits the idea).\n"
    "Make the world consistent with the player's idea and ready to play right now: real "
    "names, a clear opening, a goal, something to grab, and somewhere to go."
)


def _nonempty(value) -> bool:
    return bool(value) and bool(str(value).strip())


def _coerce_quick_sheet(prompt: str, data: dict) -> WorldSheet:
    """Turn whatever the model returned (or {}) into a WorldSheet that is ALWAYS playable:
    every required piece is filled from the data when present and from a themed default
    otherwise, so the result has a title, an opening, a start location, and at least one
    character, one takeable scene item, one exit and one quest."""
    data = data if isinstance(data, dict) else {}
    theme = (prompt or "").strip() or "a surprising new world"
    short = theme[:60].rstrip(" .,!?") or "the unknown"

    title = data.get("title") if _nonempty(data.get("title")) else f"The Tale of {short}"
    opening = (data.get("opening_scenario")
               if _nonempty(data.get("opening_scenario"))
               else f"The story opens. {theme}. The way ahead is yours to discover.")
    start = data.get("start_location") if _nonempty(data.get("start_location")) else "the opening"

    # characters: keep only well-formed ones; guarantee at least one companion
    chars = []
    for c in (data.get("characters") or []):
        if isinstance(c, dict) and _nonempty(c.get("name")) and _nonempty(c.get("persona")):
            chars.append(c)
    if not chars:
        chars = [{"name": "Companion", "relation": "stranger",
                  "persona": f"A wary stranger drawn into {theme}. Watchful, capable, slow to trust.",
                  "knowledge": "Knows more about this place than they first let on."}]

    # quests: keep well-formed ones; guarantee at least one with an objective
    quests = []
    for q in (data.get("quests") or []):
        if isinstance(q, dict) and _nonempty(q.get("title")):
            quests.append(q)
    if not quests:
        quests = [{"title": f"Into {short}",
                   "description": f"Make your way through {theme}.",
                   "objectives": ["Get your bearings", "Find a way forward"]}]

    # scene_items: keep well-formed ones; guarantee at least one TAKEABLE (fixed=False)
    items = []
    for si in (data.get("scene_items") or []):
        if isinstance(si, dict) and _nonempty(si.get("name")):
            items.append(si)
    if not any(not bool(si.get("fixed")) for si in items):
        items.append({"name": "worn satchel", "fixed": False,
                      "description": "A worn satchel left within reach, waiting to be taken."})

    # exits: keep well-formed ones; guarantee at least one
    exits = []
    for ex in (data.get("exits") or []):
        if isinstance(ex, dict) and _nonempty(ex.get("label")) and _nonempty(ex.get("target")):
            exits.append(ex)
    if not exits:
        exits = [{"label": "the way onward", "target": "beyond"}]

    # player_items are optional; pass through only well-formed entries
    pitems = [pi for pi in (data.get("player_items") or [])
              if isinstance(pi, dict) and _nonempty(pi.get("name"))]

    # Carry the player's RAW prompt into the narrator's PERMANENT context as a constant
    # lore entry. Constant lore rides every narrator turn, so whatever the model did (or
    # did not) structure, the adventure stays true to the words the player typed and never
    # drifts genre - "asked cyberpunk, got medieval" can't happen. Kept even on a fully
    # model-shaped world, so the exact premise keeps anchoring the story as it continues.
    lore = []
    if theme and prompt and prompt.strip():
        lore.append({"keys": ["premise", "theme", "story"], "constant": True,
                     "content": (f'The player asked for this adventure in their own words: '
                                 f'"{prompt.strip()}". Honor this premise in every scene, '
                                 f'character, item and event; keep the genre, setting and tone '
                                 f'true to it and never drift into a different kind of story.')})
    for lo in (data.get("lore") or []):
        if isinstance(lo, dict) and _nonempty(lo.get("content")):
            lore.append(lo)

    return WorldSheet(
        title=title,
        setting=data.get("setting") or theme,
        tone=data.get("tone") or "",
        narrator_persona=data.get("narrator_persona") or "",
        opening_scenario=opening,
        start_location=start,
        player_life=data.get("player_life") or 20,
        characters=chars,
        quests=quests,
        scene_items=items,
        exits=exits,
        player_items=pitems,
        lore=lore,
    )


def quick_create(conn, prompt: str) -> str:
    """One sentence -> a complete, seeded, playable game in a single pass. The model
    returns the WorldSheet as JSON (not a tool call - Anna has no function-calling); we
    parse leniently, fill every required piece with a themed default, and fall back to a
    fully deterministic world if the call raises or yields nothing usable. NEVER raises."""
    data: dict = {}
    try:
        reply = llm.chat(
            [{"role": "system", "content": QUICK_DIRECTIVE},
             {"role": "user", "content": (prompt or "").strip()
              or "Surprise me with a complete original adventure."}],
            temperature=0.8,
            max_tokens=0,                       # uncapped: the prompt governs length
            response_format={"type": "json_object"},
        )
        parsed = _loads_lenient(reply.content or "")
        data = parsed if isinstance(parsed, dict) else {}
    except Exception:
        data = {}                               # any failure -> the deterministic fallback
    # _coerce_quick_sheet backfills every required piece, so an empty data dict here still
    # yields a fully playable themed world built from the prompt.
    sheet = _coerce_quick_sheet(prompt, data)
    gid = repo.create_game(conn, sheet)
    _seed_sheet_extras(conn, gid, sheet)
    return gid
