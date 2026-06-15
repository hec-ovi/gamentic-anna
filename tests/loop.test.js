// Behavioral tests for the live turn loop's PURE core (bundle/core.js):
//   - reduceTurn folds a parsed presentation state into the running game
//     immutably: scene/inventory/choices set, roster merged by name (add /
//     update / no-dup / order), history appended and capped at 40, null game
//     initializes.
//   - assistantText concatenates the streamed text deltas, ignoring non-text
//     frames, and returns "" for empty/garbage input.
// No DOM, no SDK: these are plain vitest unit tests over pure functions.

import { describe, it, expect } from "vitest";
import { reduceTurn, assistantText, parsePresentation, whisperReply } from "../bundle/core.js";

// A small presentation-state factory (the shape parsePresentation emits).
function state(over = {}) {
  return {
    scene: { text: "A beat.", image_prompt: "a place" },
    characters: [],
    inventory: [],
    choices: ["go on"],
    ...over,
  };
}

describe("reduceTurn", () => {
  it("initializes from a null/empty game with empty arrays", () => {
    const g = reduceTurn(null, state());
    expect(g.scene).toEqual({ text: "A beat.", image_prompt: "a place" });
    expect(g.roster).toEqual([]);
    expect(g.inventory).toEqual([]);
    expect(g.choices).toEqual(["go on"]);
    expect(g.history).toEqual([{ narration: "A beat." }]);

    // undefined game is handled the same way
    expect(reduceTurn(undefined, state()).history).toEqual([{ narration: "A beat." }]);
  });

  it("sets scene, inventory and choices from the incoming state", () => {
    const g = reduceTurn(null, state({
      scene: { text: "You enter the hall.", image_prompt: "a stone hall" },
      inventory: [{ name: "A torch" }, { name: "A key" }],
      choices: ["light the torch", "open the door"],
    }));
    expect(g.scene).toEqual({ text: "You enter the hall.", image_prompt: "a stone hall" });
    expect(g.inventory).toEqual([{ name: "A torch" }, { name: "A key" }]);
    expect(g.choices).toEqual(["light the torch", "open the door"]);
  });

  it("inventory is replaced each turn (the full current list), not accumulated", () => {
    let g = reduceTurn(null, state({ inventory: [{ name: "A torch" }] }));
    g = reduceTurn(g, state({ inventory: [{ name: "A key" }] }));
    expect(g.inventory).toEqual([{ name: "A key" }]);
  });

  it("merges new characters into the roster, preserving order", () => {
    let g = reduceTurn(null, state({
      characters: [{ name: "Wren", look: "copper braid" }],
    }));
    g = reduceTurn(g, state({
      characters: [
        { name: "Wren", look: "copper braid" },
        { name: "Vell", look: "a masked stranger" },
      ],
    }));
    expect(g.roster).toEqual([
      { name: "Wren", look: "copper braid" },
      { name: "Vell", look: "a masked stranger" },
    ]);
  });

  it("never duplicates a character already in the roster", () => {
    let g = reduceTurn(null, state({ characters: [{ name: "Wren", look: "copper braid" }] }));
    g = reduceTurn(g, state({ characters: [{ name: "Wren", look: "copper braid" }] }));
    g = reduceTurn(g, state({ characters: [{ name: "Wren", look: "copper braid" }] }));
    expect(g.roster).toHaveLength(1);
    expect(g.roster[0].name).toBe("Wren");
  });

  it("updates an existing character's look when the incoming look is non-empty", () => {
    let g = reduceTurn(null, state({ characters: [{ name: "Wren", look: "copper braid" }] }));
    g = reduceTurn(g, state({ characters: [{ name: "Wren", look: "now bloodied and grim" }] }));
    expect(g.roster).toEqual([{ name: "Wren", look: "now bloodied and grim" }]);
  });

  it("preserves an existing look when the incoming look is empty", () => {
    let g = reduceTurn(null, state({ characters: [{ name: "Wren", look: "copper braid" }] }));
    g = reduceTurn(g, state({ characters: [{ name: "Wren", look: "" }] }));
    g = reduceTurn(g, state({ characters: [{ name: "Wren" }] }));
    expect(g.roster).toEqual([{ name: "Wren", look: "copper braid" }]);
  });

  it("appends the scene narration to history each turn", () => {
    let g = reduceTurn(null, state({ scene: { text: "First.", image_prompt: null } }));
    g = reduceTurn(g, state({ scene: { text: "Second.", image_prompt: null } }));
    g = reduceTurn(g, state({ scene: { text: "Third.", image_prompt: null } }));
    expect(g.history).toEqual([
      { narration: "First." },
      { narration: "Second." },
      { narration: "Third." },
    ]);
  });

  it("caps history at the last 40 entries", () => {
    let g = null;
    for (let i = 1; i <= 45; i++) {
      g = reduceTurn(g, state({ scene: { text: `beat ${i}`, image_prompt: null } }));
    }
    expect(g.history).toHaveLength(40);
    // the oldest five (1-5) fell off; the window is beats 6..45
    expect(g.history[0]).toEqual({ narration: "beat 6" });
    expect(g.history[39]).toEqual({ narration: "beat 45" });
  });

  it("is immutable: the input game object is never mutated", () => {
    const before = reduceTurn(null, state({
      characters: [{ name: "Wren", look: "copper braid" }],
      inventory: [{ name: "A torch" }],
    }));
    const snapshot = structuredClone(before);
    const after = reduceTurn(before, state({
      characters: [{ name: "Vell", look: "a masked stranger" }],
      inventory: [{ name: "A key" }],
      scene: { text: "Next.", image_prompt: null },
    }));
    expect(before).toEqual(snapshot); // unchanged
    expect(after).not.toBe(before); // a new object
    expect(after.roster).toHaveLength(2);
  });

  it("never throws on a missing/garbage state", () => {
    expect(() => reduceTurn(null, null)).not.toThrow();
    expect(() => reduceTurn(null, undefined)).not.toThrow();
    const g = reduceTurn(null, {});
    expect(g.scene).toEqual({ text: "", image_prompt: null });
    expect(g.history).toEqual([{ narration: "" }]);
  });
});

describe("assistantText", () => {
  it("concatenates the text deltas across frames in order", () => {
    const frames = [
      { choices: [{ delta: { content: "Hello" } }] },
      { choices: [{ delta: { content: ", " } }] },
      { choices: [{ delta: { content: "world" } }] },
    ];
    expect(assistantText(frames)).toBe("Hello, world");
  });

  it("ignores non-text frames (no delta, no content, non-string content)", () => {
    const frames = [
      { choices: [{ delta: { content: "A" } }] },
      { choices: [{ delta: {} }] }, // no content
      { choices: [{ delta: { content: null } }] }, // null content
      { choices: [{ delta: { content: 42 } }] }, // non-string content
      { choices: [{}] }, // no delta
      {}, // no choices
      null, // not even a frame
      { choices: [{ delta: { content: "B" } }] },
    ];
    expect(assistantText(frames)).toBe("AB");
  });

  it("returns '' for empty input and for garbage (non-array)", () => {
    expect(assistantText([])).toBe("");
    expect(assistantText(undefined)).toBe("");
    expect(assistantText(null)).toBe("");
    expect(assistantText("not frames")).toBe("");
    expect(assistantText({})).toBe("");
  });

  it("never throws on malformed frames", () => {
    expect(() => assistantText([undefined, 1, "x", { choices: null }])).not.toThrow();
    expect(assistantText([undefined, 1, "x", { choices: null }])).toBe("");
  });

  // The agent stream also appears in a normalized {event,text} shape (dev mock
  // and some host builds). assistantText must handle both.
  it("concatenates normalized {event:'delta', text} frames", () => {
    const frames = [
      { event: "delta", text: "Once " },
      { event: "delta", text: "upon " },
      { event: "model_token", text: "a time" },
    ];
    expect(assistantText(frames)).toBe("Once upon a time");
  });

  it("prefers a consolidated {event:'final', text} over the deltas (no double-count)", () => {
    const frames = [
      { event: "delta", text: "He" },
      { event: "delta", text: "llo" },
      { event: "final", text: "Hello" },
    ];
    expect(assistantText(frames)).toBe("Hello");
  });

  it("ignores error frames (yields empty so the graceful fallback runs)", () => {
    expect(assistantText([{ event: "error", code: "x", message: "boom" }])).toBe("");
  });

  // The exact live whisper path: the GM answers a private whisper as plain
  // prose (NOT the JSON turn shape), streamed as real-backend SSE deltas. The
  // loop must still surface the spoken line (this was the "watches you in
  // silence" bug: gating the reply on parse.ok discarded the prose).
  it("end to end: a PLAIN-PROSE whisper reply -> assistantText -> parsePresentation -> whisperReply", () => {
    const spoken = '"Keep your voice down. The captain is not who he says he is."';
    const frames = [...spoken].map((ch) => ({ event: "sse", choices: [{ delta: { content: ch } }] }));
    const text = assistantText(frames);
    const parsed = parsePresentation(text);
    expect(parsed.ok).toBe(false); // prose, not JSON
    expect(whisperReply(parsed)).toBe(spoken); // ...yet the line is surfaced
  });

  it("end to end: a JSON whisper reply -> whisperReply reads scene.text", () => {
    const json = '{"scene":{"text":"She presses a key into your palm: \\"Go now.\\""},"characters":[],"inventory":[],"choices":[]}';
    const frames = [...json].map((ch) => ({ event: "sse", choices: [{ delta: { content: ch } }] }));
    const parsed = parsePresentation(assistantText(frames));
    expect(parsed.ok).toBe(true);
    expect(whisperReply(parsed)).toBe('She presses a key into your palm: "Go now."');
  });

  it("end to end: real-shape frames -> assistantText -> parsePresentation -> reduceTurn", () => {
    const json =
      '{"scene":{"text":"A lantern sputters.","image_prompt":"a dim hall"},' +
      '"characters":[{"name":"Mara","look":"a tall woman, dark braid"}],' +
      '"inventory":[{"name":"A brass key"}],"choices":["Open the door","Wait"]}';
    // stream it as real-backend SSE content deltas, char by char
    const frames = [...json].map((ch) => ({ event: "sse", choices: [{ delta: { content: ch } }] }));
    const text = assistantText(frames);
    const { ok, state } = parsePresentation(text);
    expect(ok).toBe(true);
    const game = reduceTurn(null, state);
    expect(game.scene.text).toBe("A lantern sputters.");
    expect(game.roster.map((c) => c.name)).toEqual(["Mara"]);
    expect(game.inventory).toEqual([{ name: "A brass key" }]);
    expect(game.choices).toEqual(["Open the door", "Wait"]);
    expect(game.history).toHaveLength(1);
  });
});
