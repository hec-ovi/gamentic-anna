# 🎲 Gamentic on Anna

Describe a world in one sentence, then **play it** turn by turn: a live narrator, characters you talk and whisper to, an inventory you loot and gift, scene changes, new characters on the fly, quests, and generated art (scenes, portraits, item cards, look shots). It runs **natively as an Anna App**, with no GPU, no third-party bridge, and no bundled model: the engine reverse-RPCs Anna's own host for every token and every image.

> 🖼️ **How images stay off the hot path.** A render takes 35-90s, so none ever runs inside a tool invoke (the manifest raises the per-invoke timeout to 600s, and renders run detached anyway). They render up to two at a time, player-triggered looks get their own lane, an in-flight claim registry stops the self-heal from rendering the same asset twice, and a failing asset stops retrying after `IMAGE_HEAL_MAX_ATTEMPTS` passes (counted in the DB, so restarts don't reopen the loop). Anna's image quota is a rolling per-invoke window, so creation spends it on what shows first (the scene, then one face per character) and pauses instead of burning attempts when the window is spent; the UI says why art is waiting. The iframe pulls finished images in batches through `/media64/batch` (downscaled data URIs, disk-cached across restarts) instead of one host round-trip each.

## 📸 Screenshots

<p align="center">
  <img src="media/screenshot-4.png" width="49%" alt="Play a scene with a living cast that talks and remembers" />
  <img src="media/screenshot-6.png" width="49%" alt="Every character has a profile, private memory and 1:1 whispers" />
</p>

<p align="center"><em>A turn in play (scene, narration, party) and a character's profile + whisper channel.</em></p>

## 🎮 Play it on Anna

> 🧩 **Before anything else:** install the **Anna local Agent** and keep it running ([download it here](https://anna.partners/download)). The game engine runs on your Agent. The browser has no runtime of its own.

Then three steps, in order:

#### 📦 1. Install the app
Open **More**, go to the **App Store**, find **gamentic-anna**, and hit **Install**.

#### 🔑 2. Let it use the model
Open **More**, then **Advanced**, then **Executas**, then **Learned**. Pick **Gamentic**, open its **Permissions**, and switch **LLM Sampling** on. Art needs its own grants in the same panel: switch the image-generation and file-upload permissions on too (uploads carry the identity references that keep characters consistent across renders).

#### 🚀 3. Bring the engine online
Open **More**, then **Agents**. On your Agent, click **Install Essentials**. Open **Details** and wait until **Gamentic** reads **Running**.

> 💡 **Don't skip step 2.** LLM Sampling is what lets the engine reach the model on every turn. Without it you only get placeholder text instead of real AI.

🎲 That's it. Open the app and play.

<sub>Under the hood: Install Essentials runs `uv tool install tool-gamentic-engine-7h8aweky` from PyPI, no per-platform binary. A single `py3-none-any` wheel covers macOS, Linux and Windows (verified end to end on Linux so far).</sub>

## 🏆 Hackathon submission

Anna AI-Native App Hackathon. A working app running on Anna today: an Anna **App** plus an **Executa**.

| | |
|---|---|
| **What** | A complete AI dungeon master: describe a world, then play a text RPG with a narrator and characters that remember you. |
| **Who it's for** | Anyone on Anna who wants a rich, replayable AI RPG (one sentence in, a world out). For builders: a clean pattern for running a full FastAPI app natively on Anna. |
| **How AI is used** | The narrator, every character (each its own agent with private memory), the world-creator, and the free-text interpreter are all Anna-host LLM calls. Image generation goes the same way (Anna's `image/generate`), with identity references uploaded via `host/uploadFile`. |
| **How it connects to Anna** | The UI is an Anna iframe; the engine is an Executa it calls over `anna.tools.invoke`. The Executa reverse-RPCs the host for `sampling/createMessage` (text) and `image/generate` (images). Anna owns the model, billing and quota. |

## ✨ What works (live, inside the Anna iframe)

| Area | Capability |
|---|---|
| 🌍 **Create** | A whole adventure from one sentence (world, cast, scene, items, exits, quests). |
| 📖 **Play** | Narration + dialogue per turn; freeform typing is interpreted into directed actions. |
| 🗣️ **Talk** | Per-character chat and private **whispers** (1:1, never shown to anyone else). |
| 🎒 **Inventory** | Take items from a scene, give items to characters; deterministic, model-independent. |
| 🚪 **World** | Scene transitions, new characters spawned on the fly, exits revealed as you explore. |
| 🧠 **Memory** | Each character keeps a private rolling memory; the story keeps a recap, so context stays bounded. |
| 🖼️ **Art** | Scene images, character portraits (3-view reference sets), item unlock cards and look shots via Anna's image host, rendered in the background and slotted in as they land. A library switch turns images off per install (painted art stays). |
| 📤 **Share** | Export any adventure as JSON (a fresh-start template or a full checkpoint) and import it anywhere; inside Anna it copies through a modal, since the sandbox blocks downloads. |

**Why it's robust:** the core mechanics (movement, take, give, dialogue cueing, world seeding) are **deterministic engine-side**, so gameplay holds up even on models that won't reliably emit tool calls. The model writes the prose and dialogue; the rules (what's possible, what each action does) are enforced in code.

### What's trimmed on Anna (and why)

The Anna build hides what cannot pay off there:

| Trimmed | Why |
|---|---|
| 🔍 **Look / Search** | Follow the images switch (the library toggle, `IMAGE_ENABLED` env as default): a look turn's payoff is the render, so the composer mode, the scene action bar and the character panel only offer them while images are on. |
| 🔊 **Voice / speaker icon** | Anna has no host TTS, so the per-line speak button would never play. Hidden in Anna mode. |
| 🎁 **Give** | Handing an item to a character closes the popups and drops you back on the main screen, rather than opening their whisper thread. |

Resume is resilient to the agent runtime recycling the executa: idempotent reads (state, beats, library) retry a few times before surfacing an error, so re-opening an adventure no longer bounces you to the menu when the executa cycles mid-open.

## 🏗️ Architecture (one glance)

```
┌─────────────────────────────────────────────┐
│  Anna copilot                               │
│  browser UI, renders the sandboxed iframe   │
└──────────────────────┬──────────────────────┘
                       │  anna.tools.invoke
                       ▼
┌─────────────────────────────────────────────┐
│  Executa  (stdio JSON-RPC)                  │
│  runs the FastAPI engine in-process (ASGI)  │
└──────────────────────┬──────────────────────┘
                       │  reverse-RPC: sampling + image
                       ▼
┌─────────────────────────────────────────────┐
│  Anna host                                  │
│  your selected model: tokens and images     │
└─────────────────────────────────────────────┘
```

Top to bottom is the call path: the iframe UI invokes the Executa, which runs the engine in-process, which reverse-RPCs the Anna host for every token (and image). The original Gamentic engine and UI are kept intact, only the comms layers swap to Anna's own.

- **Backend** (`backend/app/executa.py`): the FastAPI engine wrapped as a stdio Executa. Each invoke replays an HTTP-style call against the in-process app (httpx ASGI transport), so every route, its validation and its behavior are exactly what uvicorn serves.
- **Reverse-RPC** (`backend/app/hostbridge.py`): for text, images and reference uploads the engine calls the Anna host directly (`sampling/createMessage`, `image/generate`, `host/uploadFile`) via the vendored `executa_sdk`, with bounded retries on transient gateway errors.
- **Non-blocking jobs** (`backend/app/main.py`, `backend/app/integrate/jobs.py`): renders, summary folds and origin enrichment run on a detached pool, never on the request thread. Renders take two lanes (ambient width `IMAGE_CONCURRENCY`, player looks on their own), an in-flight claim registry keeps the per-turn self-heal from double-rendering, per-asset attempt ceilings persist in the DB (a restart cannot reopen a failing render's loop), and a spent image-quota window pauses ambient renders instead of burning attempts. The frontend polls `/state` and `/beats` to pick up results.
- **Media delivery**: every image persists under `/media/<game>/` and replies carry only that small ref; the sandboxed iframe resolves refs in batches through `POST /media64/batch` (downscaled data URIs, cached on disk server-side and in a Map browser-side), one host round-trip per dozen images instead of per image.
- **Tool calls** (`backend/app/llm.py`): Anna sampling has no OpenAI-style function calling but does structured JSON, so the engine asks for a `{prose, tool_calls}` envelope and parses it back with a tolerant local repair (no network round-trip).
- **Frontend** (`frontend/src/app/anna.js`): the UI runs in Anna's sandboxed iframe and routes through the injected transport; standalone dev falls back to `fetch`.
- **Storage**: embedded SQLite under the Agent-provided `EXECUTA_DATA` dir, one per install. Voice is off (Anna has no TTS).

## 🚢 Develop and ship

There is no local preview. **Two artifacts ship, kept at one version in lockstep:**

- **The Executa** (the game engine). A Python package, `tool-gamentic-engine-7h8aweky`, published to PyPI as one `py3-none-any` wheel (`backend/pyproject.toml` builds it), then registered on Anna's Executa Hub via `backend/executa.json` (identity pinned to `executa_id=1025` in `backend/.anna/executa.json`). On Install Essentials the Agent runs `uv tool install <package>==<version>` from PyPI, so the wheel must be published at that version FIRST.
- **The App** (the runtime the player sees). The `frontend/` static SPA plus `manifest.publish.json`, pushed and cut on Anna (`app_id=19`, slug `gamentic-anna`).

Bump the version everywhere, run the tests, build the wheel and `uv publish` it to PyPI, `executa publish`, then `apps push` / `cut` / `release`, and play it through your local Agent. The full checklist (exact commands, the auth PAT, dry-runs) is [docs/RELEASE.md](docs/RELEASE.md); running the Agent in Docker is [anna-agent/README.md](anna-agent/README.md).

> 📚 **Anna platform docs.** The full platform reference the backend is built against: [anna.partners/llms-full.txt](https://anna.partners/llms-full.txt) (Executas, reverse-RPC sampling, agent sessions, storage, App manifests, the App Host API). Two hands-on companion guides sit in the repo: [anna-app.md](anna-app.md) (build and push an Anna App end to end) and [executa-release-binary.md](executa-release-binary.md) (package an Executa as a multi-platform binary; gamentic ships the simpler uv/PyPI wheel instead of per-platform binaries).

> 🔑 **Pick a model.** Anna serves whatever model your account selects (LLM / Model Selection). Self-hosted models see more gateway (502) hiccups and ship smaller context; a Pro-tier (OpenRouter-backed) model gives steadier responses and far more context.

## 🗂️ Layout

```
backend/
  app/executa.py         the Anna Executa: stdio JSON-RPC + reverse-RPC to the host
  app/hostbridge.py      the sync engine -> host bridge (sampling, image, upload)
  app/main.py            the FastAPI engine + the detached post-response job pool
  app/llm.py             chat(): native sampling + the {prose, tool_calls} envelope
  executa.json           executa descriptor (tool_id, command, host_capabilities)
  executa_sdk/           vendored Anna executa SDK (SamplingClient, ImageClient, ...)
frontend/                Gamentic UI; src/api.js + src/app/anna.js carry the Anna transport
manifest.publish.json    the Anna App manifest (iframe view, required executa, host-API grants)
executa-manifest.json    the describe manifest pasted into the Anna console
anna-agent/              Docker setup for the Anna local Agent (the executa runtime)
docs/RELEASE.md          the ship-a-release checklist
docs/about-cloud-agent.md       Anna's Cloud Agent notes (what changes for executas, APS transfer)
docs/anna-beta55-96-changelog.md  the Anna 1.1.0-beta.55..96 release digest (fal.ai wave, cloud agent)
```

## 🧪 Tests

**615 backend + 262 frontend tests pass.**

```sh
# frontend (vitest + Testing Library, msw, jsdom)
cd frontend && npm install && npm test

# backend (pytest, end-to-end through the real engine + the real Executa stdio/reverse-RPC,
# with host sampling faked only at the boundary)
cd backend && uv venv && uv pip install -e . pytest && .venv/bin/python -m pytest
```

`tests/test_executa_native.py` drives a full adventure (create world, scene change, scene item, pickup, give to a character, a character arriving, a whisper) through the live Executa protocol.

## 📝 Notes

- **Keep slow work off the invoke.** The manifest raises the per-invoke timeout to 600s, but the reverse-RPC token dies about 600s after its invoke too, so anything slow (renders above all) runs detached and concurrently; the per-turn self-heal picks up whatever a dead token dropped.
- **Token budget:** Anna's executa-side sampling makes `max_tokens` mandatory and caps it at 8192; the engine always passes the maximum and shapes length through the prompt, never a truncating ceiling.
- **Images:** generated images come back as short-lived host URLs (~30 min); the engine persists each per game under `/media`, and the iframe pulls them in batches via `/media64` (see Architecture). Identity references (a character's stored view) upload to the host via `host/uploadFile` because the host can only fetch references over HTTPS. Anna's image quota is a rolling per-invoke window (default ~4 images per 30 min), which is why creation renders the scene and faces first and lets the per-turn heal finish the rest.
- **Publishing:** the Executa is published to Anna's Executa Hub and referenced by `tool_id`; on Install Essentials the user's Agent runs `uv tool install <package>==<version>` from **PyPI** (`backend/pyproject.toml` builds the wheel; one `py3-none-any` artifact plus uv-resolved dependency wheels cover every platform). A wheel URL does not work here because the Agent always appends `==<version>`, which only a package name (not a URL) resolves. Release checklist: [docs/RELEASE.md](docs/RELEASE.md).
