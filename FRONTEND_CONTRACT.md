# Frontend contract

This is the interface between the **functionality layer** (`bundle/app.js`, `bundle/core.js`) and the
**frontend layer** (`bundle/render.js`, `bundle/style.css`, `bundle/index.html`). The frontend can be
redesigned freely (look, markup, motion, layout) as long as it keeps this contract. If you keep these
exports, fields, and behaviors, the live game loop keeps working untouched.

## File ownership (read this first)

The two layers are isolated by file. Stay on your side and the seam below is all that connects us.

**Frontend agent MAY edit ONLY these (presentation):**
- `bundle/render.js`  (the DOM rendering, animations, the whisper drawer; keep the exports + behavior in section 1)
- `bundle/style.css`  (all styling, fully free)
- `bundle/index.html`  (markup, free; but keep an element with `id="root"` and keep `<script type="module" src="./app.js">`)
- `tests/render.test.js`  (the renderer's tests)
- You may ADD new asset files the bundle needs (an inline-SVG sprite, etc.), as long as they stay self-contained (no external network).

**Backend agent (the other instance) owns; the frontend agent MUST NOT touch:**
- `bundle/app.js`  (the SDK boot + live game loop + image generation + persistence)
- `bundle/core.js`  (the GM prompt, turn parsing/reducer, storage helpers)
- `manifest.json`, `app.json`  (scopes, grants, identity)
- `package.json`, `package-lock.json`
- `tests/llm.test.js`, `tests/storage.test.js`, `tests/presentation.test.js`, `tests/loop.test.js`
- `FRONTEND_CONTRACT.md`  (this file; the backend maintains it, read it but do not edit)

So: the frontend is the four files `render.js` / `style.css` / `index.html` / `render.test.js`. Everything
else is backend. The only thing connecting the two is the contract below (the render.js exports + the
presentation-state shape + the handlers). Honor it and neither side breaks the other.

**You may change anything visual.** Rewrite the markup inside `#root`, the CSS, the animations, the
procedural placeholders, the glyphs, the responsive layout, add panels and effects. **You must keep the
exports, the fields consumed, the handler names, and the tolerant-never-blank behavior below.**

## 1. Required exports from `bundle/render.js`

```ts
// Builds the stage on the first call for a given root element; on every later
// call it APPENDS the new narration as a fresh beat and patches the panels
// (cast, inventory, choices, scene) to the latest state. Must never throw.
export function renderTurn(root: HTMLElement, state: PresentationState, handlers?: Handlers): HTMLElement

// Locks / dims the stage while a turn resolves (a turn takes a few seconds).
export function setBusy(root: HTMLElement, busy: boolean): void
```

Keep these names and signatures. `app.js` imports exactly `{ renderTurn, setBusy }`. Other helpers in
`render.js` (escapeHtml, splitParas, speakerColor, sceneBackdrop, etc.) are internal: rename or remove
them freely.

### Proposed optional exports (graceful: `app.js` only calls them if `typeof` is a function)

```ts
// Progressive images: text renders instantly, art arrives a few seconds later.
// app.js calls these to patch the CURRENT turn in place (renderTurn appends a
// new beat each call, so it cannot be used to back-fill an image).
export function setSceneImage(root: HTMLElement, url: string): void          // swap the scene art to this src
export function setPortrait(root: HTMLElement, characterName: string, url: string): void  // set a character's portrait

// Full whisper support (see section 6): show the AI's private reply in the drawer.
export function pushWhisperReply(root: HTMLElement, characterName: string, text: string): void
```

If you add these, the loop uses them; until then it degrades gracefully (images still appear via
`scene.image_url` / `characters[].portrait` on the next turn and on reload; whisper replies render as a
normal turn).

## 2. The data contract: `PresentationState`

This single object is what `renderTurn` receives, what the UI renders, and what gets persisted.

```ts
type PresentationState = {
  scene: {
    text: string;             // the narration prose: THE story the player reads
    image_prompt?: string | null;  // a plain visual description of the scene
    image_url?: string | null;     // OPTIONAL: a ready-to-use <img> src (data: URI or https) for scene art
  };
  characters: { name: string; look?: string; portrait?: string | null }[];
  inventory: { name: string }[];
  choices: string[];          // 2 to 4 short action labels
};
```

Rules the renderer must honor:

- **Tolerant, never blank.** Any field may be missing, empty, or weakly typed. Coerce or drop, never
  throw, never leave the screen empty. `render.js` already does this in `normalizeState`; keep that
  guarantee. (The authoritative parser is `core.parsePresentation`, but the renderer must also stand
  alone.)
- `scene.text` is the only place the story lives. Render it as prose (it may be multiple paragraphs).
- `characters` is who is present / known now. Render each as a card with its `name` (and `look` if
  present). Newly-appeared characters can get an entrance treatment.
- `inventory` is the player's current items (the full list each turn, not a diff).
- `choices` are the suggested action buttons (may be 0; hide the row when empty).

### Images (the seam for the image feature)

The functionality layer generates scene art and character portraits via `anna.image.generate`, caches
them (portraits are stable per character and persisted), and sets:

- `scene.image_url` to a ready-to-use `<img>` src (a `data:` URI), and
- each `characters[i].portrait` to a ready-to-use `<img>` src.

**Render these as real images when present; fall back to your procedural / placeholder art when absent.**
Do not fetch or generate images in the frontend, just display what is provided. NOTE: the current
`normalizeState` strips `image_url` and `portrait`; to show images, keep those two fields when you
normalize. Everything still works visually without them (placeholders), so this is additive.

## 3. The handlers contract

`renderTurn` is given a handlers object; wire your buttons / inputs to call these (they resolve a real
AI turn in the functionality layer):

```ts
type Handlers = {
  onChoice?(text: string): void;          // a choice button was clicked
  onSubmit?(text: string): void;          // the player typed a free-form action and submitted
  onWhisper?(name: string, message: string): void;  // a private message to one character
};
```

- `onChoice` and `onSubmit` are the same kind of turn (a public action); call whichever matches the UI
  affordance.
- `onWhisper(name, message)` starts a private turn directed at the named character.
- Handlers may be (re)bound on a later `renderTurn` call (the live handlers replace the preview ones once
  Anna connects). `render.js` already merges handlers across calls; keep that.
- While a turn is resolving the stage is `setBusy(root, true)`; ignore further clicks until it clears
  (the current renderer guards choices with a `generating` class, keep an equivalent guard).

## 4. DOM and boot contract

- `index.html` must contain an element with `id="root"` and must load `./app.js` as a module
  (`<script type="module" src="./app.js">`). `app.js` imports the renderer; do not move that import.
- `app.js` may **replace** the `#root` element with a fresh empty element on connect (to clear the
  preview mock). `renderTurn` must therefore work when handed a fresh, empty element (build from
  scratch). It already keys its built stage per element, keep that.
- Keep all assets self-contained: no external fonts, CDNs, or network requests (the bundle runs in a
  sandboxed iframe with a strict CSP). System fonts and inline SVG only.
- Keep it accessible (roles, labels, keyboard, focus) and responsive (desktop + mobile), and respect
  `prefers-reduced-motion`.

## 5. Lifecycle

- **Preview mode** (opened as a plain static page, no Anna SDK): `app.js` renders a built-in mock turn so
  the page is a full, populated view. Handlers just log. This is how you iterate on design standalone:
  serve `bundle/` and open `index.html`.
- **Live mode** (inside Anna): `app.js` connects, opens one AI session, renders the create-an-adventure
  invite (fresh) or the restored game (returning), and routes the handlers to real AI turns, persisting
  after each. The frontend does not need to know which mode it is in: it just renders `PresentationState`
  and calls handlers.

## 6. Whisper

The whisper drawer is opened from a character (the renderer owns the open/close + the player's outgoing
line). On send it calls `onWhisper(name, message)`. The functionality layer resolves a private turn and,
**if you export `pushWhisperReply(root, name, text)`** (section 1), gets the character's reply rendered
back into the drawer thread. If that export is absent, the reply falls back to a normal story turn. Please
add `pushWhisperReply` so whispers feel private.

## 7. Tests

`tests/render.test.js` (happy-dom) pins the renderer's behavior against this contract. Keep it green; if
you change internal markup, update the tests but keep the contract assertions (exports exist, tolerant of
weak state, handlers fire, never throws, never blanks). Run `npm test` (`vitest run`).

## 8. Adventure management + creator (new — build this in parallel)

The app now supports MULTIPLE saved adventures and a creator (world-building) flow. This adds one new
render function and a few handlers. As always, the backend calls these; you implement the visuals. The
backend calls every new function/handler with a `typeof` guard, so you can ship them incrementally and the
app degrades gracefully until each lands.

### New export: the home / adventure picker

```ts
// Render the "home" screen: the saved adventures + a way to start a new one.
// The backend calls this on boot (when adventures exist) and whenever the player
// returns to the menu. Must never throw; render a friendly empty state when the
// list is empty.
export function renderHome(root: HTMLElement, adventures: Adventure[], handlers: HomeHandlers): HTMLElement

type Adventure   = { id: string; title: string; updatedAt: number };  // updatedAt = ms epoch
type HomeHandlers = {
  onNewAdventure(): void;       // "New Adventure" -> launches the creator
  onResume(id: string): void;   // open a saved adventure (e.g. click the row)
  onDelete(id: string): void;   // delete a saved adventure (a confirm in-UI is welcome)
};
```
- Show each adventure's `title` + a friendly "when" (derive from `updatedAt`), a resume affordance, and a delete affordance.
- A prominent **New Adventure** action.
- Empty list -> a welcoming empty state with just **New Adventure**.
- If `renderHome` is absent, the backend falls back to launching the creator directly (the app still runs), but the list/resume/delete UI won't be reachable until you add it.

### Returning to the menu from play (extends the section 3 handlers)

```ts
onHome?(): void;   // leave the current adventure and show the picker
```
Add a small **home/menu** affordance in the play view (and the creator) that calls `onHome()`.

### The creator REUSES `renderTurn` (no new function needed)

The creator is a short conversation that designs the world before play starts. It renders through the
existing `renderTurn`:
- `scene.text` = the creator's question / message (prose).
- `choices` = suggested directions, plus a **"Begin the adventure"** choice once the world is ready.
- `characters` / `inventory` are usually empty during creation.

So it already works in the current UI. OPTIONAL: to style the creation phase differently (e.g. a "designing
your world" header), the backend passes an additive 4th arg you may ignore:
```ts
renderTurn(root, state, handlers, opts?: { mode?: "creator" | "play" })
```
`opts` is optional and backward-compatible — ignore it and nothing breaks; read `opts.mode === "creator"` to theme creation.

## 9. Playtest UX requirements (frontend-owned, from live feedback)

These are all on YOUR side of the seam (render.js / style.css). The backend now feeds you
everything you need for them; this section is the spec. There are exactly THREE views (home picker,
creator chat, play), and inside play a narration view + a private whisper view. Keep them distinct.

**Echo the player's own line.** Today the player never sees what THEY just did in the public story
(the whisper drawer already echoes the player's outgoing line as a `pm-you` bubble; the story log does
not). When `onSubmit(text)` / `onChoice(text)` fire, render the player's own words IMMEDIATELY as a
distinct "you" beat in the story (before the AI reply streams in). The backend does not echo the line
back to you, so render it from the handler argument. This is the #1 reported gap ("I do not see my own
messages"), in both creation and play.

**Gate "Begin the adventure" on `opts.ready`.** The creator render now passes
`renderTurn(root, state, handlers, { mode: "creator", ready })` with a boolean `ready`. Keep the Begin
affordance INERT (hidden or visibly disabled) until `ready === true`. The backend guarantees `ready`
turns true on its own within a few exchanges (the moment the architect signals it, or after enough
back-and-forth), so the gate always opens, the player is never deadlocked. Until then, the creator view
is just the question + the composer for the player's answer.

**Hide play-only affordances during creation** (`opts.mode === "creator"`). Creation is a plain chat:
hide/disable the whisper affordance, the `@`-tag and stack buttons, the inventory strip, the cast rail,
and the Do/Say/Look modes. Show only the architect's question, the player's typed answers, and (once
`ready`) Begin. Reveal the full play HUD only when play starts (`opts.mode === "play"`).

**Loaders while the model generates.** `setBusy(root, true)` wraps the FULL duration of every turn.
Make it a VISIBLE loading state (a typing indicator / shimmer on the pending beat), and make it work
even before the first `renderTurn` of a view: the opening scene and the first creator question both
generate before any beat exists, so a busy state on a fresh/empty stage must show a loader, not a blank
screen. (Right now `setBusy` early-returns when no stage is built yet; build a minimal loading surface
so the blank gap during the first generation is covered.)

**Typewriter narration.** Ink narration in as if the model is typing (a fast typewriter / progressive
reveal), so generation feels live. Respect `prefers-reduced-motion` (render instantly for those users).

**Whisper vs narration must look different.** Whisper replies are private chat BUBBLES with the
character's avatar in the drawer (`pushWhisperReply` already routes there); narration is prose in the
story log. Never let a whisper reply leak into the public story, and never style a narration beat as a
chat bubble.

**Clear view transitions.** The backend now hands `renderTurn` / `renderHome` a FRESH `#root` element
every time the view changes (home -> creator -> play -> home). Two consequences: (a) you always get a
clean element on a view change, so a previous view's beats can never bleed into the next (this fixes
"when I start an adventure I see the full messages of the creation"); (b) you may animate the transition
(fade/slide) knowing the stage rebuilds from scratch on the fresh element. Do not rely on persisting DOM
across a view change.

## 10. Quick checklist before you hand the frontend back

- [ ] `renderTurn(root, state, handlers)` and `setBusy(root, busy)` still exported with these signatures.
- [ ] Renders `scene.text`, `characters[].name/look`, `inventory[].name`, `choices[]`.
- [ ] Renders `scene.image_url` and `characters[].portrait` as images when present (placeholder otherwise),
      and `normalizeState` keeps those fields.
- [ ] Calls `onChoice` / `onSubmit` / `onWhisper` on the right interactions; guards while busy.
- [ ] Tolerant: never throws, never blanks, on any weak/missing state.
- [ ] `#root` present, `./app.js` loaded as a module, no external network, accessible, responsive.
- [ ] `vitest run` green.
- [ ] (Nice) `pushWhisperReply` exported.
- [ ] `renderHome(root, adventures, handlers)` exported: lists adventures (title + when), resume + delete
      per row, a New Adventure action, a graceful empty state; never throws.
- [ ] A home/menu affordance in play + creator that calls `onHome()`.
- [ ] (Optional) creator-phase theming via `renderTurn`'s `opts.mode === "creator"`.
- [ ] Player's own line echoed as a "you" beat on `onSubmit` / `onChoice` (story) — section 9.
- [ ] "Begin the adventure" gated on `opts.ready` (inert until ready) — section 9.
- [ ] Play-only affordances (whisper, tag, inventory, cast, modes) hidden when `opts.mode === "creator"`.
- [ ] `setBusy` shows a visible loader, including on a fresh/empty stage (first turn of a view).
- [ ] Narration inks in (typewriter), respecting `prefers-reduced-motion`.
- [ ] Whisper replies render as avatar bubbles in the drawer, never as public narration.
