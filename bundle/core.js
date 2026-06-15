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
