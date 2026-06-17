# Gamentic on Anna

Gamentic is an AI driven text adventure: you create a world, then play it turn by
turn with a narrator, characters you can talk to (and whisper to), an inventory,
scenes, quests, and generated scene art. This repo runs the whole thing as a
**native Anna App**: the model and images come from Anna's own host, with nothing
of ours in between. No GPU.

## The hackathon goal

Run Gamentic on Anna's stack natively. A user who already has Anna installed
installs this app and it just works, using only Anna's runtime, an executa, and an
iframe UI. There is **no third-party bridge and no bundled model server**: the
executa asks the Anna host directly for LLM text and images, and Anna owns model
selection, billing and quota. The original Gamentic engine and UI are kept intact;
only the communication layers are swapped to Anna's own.

## How it works

- **Backend**: the Gamentic engine (FastAPI) is wrapped as an Anna Executa
  (`backend/app/executa.py`). The iframe invokes it over `anna.tools.invoke`; the
  executa replays each call against the in-process app (httpx ASGI transport), so
  the engine code is unchanged. For text and images the engine reverse-RPCs the
  Anna host (`sampling/createMessage`, `image/generate`) through
  `backend/app/hostbridge.py`, using the vendored `executa_sdk`.
- **Tool calls**: Anna sampling has no OpenAI style function calling, but it does
  structured JSON output. So when the engine offers tools, `llm.chat` asks the
  model for a `{prose, tool_calls}` envelope and parses it back into the same
  reply the engine already expects (`backend/app/llm.py`). No external repair
  service.
- **Frontend**: the Gamentic UI runs in Anna's sandboxed iframe.
  `frontend/src/api.js` routes through the injected Anna transport when present and
  falls back to `fetch` for standalone dev. Renderers and controllers are untouched.
- **Storage**: game state is embedded SQLite, kept on a Docker volume. Voice is off.

## Run it

One container runs `anna-app dev` (Anna's own dev runtime), which serves the
Gamentic iframe and spawns the Gamentic executa. Nothing of ours bridges anything.

```sh
docker compose up -d --build
docker exec -it gamentic-anna anna-app login --host https://anna.partners --no-browser
# complete the device-code once; the token persists on the anna-cred volume
```

Then play at http://localhost:5180. Full teardown (including the login and saved
games): `docker compose down -v`.

## Layout

```
backend/
  app/executa.py     the Anna Executa: stdio JSON-RPC + reverse-RPC to the Anna host
  app/hostbridge.py  the sync engine -> host reverse-RPC bridge (sampling, image)
  app/llm.py         chat(): native sampling + the {prose, tool_calls} envelope
  executa.json       executa descriptor (tool_id, command, host_capabilities)
  executa_sdk/       vendored Anna executa SDK (SamplingClient, ImageClient, ...)
frontend/            Gamentic UI; src/api.js + src/app/anna.js carry the Anna transport
infra/Dockerfile     the single image: node + anna-app + the engine venv
manifest.json        the Anna App manifest (iframe view, required executa, host API ACL)
docker-compose.yml
```

## Tests

- **Frontend** (vitest + Testing Library, msw, jsdom):
  ```sh
  cd frontend && npm install && npm test
  ```
- **Backend** (pytest, end to end against the real engine and the real Executa
  stdio + reverse-RPC, with the host sampling faked at the boundary):
  ```sh
  cd backend && uv pip install --python .venv -r requirements.txt pytest
  .venv/bin/python -m pytest
  ```
  `tests/test_executa_native.py` drives a full adventure (create world, scene
  change, scene item, pickup, give to a character, a character arriving, a whisper)
  through the live Executa protocol.

## Notes

- Anna's executa-side sampling caps each call at 8192 tokens and allows a limited
  number of model calls per invoke, so a turn keeps within that budget.
- Generated images come back as short lived host URLs; the engine downloads and
  persists each one per game, then the executa inlines it to the iframe as a data
  URI (the sandboxed iframe cannot fetch arbitrary URLs).
- Publishing: the executa is published to Anna's Executa Hub and referenced by the
  app by `tool_id`; on install, the user's Anna downloads and runs it. This repo is
  the dev/run setup for that app.
