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
