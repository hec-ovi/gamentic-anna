# Gamentic Executa

The Gamentic game engine, packaged as an Anna **Tool** Executa. It is the backend half
of the [gamentic-anna](https://github.com/hec-ovi/gamentic-anna) Anna App.

## What it is

A self-contained binary (PyInstaller, no Python required on the host) that runs the
FastAPI game engine as a stdio JSON-RPC Executa. It exposes a single tool, `request`,
which replays an HTTP-style call against the in-process engine.

- **Tool:** `request`, args `{ path, method?, body?, query? }`, returns `{ status, json }`
- **Distribution:** `binary` (linux-x86_64), hosted on GitHub Releases, mirrored to Anna R2 on cut
- **Host capabilities:** `llm.sample` (text), `llm.image` (images)
- **Storage:** embedded SQLite under `EXECUTA_DATA` (per install)

## What the engine does

It drives a turn-based text RPG, all reverse-RPCed through the Anna host (no GPU, no
bundled model, no third-party keys):

- World creation from one sentence (cast, scene, items, exits, quests)
- A live narrator and characters that each keep a private rolling memory
- Private 1:1 whispers, inventory (loot a scene, gift items to characters)
- Scene transitions and new characters spawned on the fly
- Deterministic engine-side mechanics (movement, take, give, dialogue cueing), so play
  holds up even on models that will not reliably emit tool calls

## Build and publish

```sh
cd backend
bash packaging/build-binary.sh 0.2.0   # -> dist/gamentic-executa-<platform>.tar.gz
anna-app executa publish               # mint or update the executa (reads executa.json)
```

See the [repo README](https://github.com/hec-ovi/gamentic-anna#readme) for the full app,
architecture, and run instructions.
