# Frontend index

Resolver-style map of the UI layer: find the thing you want to change, go straight to the file that owns it. Vanilla ES modules, no build step; one in-memory state, one `render()` that MORPHS the DOM (vendored idiomorph: unchanged nodes keep focus, caret, scroll, animations), delegated event handlers that mutate state and re-render.

## The flow of one turn

Composer submit (`app.js`) -> `api.takeAction` (or `api.continueStory`) -> `adapters.mapGameState`/`mapBeats` -> `render.js` morphs the screen with new beats veiled -> `diffState` notices + flashes -> the staged reveal types them out (voice pipelined per beat) -> background media (look shots, item cards, late art) arrives by SSE push: `mediastream.js` listens on `GET /games/{gid}/events` and re-fetches `/state` or `/beats?since=` on signal (60s fallback sweep for SSE-hostile proxies).

## Files

| Where | What lives there |
|---|---|
| `index.html` | Document shell, favicon, the CSS/JS entrypoints. Nothing else. |
| `styles.css` | STRUCTURE only: layout, shape, motion. No color literals (lint-enforced); every design value is a token. |
| `themes/hightech.css` | The design tokens: colors, fonts, chamfer factor, eases. A new theme = one file like this. |
| `vendor/idiomorph.esm.js` | Vendored DOM-morphing lib (0BSD, v0.7.4): render() patches the real DOM in place instead of rebuilding it. |
| `src/app.js` | The BOOT facade: `init()` (exported for tests) + auto-init. The controller lives in `src/app/`. |
| `src/app/ctx.js` | The ONE in-memory state, the voice engine, the api client and root element, shared as live bindings. |
| `src/app/ui.js` | `render()` (DOM morph via idiomorph), `delegate()` (five root listeners, wired once), the `[data-act]` action dispatcher, the partial busy-lock gate. |
| `src/app/turns.js` | The turn loop: action/continue, the optimistic echo + failure restore, the wish, the post-turn focus return. |
| `src/app/reveal.js` | The staged reveal: typewriter, veils, voice pacing, follow-scroll, the new-image affordances. |
| `src/app/game.js` | Library, open/resume, delete, wipe-all, export/import. |
| `src/app/mediastream.js` | Media-ready SSE push (one EventSource per game), the /state and /beats one-shot fetchers, the 60s fallback sweep. |
| `src/app/playctl.js` | Scene/character action buttons, tap-to-inspect + /explain, the give flow, the @ tagger. |
| `src/app/profilectl.js` | Profile open/refetch and the in-place (flick-free) tab switch. |
| `src/app/composerctl.js` | Composer modes, the current line as a segment, stacking, the public/private execute paths. |
| `src/app/creatorctl.js` | Creator chat sessions, restore-on-entry, finalize. |
| `src/app/speech.js` | Per-beat voice resolution + the speak-button state machine. |
| `src/app/settingsctl.js` | FE-local settings + the per-game PATCH. |
| `src/app/cues.js` | Transition notices, one-shot flashes, toasts, help popovers. |
| `src/app/media.js` | The image lightbox and the failed-image retry. |
| `src/api.js` | `createApi(backendUrl)`: the thin orchestrator REST client. Every endpoint the UI calls, in one place. |
| `src/adapters.js` | Raw wire JSON -> the view model: `mapGameState`, `mapBeats`, `mapProfile`, `voiceForBeat`, `presentCharacters`. Media URLs stay relative. |
| `src/composer.js` | The tagged-segment composer helpers: entity chips, `buildSegment` (say/do/look x public/whisper), `serializeComposer`, `describeSegment`. |
| `src/transitions.js` | `diffState(prev, next)` + `buildNotices()`: the pure state-diff engine that makes every turn's changes legible. |
| `src/voice.js` | `Voice`: Maya1 TTS via `POST /voice/speak` only (never /voice/stream into an `<audio>`). `prepare()`/`playUrl()` split + a strict FIFO synth queue power the reveal pipeline. Every in-game speak carries the active game's `game_id` (the voice-api ownership manifest: delete the game, its wavs die with it). |
| `src/render.js` | The render FACADE: `renderApp` + the public surface (HELP, escapeHtml, playerSpeech, renderProfilePane...). |
| `src/render/` | The builders, one module per concern: `common.js`, `widgets.js`, `screens.js`, `play.js`, `story.js`, `profile.js`, `inspect.js`. |
| `src/icons.js` | The inline SVG icon set. |

## Feature resolver

| Feature | Lives in | Tested in |
|---|---|---|
| Library / delete / export choice / import | `render/screens.js` (renderLibrary, renderGameCard, renderExportChoice), `app/game.js` (refreshLibrary, exportGame, importGameFile) | `test/play.component.test.js`, `test/render.test.js` |
| Story creator + session restore | `render/screens.js` (renderCreator), `app/creatorctl.js` (creator fns, localStorage session) | `test/creator.component.test.js` |
| The integrated deck (scene, items, exits, vitals, goal, clock, meter) | `render/play.js` (renderPlayDeck), `render/widgets.js` (contextMeter) | `test/render.test.js` |
| Context meter format ("4.2k / 128k", tones) | `render/widgets.js` (contextMeter) | `test/render.test.js` |
| Character columns + light action row | `render/play.js` (renderCharColumn, castRow) | `test/render.test.js` |
| Full-screen character profile (tabs: status+origin/traits/memories/whisper; gender) | `render/profile.js` (renderProfile, profileBody, the pane builders), `app/profilectl.js` (openProfile, refreshProfile, profile-tab), `adapters.js` (mapProfile) | `test/render.test.js`, `test/play.component.test.js` |
| Whisper channel (in the profile; scroll pin; voice on replies) | `render/profile.js` (renderWhisperChannel, renderPmBeat), `app/composerctl.js` (executePrivate), `app/reveal.js` (followStory) | `test/play.component.test.js` |
| Composer: Do/Say/Look modes, chips, stacking | `render/widgets.js` (renderComposer), `composer.js`, `app/composerctl.js` (executeComposer, setComposerMode) | `test/composer.test.js`, `test/interaction.test.js`, `test/play.component.test.js` |
| Look action (button, empty = whole scene, scene Look/Search rewire) | `app/playctl.js` (takeSceneAction), `app/composerctl.js` (executeComposer), `composer.js` (buildSegment) | `test/play.component.test.js` |
| Continue + the wish line | `render/play.js` (renderActionBar), `app/turns.js` (continueStory, captureWish) | `test/play.component.test.js` |
| Partial busy-lock (read-only stays live) | `app/ui.js` (MUTATING_ACTS), `render/widgets.js` + `render/play.js` (per-control `disabled`) | `test/play.component.test.js`, `test/interaction.test.js` |
| Staged reveal (typewriter, veils, click to skip, voice pacing) | `app/reveal.js` (startReveal, revealBeat, typewrite) | `test/play.component.test.js` |
| Optimistic player echo (instant dimmed lines, swap on resolve, composer restore on failure) | `app/turns.js` (echoBeats, resolveTurn, restoreInput) | `test/play.component.test.js` |
| Quote stripping on speech | `render.js` (stripWrappingQuotes, re-exported from `render/common.js`) | `test/render.test.js` |
| Speak button states (loading/playing/idle) | `app/speech.js` (speakBeat, applySpeakStates) | `test/play.component.test.js` |
| Scene-art anchoring (establishing narration, never "latest") | `render/story.js` (renderStory, sceneArtCard) | `test/render.test.js`, `test/play.component.test.js` |
| Late media (look shots, item cards, art) via SSE push + fallback sweep | `app/mediastream.js`, `render/story.js` (renderImageBeat), `render/widgets.js` (renderViewPending) | `test/play.component.test.js` |
| Item thumbnails + tap-to-inspect + /explain | `render/widgets.js` (slot builders), `render/inspect.js` (renderInspectModal), `app/playctl.js` (openInspect, doExplain) | `test/play.component.test.js` |
| Trait receipts (celebration tone) | `render/story.js` (systemTone "trait") | `test/render.test.js` |
| Transition notices + HUD flashes | `transitions.js`, `app/cues.js` (applyTransitions) | `test/transitions.test.js` |
| Voice playback (speak-not-stream, FIFO, autoplay split, cloud-bytes branch, game_id ownership tag) | `voice.js`, `app/reveal.js` (autoplayFor, reveal pipeline) | `test/voice.test.js`, `test/play.component.test.js` |
| Theme tokens + the no-literal contract | `themes/hightech.css`, `styles.css` | `test/theme.lint.test.js` |
| Turn pacing selects (voices per turn / acts per voice) | `render/screens.js` (pacingSelect), `app/settingsctl.js` (NUMERIC_GAME_SETTINGS) | `test/play.component.test.js`, `test/render.test.js` |
| Private look from the profile (whisper mode:"look"; thread placeholder) | `composer.js` (buildSegment), `app/composerctl.js`, `render/profile.js` | `test/play.component.test.js` |
| Settings (audio split; per-game difficulty/voice; wipe-all danger zone) | `render/screens.js` (renderSettings, renderGameSettings, renderWipeConfirm), `app/settingsctl.js` (updateSetting, patchGameSettings), `app/game.js` (wipeEverything) | `test/render.test.js`, `test/play.component.test.js` |
| Lightbox + image retry | `app/media.js` (maybeOpenLightbox, retryFailedImage) | `test/play.component.test.js` |
| Backend wire calls | `api.js` | `test/api.test.js` |

## Rendering rules

- Render strictly by `beat.kind` / `beat.speaker`; never hardcode character names or a literal "narrator" voice id. The wire decides the treatment.
- Narration is prose (a serif `<section>` of `<p>`, generous measure, no speaker label, no bubble). Dialogue is a named accent-colored card with the speaker's avatar (face art or color+initial fallback). The player's own action echo is a quiet right-aligned marker; a character's deed is a centered italic line. System beats are an animated badge whose tone (danger/points/item/quest) is inferred from the text. A `private_with` beat never reaches the public story (only its character's whisper view).

## Design rules

- A re-render must NEVER read as a "refresh": the morph plus preserved scrollTop keep the reader's place, and every state change is made LEGIBLE (notices for narrative shifts, one-shot flashes on the card/slot/HUD that changed). That legibility is the point of state-consciousness, not a side effect.
- In-game is a game, not an admin panel: keep the HUD minimal, settings behind the menu, and add "?" help where a new player would ask "what is this?".
- Treat all backend text and URLs as untrusted; escape before injecting (`escapeHtml`).
- Media is relative and same-origin; never hardcode `:9001`/`:9002`. Only the orchestrator lives at `backendUrl`.
- Voice is best-effort: null/empty voice id -> skip, any error -> text stays, never block a turn on audio. `emotion` rides `POST /voice/speak` verbatim.
- Quick-action chips are a frontend-only helper; the backend never returns choices.

## Tests

`npm test` (vitest, jsdom): 12 test files (the count grows with every change; the suite output is the truth). Component tests mount the real `app.js` via `init()`, drive it with `@testing-library/user-event`, and intercept the orchestrator with MSW at the network layer (`test/setup.js` holds the default handlers + per-test poller teardown, `test/fixtures.js` the wire-shaped builders). `test/theme.lint.test.js` enforces the theme contract.
