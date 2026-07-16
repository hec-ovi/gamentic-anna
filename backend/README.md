# The game engine (backend)

FastAPI service that runs the game: narrator + per-character agents + story-creator,
with game state in SQLite. Plain REST, sequential turns. No agent framework, no
streaming. The model only proposes state changes through tools; the DB is the source
of truth. The game is fully playable text-only; images are an accessory.

On Anna it does not run as an HTTP server: `app/executa.py` wraps the same app as a
stdio JSON-RPC Executa (published to PyPI as `tool-gamentic-engine-7h8aweky`, see
`../docs/RELEASE.md`), and all LLM/image traffic reverse-RPCs the Anna host through
`app/hostbridge.py`.

Code map: `INDEX.md` (resolver-style: find the thing, open one small file).

## Prompts

All prose lives in `prompts/*.md` and is reloaded on every call, so you can edit and
review prompts without touching code or restarting. The core stacks: `narrator.system.md`
+ `narrator.user.md` (plus conditional blocks injected only on the turns that trigger
them), `narrator.resolve.md` + `.user.md`, `character.system.md` + `.user.md`,
`interpret.*` (typed-input parser), `summary.*` and `charsummary.*` (rolling recap
folds), `imageprompt.*` (optional agentic image prompts), `explain.*`,
`creator.system.md`, `finalize.*`. The dispatch table lives in `INDEX.md`.

## Test

```bash
cd backend
uv venv && uv pip install -e . pytest
.venv/bin/python -m pytest
```

The suite is deterministic (host sampling faked at the boundary, real routes + real
SQLite). It covers the turn loop, every tool, adjudication, memory (witnessed windows,
recaps, privacy), media glue and self-heal, game-over, export/import, the story-creator,
and the live Executa protocol end to end (`tests/test_executa_native.py`).

## Settings

Every knob lives in `app/config.py` with comments and env overrides. The published
executa runs on the defaults (it receives no env); anything player-facing, like the
images switch, is a stored setting exposed through the API instead.
