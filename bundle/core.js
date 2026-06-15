// Pure, runtime-injected logic. No DOM, no SDK import, no top-level side effects.
// `runtime` is the Anna app runtime (production SDK or the test harness): both
// expose an identical `llm.complete({ messages })` call shape.
//
// NOTE: never pass an output-token cap (maxTokens) here. A cap truncates Anna's
// narration mid-sentence and breaks structured output; let the model finish.

/**
 * Ask Anna's LLM a single user turn and return the assistant text.
 * @param {{ llm: { complete: (args: object) => Promise<{ content: { text: string } }> } }} runtime
 * @param {string} text
 * @returns {Promise<string>}
 */
export async function askAnna(runtime, text) {
  const reply = await runtime.llm.complete({
    messages: [{ role: "user", content: { type: "text", text } }],
  });
  return reply.content.text;
}

// Storage primitives for persisting game state. We use the portable
// `runtime.call("storage", method, argsObject)` shape, which behaves
// identically in the test harness and in the production SDK (where
// anna.storage.<method>(argsObject) forwards the object verbatim). Do NOT use
// `runtime.storage.get(key)` positional form: that exists only in the harness.

/**
 * Save a JSON-serializable value under key. Returns the host result.
 * @param {{ call: (ns: string, method: string, args: object) => Promise<any> }} runtime
 * @param {string} key
 * @param {*} value
 * @returns {Promise<any>}
 */
export async function saveState(runtime, key, value) {
  return runtime.call("storage", "set", { key, value });
}

/**
 * Load the value stored under key, or null if absent.
 * @param {{ call: (ns: string, method: string, args: object) => Promise<any> }} runtime
 * @param {string} key
 * @returns {Promise<*>}
 */
export async function loadState(runtime, key) {
  const r = await runtime.call("storage", "get", { key });
  // Production storage.get returns an envelope { value, exists, etag, ... }; the
  // in-memory test harness returns the raw stored value (or null). Unwrap the
  // envelope so callers always get the stored value itself.
  if (
    r &&
    typeof r === "object" &&
    !Array.isArray(r) &&
    "value" in r &&
    ("exists" in r || "etag" in r || "generation" in r || "key" in r)
  ) {
    return r.value ?? null;
  }
  return r ?? null;
}

// --- Presentation-state parsing -------------------------------------------
//
// The GM returns a turn as a JSON object we call the PRESENTATION STATE: the one
// structured contract the UI renders and we persist. The verified live shape is:
//   { scene: { text, image_prompt? }, characters: [{name, look}],
//     inventory: [{name}], choices: [string] }
//
// Design philosophy: loose by default, strict only here at the UI boundary, and
// "design for the dumbest model". This parser must be TOLERANT and must NEVER
// throw, so a weak model's imperfect output can never blank the screen.

/** Coerce any value to a string; null/undefined -> "". Never throws. */
function toStr(v) {
  if (v == null) return "";
  if (typeof v === "string") return v;
  try {
    return String(v);
  } catch {
    return "";
  }
}

/** Coerce a value to an array: arrays pass through, everything else -> []. */
function toArr(v) {
  return Array.isArray(v) ? v : [];
}

/** Build the empty (fallback) presentation state. */
function emptyState() {
  return {
    scene: { text: "", image_prompt: null },
    characters: [],
    inventory: [],
    choices: [],
  };
}

/**
 * Try to extract a parsed JSON object from raw model output, tolerantly:
 *   1. JSON.parse(text) as-is.
 *   2. Strip one leading/trailing markdown code fence and retry.
 *   3. Extract the substring from the FIRST "{" to the LAST "}" and retry.
 * Returns the parsed value, or undefined if nothing parsed. Never throws.
 */
function extractJson(text) {
  // 1. As-is.
  try {
    return JSON.parse(text);
  } catch {
    /* fall through */
  }

  // 2. Strip a markdown code fence: ```json\n...\n``` or ```\n...\n```.
  const fenced = text
    .trim()
    .replace(/^```[^\n]*\n?/, "")
    .replace(/\n?```$/, "");
  if (fenced !== text) {
    try {
      return JSON.parse(fenced);
    } catch {
      /* fall through */
    }
  }

  // 3. First "{" to last "}".
  const first = text.indexOf("{");
  const last = text.lastIndexOf("}");
  if (first !== -1 && last !== -1 && last > first) {
    try {
      return JSON.parse(text.slice(first, last + 1));
    } catch {
      /* fall through */
    }
  }

  return undefined;
}

/** Normalize an arbitrary parsed object into the strict presentation shape. */
function normalize(parsed) {
  const state = emptyState();
  if (parsed == null || typeof parsed !== "object" || Array.isArray(parsed)) {
    return state;
  }

  // scene -> { text, image_prompt|null }
  const scene = parsed.scene;
  if (scene != null && typeof scene === "object" && !Array.isArray(scene)) {
    state.scene.text = toStr(scene.text);
    state.scene.image_prompt =
      scene.image_prompt == null ? null : toStr(scene.image_prompt);
  }

  // characters -> [{ name, look }], drop entries with no name.
  for (const c of toArr(parsed.characters)) {
    if (c == null || typeof c !== "object" || Array.isArray(c)) continue;
    const name = toStr(c.name);
    if (!name) continue;
    state.characters.push({ name, look: toStr(c.look) });
  }

  // inventory -> [{ name }], drop entries with no name.
  for (const i of toArr(parsed.inventory)) {
    if (i == null || typeof i !== "object" || Array.isArray(i)) continue;
    const name = toStr(i.name);
    if (!name) continue;
    state.inventory.push({ name });
  }

  // choices -> [string], drop non-strings and empties.
  for (const ch of toArr(parsed.choices)) {
    if (typeof ch !== "string") continue;
    const trimmed = ch.trim();
    if (!trimmed) continue;
    state.choices.push(ch);
  }

  return state;
}

/**
 * Parse raw GM output into a strict, render-safe presentation state.
 * ALWAYS returns { ok, state, raw } and NEVER throws.
 *
 * - ok:true  -> JSON was found and normalized into the shape.
 * - ok:false -> no JSON parsed; falls back so the player still sees something:
 *               scene.text = trimmed raw text, everything else empty.
 *
 * @param {string} text raw model output
 * @returns {{ ok: boolean, state: { scene: { text: string, image_prompt: string|null }, characters: {name: string, look: string}[], inventory: {name: string}[], choices: string[] }, raw: string }}
 */
export function parsePresentation(text) {
  const raw = typeof text === "string" ? text : toStr(text);

  let parsed;
  try {
    parsed = extractJson(raw);
  } catch {
    parsed = undefined;
  }

  // Treat a parse that yields a non-object (string, number, array, null) as a
  // failure too: there is no usable presentation state in it, so fall back to
  // showing the raw text rather than reporting ok:true with a blank screen.
  if (parsed == null || typeof parsed !== "object" || Array.isArray(parsed)) {
    const state = emptyState();
    state.scene.text = raw.trim();
    return { ok: false, state, raw };
  }

  let state;
  try {
    state = normalize(parsed);
  } catch {
    state = emptyState();
    state.scene.text = raw.trim();
    return { ok: false, state, raw };
  }

  return { ok: true, state, raw };
}

// --- The live agent turn loop (pure logic only) ---------------------------
//
// Everything below is the brain of the playable loop, kept here so it stays
// pure (no DOM, no SDK) and unit-testable. app.js does the side-effecty parts
// (open the session, stream frames, render, persist); these helpers just shape
// the data.

/**
 * The Game Master ruleset, embedded verbatim and used as the agent session's
 * system_prompt. Kept well under the ~4000-char cap the backend enforces.
 */
export const GM_RULESET = `You are the Game Master of a text adventure. You narrate the world, play every character in it, and decide what happens when the player acts. Be vivid but brief. Keep the story moving.

Each turn: read the player's action, narrate the outcome in 2 to 4 short sentences, and voice any characters present. Then offer 2 to 4 things the player could do next.

If the action is marked as a private whisper to a character, reply ONLY as that character speaking quietly to the player; put just their short spoken reply in scene.text; other characters do not hear it.

Reply with ONLY a JSON object in this exact shape, nothing before or after:
{"scene":{"text":"the story the player reads, as prose","image_prompt":"a short plain visual description of the scene, no words in the image"},"characters":[{"name":"who","look":"one short visual line: sex, rough age, hair, clothing"}],"inventory":[{"name":"an item the player carries"}],"choices":["a short action","a short action"]}

Rules:
- scene.text is the only place the story lives; write it like a storyteller.
- characters: only who is present now. inventory: the full current list the player carries each turn.
- choices: 2 to 4 short actions, always at least two.
- Output valid JSON only. No markdown fences, no text outside the object.
- Everything else (plot, world, what characters want) is yours to invent and keep consistent.`;

/**
 * Concatenate the assistant text out of OpenAI-style SSE frames. Each frame's
 * text lives at frame.choices[0].delta.content; non-text / malformed frames are
 * ignored. Never throws; always returns a string.
 *
 * @param {any[]} frames
 * @returns {string}
 */
export function assistantText(frames) {
  if (!Array.isArray(frames)) return "";
  // Tolerant of BOTH agent-stream frame shapes seen in the wild:
  //  - real Anna backend SSE: { event:"sse", choices:[{ delta:{ content } }] }
  //  - normalized / dev-mock:  { event:"delta"|"model_token"|"final", text }
  // Prefer a consolidated "final" text when present (so we never double-count
  // streamed deltas + a final that repeats them); otherwise concatenate deltas.
  let finalText = "";
  let deltas = "";
  for (const f of frames) {
    if (!f || typeof f !== "object") continue;
    const piece = f?.choices?.[0]?.delta?.content;
    if (typeof piece === "string") deltas += piece;
    if (typeof f.text === "string") {
      if (f.event === "final") finalText += f.text;
      else if (f.event === "delta" || f.event === "model_token") deltas += f.text;
    }
    // event:"error" frames carry no usable text; ignored -> empty turn -> the
    // app's graceful "world hesitates" fallback handles it.
  }
  return finalText || deltas;
}

// History is capped so a long session can be re-seeded and persisted without
// growing without bound.
const HISTORY_CAP = 40;

/** A fresh, empty game object. */
function emptyGame() {
  return {
    scene: { text: "", image_prompt: null },
    roster: [],
    inventory: [],
    choices: [],
    history: [],
  };
}

/**
 * Fold a parsed presentation `state` into the running `game`, immutably.
 * Returns a NEW game object; the input is never mutated.
 *
 * - scene / inventory / choices are taken from the incoming state.
 * - characters are MERGED into the roster by name: new ones append, existing
 *   ones update their look only when the incoming look is non-empty, order is
 *   preserved, and a name never duplicates.
 * - the scene narration is appended to history, capped to the last 40 entries.
 *
 * A null/empty game initializes empty arrays. Pure, never throws.
 *
 * @param {{scene?:object, roster?:any[], inventory?:any[], choices?:any[], history?:any[]}|null} game
 * @param {{scene?:object, characters?:any[], inventory?:any[], choices?:any[]}} state
 * @returns {{scene:{text:string,image_prompt:string|null}, roster:{name:string,look:string}[], inventory:{name:string}[], choices:string[], history:{narration:string}[]}}
 */
export function reduceTurn(game, state) {
  const base = game && typeof game === "object" ? game : emptyGame();
  const s = state && typeof state === "object" ? state : {};

  // scene (always a fresh object so callers can't alias the input)
  const inScene = s.scene && typeof s.scene === "object" ? s.scene : {};
  const scene = {
    text: toStr(inScene.text),
    image_prompt: inScene.image_prompt == null ? null : toStr(inScene.image_prompt),
  };

  // roster: copy the prior roster, then merge incoming characters by name.
  const roster = toArr(base.roster)
    .filter((c) => c && typeof c === "object" && toStr(c.name))
    .map((c) => ({ name: toStr(c.name), look: toStr(c.look) }));
  const indexByName = new Map(roster.map((c, i) => [c.name, i]));
  for (const c of toArr(s.characters)) {
    if (c == null || typeof c !== "object" || Array.isArray(c)) continue;
    const name = toStr(c.name);
    if (!name) continue;
    const look = toStr(c.look);
    if (indexByName.has(name)) {
      // update the look only when the incoming one carries information
      if (look) roster[indexByName.get(name)].look = look;
    } else {
      roster.push({ name, look });
      indexByName.set(name, roster.length - 1);
    }
  }

  // inventory: the full current list, taken from the incoming state.
  const inventory = toArr(s.inventory)
    .filter((i) => i && typeof i === "object" && !Array.isArray(i) && toStr(i.name))
    .map((i) => ({ name: toStr(i.name) }));

  // choices: incoming strings only.
  const choices = toArr(s.choices).filter(
    (ch) => typeof ch === "string" && ch.trim(),
  );

  // history: prior + this narration, capped to the last HISTORY_CAP entries.
  const history = toArr(base.history)
    .filter((h) => h && typeof h === "object")
    .map((h) => ({ narration: toStr(h.narration) }));
  history.push({ narration: scene.text });
  const trimmed = history.length > HISTORY_CAP ? history.slice(-HISTORY_CAP) : history;

  return { scene, roster, inventory, choices, history: trimmed };
}

/**
 * Build a short plain-text recap from the latest game state, used to re-seed a
 * fresh agent session after a reload (the session has no memory of prior turns).
 * Never throws.
 *
 * @param {{roster?:any[], inventory?:any[], history?:any[]}} game
 * @returns {string}
 */
export function recap(game) {
  const g = game && typeof game === "object" ? game : {};
  const history = toArr(g.history);
  const last = history.length ? toStr(history[history.length - 1].narration).trim() : "";
  const names = toArr(g.roster)
    .map((c) => toStr(c && c.name).trim())
    .filter(Boolean);
  const items = toArr(g.inventory)
    .map((i) => toStr(i && i.name).trim())
    .filter(Boolean);

  const parts = [];
  parts.push(`So far: ${last || "(the story has not begun)"}.`);
  parts.push(`Present: ${names.length ? names.join(", ") : "no one"}.`);
  parts.push(`Carrying: ${items.length ? items.join(", ") : "nothing"}.`);
  return parts.join(" ");
}

// --- Adventure management + creator (pure logic only) ---------------------
//
// Two new surfaces live here, both pure and never-throwing:
//  - the CREATOR: a short world-building interview that runs as plain prose and
//    signals readiness with a [ready] marker (isCreatorReady detects/strips it).
//  - ADVENTURE MANAGEMENT: a tiny index of saved adventures (upsert/remove),
//    plus deriveTitle to name a fresh one from its seed or opening narration.

/**
 * The Creator ruleset, embedded verbatim and used as the world-building chat's
 * system_prompt. Plain prose only; ends with the exact [ready] marker once the
 * world is genuinely ready. Kept well under the backend's ~4000-char cap.
 */
export const CREATOR_RULESET = `You are a warm, imaginative story architect helping someone design a text-adventure world through a short, friendly chat.

Ask ONE focused question at a time, building on their answers, to settle: the setting and genre, the tone, who the player is, and a central hook or starting quest. Offer concrete suggestions they can accept or change. Keep each reply to 1 to 3 short sentences. Be encouraging.

When you have ENOUGH to begin (a setting, a tone, and a starting hook), give a one-line summary of the world you have agreed on, invite them to begin, and end that reply with the exact marker [ready] on its own line. NEVER write [ready] before the world is genuinely ready; if they change direction, simply stop including it until it is ready again.

Reply in plain prose. Do NOT output JSON during creation.`;

/**
 * Detect the creator "ready" signal in a model reply, and strip the marker.
 *
 * A [ready] token (case-insensitive, optionally surrounded by whitespace and
 * adjacent punctuation) anywhere in the text flags readiness. ALL occurrences
 * are removed; the remaining text is whitespace-collapsed at the edges and
 * trimmed. Non-string / empty input yields { ready: false, text: "" }.
 * Never throws.
 *
 * @param {string} text raw model reply
 * @returns {{ ready: boolean, text: string }}
 */
export function isCreatorReady(text) {
  if (typeof text !== "string" || text.trim() === "") {
    return { ready: false, text: "" };
  }
  // Match a [ready] token (any case, optional inner whitespace), optionally
  // wrapped in surrounding whitespace/punctuation so a marker on its own line
  // or trailing a sentence is removed cleanly along with its blank line.
  const marker = /[ \t]*\[\s*ready\s*\][ \t]*/gi;
  const ready = marker.test(text);
  marker.lastIndex = 0;
  // Replace markers with a single space so words on either side don't fuse,
  // then collapse the runs of whitespace those replacements may leave behind.
  const stripped = text
    .replace(marker, " ")
    .replace(/[ \t]*\n[ \t]*/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .replace(/[ \t]{2,}/g, " ")
    .trim();
  return { ready, text: stripped };
}

/**
 * Coerce one adventure-index entry into a clean { id, title, updatedAt } record,
 * or return null if it carries no usable id. Never throws.
 */
function cleanEntry(entry) {
  if (entry == null || typeof entry !== "object" || Array.isArray(entry)) {
    return null;
  }
  const id = toStr(entry.id).trim();
  if (!id) return null;
  return {
    id,
    title: toStr(entry.title),
    updatedAt: entry.updatedAt == null ? "" : toStr(entry.updatedAt),
  };
}

/**
 * Sort an adventure index by updatedAt DESCENDING (most recent first). A missing
 * /empty updatedAt sorts last. Stable-ish: equal keys keep input order.
 */
function sortIndex(list) {
  return list
    .map((e, i) => [e, i])
    .sort((a, b) => {
      const ua = a[0].updatedAt || "";
      const ub = b[0].updatedAt || "";
      if (ua === ub) return a[1] - b[1]; // stable on ties
      if (!ua) return 1; // a missing -> after b
      if (!ub) return -1; // b missing -> after a
      return ua < ub ? 1 : -1; // descending
    })
    .map((pair) => pair[0]);
}

/**
 * Insert or replace `entry` in an adventure `index`, by id, returning a NEW
 * array sorted by updatedAt descending. The input is never mutated. An index
 * that is missing or not an array is treated as []. An entry with no id is
 * ignored (a cleaned copy of the index is returned). Never throws.
 *
 * @param {{id:string,title?:string,updatedAt?:string}[]} index
 * @param {{id:string,title?:string,updatedAt?:string}} entry
 * @returns {{id:string,title:string,updatedAt:string}[]}
 */
export function upsertAdventure(index, entry) {
  const base = toArr(index)
    .map(cleanEntry)
    .filter(Boolean);
  const clean = cleanEntry(entry);
  if (!clean) {
    // No usable id on the entry: return a cleaned, sorted copy of the index.
    return sortIndex(base);
  }
  const idx = base.findIndex((e) => e.id === clean.id);
  if (idx === -1) {
    base.push(clean);
  } else {
    base[idx] = clean;
  }
  return sortIndex(base);
}

/**
 * Remove the entry whose id === `id` from an adventure `index`, returning a NEW
 * array. The input is never mutated. A missing / non-array index is treated as
 * []. Never throws.
 *
 * @param {{id:string,title?:string,updatedAt?:string}[]} index
 * @param {string} id
 * @returns {{id:string,title:string,updatedAt:string}[]}
 */
export function removeAdventure(index, id) {
  const target = toStr(id).trim();
  return toArr(index)
    .map(cleanEntry)
    .filter((e) => e && e.id !== target);
}

/**
 * Derive a short human title from a seed string or opening narration. Takes the
 * first line/sentence, collapses whitespace, strips surrounding quotes and a
 * little markdown, and trims to <= `max` chars on a word boundary (no mid-word
 * cut), appending a single ellipsis char when truncated. Empty / non-string
 * input falls back to "Untitled adventure". Never throws.
 *
 * @param {string} text seed or opening narration
 * @param {number} [max=48]
 * @returns {string}
 */
export function deriveTitle(text, max = 48) {
  const FALLBACK = "Untitled adventure";
  if (typeof text !== "string") return FALLBACK;

  // First non-empty line, then first sentence within it.
  let line = "";
  for (const raw of text.split(/\r?\n/)) {
    if (raw.trim()) {
      line = raw;
      break;
    }
  }
  // First sentence: stop at ., !, or ? followed by space/end.
  const sentenceMatch = line.match(/^(.*?[.!?])(\s|$)/);
  let title = sentenceMatch ? sentenceMatch[1] : line;

  // Collapse all whitespace to single spaces.
  title = title.replace(/\s+/g, " ").trim();

  // Strip a little leading markdown (heading hashes, list bullets, blockquote).
  title = title.replace(/^(?:#{1,6}\s+|[-*+]\s+|>\s+)/, "").trim();
  // Strip surrounding markdown emphasis markers and quote characters, possibly
  // layered (e.g. **"..."**), peeling one matched wrapper at a time.
  let prev;
  do {
    prev = title;
    title = title
      .replace(/^(["'`“”‘’*_~]+)([\s\S]*?)\1$/, "$2")
      .replace(/^["'`“”‘’*_~]+/, "")
      .replace(/["'`“”‘’*_~]+$/, "")
      .trim();
  } while (title !== prev);

  if (!title) return FALLBACK;

  const limit = Number.isFinite(max) && max > 0 ? Math.floor(max) : 48;
  if (title.length <= limit) return title;

  // Reserve one char for the ellipsis, then trim back to a word boundary so no
  // word is cut mid-way. If the slice already ends right at a word boundary
  // (the next source char is whitespace), keep the whole final word.
  const ELLIPSIS = "…";
  let cut = title.slice(0, limit - 1);
  if (!/\s/.test(title[limit - 1] || "")) {
    // The slice landed inside a word: drop the partial trailing word.
    const lastSpace = cut.lastIndexOf(" ");
    if (lastSpace > 0) cut = cut.slice(0, lastSpace);
  }
  cut = cut.replace(/\s+$/, "");
  if (!cut) {
    // A single word longer than the limit: hard-cut (still no room for words).
    cut = title.slice(0, limit - 1);
  }
  return cut + ELLIPSIS;
}
