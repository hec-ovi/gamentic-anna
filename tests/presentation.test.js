import { describe, it, expect } from "vitest";
import { parsePresentation } from "../bundle/core.js";

// The verified-live "Elder Bramble" turn: the one structured contract the UI
// renders. Used clean, fenced, and prose-wrapped below.
const SAMPLE = {
  scene: {
    text: "You awaken in a damp, moss-covered clearing. Chanting drifts from the woods to the east.",
    image_prompt:
      "a mossy, dark forest clearing with ancient towering trees and heavy mist",
  },
  characters: [
    {
      name: "Elder Bramble",
      look: "A stooped figure, weathered skin, roughspun green tunic, gnarled staff",
    },
  ],
  inventory: [{ name: "A smooth, grey river stone" }],
  choices: [
    "Follow the sound of chanting",
    "Examine the surrounding trees",
    "Rest and observe the clearing",
  ],
};
const SAMPLE_JSON = JSON.stringify(SAMPLE);

describe("parsePresentation", () => {
  it("(a) clean JSON: parses the Elder Bramble sample into the strict shape", () => {
    const r = parsePresentation(SAMPLE_JSON);
    expect(r.ok).toBe(true);
    expect(r.raw).toBe(SAMPLE_JSON);
    expect(r.state.scene.text.length).toBeGreaterThan(0);
    expect(r.state.scene.image_prompt).toBe(SAMPLE.scene.image_prompt);
    expect(r.state.characters).toHaveLength(1);
    expect(r.state.characters[0]).toEqual({
      name: "Elder Bramble",
      look: SAMPLE.characters[0].look,
    });
    expect(r.state.inventory).toHaveLength(1);
    expect(r.state.inventory[0]).toEqual({ name: "A smooth, grey river stone" });
    expect(r.state.choices).toHaveLength(3);
  });

  it("(b) markdown-fenced: strips a ```json fence and parses", () => {
    const r = parsePresentation("```json\n" + SAMPLE_JSON + "\n```");
    expect(r.ok).toBe(true);
    expect(r.state.characters).toHaveLength(1);
    expect(r.state.characters[0].name).toBe("Elder Bramble");
    expect(r.state.choices).toHaveLength(3);

    // A bare (language-less) fence also works.
    const bare = parsePresentation("```\n" + SAMPLE_JSON + "\n```");
    expect(bare.ok).toBe(true);
    expect(bare.state.inventory).toHaveLength(1);
  });

  it("(c) prose-wrapped: extracts first { to last } from surrounding text", () => {
    const wrapped = "Here is your turn:\n" + SAMPLE_JSON + "\nEnjoy!";
    const r = parsePresentation(wrapped);
    expect(r.ok).toBe(true);
    expect(r.raw).toBe(wrapped);
    expect(r.state.scene.text.length).toBeGreaterThan(0);
    expect(r.state.characters).toHaveLength(1);
    expect(r.state.choices).toHaveLength(3);
  });

  it("(d) partial: missing image_prompt and inventory -> null and []", () => {
    const partial = JSON.stringify({
      scene: { text: "A quiet hall." },
      characters: [{ name: "Warden", look: "tall, armored" }],
      choices: ["Wait", "Leave"],
    });
    const r = parsePresentation(partial);
    expect(r.ok).toBe(true);
    expect(r.state.scene.text).toBe("A quiet hall.");
    expect(r.state.scene.image_prompt).toBeNull();
    expect(r.state.inventory).toEqual([]);
    expect(r.state.characters).toHaveLength(1);
    expect(r.state.choices).toEqual(["Wait", "Leave"]);
  });

  it("(e) bad types: coerces/drops bad entries, never throws, shape intact", () => {
    const messy = JSON.stringify({
      // scene entirely missing
      characters: [
        { name: "Lyra" }, // missing look -> look coerced to ""
        { look: "no name here" }, // no name -> dropped
        "not an object", // dropped
        null, // dropped
      ],
      inventory: [{ name: "Torch" }, { foo: "bar" }, 42],
      choices: ["Go north", 7, "", null, "Go south"], // numbers/empties dropped
    });

    let r;
    expect(() => {
      r = parsePresentation(messy);
    }).not.toThrow();

    expect(r.ok).toBe(true);
    // scene missing -> safe defaults.
    expect(r.state.scene.text).toBe("");
    expect(r.state.scene.image_prompt).toBeNull();
    // Only the named character survives, with look coerced to "".
    expect(r.state.characters).toEqual([{ name: "Lyra", look: "" }]);
    // Only the named inventory entry survives.
    expect(r.state.inventory).toEqual([{ name: "Torch" }]);
    // Only the string choices survive.
    expect(r.state.choices).toEqual(["Go north", "Go south"]);
  });

  it("(e2) defensive: characters as a string, choices as a number -> dropped to []", () => {
    const wrong = JSON.stringify({
      scene: "the scene is a string, not an object",
      characters: "Elder Bramble",
      inventory: 5,
      choices: 99,
    });
    let r;
    expect(() => {
      r = parsePresentation(wrong);
    }).not.toThrow();
    expect(r.ok).toBe(true);
    // scene is a string (not an object) -> safe defaults, no crash.
    expect(r.state.scene.text).toBe("");
    expect(r.state.scene.image_prompt).toBeNull();
    expect(r.state.characters).toEqual([]);
    expect(r.state.inventory).toEqual([]);
    expect(r.state.choices).toEqual([]);
  });

  it("(f) pure prose (no JSON): falls back to raw text, ok:false, empty arrays", () => {
    const prose = "You enter a dark cave.";
    const r = parsePresentation(prose);
    expect(r.ok).toBe(false);
    expect(r.state.scene.text).toBe(prose);
    expect(r.state.scene.image_prompt).toBeNull();
    expect(r.state.characters).toEqual([]);
    expect(r.state.inventory).toEqual([]);
    expect(r.state.choices).toEqual([]);
    expect(r.raw).toBe(prose);
  });

  it("(g) garbage / empty / non-string input: never throws, ok:false", () => {
    for (const bad of ["", "   ", "}{ not json", "<<<>>>", "{ broken", null, undefined, 42]) {
      let r;
      expect(() => {
        r = parsePresentation(bad);
      }).not.toThrow();
      expect(r.ok).toBe(false);
      expect(r.state.characters).toEqual([]);
      expect(r.state.inventory).toEqual([]);
      expect(r.state.choices).toEqual([]);
      expect(r.state.scene.image_prompt).toBeNull();
    }
  });
});
