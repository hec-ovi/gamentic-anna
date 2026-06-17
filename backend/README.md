# Orchestrator (the game brain)

FastAPI service that runs the game: narrator + per-character agents + story-creator, all on one local model (different contexts), with game state in SQLite. Plain REST, sequential turns. No agent framework, no streaming. The model only proposes state changes through tools; the DB is the source of truth.

Contracts: `docs/shared/specs.md` (founding spec) and `docs/frontend/frontend-api.md` (canonical FE contract). The image/voice services are optional accessories: the game is fully playable text-only. Code map: `INDEX.md` here (resolver-style: find the thing, open one small file).

## Layout

```
orchestrator/
  app/
    main.py       # FastAPI routes
    engine/       # package: the turn loop (narrator -> tools -> cued characters), parsing, folds
    prompts.py    # loads the markdown templates, builds every message stack
    tools/        # package: game tool schemas + handlers side by side, validated dispatch
    repo/         # package: SQLite data access, one module per domain
    integrate/    # package: media glue, one module per concern (voice, image prompts, storage, render jobs)
    transfer.py   # adventure export/import (template + checkpoint)
    creator.py    # story-creator sessions
    db.py         # schema + additive migrations + connection
    llm.py        # llama.cpp OpenAI-compatible client (one retry on dropped connections)
    models.py     # request/response shapes
    config.py     # env-driven settings
  prompts/        # EDITABLE markdown prompt templates ({{placeholders}}), loaded fresh each call
  tests/          # deterministic (LLM faked) + live (real model, auto-skipped if unreachable)
```

## Prompts

All prose lives in `prompts/*.md` and is reloaded on every call, so you can edit and review prompts without touching code or restarting. The core stacks: `narrator.system.md` + `narrator.user.md` (plus conditional blocks injected only on the turns that trigger them: `narrator.newplace.md`, `narrator.returning.md`, `narrator.looking.md`, `narrator.easy.md` / `narrator.hard.md`, `narrator.attempts.md`), `narrator.resolve.md` + `.user.md` (the no-dead-air follow-up pass), `character.system.md` + `.user.md`, `interpret.*` (typed-input parser), `summary.*` (the narrator's rolling recap fold), `charsummary.*` (each character's private memory fold), `imageprompt.*` (optional agentic image prompts), `explain.*` (tap-to-explain), `creator.system.md`, `finalize.*`. The dispatch table lives in `INDEX.md`.

## Run (local)

```bash
cd orchestrator
uv venv .venv --python 3.12 && . .venv/bin/activate
uv pip install -r requirements.txt
# point at the text model (default http://localhost:8080/v1)
export LLM_BASE_URL=http://localhost:8080/v1
uvicorn app.main:app --host 0.0.0.0 --port 8000
```

Or in the compose group: `docker compose up -d orchestrator` (talks to `gamentic-llm-text` over the network).

## Test

```bash
. .venv/bin/activate
# deterministic (no GPU, LLM faked at the boundary) - fast, CI-safe
PYTHONPATH=. pytest -q tests/
# live (real model must be up at LLM_BASE_URL; auto-skips otherwise)
PYTHONPATH=. pytest -v -s tests/test_live.py
# play a scripted adventure against the real model and watch tool calls + state deltas per turn
PYTHONPATH=. python scripts/playtest.py --scenario crypt   # or: tavern
```

The deterministic suite exercises the real HTTP routes through tool dispatch to DB side effects (LLM faked). It covers the turn loop, every tool, adjudication, narrator and character memory (witnessed windows, recaps, privacy), media glue and self-heal, game-over, export/import, and the story-creator. The live suite plays real turns against Gemma and asserts the brain stays playable.

## Key env vars

| Var | Default | Note |
|---|---|---|
| `LLM_BASE_URL` | `http://localhost:8080/v1` | llama.cpp endpoint |
| `LLM_MODEL` | `gemma-4-12b-heretic` | model alias |
| `DB_PATH` | `./gamentic.db` | SQLite file |
| `HISTORY_BEATS` | 80 | narrator verbatim window (also a live per-game setting) |
| `SUMMARY_EVERY_TURNS` / `SUMMARY_KEEP_TURNS` | 10 / 8 | narrator recap fold cadence / never-folded newest |
| `CHAR_HISTORY_BEATS` | 30 | a character's verbatim window of beats THEY witnessed |
| `CHAR_SUMMARY_ENABLED` / `CHAR_SUMMARY_EVERY` | true / 12 | per-character private recap fold (witnessed beats) |
| `LORE_BUDGET` | 8 | max lore entries injected |
| `IMAGE_API_URL` / `VOICE_API_URL` | :9001 / :9002 | accessory services (optional) |
| `IMAGE_ENABLED` / `VOICE_ENABLED` | true | set false to run pure text; nothing is scheduled, game unaffected |
| `IMAGE_NARRATOR_COOLDOWN_TURNS` / `IMAGE_MAX_ITEMS_PER_TURN` | 4 / 2 | spontaneous image pacing / item cards per turn |

The full knob list with comments is `app/config.py`; the compose defaults live in `docker-compose.yml` at the repo root.
