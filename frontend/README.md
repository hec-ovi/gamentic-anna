# Gamentic Frontend

Static, vanilla HTML/CSS/JS frontend for the self-hosted AI dungeon RPG. No build step, no framework, ES modules only (`src/app.js` and `src/render.js` are thin facades over the `src/app/` and `src/render/` module folders). Rendering is state -> full HTML string -> DOM MORPH (vendored idiomorph, one 0BSD file in `vendor/`): unchanged nodes keep their identity, so focus, caret, scroll and mid-flight animations survive background re-renders structurally. Events are delegated: five listeners on the root, attached once, independent of rendering. The backend wire contract is `../docs/frontend/frontend-api.md` (internal/private, not part of the public docs).

## The core idea

The screen is a story you read, not an admin panel:

- **Narration** is the storyteller. It renders as flowing literary prose, like a book, with the scene art floated into it as a collection card that reveals once the image is painted.
- **Characters** speak in **dialogue** bubbles, and stand in the scene as tall, wide full-body holders (disposition, HP, what they carry, and an "expand to interact" hint; everything else - who they are, what you can do to them, the whisper channel - lives in their full-screen profile).
- **Player actions** show as a quiet inline marker, not a competing chat bubble.
- **System beats** (damage, items, points, quest changes, rejected attempts) pop in as small animated badges. They are the "juice".

During play there is ONE integrated header: the scene (name, mood, story clock), its items / actions / ways out, and your vitals (life, points, the permanent story-memory meter reading like "4.2k / 128k", current goal). Each character also wears their own small memory meter, since each one is its own agent. Each affordance comes from one state field and renders once. The composer at the bottom has Do/Say/Look modes (Look studies the scene or one thing; the narrator decides whether it earns a picture, which lands seconds later as the story keeps moving (announced by the backend over SSE the moment it persists; no blind polling)), an @ tagger that chips characters and items into your words, and a + that stacks several lines into a single turn. Next to it sit Continue (the story advances on its own) and the wish line: a hope whispered to the storyteller, not an action. Tapping a character opens their full-screen tabbed profile: their status sheet (gender, relation, standing, what they carry, what you can do to them, and the pieces of their past you have learned), the traits unlocked through play, the memories of what you shared (concept-captioned images and a pivotal-event timeline), and the whisper channel only they can hear (each reply has its own voice button with the same loading states as the story, deeds read as plain lines, a thinking indicator shows while the turn resolves, and Look works from the panel as a quiet PRIVATE study: whisper mode "look" on the wire, its echo and guaranteed image land in the thread and never in the public story). Characters who are elsewhere or gone can still be consulted: their profile stays readable, with a status line where the composer and actions would be. While a turn resolves, only the things that act are locked; reading, inspecting and profiles stay live. Your own words appear the instant you send them, then the turn plays out staged: receipts pop instantly (trait unlocks get a little celebration), prose types itself quote-free (the bubble is the quotation), images fade in (click to skip) with their full concept caption under them, item unlocks arrive as small cards on the prose's edge. Each spoken line's speaker button shows when it is rendering, playing, or ready again. Tap anything - an item, the goal, a receipt - to expand it and ask the narrator what it is. Click any image for the full-size view with its description under it (the scene's, the character's, the item's, or the moment's concept). Settings hold the audio (narrator and character voices autoplay independently), this adventure's difficulty and narrator voice, the story-memory controls (memory depth, auto-summarize cadence, and the context budget that caps turn latency), the turn-pacing dials (voices per turn, acts per voice; Default hands the reins back to the narrator), and the danger-zone wipe (every adventure, double-confirmed, no undo); every library card can export its adventure (share the world, or save this exact moment) and the library can import what others share. A creation chat survives refreshes: come back and it picks up where you left off.

## Running

In this repo the UI runs inside the Anna app, served by `anna-app` in the single
container (the iframe talks to the engine over the Anna transport, not HTTP). See
the top-level `README.md`. For isolated UI work you can still serve the static
files directly (`cd frontend && python3 -m http.server 4173`) against a standalone
backend; the api client falls back to `fetch` when no Anna transport is injected.

## Theming

Every design decision (colors, fonts, the clip-path chamfer factor, eases) is a custom property in `themes/hightech.css`; `styles.css` is structure only and carries no color literals (lint-enforced, the JS render layer included: even character fallback colors are `var(--speaker-N)` references). A new theme - medieval, noir - is one file defining the same tokens, linked from `index.html` before the structure sheet (`data-theme` on `<html>`). Alpha variants derive via `color-mix`, so re-tinting one token re-tints every glow and gradient built from it.

## Tests

```bash
cd frontend
npm install      # dev-only: vitest, @testing-library/dom + user-event, msw, jsdom (not shipped in the image)
npm test         # vitest run over test/*.test.js
```

Tests run on **vitest** in a jsdom environment. Component tests mount the real `app.js`
(via the exported `init()`), drive it with `@testing-library/user-event`, and intercept
the orchestrator with **MSW** at the network layer. The app itself stays build-free; this
tooling is test-only.

Coverage (215 tests, 12 files):

- `test/play.component.test.js` (MSW + user-event): the full player loop. Lists games and enters one (deck, goal, clock, meter, character column, dead end); a free-text Do turn posts `{ action }` and Say posts a segment; the PARTIAL lock blocks mutating controls mid-turn while the lightbox, tap-to-inspect and `/explain` keep working (exactly one POST goes out); the @ tagger chips an entity and the request carries `refs`; stacking sends several segments as one turn; Look sends a `look` segment (typed focus, empty = whole scene, and the scene's Look around / Search buttons); after a look turn the late-image poll (`GET /beats?since=`) lands the narrator's hero shot plus a SMALL item unlock card and resolves the "rendering the view..." hint, which NEVER expires on a timer (fake-clock test: it outlives the 45s window, polling backs off to ~9s, the image swaps in); turn pacing PATCHes turn_voices/turn_acts (Default sends 0); a failed open returns to the library with a toast; a failed say restores the typed line to its composer; a background re-render never erases a half-typed line; a 422 toasts its human message; Continue runs a no-input turn (no player beat) and the wish line rides /continue and /action then clears; tapping items opens the inspect modal where loot offers Take and scenery offers Examine, with `/explain` asides (incl. the 404 "nothing more" case) and receipt beats by `beat_id`; a character card opens the full-screen tabbed profile (status sheet, traits + stamps, memories with private marks, the empty-state copy; the active tab survives the post-turn refetch) whose whisper composer sends `whisper` segments (say and do modes), pins its thread to the newest line, speaks replies with the character's voice, and never leaks the secret into the public story; game settings PATCH difficulty round-trip; the autoplay split persists narrator/character toggles independently; a library card's Export opens the share/save choice and downloads the named JSON, and Import posts a file then enters the new game (400 surfaces); a revealed exit raises a notice; the staged reveal keeps later beats veiled while prose types and a story click instant-finishes; the scene image stays anchored when new narration arrives; the lightbox opens on image click and closes on Esc/outside; art polling swaps the scene loader for the real image; a failed game image retries with a cache-buster; deleting a game confirms then removes it.
- `test/creator.component.test.js`: creator persistence - a stored session restores the chat after a refresh, Start over discards it, an expired session starts clean, and sending a message stores the id.
- `test/composer.test.js`: chip serialization (inline name + refs, escaping, atomic non-editable chips) and `buildSegment` across say/do/look x public/whisper.
- `test/transitions.test.js`: the diff engine - scene change, item revealed/taken, follow/disposition/death/join transitions, goal/objective/quest changes, point/life deltas, story end, and human-readable notices.
- `test/adapters.test.js`: real-shaped state mapping - narrator/character voices, relative media URLs preserved, `private_with` -> `privateWith`, the `fixed` item flag, exits NOT capped (auto back-exit flagged), present-character filtering, missing-field tolerance.
- `test/render.test.js`: narration as prose (no speaker label, and narrator-speaker dialogue stays prose), dialogue bubble, player/character action lines, toned system badges (adjudication veto + trait celebration), the integrated deck (exits/actions/goal in one header, no repeated affordances), context meter format ("4.2k / 128k", tones, always visible) + story clock, art loader vs static placeholder per `images_enabled`, scene art anchoring, mirrored player speech, the profile screen (traits/moments/memories/whisper composer/empty copy), small item cards vs hero image beats, item slot thumbnails, the Look mode + Continue/wish row, the partial lock rendering, the settings screen (autoplay split + per-game section, no export here), the library's per-card export choice + import affordance, the narrator-free whisper hint, fixed-slot grids, library cards with delete + confirm modal.
- `test/theme.lint.test.js`: the theming contract - no color literal in `styles.css` or the JS render layer, every consumed token defined in the theme file.
- `test/voice.test.js` / `test/api.test.js` / `test/interaction.test.js`: lazy TTS behavior, speak-not-stream playback, the `prepare()`/`playUrl()` pipeline primitives and the strict FIFO synth queue (never parallel, failures don't poison it); the REST client (segments vs plain action, delete, clear-beats); the rendered composer (modes, tagger, stack rows, the partial lock, no quick chips).
- `test/mobile.lint.test.js` (the 640px mobile-adapter contract / desktop-byte-identical guard).
- `test/setuppage.test.js` (setup.html rendered from infra/setup/schema.js).

## Backend integration

The app calls the orchestrator (game API) at `backendUrl` (default `http://localhost:8000`, CORS `*`):

- Library: `GET /games`, import via `POST /games/import`
- Open/resume: `GET /games/{id}/state` + `GET /games/{id}/beats` (`?since=` for the post-turn late-image poll)
- Turn: `POST /games/{id}/action {action|segments, wish?}` -> `{ beats, state }`; `POST /games/{id}/continue {wish?}` for a no-input turn
- Tap-to-explain: `POST /games/{id}/explain`; character profile: `GET /games/{id}/characters/{cid}/profile`
- Live settings: `PATCH /games/{id}/settings` (any subset of difficulty, narrator_gender, history_beats, summary_every, context_tokens, turn_voices, turn_acts); export: `GET /games/{id}/export?kind=template|checkpoint`
- Creator: `POST /create/message` + `POST /create/finalize` (409 means "keep chatting")

Media is **same-origin and relative**. `beat.image_url` / character `face_url` etc. come back as relative paths (`/media/...`, `/image/file?...`) and load directly via `<img src>` behind the proxy. Voice is lazy (Maya1): for a playable beat the app calls `POST /voice/speak { text, voice_id }` (full render, cached `audio_url`) and plays it through an `<audio>` element; the staged reveal pipelines the next beat's render while the current one plays. (/voice/stream is not used for playback: it cuts off mid-line in an audio element.) Narration uses `state.narrator_voice_id`; dialogue uses the speaking character's `voice_id`. Voice ids are opaque (some are long description strings) and are never displayed. If a voice id is null the app skips synthesis entirely (the server 400s on empty voice). On any voice error the text simply stays on screen.

Character reference art is generated by a background task after game creation, so it appears a few seconds later. The app polls `/state` and slots the portraits in when they arrive, falling back to color + initial until then.

There are no fake/seed games. If the backend is unreachable the library shows an honest "backend offline" state, never mock content.

See `INDEX.md` for the module map.
