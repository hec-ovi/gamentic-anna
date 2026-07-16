# Gamentic Executa

The Gamentic game engine, packaged as an Anna **Tool** Executa. It is the backend half
of the [gamentic-anna](https://github.com/hec-ovi/gamentic-anna) Anna App.

## What it is

A `uv` distribution: one `py3-none-any` wheel on PyPI (`tool-gamentic-engine-7h8aweky`).
On Install Essentials the user's Agent runs `uv tool install <package>==<version>`, which
fetches a managed CPython plus cross-platform dependency wheels, so there is no
per-platform binary. The console script runs the FastAPI game engine as a stdio JSON-RPC
Executa exposing a single tool, `request`, which replays an HTTP-style call against the
in-process engine.

- **Tool:** `request`, args `{ path, method?, body?, query? }`, returns `{ status, json }`
- **Distribution:** `uv` (PyPI wheel; `backend/pyproject.toml` is the build)
- **Host capabilities:** `llm.sample` + `llm.agent.auto` (text), `llm.image` (images),
  `host.upload` (reference-image uploads)
- **Storage:** embedded SQLite under `EXECUTA_DATA` (per install)

## What the engine does

It drives a turn-based text RPG, all reverse-RPCed through the Anna host (no GPU, no
bundled model, no third-party keys):

- World creation from one sentence (cast, scene, items, exits, quests)
- A live narrator and characters that each keep a private rolling memory
- Private 1:1 whispers, inventory (loot a scene, gift items to characters)
- Scene transitions and new characters spawned on the fly
- Background art: scene images, 3-view character portraits, item cards and look shots,
  rendered detached (never inside an invoke) and served to the iframe via `/media64`
- Deterministic engine-side mechanics (movement, take, give, dialogue cueing), so play
  holds up even on models that will not reliably emit tool calls

## Build and publish

```sh
cd backend
uv build                     # -> dist/tool_gamentic_engine_7h8aweky-<version>-py3-none-any.whl
# upload to PyPI, then:
anna-app executa publish     # mint or update the executa (reads executa.json)
```

Keep `[project].version` (pyproject), `VERSION` (app/executa.py) and the manifests in
lockstep. `backend/packaging/build-binary.sh` is the legacy PyInstaller path, kept only
for reference.

See the [repo README](https://github.com/hec-ovi/gamentic-anna#readme) for the full app,
architecture, and run instructions.
