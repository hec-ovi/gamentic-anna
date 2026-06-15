import { describe, it, expect } from "vitest";
import {
  CREATOR_RULESET,
  isCreatorReady,
  creatorCanBegin,
  upsertAdventure,
  removeAdventure,
  deriveTitle,
} from "../bundle/core.js";

describe("CREATOR_RULESET", () => {
  it("is a non-empty plain-prose ruleset that mentions the [ready] marker", () => {
    expect(typeof CREATOR_RULESET).toBe("string");
    expect(CREATOR_RULESET.length).toBeGreaterThan(0);
    expect(CREATOR_RULESET).toContain("[ready]");
    // Plain prose, not a JSON contract like the GM ruleset.
    expect(CREATOR_RULESET).toContain("Do NOT output JSON during creation.");
    // Comfortably under the backend's ~4000-char system_prompt cap.
    expect(CREATOR_RULESET.length).toBeLessThan(4000);
  });
});

describe("isCreatorReady", () => {
  it("detects a marker on its own line and strips it, keeping the prose", () => {
    const input = "Your misty harbor town is set, a hopeful tone, smugglers afoot. Shall we begin?\n[ready]";
    const r = isCreatorReady(input);
    expect(r.ready).toBe(true);
    expect(r.text).toBe(
      "Your misty harbor town is set, a hopeful tone, smugglers afoot. Shall we begin?",
    );
    expect(r.text).not.toMatch(/\[ready\]/i);
  });

  it("detects a marker at the very end of a line and strips it", () => {
    const r = isCreatorReady("All set. Let's go! [ready]");
    expect(r.ready).toBe(true);
    expect(r.text).toBe("All set. Let's go!");
  });

  it("matches the marker case-insensitively", () => {
    const r = isCreatorReady("Ready when you are.\n[READY]");
    expect(r.ready).toBe(true);
    expect(r.text).toBe("Ready when you are.");
  });

  it("returns ready:false and the trimmed text when no marker is present", () => {
    const input = "  What kind of hero do you want to play?  ";
    const r = isCreatorReady(input);
    expect(r.ready).toBe(false);
    expect(r.text).toBe("What kind of hero do you want to play?");
  });

  it("strips ALL occurrences of the marker", () => {
    const r = isCreatorReady("[ready] one [ready] two\n[ready]");
    expect(r.ready).toBe(true);
    expect(r.text).not.toMatch(/\[ready\]/i);
    expect(r.text).toBe("one two");
  });

  it("does not treat the bare word 'ready' (no brackets) as the marker", () => {
    const r = isCreatorReady("Are you ready to start?");
    expect(r.ready).toBe(false);
    expect(r.text).toBe("Are you ready to start?");
  });

  it("returns ready:false and text:'' for non-string / empty input, never throwing", () => {
    for (const bad of [null, undefined, 42, {}, [], "", "   ", "\n\n"]) {
      let r;
      expect(() => {
        r = isCreatorReady(bad);
      }).not.toThrow();
      expect(r.ready).toBe(false);
      expect(r.text).toBe("");
    }
  });
});

describe("creatorCanBegin", () => {
  it("is true immediately when the [ready] marker fired, at any exchange count", () => {
    expect(creatorCanBegin(true, 0)).toBe(true);
    expect(creatorCanBegin(true, 1)).toBe(true);
  });

  it("stays false early when not ready (the Begin gate is closed)", () => {
    expect(creatorCanBegin(false, 0)).toBe(false);
    expect(creatorCanBegin(false, 1)).toBe(false);
    expect(creatorCanBegin(false, 2)).toBe(false);
  });

  it("opens at the default floor (3 exchanges) even without the marker - never deadlocks", () => {
    expect(creatorCanBegin(false, 3)).toBe(true);
    expect(creatorCanBegin(false, 5)).toBe(true);
  });

  it("honors a custom floor", () => {
    expect(creatorCanBegin(false, 1, 2)).toBe(false);
    expect(creatorCanBegin(false, 2, 2)).toBe(true);
  });

  it("treats a bad exchange count as 0 and a bad floor as the default, never throwing", () => {
    expect(() => creatorCanBegin(false, NaN)).not.toThrow();
    expect(creatorCanBegin(false, NaN)).toBe(false);
    expect(creatorCanBegin(false, undefined)).toBe(false);
    // bad floor -> falls back to default 3
    expect(creatorCanBegin(false, 3, 0)).toBe(true);
    expect(creatorCanBegin(false, 2, -1)).toBe(false);
  });
});

describe("upsertAdventure", () => {
  const A = { id: "a", title: "Alpha", updatedAt: "2026-01-01T00:00:00Z" };
  const B = { id: "b", title: "Bravo", updatedAt: "2026-03-01T00:00:00Z" };
  const C = { id: "c", title: "Charlie", updatedAt: "2026-02-01T00:00:00Z" };

  it("inserts a new entry, sorted by updatedAt descending", () => {
    const out = upsertAdventure([A, B], C);
    expect(out.map((e) => e.id)).toEqual(["b", "c", "a"]);
  });

  it("replaces an entry by id (no duplicate) and re-sorts", () => {
    const updated = { id: "a", title: "Alpha v2", updatedAt: "2026-04-01T00:00:00Z" };
    const out = upsertAdventure([A, B, C], updated);
    expect(out.map((e) => e.id)).toEqual(["a", "b", "c"]);
    expect(out.find((e) => e.id === "a").title).toBe("Alpha v2");
    // Exactly one entry with id "a".
    expect(out.filter((e) => e.id === "a")).toHaveLength(1);
  });

  it("sorts a missing updatedAt last", () => {
    const noDate = { id: "z", title: "Zeta" };
    const out = upsertAdventure([A, B], noDate);
    expect(out.map((e) => e.id)).toEqual(["b", "a", "z"]);
    expect(out[2].updatedAt).toBe("");
  });

  it("never mutates the input array or its entries", () => {
    const index = [A, B];
    const snapshot = JSON.stringify(index);
    const out = upsertAdventure(index, C);
    expect(JSON.stringify(index)).toBe(snapshot);
    expect(index).toHaveLength(2);
    expect(out).not.toBe(index);
    // The original entry objects are not reused/mutated in the output.
    expect(out.find((e) => e.id === "a")).not.toBe(A);
  });

  it("ignores an entry with no id, returning a clean sorted copy", () => {
    const out = upsertAdventure([A, B], { title: "no id here" });
    expect(out.map((e) => e.id)).toEqual(["b", "a"]);
    expect(out).toHaveLength(2);
  });

  it("treats a missing / non-array index as []", () => {
    expect(upsertAdventure(undefined, A)).toEqual([
      { id: "a", title: "Alpha", updatedAt: "2026-01-01T00:00:00Z" },
    ]);
    expect(upsertAdventure("not an array", B).map((e) => e.id)).toEqual(["b"]);
    expect(upsertAdventure(null, { title: "no id" })).toEqual([]);
  });

  it("never throws on garbage entries inside the index", () => {
    let out;
    expect(() => {
      out = upsertAdventure([A, null, "junk", 7, { foo: "bar" }, B], C);
    }).not.toThrow();
    // Only entries with a usable id survive.
    expect(out.map((e) => e.id).sort()).toEqual(["a", "b", "c"]);
  });
});

describe("removeAdventure", () => {
  const A = { id: "a", title: "Alpha", updatedAt: "2026-01-01T00:00:00Z" };
  const B = { id: "b", title: "Bravo", updatedAt: "2026-03-01T00:00:00Z" };

  it("removes the entry whose id matches", () => {
    const out = removeAdventure([A, B], "a");
    expect(out.map((e) => e.id)).toEqual(["b"]);
  });

  it("is a no-op when the id is absent (returns a clean copy)", () => {
    const out = removeAdventure([A, B], "missing");
    expect(out.map((e) => e.id)).toEqual(["a", "b"]);
  });

  it("never mutates the input array", () => {
    const index = [A, B];
    const snapshot = JSON.stringify(index);
    const out = removeAdventure(index, "a");
    expect(JSON.stringify(index)).toBe(snapshot);
    expect(index).toHaveLength(2);
    expect(out).not.toBe(index);
  });

  it("treats a missing / non-array index as [] and never throws", () => {
    for (const bad of [undefined, null, "nope", 99, {}]) {
      let out;
      expect(() => {
        out = removeAdventure(bad, "a");
      }).not.toThrow();
      expect(out).toEqual([]);
    }
  });

  it("drops garbage entries while removing the target", () => {
    const out = removeAdventure([A, null, "junk", { foo: 1 }, B], "b");
    expect(out.map((e) => e.id)).toEqual(["a"]);
  });
});

describe("deriveTitle", () => {
  it("passes short text through unchanged", () => {
    expect(deriveTitle("The Sunken City")).toBe("The Sunken City");
  });

  it("truncates long text on a word boundary, <= max, with a single ellipsis", () => {
    const long =
      "A vast and ancient kingdom of glittering towers and forgotten halls";
    const out = deriveTitle(long, 24);
    expect(out.length).toBeLessThanOrEqual(24);
    // No mid-word cut: the part before the ellipsis is whole words.
    expect(out.endsWith("…")).toBe(true);
    const words = out.slice(0, -1).trim();
    expect(long.startsWith(words)).toBe(true);
    // The next char in the source after the kept words is a space (word boundary).
    expect(long[words.length]).toBe(" ");
  });

  it("strips surrounding quotes and markdown emphasis", () => {
    expect(deriveTitle('"The Hollow Crown"')).toBe("The Hollow Crown");
    expect(deriveTitle("**The Hollow Crown**")).toBe("The Hollow Crown");
    expect(deriveTitle("## The Hollow Crown")).toBe("The Hollow Crown");
    expect(deriveTitle('**"The Hollow Crown"**')).toBe("The Hollow Crown");
  });

  it("takes the first line of multiline input", () => {
    expect(deriveTitle("Whispering Pines\nA quiet woodland mystery.")).toBe(
      "Whispering Pines",
    );
  });

  it("takes the first sentence of a long opening narration", () => {
    const narration =
      "You awaken in a damp clearing. Chanting drifts from the woods to the east.";
    expect(deriveTitle(narration)).toBe("You awaken in a damp clearing.");
  });

  it("falls back to 'Untitled adventure' for empty / non-string input", () => {
    for (const bad of ["", "   ", "\n\n", null, undefined, 42, {}, []]) {
      let out;
      expect(() => {
        out = deriveTitle(bad);
      }).not.toThrow();
      expect(out).toBe("Untitled adventure");
    }
  });

  it("respects a custom max and never throws on a bad max", () => {
    expect(deriveTitle("alpha beta gamma delta", 11)).toBe("alpha beta…");
    let out;
    expect(() => {
      out = deriveTitle("alpha beta gamma", -5);
    }).not.toThrow();
    expect(typeof out).toBe("string");
  });

  it("hard-cuts a single word longer than max (no word boundary to honor)", () => {
    const out = deriveTitle("Supercalifragilisticexpialidocious", 10);
    expect(out.length).toBeLessThanOrEqual(10);
    expect(out.endsWith("…")).toBe(true);
  });
});
