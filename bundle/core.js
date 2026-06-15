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
