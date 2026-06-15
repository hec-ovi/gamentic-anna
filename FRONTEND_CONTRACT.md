# Frontend contract

This is the interface between the **functionality layer** (`bundle/app.js`, `bundle/core.js`) and the
**frontend layer** (`bundle/render.js`, `bundle/style.css`, `bundle/index.html`). The frontend can be
redesigned freely (look, markup, motion, layout) as long as it keeps this contract. If you keep these
exports, fields, and behaviors, the live game loop keeps working untouched.

## Ownership

| Layer | Files | Owns |
| --- | --- | --- |
| Functionality | `app.js`, `core.js`, `tests/*` (except render) | the game loop, the AI turns, parsing, persistence, image generation |
| Frontend | `render.js`, `style.css`, `index.html`, `tests/render.test.js` | everything visual: structure, CSS, animation, layout, placeholders |

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

## 8. Quick checklist before you hand the frontend back

- [ ] `renderTurn(root, state, handlers)` and `setBusy(root, busy)` still exported with these signatures.
- [ ] Renders `scene.text`, `characters[].name/look`, `inventory[].name`, `choices[]`.
- [ ] Renders `scene.image_url` and `characters[].portrait` as images when present (placeholder otherwise),
      and `normalizeState` keeps those fields.
- [ ] Calls `onChoice` / `onSubmit` / `onWhisper` on the right interactions; guards while busy.
- [ ] Tolerant: never throws, never blanks, on any weak/missing state.
- [ ] `#root` present, `./app.js` loaded as a module, no external network, accessible, responsive.
- [ ] `vitest run` green.
- [ ] (Nice) `pushWhisperReply` exported.
