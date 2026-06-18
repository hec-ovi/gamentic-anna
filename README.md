# 🎲 Gamentic on Anna

> Describe a world in one sentence, then **play it** turn by turn: a live narrator, characters you talk and whisper to, an inventory you loot and gift, scene changes, new characters on the fly, quests, and generated art. It runs **natively as an Anna App**. No GPU, no third-party bridge, no bundled model: the engine reverse-RPCs Anna's own host for every token and every image.

## 🏆 Hackathon submission

Anna AI-Native App Hackathon. This is a working app that runs on Anna (an Anna **App** + a published **Executa**), not a future integration plan.

| | |
|---|---|
| **What** | A complete AI dungeon master: create a world, then play an illustrated text RPG with a narrator and characters that remember you. |
| **Who it's for** | Anyone on Anna who wants a rich, replayable AI RPG (one sentence in, a world out). For builders: a clean pattern for running a real FastAPI app natively on Anna. |
| **How AI is used** | The narrator, every character (each its own agent with private memory), the world-creator, the free-text interpreter, and the art director are all Anna-host LLM calls. Anna also generates the scene art, portraits and item cards. |
| **How it connects to Anna** | The UI is an Anna iframe; the engine is an Executa it calls over `anna.tools.invoke`. The Executa reverse-RPCs the host for `sampling/createMessage` (text) and `image/generate` (images). Anna owns the model, billing and quota. |

## ✨ What works (all live, inside the Anna iframe)

| Area | Capability |
|---|---|
| 🌍 **Create** | A whole adventure from one sentence (world, cast, scene, items, exits, quests, opening art). |
| 📖 **Play** | Narration + dialogue per turn; freeform typing is interpreted into directed actions. |
| 🗣️ **Talk** | Per-character chat and private **whispers** (1:1, never leaked to the room). |
| 🎒 **Inventory** | Take items from a scene, give items to characters; deterministic, model-independent. |
| 🚪 **World** | Scene transitions, new characters spawned on the fly, exits revealed as you explore. |
| 🖼️ **Art** | Scene images, character portraits, item cards, and on-demand "look" images, inlined into the iframe. |
| 🧠 **Memory** | Each character keeps a private rolling memory; the story keeps a recap, so context stays bounded. |

**Why it's robust:** the core mechanics (movement, take, give, dialogue cueing, world seeding) are **deterministic engine-side**, so gameplay holds up even on models that won't reliably emit tool calls. The LLM shapes the story; the engine guarantees the rules.

## 🏗️ Architecture (one glance)

```
Anna copilot
  -> iframe UI  --(anna.tools.invoke)-->  Executa  --(in-process ASGI)-->  FastAPI engine
                                             \__(reverse-RPC: sampling + image)__> Anna host
                                                                                (your selected model)
```

One container. The original Gamentic engine and UI are kept intact; only the comms layers swap to Anna's own.

- **Backend** (`backend/app/executa.py`): the FastAPI engine wrapped as a stdio Executa. Each invoke replays an HTTP-style call against the in-process app (httpx ASGI transport), so every route, its validation and its behavior are exactly what uvicorn serves.
- **Reverse-RPC** (`backend/app/hostbridge.py`): for text and images the engine calls the Anna host directly (`sampling/createMessage`, `image/generate`) via the vendored `executa_sdk`. Transient host hiccups are retried; renders run inside the invoke (Anna's image token is invoke-scoped).
- **Tool calls** (`backend/app/llm.py`): Anna sampling has no OpenAI-style function calling but does structured JSON, so the engine asks for a `{prose, tool_calls}` envelope and parses it back with a tolerant local repair (no network round-trip).
- **Frontend** (`frontend/src/app/anna.js`): the UI runs in Anna's sandboxed iframe and routes through the injected transport; standalone dev falls back to `fetch`. Renderers and controllers are unchanged.
- **Storage**: embedded SQLite plus per-game generated images, on a Docker volume. Voice is off (Anna has no TTS).

## 📦 Run it

One container runs `anna-app dev` (Anna's own dev runtime): it serves the iframe and spawns the Executa.

```sh
docker compose up -d --build
docker exec -it gamentic-anna anna-app login --host https://anna.partners --no-browser   # device-code, once
```

Then open **http://localhost:5180** and play. Full teardown (login + saved games): `docker compose down -v`.

> 🔑 **Pick a model.** Anna serves whatever model your account selects (LLM / Model Selection). Self-hosted models see more gateway (502) hiccups and ship smaller context; a Pro-tier (OpenRouter-backed) model gives steadier responses, better quality, and far more context for long adventures.

## 🗂️ Layout

```
backend/
  app/executa.py     the Anna Executa: stdio JSON-RPC + reverse-RPC to the host
  app/hostbridge.py  the sync engine -> host bridge (sampling, image), invoke-scoped
  app/llm.py         chat(): native sampling + the {prose, tool_calls} envelope
  executa.json       executa descriptor (tool_id, command, host_capabilities)
  executa_sdk/       vendored Anna executa SDK (SamplingClient, ImageClient, ...)
frontend/            Gamentic UI; src/api.js + src/app/anna.js carry the Anna transport
infra/Dockerfile     the single image: node + anna-app + the engine venv
manifest.json        the Anna App manifest (iframe view, required executa, host-API grants)
docker-compose.yml
```

## 🧪 Tests

**569 backend + 232 frontend tests pass.**

```sh
# frontend (vitest + Testing Library, msw, jsdom)
cd frontend && npm install && npm test

# backend (pytest, end-to-end through the real engine + the real Executa stdio/reverse-RPC,
# with host sampling faked only at the boundary)
cd backend && uv pip install --python .venv -r requirements.txt pytest && .venv/bin/python -m pytest
```

`tests/test_executa_native.py` drives a full adventure (create world, scene change, scene item, pickup, give to a character, a character arriving, a whisper) through the live Executa protocol.

## 📝 Notes

- **Token budget:** Anna's executa-side sampling makes `max_tokens` mandatory and caps it at 8192; the engine always passes the maximum and shapes length through the prompt, never a truncating ceiling.
- **Images:** generated images come back as short-lived host URLs; the engine persists each one per game, then the Executa inlines it to the iframe as a data URI (the sandboxed iframe cannot fetch arbitrary URLs).
- **Publishing:** the Executa is published to Anna's Executa Hub and referenced by `tool_id`; on install, the user's Anna downloads and runs it. This repo is the dev/run setup for that app.
