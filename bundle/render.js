// render.js - the Emberlight presentation-state renderer.
//
// A PURE rendering module: no SDK import, no top-level side effects, so it
// renders standalone in any DOM. It paints the ONE data contract the UI knows:
//   { scene: { text, image_prompt? }, characters: [{name, look}],
//     inventory: [{name}], choices: [string] }
// into a cinematic illustrated-novel stage (Emberlight): the scene image is the
// HERO BACKDROP, the prose is light cast onto it (drop cap + ink-wipe), the
// cast glows in along a thin rail, and the one HUD object is a stitched
// bookmark ribbon.
//
// Public API:
//   renderTurn(root, state, handlers)  -> builds (first call) or APPENDS a turn
//   helpers: escapeHtml, splitParas, placeholderHue, speakerColor, sceneBackdrop
//
// handlers = { onChoice(text), onSubmit(text), onWhisper(name, message) }.
// Every interactive surface is a real element with an accessible name so the
// component tests (getByRole) keep passing.

// ---------------------------------------------------------------------------
// Small pure helpers (no DOM)
// ---------------------------------------------------------------------------

/** HTML-escape a string for safe interpolation into innerHTML. Never throws. */
export function escapeHtml(v) {
  const s = v == null ? "" : String(v);
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/** Split prose into paragraphs on blank lines; single newlines become <br>. */
export function splitParas(text) {
  return String(text == null ? "" : text)
    .split(/\n{2,}/)
    .map((p) => p.trim())
    .filter(Boolean);
}

// Leading articles to strip before abbreviating or labeling, so "A sealed
// letter" and "A smooth grey river stone" do not collide on a shared "A ...".
const ARTICLE_RE = /^(?:a|an|the|some|your|my|his|her|their)\s+/i;

/** Strip a leading article from a name. "A sealed letter" -> "sealed letter". */
export function stripArticle(name) {
  return String(name || "").trim().replace(ARTICLE_RE, "");
}

/**
 * 2-char monogram from a name. Leading articles ("A ", "The ") and punctuation
 * are stripped FIRST, so "A sealed letter" -> "SE" (not "AS"), "A smooth grey
 * river stone" -> "SG", and "Rope (50ft)" -> "RO" (never "R(").
 */
export function initials(name) {
  // strip articles, then keep only letters/digits/space to derive the monogram
  const cleaned = stripArticle(name).replace(/[^\p{L}\p{N}\s]/gu, " ");
  const words = cleaned.trim().split(/\s+/).filter(Boolean);
  if (!words.length) return "?";
  if (words.length === 1) {
    const w = words[0];
    return (w.length >= 2 ? w.slice(0, 2) : w).toUpperCase();
  }
  return (words[0][0] + words[1][0]).toUpperCase();
}

// INVENTORY VOCABULARY: a small keyword -> icon map so each carried item reads
// as a recognizable object, not a cryptic monogram. Matched case-insensitively
// against the item name; first hit wins; anything unmatched falls back to "gem".
const ITEM_ICONS = [
  [/\b(key|keyring)\b/i, "key"],
  [/\b(letter|note|scroll|parchment|page|map|deed|contract)\b/i, "scroll"],
  [/\b(stone|rock|pebble|gem|crystal|jewel|ore|ring|amulet|locket|coin|gold|silver|relic|idol)\b/i, "gem"],
  [/\b(potion|draught|elixir|vial|flask|tonic|brew|phial)\b/i, "flask"],
  [/\b(tinderbox|torch|lantern|candle|flame|match|firestarter)\b/i, "flame"],
  [/\b(rope|cord|twine|chain|line)\b/i, "rope"],
  [/\b(sword|blade|dagger|knife|axe|spear|bow|staff|wand|weapon|club|mace)\b/i, "blade"],
  [/\b(book|tome|grimoire|journal|ledger|codex)\b/i, "book"],
  [/\b(bread|food|ration|apple|meat|cheese|waterskin|water|drink|meal)\b/i, "food"],
  [/\b(shield|armou?r|helm|cloak|boots|glove|mantle)\b/i, "shield"],
];

/** Pick a glyph name for an inventory item from its text. Defaults to "gem". */
export function itemGlyphName(name) {
  const s = String(name || "");
  for (const [re, icon] of ITEM_ICONS) {
    if (re.test(s)) return icon;
  }
  return "gem";
}

/**
 * A readable, article-stripped label for an inventory chip. Smartly truncated so
 * long names never blow out the strip; the full name still lives in title/aria.
 * "A smooth grey river stone" -> "Smooth grey river stone".
 */
export function itemLabel(name, max = 22) {
  let s = stripArticle(name);
  if (!s) s = String(name || "").trim();
  if (!s) return "Item";
  s = s.charAt(0).toUpperCase() + s.slice(1);
  if (s.length > max) s = s.slice(0, max - 1).trimEnd() + "…";
  return s;
}

/** Stable 32-bit hash of a string (deterministic placeholder seed). */
export function hashStr(s) {
  let h = 2166136261 >>> 0;
  const str = String(s || "");
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

// The Emberlight speaker ramp (matches the theme tokens). A character's color is
// derived deterministically from their name so portraits are stable turn-to-turn.
export const SPEAKER_RAMP = [
  "#4fb8a6", // teal
  "#e8a24a", // amber
  "#d2566b", // rose
  "#7fb069", // sage
  "#9b8bd4", // violet
  "#d97a4a", // terracotta
];

/** Deterministic speaker color for a character name. */
export function speakerColor(name) {
  return SPEAKER_RAMP[hashStr(name) % SPEAKER_RAMP.length];
}

/** A deterministic hue (0-360) for a name, for the duotone portrait plate. */
export function placeholderHue(name) {
  return hashStr(name) % 360;
}

// ---------------------------------------------------------------------------
// Procedural placeholders (no network, no images): inline SVG + gradients.
// ---------------------------------------------------------------------------

// A pseudo-random but DETERMINISTIC sequence from a seed: lets the backdrop
// vary by image_prompt without ever hitting the network.
function rng(seed) {
  let s = seed >>> 0 || 1;
  return () => {
    s ^= s << 13;
    s ^= s >>> 17;
    s ^= s << 5;
    s >>>= 0;
    return s / 4294967296;
  };
}

// The HERO BACKDROP for a scene: layered ember gradients + an inline-SVG
// treeline/horizon silhouette seeded from image_prompt text. Good enough that a
// mock turn reads as an atmospheric concept frame, never a gray box. Returns an
// HTML string for a <div class="backdrop-art">.
export function sceneBackdrop(imagePrompt) {
  const seed = hashStr(imagePrompt || "ember");
  const rand = rng(seed);
  // pick a mood tint pair off the ember/night ramp, nudged by the seed
  const baseHue = 18 + (seed % 30); // warm amber-orange band
  const farHue = 200 + (seed % 40); // cool misty band for depth
  const w = 1200;
  const h = 800;

  // a layered treeline: several rows of jagged silhouettes receding into mist
  let layers = "";
  const rows = 3;
  for (let r = 0; r < rows; r++) {
    const baseY = h * (0.5 + r * 0.16);
    const darkness = 0.22 + r * 0.26;
    const step = 70 - r * 8;
    let d = `M0 ${h} L0 ${baseY.toFixed(0)}`;
    for (let x = 0; x <= w; x += step) {
      const peak = baseY - (40 + rand() * 130) * (1 - r * 0.18);
      d += ` L${x} ${peak.toFixed(0)} L${(x + step / 2).toFixed(0)} ${baseY.toFixed(0)}`;
    }
    d += ` L${w} ${baseY.toFixed(0)} L${w} ${h} Z`;
    layers += `<path d="${d}" fill="hsl(${(farHue + r * 6) % 360} 30% ${(6 + r * 3).toFixed(0)}%)" opacity="${darkness.toFixed(2)}"/>`;
  }

  // a low warm glow disc (firelight / sun just out of frame), offset by seed
  const gx = (20 + (seed % 60)).toFixed(0);
  const gy = (28 + ((seed >> 3) % 30)).toFixed(0);

  const svg = `<svg viewBox="0 0 ${w} ${h}" preserveAspectRatio="xMidYMid slice" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">
      <defs>
        <radialGradient id="g-glow" cx="${gx}%" cy="${gy}%" r="75%">
          <stop offset="0%" stop-color="hsl(${baseHue} 80% 58%)" stop-opacity="0.55"/>
          <stop offset="38%" stop-color="hsl(${(baseHue + 14) % 360} 60% 34%)" stop-opacity="0.32"/>
          <stop offset="100%" stop-color="hsl(${farHue} 38% 7%)" stop-opacity="0.95"/>
        </radialGradient>
        <linearGradient id="g-sky" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stop-color="hsl(${(baseHue + 6) % 360} 46% 22%)"/>
          <stop offset="52%" stop-color="hsl(${(farHue + 10) % 360} 34% 11%)"/>
          <stop offset="100%" stop-color="hsl(${farHue} 40% 5%)"/>
        </linearGradient>
      </defs>
      <rect width="${w}" height="${h}" fill="url(#g-sky)"/>
      <rect width="${w}" height="${h}" fill="url(#g-glow)"/>
      ${layers}
      <rect width="${w}" height="${h}" fill="hsl(${farHue} 40% 4%)" opacity="0.12"/>
    </svg>`;

  return svg;
}

// A character PORTRAIT PLATE placeholder: a soft duotone gradient keyed off the
// name's hue with a large serif monogram. Returns HTML for inside .col-art.
function portraitPlate(c) {
  const hue = placeholderHue(c.name);
  const color = speakerColor(c.name);
  const mono = initials(c.name);
  const altText = [c.name, c.look].filter(Boolean).join(" - ");
  return `<div class="col-body art-off" role="img" aria-label="${escapeHtml(altText || c.name)}"
        style="--phue:${hue}; --speaker:${color}">
        <span class="col-initial">${escapeHtml(mono)}</span>
      </div>`;
}

// ---------------------------------------------------------------------------
// One-time STAGE build. Builds the full Emberlight shell ONCE and caches the
// live element references on the root via a WeakMap, so subsequent renderTurn()
// calls APPEND to the narration log and patch panels in place (no flicker, no
// re-announce of old beats).
// ---------------------------------------------------------------------------

const STAGE = new WeakMap();

function buildStage(root, handlers) {
  root.innerHTML = "";
  root.classList.add("emberlight-root");

  const stage = el("div", "play-stage");
  stage.setAttribute("data-stage", "");

  // L0 + L1: backdrop layers (two for crossfade) + scrim/grain/vignette
  const backdrop = el("div", "backdrop");
  backdrop.setAttribute("aria-hidden", "true");
  const artA = el("div", "backdrop-art is-active");
  const artB = el("div", "backdrop-art");
  const scrim = el("div", "backdrop-scrim");
  const grain = el("div", "backdrop-grain");
  const vignette = el("div", "backdrop-vignette");
  backdrop.append(artA, artB, scrim, grain, vignette);

  // L2: the deck (top strip)
  const deck = buildDeck();

  // body: reading column + cast rail
  const body = el("div", "play-body");

  const story = el("main", "story");
  story.id = "storyStream";
  story.setAttribute("role", "log");
  story.setAttribute("aria-live", "polite");
  story.setAttribute("aria-relevant", "additions");
  story.setAttribute("aria-label", "Story");

  const castWrap = el("aside", "char-column");
  const colHead = el("div", "col-head");
  colHead.innerHTML = `${glyph("mask")}<span>The cast</span>`;
  const charDeck = el("div", "char-deck");
  castWrap.append(colHead, charDeck);

  body.append(story, castWrap);

  // bottom: action bar (choices row + inventory + composer)
  const actionbar = buildActionBar(handlers);

  // whisper drawer (hidden until opened)
  const drawer = buildWhisperDrawer(handlers);

  stage.append(backdrop, deck, body, actionbar, drawer.overlay, drawer.panel);
  root.append(stage);

  const refs = {
    stage,
    artA,
    artB,
    activeArt: artA,
    deck,
    sceneName: deck.querySelector("[data-scene-name]"),
    timeChip: deck.querySelector("[data-time-chip]"),
    ctxFill: deck.querySelector("[data-ctx-fill]"),
    ctxNum: deck.querySelector("[data-ctx-num]"),
    ribbon: deck.querySelector(".bookmark"),
    story,
    charDeck,
    castWrap,
    choicesRow: actionbar.querySelector("[data-choices]"),
    invGrid: actionbar.querySelector("[data-inv]"),
    composerInput: actionbar.querySelector(".composer-input"),
    modeBtns: actionbar.querySelectorAll(".mode-btn"),
    sendBtn: actionbar.querySelector("[data-send]"),
    drawer,
    handlers,
    mode: "do",
    lastImagePrompt: undefined,
    turnCount: 0,
    characters: [],
  };

  wireActionBar(refs);
  STAGE.set(root, refs);
  return refs;
}

function el(tag, cls) {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  return e;
}

// A tiny inline-SVG icon set (CSP-safe, no font/CDN). Stroke uses currentColor.
function glyph(name) {
  const p = {
    mask: '<path d="M3 6c0 7 4 12 9 12s9-5 9-12c-3 1-6 1.5-9 1.5S6 7 3 6Z"/><circle cx="8.5" cy="10" r="1"/><circle cx="15.5" cy="10" r="1"/>',
    gem: '<path d="m12 3 7 6-7 12L5 9l7-6Z"/><path d="M5 9h14M9 3l3 6 3-6"/>',
    star: '<path d="m12 3 2.7 5.6 6.1.9-4.4 4.3 1 6.1L12 17l-5.4 2.9 1-6.1L3.2 9.5l6.1-.9L12 3Z"/>',
    heart: '<path d="M12 20s-7-4.3-9.3-8.5C1.2 8.3 2.6 5 5.8 5 8 5 9.5 6.6 12 9c2.5-2.4 4-4 6.2-4 3.2 0 4.6 3.3 3.1 6.5C19 15.7 12 20 12 20Z"/>',
    compass: '<circle cx="12" cy="12" r="9"/><path d="m15.5 8.5-2 5-5 2 2-5 5-2Z"/>',
    clock: '<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/>',
    send: '<path d="M4 12 20 4l-6 16-3-7-7-1Z"/>',
    at: '<circle cx="12" cy="12" r="4"/><path d="M16 12v1.5a2.5 2.5 0 0 0 5 0V12a9 9 0 1 0-3.5 7.1"/>',
    plus: '<path d="M12 5v14M5 12h14"/>',
    lock: '<rect x="5" y="11" width="14" height="9" rx="2"/><path d="M8 11V8a4 4 0 0 1 8 0v3"/>',
    mic: '<rect x="9" y="3" width="6" height="11" rx="3"/><path d="M5 11a7 7 0 0 0 14 0M12 18v3"/>',
    x: '<path d="M6 6l12 12M18 6 6 18"/>',
    chevR: '<path d="m9 5 7 7-7 7"/>',
    // inventory vocabulary
    key: '<circle cx="8" cy="8" r="4"/><path d="m11 11 8 8M16 16l2-2M18 18l2-2"/>',
    scroll: '<path d="M7 4h10v13a3 3 0 0 1-3 3H7a3 3 0 0 1-3-3V4Z"/><path d="M7 4a3 3 0 0 0-3 3M17 17h3a0 0 0 0 1 0 0 3 3 0 0 1-3 3"/><path d="M8 8h6M8 11h6"/>',
    flask: '<path d="M9 3h6M10 3v6l-5 8a2 2 0 0 0 2 3h10a2 2 0 0 0 2-3l-5-8V3"/><path d="M7.5 14h9"/>',
    flame: '<path d="M12 3c-2 3-5 5-5 9a5 5 0 0 0 10 0c0-2-1-3-2-4 .2 1.5-.6 2.5-1.5 2.5C12 10.5 13 7 12 3Z"/>',
    rope: '<path d="M6 4c0 3 3 3 3 6s-3 3-3 6 3 3 3 4"/><path d="M14 4c0 3 3 3 3 6s-3 3-3 6 3 3 3 4"/>',
    blade: '<path d="m4 20 3-1 11-11-2-2L4 17l-1 3 1 0Z"/><path d="M14 6l4 4M15 13l3 3-1.5 1.5L13 15"/>',
    book: '<path d="M4 5a2 2 0 0 1 2-2h13v16H6a2 2 0 0 0-2 2V5Z"/><path d="M6 17h13M9 7h6"/>',
    food: '<circle cx="12" cy="13" r="7"/><path d="M12 6c0-2 1-3 3-3M9 11c0-1.5 1-2.5 2.5-2.5"/>',
    shield: '<path d="M12 3 5 6v5c0 5 3 8 7 10 4-2 7-5 7-10V6l-7-3Z"/>',
  }[name] || "";
  return `<svg class="ic" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${p}</svg>`;
}

// THE DECK (top strip): serif logo | stitched dog-ear scene tab with bookmark
// ribbon | vitals cluster.
function buildDeck() {
  const deck = el("header", "play-deck");
  deck.innerHTML = `
    <div class="deck-logo">
      <span class="logo-mark">Gamentic</span>
    </div>
    <div class="deck-scene">
      <span class="scene-fold" aria-hidden="true"></span>
      <div class="scene-id">
        <span class="scene-kicker">The story so far</span>
        <h2 class="scene-name"><span data-scene-name>An untold place</span></h2>
      </div>
      <span class="time-chip" data-time-chip title="Story time, not yours">${glyph("clock")}<span>Dusk</span></span>
      <div class="bookmark" role="meter" aria-valuemin="0" aria-valuemax="100" aria-valuenow="0" aria-label="Story memory">
        <span class="bookmark-ribbon"><span class="ctx-fill" data-ctx-fill style="height:8%"></span></span>
        <span class="ctx-num" data-ctx-num>memory</span>
      </div>
    </div>
    <div class="deck-vitals">
      <span class="vital hp-capsule" title="Vitality">${glyph("heart")}<span class="hud-num">5/5</span></span>
      <span class="vital points" title="Points">${glyph("star")}<span class="hud-num">0</span></span>
      <span class="vital location" title="Where you are"><span data-location>Wilderness</span></span>
    </div>`;
  return deck;
}

// THE ACTION BAR: choices row above the free-text composer; the player
// inventory sits as a labeled slot row.
function buildActionBar(handlers) {
  void handlers;
  const bar = el("footer", "play-actionbar");
  bar.innerHTML = `
    <div class="player-inv">
      <span class="rail-label">${glyph("gem")}<span>What you carry</span></span>
      <div class="slot-grid player-items" data-inv></div>
    </div>
    <div class="choices-row" data-choices role="group" aria-label="Suggested actions"></div>
    <form class="action-form" novalidate>
      <div class="composer">
        <div class="composer-modes" role="group" aria-label="Line kind">
          <button type="button" class="mode-btn active" data-mode="do" aria-pressed="true">Do</button>
          <button type="button" class="mode-btn" data-mode="say" aria-pressed="false">Say</button>
          <button type="button" class="mode-btn" data-mode="look" aria-pressed="false">Look</button>
        </div>
        <div class="composer-input" id="cmpInput" contenteditable="true" role="textbox"
             aria-multiline="false" aria-label="What you do"
             data-placeholder="Do or say anything... (Enter sends)"></div>
        <button type="button" class="composer-icon tag-btn" data-tag
                title="Tag a character or item" aria-label="Tag a character or item">${glyph("at")}</button>
        <button type="button" class="composer-icon stack-btn" data-stack
                title="Stack this line to send several at once" aria-label="Stack this line">${glyph("plus")}</button>
        <button class="composer-send" type="submit" data-send>${glyph("send")}<span>Send</span></button>
      </div>
    </form>`;
  return bar;
}

const MODE_PLACEHOLDER = {
  do: "Do or say anything... (Enter sends)",
  say: "What do you say?",
  look: "Look at what? (empty = study the whole scene)",
};
const MODE_ARIA = { do: "What you do", say: "What you say", look: "What you look at" };

function wireActionBar(refs) {
  const { composerInput, modeBtns, sendBtn, handlers } = refs;

  // mode toggle (Do / Say / Look) - updates placeholder + aria-label
  modeBtns.forEach((btn) => {
    btn.addEventListener("click", () => {
      const mode = btn.getAttribute("data-mode");
      refs.mode = mode;
      modeBtns.forEach((b) => {
        const on = b === btn;
        b.classList.toggle("active", on);
        b.setAttribute("aria-pressed", String(on));
      });
      composerInput.setAttribute("data-placeholder", MODE_PLACEHOLDER[mode] || MODE_PLACEHOLDER.do);
      composerInput.setAttribute("aria-label", MODE_ARIA[mode] || MODE_ARIA.do);
    });
  });

  const submit = () => {
    if (refs.stage.classList.contains("generating")) return;
    const text = composerInput.textContent.trim();
    if (!text) return; // empty submit is inert
    if (typeof handlers.onSubmit === "function") handlers.onSubmit(text);
    composerInput.textContent = "";
  };

  refs.stage.querySelector(".action-form").addEventListener("submit", (e) => {
    e.preventDefault();
    submit();
  });
  sendBtn.addEventListener("click", (e) => {
    e.preventDefault();
    submit();
  });
  composerInput.addEventListener("keydown", (e) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      submit();
    }
  });
}

// THE WHISPER DRAWER: a private 1:1 amber channel. Built once, hidden until a
// card's whisper affordance opens it.
function buildWhisperDrawer(handlers) {
  const overlay = el("div", "whisper-overlay");
  overlay.setAttribute("hidden", "");

  const panel = el("aside", "whisper-drawer");
  panel.setAttribute("hidden", "");
  panel.setAttribute("role", "dialog");
  panel.setAttribute("aria-modal", "true");
  panel.setAttribute("aria-label", "Whisper");
  panel.innerHTML = `
    <header class="whisper-head">
      <span class="whisper-portrait" data-wp></span>
      <span class="whisper-name" data-wname>Whisper</span>
      <span class="whisper-lock" title="Private channel">${glyph("lock")}<span>private</span></span>
      <button type="button" class="whisper-close" data-wclose aria-label="Close whisper">${glyph("x")}</button>
    </header>
    <div class="pm-thread" data-wthread aria-live="polite"></div>
    <form class="pm-form" data-wform novalidate>
      <input type="text" class="pm-input" data-winput autocomplete="off"
             aria-label="Whisper a private message" placeholder="Say something only they will hear..." />
      <button type="submit" class="pm-send" aria-label="Send whisper">${glyph("send")}</button>
    </form>`;

  const ref = {
    overlay,
    panel,
    thread: panel.querySelector("[data-wthread]"),
    input: panel.querySelector("[data-winput]"),
    nameEl: panel.querySelector("[data-wname]"),
    portrait: panel.querySelector("[data-wp]"),
    current: null,
    lastFocus: null,
  };

  const close = () => closeWhisper(ref);
  overlay.addEventListener("click", close);
  panel.querySelector("[data-wclose]").addEventListener("click", close);
  panel.addEventListener("keydown", (e) => {
    if (e.key === "Escape") close();
  });

  panel.querySelector("[data-wform]").addEventListener("submit", (e) => {
    e.preventDefault();
    const msg = ref.input.value.trim();
    if (!msg || !ref.current) return;
    appendWhisperLine(ref, "you", msg);
    if (typeof handlers.onWhisper === "function") handlers.onWhisper(ref.current, msg);
    ref.input.value = "";
    ref.input.focus();
  });

  return ref;
}

function openWhisper(refs, character) {
  const w = refs.drawer;
  w.current = character.name;
  w.lastFocus = document.activeElement;
  w.nameEl.textContent = character.name;
  w.panel.setAttribute("aria-label", `${character.name}'s whisper`);
  const hue = placeholderHue(character.name);
  const color = speakerColor(character.name);
  w.portrait.style.setProperty("--phue", hue);
  w.portrait.style.setProperty("--speaker", color);
  w.portrait.textContent = initials(character.name);
  w.thread.innerHTML = `<p class="pm-empty">Say something only ${escapeHtml(character.name)} will ever hear.</p>`;
  w.overlay.removeAttribute("hidden");
  w.panel.removeAttribute("hidden");
  // next frame -> animate in
  requestAnimationFrame(() => {
    w.overlay.classList.add("open");
    w.panel.classList.add("open");
  });
  w.input.focus();
}

function closeWhisper(w) {
  w.panel.classList.remove("open");
  w.overlay.classList.remove("open");
  w.panel.setAttribute("hidden", "");
  w.overlay.setAttribute("hidden", "");
  w.current = null;
  if (w.lastFocus && typeof w.lastFocus.focus === "function") w.lastFocus.focus();
}

function appendWhisperLine(w, who, text) {
  const empty = w.thread.querySelector(".pm-empty");
  if (empty) empty.remove();
  const line = el("div", `pm-line ${who === "you" ? "pm-you" : "pm-them"}`);
  line.innerHTML = `<span class="pm-text">${escapeHtml(text)}</span>`;
  w.thread.append(line);
  w.thread.scrollTop = w.thread.scrollHeight;
}

// ---------------------------------------------------------------------------
// Per-turn rendering: append narration, set the backdrop, patch the cast rail,
// inventory, choices, and the scene tab.
// ---------------------------------------------------------------------------

/**
 * Render a presentation-state turn into root. On the first call it builds the
 * full stage; on every call it APPENDS the new narration as a fresh beat and
 * patches the panels (cast, inventory, choices, scene) to the latest state.
 *
 * @param {HTMLElement} root
 * @param {{ scene: {text:string, image_prompt?:string|null}, characters?: {name:string,look?:string}[], inventory?: {name:string}[], choices?: string[] }} state
 * @param {{ onChoice?:(text:string)=>void, onSubmit?:(text:string)=>void, onWhisper?:(name:string,msg:string)=>void }} [handlers]
 * @returns {HTMLElement} root
 */
export function renderTurn(root, state, handlers = {}) {
  let refs = STAGE.get(root);
  if (!refs) {
    refs = buildStage(root, handlers);
  } else if (handlers && (handlers.onChoice || handlers.onSubmit || handlers.onWhisper)) {
    // allow handlers to be (re)bound on a later call
    refs.handlers = Object.assign(refs.handlers, handlers);
  }

  const s = normalizeState(state);
  refs.turnCount += 1;

  appendNarration(refs, s.scene.text, refs.turnCount === 1);
  setBackdrop(refs, s.scene);
  renderCast(refs, s.characters);
  renderInventory(refs, s.inventory);
  renderChoices(refs, s.choices);

  return root;
}

// Tolerant local normalize (the renderer must never blank on a weak shape; the
// authoritative parser is core.parsePresentation, but render must stand alone).
function normalizeState(state) {
  const st = state && typeof state === "object" ? state : {};
  const scene = st.scene && typeof st.scene === "object" ? st.scene : {};
  return {
    scene: {
      text: scene.text == null ? "" : String(scene.text),
      image_prompt: scene.image_prompt == null ? null : String(scene.image_prompt),
    },
    characters: Array.isArray(st.characters)
      ? st.characters.filter((c) => c && c.name).map((c) => ({ name: String(c.name), look: c.look == null ? "" : String(c.look) }))
      : [],
    inventory: Array.isArray(st.inventory)
      ? st.inventory.filter((i) => i && i.name).map((i) => ({ name: String(i.name) }))
      : [],
    choices: Array.isArray(st.choices) ? st.choices.filter((c) => typeof c === "string" && c.trim()) : [],
  };
}

// NARRATION: append a new beat. The first paragraph of the scene-opening turn
// gets the drop cap. Paragraphs ink in (clip-wipe) via CSS, staggered.
function appendNarration(refs, text, isOpening) {
  const paras = splitParas(text);
  const section = el("section", "narration");
  if (isOpening) section.classList.add("scene-open");

  if (!paras.length) {
    section.innerHTML = `<p class="muted">The story holds its breath...</p>`;
  } else {
    section.innerHTML = paras
      .map((p, i) => `<p class="beat-line" style="--beat:${i}">${escapeHtml(p)}</p>`)
      .join("");
  }
  // a faint scene-break rubrication tick before any turn after the first
  if (refs.turnCount > 1) {
    const tick = el("span", "scene-tick");
    tick.setAttribute("aria-hidden", "true");
    refs.story.append(tick);
  }
  refs.story.append(section);
  // scroll the newest beat into view within the internal-scroll story column
  refs.story.scrollTop = refs.story.scrollHeight;
}

// BACKDROP: on the first turn or when image_prompt changes, crossfade to the
// new procedural art. Stable prompt -> no churn.
function setBackdrop(refs, scene) {
  const prompt = scene.image_prompt || scene.text || "";
  if (prompt === refs.lastImagePrompt) return;
  refs.lastImagePrompt = prompt;

  const incoming = refs.activeArt === refs.artA ? refs.artB : refs.artA;
  incoming.innerHTML = sceneBackdrop(prompt);
  // crossfade
  incoming.classList.add("is-active");
  refs.activeArt.classList.remove("is-active");
  refs.activeArt = incoming;
}

// CAST RAIL: render persistent portrait plates. Existing cards are kept;
// genuinely new entrants get the .card-arrive reveal.
function renderCast(refs, characters) {
  const known = new Set(refs.characters);
  refs.charDeck.innerHTML = "";

  if (!characters.length) {
    const empty = el("p", "char-empty muted");
    empty.textContent = "No one else is here right now.";
    refs.charDeck.append(empty);
  }

  for (const c of characters) {
    const isNew = !known.has(c.name);
    const card = buildCharCard(refs, c, isNew);
    refs.charDeck.append(card);
  }
  refs.characters = characters.map((c) => c.name);
}

function buildCharCard(refs, c, isNew) {
  const color = speakerColor(c.name);
  const card = el("article", "char-col" + (isNew ? " card-arrive" : ""));
  card.style.setProperty("--speaker", color);
  card.setAttribute("data-char-name", c.name);

  const artBtn = el("button", "col-art");
  artBtn.type = "button";
  artBtn.setAttribute("aria-label", `Open ${c.name}'s profile`);
  artBtn.title = `Open ${c.name}'s profile`;
  artBtn.innerHTML = `
    ${portraitPlate(c)}
    <div class="col-grad" aria-hidden="true"></div>
    <div class="col-plate">
      <span class="char-name">${escapeHtml(c.name)}</span>
      ${c.look ? `<span class="char-look">${escapeHtml(c.look)}</span>` : ""}
    </div>`;

  const whisperBtn = el("button", "chip-btn whisper");
  whisperBtn.type = "button";
  whisperBtn.setAttribute("aria-label", `Whisper to ${c.name}`);
  whisperBtn.title = `Whisper privately to ${c.name}`;
  whisperBtn.innerHTML = `${glyph("mic")}<span>Whisper</span>`;
  whisperBtn.addEventListener("click", () => openWhisper(refs, c));

  artBtn.addEventListener("click", () => openWhisper(refs, c));

  card.append(artBtn, whisperBtn);
  return card;
}

// INVENTORY: readable item chips - an object glyph + the item's name (not a
// 2-letter monogram). The full name lives in title + aria-label for hover/SR;
// the visible label is article-stripped and smartly truncated. With 0 items we
// show one quiet "nothing yet" hint, NOT a row of dashed empty boxes, so the
// strip never looks half-empty. Handles 0-12 items gracefully.
function renderInventory(refs, inventory) {
  refs.invGrid.innerHTML = "";

  if (!inventory.length) {
    const empty = el("span", "inv-empty muted");
    empty.textContent = "Your hands are empty.";
    refs.invGrid.append(empty);
    return;
  }

  for (const it of inventory.slice(0, 12)) {
    const chip = el("button", "item-chip");
    chip.type = "button";
    chip.title = it.name; // full, untruncated name on hover
    chip.setAttribute("aria-label", it.name);
    chip.innerHTML =
      `<span class="item-ic" aria-hidden="true">${glyph(itemGlyphName(it.name))}</span>` +
      `<span class="item-label">${escapeHtml(itemLabel(it.name))}</span>`;
    refs.invGrid.append(chip);
  }
}

// CHOICES: tactile rounded "key" buttons above the composer. 0 -> row hidden.
function renderChoices(refs, choices) {
  refs.choicesRow.innerHTML = "";
  if (!choices.length) {
    refs.choicesRow.hidden = true;
    return;
  }
  refs.choicesRow.hidden = false;
  for (const text of choices) {
    const key = el("button", "choice-key");
    key.type = "button";
    key.textContent = text;
    key.addEventListener("click", () => {
      if (refs.stage.classList.contains("generating")) return;
      if (typeof refs.handlers.onChoice === "function") refs.handlers.onChoice(text);
    });
    refs.choicesRow.append(key);
  }
}

// Expose the busy-lock toggle so app.js can dim/lock the stage while a turn
// resolves (the existing partial busy-lock pattern).
export function setBusy(root, busy) {
  const refs = STAGE.get(root);
  if (!refs) return;
  refs.stage.classList.toggle("generating", Boolean(busy));
}
