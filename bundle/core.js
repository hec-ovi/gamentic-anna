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
  return runtime.call("storage", "get", { key });
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
