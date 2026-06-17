# Gamentic on Anna

Gamentic is an AI driven text adventure: you create a world, then play it turn by
turn with a narrator, characters you can talk to (and whisper to), an inventory,
scenes, and quests. This repo runs the whole thing as a real Anna App, inside a
single Docker container, with Anna's own agent providing the text and the images.
No GPU.

## How it works

The original Gamentic is a Python engine plus a vanilla JS web UI. Both are kept
intact here. Only the communication layers are swapped so it lives inside Anna:

- **Backend**: the Gamentic engine (FastAPI) is wrapped as an Anna Executa
  (`backend/app/executa.py`). The UI calls it over `anna.tools.invoke` instead of
  HTTP; a thin stdio bridge replays each call against the in-process app, so the
  engine code is unchanged.
- **Frontend**: the Gamentic UI runs in Anna's sandboxed iframe.
  `frontend/src/api.js` routes through the injected Anna transport when it is
  present, and falls back to `fetch` for standalone dev. Renderers and controllers
  are untouched. The layout adapts to the small Anna window.
- **LLM and images**: the engine calls an OpenAI compatible endpoint
  (`infra/anna-api`) that translates to the Anna agent's copilot. Text comes from
  Anna; images use the experimental copilot image path. Voice is off.

Game state persists in embedded SQLite on a Docker volume.

## Run it

One container holds the whole Anna environment, with three processes under
supervisord:

| port | process | role |
| --- | --- | --- |
| 19001 | the Anna agent | the backend, plus its one time sign in UI |
| 9100 | anna-api | OpenAI to copilot bridge (internal) |
| 5180 | anna-app dev | the Anna app runner: Gamentic iframe + the engine Executa |

```sh
docker compose up -d --build
```

Then sign in to your Anna account once at http://localhost:19001 (it persists on
the `anna-data` volume), and play at http://localhost:5180.

- Manage the processes: `docker exec gamentic-anna supervisorctl status`
- Full teardown, including the sign in and saved games: `docker compose down -v`

### Config

Copy `.env.example` to `.env` to override the defaults (host port, the image path,
optional headless sign in). The defaults work out of the box.

## Layout

```
backend/        Gamentic engine (FastAPI) + app/executa.py (the Anna Executa) + executa.json
frontend/       Gamentic UI; src/api.js + src/app/anna.js carry the Anna transport
infra/
  Dockerfile        the single image: Anna agent + bridge + engine + UI runner
  supervisord.conf  runs the three processes
  anna-api/         OpenAI compatible face over the Anna copilot
manifest.json   the Anna App manifest (iframe view, required executa, host API ACL)
docker-compose.yml
```

## Tests

- **Frontend** (vitest + Testing Library, msw, jsdom):
  ```sh
  cd frontend && npm install && npm test
  ```
- **Backend** (pytest, end to end against the real engine):
  ```sh
  cd backend && uv pip install --python .venv -r requirements.txt pytest
  .venv/bin/python -m pytest
  ```

## Notes

- The image base must be Debian trixie (`node:22-trixie-slim`). The Anna agent is a
  PyInstaller binary linked against glibc 2.38, so older bases (bookworm, glibc
  2.36) crash on load.
- The Anna copilot is a chat assistant, not a native function caller, so the bridge
  repairs slightly malformed tool call JSON (`infra/anna-api/app/wire.py`) and
  biases the prompt toward emitting the call. Without it, world creation fails.
