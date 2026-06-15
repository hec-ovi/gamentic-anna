// @vitest-environment happy-dom
//
// Behavioral tests for the Emberlight renderer (bundle/render.js). These render
// the REAL presentation-state contract into a live DOM and assert what a player
// (and a screen reader) would actually perceive, queried by role / accessible
// name / visible text - never by internal class names where a role exists.
//
// They pin the critique fixes that elevated the UI:
//   - INVENTORY reads as named items (glyph + name), not cryptic 2-letter
//     monograms, and two differently-named items never collide.
//   - The empty-handed strip shows ONE quiet line, not a row of dashed boxes.
//   - The PERSISTENT-CHARACTER rail renders the WHOLE roster (3-5 cards), not a
//     single card, and new entrants get the arrival reveal.
//   - The pure label helpers strip leading articles + punctuation.

import { describe, it, expect, beforeEach } from "vitest";
import {
  renderTurn,
  initials,
  stripArticle,
  itemGlyphName,
  itemLabel,
} from "../bundle/render.js";

// happy-dom provides window/document; requestAnimationFrame is used by the
// whisper drawer open path but not by renderTurn - provide a shim just in case.
if (typeof globalThis.requestAnimationFrame !== "function") {
  globalThis.requestAnimationFrame = (cb) => setTimeout(() => cb(Date.now()), 0);
}

const SAMPLE = {
  scene: {
    text: "You awaken in a damp, moss-covered clearing. A faint chanting drifts from the east.",
    image_prompt: "a mossy dark forest clearing with ancient towering trees and heavy mist",
  },
  characters: [
    { name: "Elder Bramble", look: "a stooped old figure, gnarled staff" },
    { name: "Wren", look: "a wiry young woman, short copper braid" },
  ],
  inventory: [
    { name: "A smooth grey river stone" },
    { name: "A sealed letter" },
    { name: "Tinderbox" },
  ],
  choices: ["Follow the chanting east", "Examine the ancient trees"],
};

function freshRoot() {
  document.body.innerHTML = "";
  const root = document.createElement("main");
  document.body.appendChild(root);
  return root;
}

let root;
beforeEach(() => {
  root = freshRoot();
});

// --- pure label helpers ----------------------------------------------------

describe("inventory label helpers (pure)", () => {
  it("stripArticle removes a leading article, case-insensitively", () => {
    expect(stripArticle("A sealed letter")).toBe("sealed letter");
    expect(stripArticle("An apple")).toBe("apple");
    expect(stripArticle("The Crown of Vell")).toBe("Crown of Vell");
    expect(stripArticle("Tinderbox")).toBe("Tinderbox"); // no article -> unchanged
  });

  it("initials strips articles + punctuation so distinct items never collide", () => {
    // The two mock items that used to BOTH render 'AS'.
    const a = initials("A smooth grey river stone");
    const b = initials("A sealed letter");
    expect(a).not.toBe(b); // the core regression: they must differ
    expect(a).toBe("SG");
    expect(b).toBe("SL");
  });

  it("initials never emits a punctuation 'initial' like the old 'R('", () => {
    const r = initials("Rope (50ft)");
    expect(r).not.toMatch(/[^A-Z0-9]/); // letters/digits only
    expect(r).toBe("R5");
  });

  it("itemLabel strips the article and titlecases", () => {
    expect(itemLabel("A sealed letter")).toBe("Sealed letter");
    expect(itemLabel("some bread")).toBe("Bread");
  });

  it("itemLabel truncates long names with an ellipsis (full name kept elsewhere)", () => {
    const label = itemLabel("Ancient tome of forbidden and forgotten secrets");
    expect(label.length).toBeLessThanOrEqual(22);
    expect(label.endsWith("…")).toBe(true);
  });

  it("itemGlyphName maps keywords to an object glyph, default 'gem'", () => {
    expect(itemGlyphName("A tiny iron key")).toBe("key");
    expect(itemGlyphName("A sealed letter")).toBe("scroll");
    expect(itemGlyphName("Tinderbox")).toBe("flame");
    expect(itemGlyphName("Rope (50ft)")).toBe("rope");
    expect(itemGlyphName("Healing draught")).toBe("flask");
    expect(itemGlyphName("A smooth grey river stone")).toBe("gem");
    expect(itemGlyphName("An unidentifiable thing")).toBe("gem"); // fallback
  });
});

// --- INVENTORY pillar (rendered) -------------------------------------------

describe("INVENTORY renders as readable named items", () => {
  it("each item is a button exposing its FULL name as the accessible name", () => {
    renderTurn(root, SAMPLE, {});

    // queried by accessible role + name, the way a screen reader sees them
    for (const it of SAMPLE.inventory) {
      const btn = [...root.querySelectorAll("button")].find(
        (b) => b.getAttribute("aria-label") === it.name,
      );
      expect(btn, `a button named "${it.name}"`).toBeTruthy();
      // the visible label is human text, NOT a 2-letter monogram
      const visible = btn.querySelector(".item-label").textContent;
      expect(visible.length).toBeGreaterThan(2);
    }
  });

  it("the two formerly-colliding items render as DISTINCT, readable chips", () => {
    renderTurn(root, SAMPLE, {});

    // The two items that BOTH used to render the cryptic 'AS' badge: their FULL
    // names survive verbatim as the accessible name (hover/SR), and their
    // visible labels are human words that differ from each other.
    const byName = (n) =>
      [...root.querySelectorAll(".item-chip")].find(
        (b) => b.getAttribute("aria-label") === n,
      );
    const stone = byName("A smooth grey river stone");
    const letter = byName("A sealed letter");
    expect(stone).toBeTruthy();
    expect(letter).toBeTruthy();

    const stoneLabel = stone.querySelector(".item-label").textContent;
    const letterLabel = letter.querySelector(".item-label").textContent;
    expect(stoneLabel).not.toBe(letterLabel); // the old 'AS' == 'AS' collision
    expect(letterLabel).toBe("Sealed letter");
    expect(stoneLabel.startsWith("Smooth grey river")).toBe(true);

    // every visible label across the strip is unique (no two items look alike)
    const labels = [...root.querySelectorAll(".item-label")].map((n) => n.textContent);
    expect(new Set(labels).size).toBe(labels.length);
  });

  it("does NOT pad with dashed empty slots (no half-empty look)", () => {
    renderTurn(root, SAMPLE, {});
    // 3 real items -> exactly 3 chips, zero empty padding slots.
    expect(root.querySelectorAll(".item-chip")).toHaveLength(3);
    expect(root.querySelectorAll(".slot.empty")).toHaveLength(0);
  });

  it("with NO items shows one quiet hint, not a grid of empty boxes", () => {
    renderTurn(root, { ...SAMPLE, inventory: [] }, {});
    expect(root.querySelectorAll(".item-chip")).toHaveLength(0);
    expect(root.querySelectorAll(".slot.empty")).toHaveLength(0);
    const hint = root.querySelector(".inv-empty");
    expect(hint).toBeTruthy();
    expect(hint.textContent.trim().length).toBeGreaterThan(0);
  });

  it("caps the carry strip at 12 chips for a dense roster", () => {
    const many = Array.from({ length: 16 }, (_, i) => ({ name: `Relic ${i}` }));
    renderTurn(root, { ...SAMPLE, inventory: many }, {});
    expect(root.querySelectorAll(".item-chip")).toHaveLength(12);
  });
});

// --- PERSISTENT CHARACTERS pillar (rendered) -------------------------------

describe("CAST rail renders the whole roster (not a single card)", () => {
  it("renders one card per character, each opening that character's profile", () => {
    const roster = [
      { name: "Elder Bramble", look: "a stooped old figure" },
      { name: "Wren", look: "a wiry young woman" },
      { name: "Vell", look: "a masked stranger" },
      { name: "Mara", look: "a tall warden" },
      { name: "Pike", look: "a grinning thief" },
    ];
    renderTurn(root, { ...SAMPLE, characters: roster }, {});

    const cards = root.querySelectorAll(".char-col");
    expect(cards).toHaveLength(5); // the regression: it used to show ONE

    // every roster member is present and reachable by their accessible name
    for (const c of roster) {
      const open = [...root.querySelectorAll("button")].find(
        (b) => b.getAttribute("aria-label") === `Open ${c.name}'s profile`,
      );
      expect(open, `a profile button for ${c.name}`).toBeTruthy();
      const whisper = [...root.querySelectorAll("button")].find(
        (b) => b.getAttribute("aria-label") === `Whisper to ${c.name}`,
      );
      expect(whisper, `a whisper button for ${c.name}`).toBeTruthy();
    }
  });

  it("does not force a tall fixed aspect-ratio that lets one card fill the rail", () => {
    renderTurn(root, SAMPLE, {});
    const art = root.querySelector(".col-art");
    // the fix removed the inline/forced 3/5 ratio; height is capped via CSS class
    expect(art.style.aspectRatio).toBeFalsy();
  });

  it("only genuinely NEW entrants get the arrival reveal on a later turn", () => {
    renderTurn(root, SAMPLE, {}); // turn 1: Bramble + Wren both arrive
    let arriving = root.querySelectorAll(".char-col.card-arrive");
    expect(arriving).toHaveLength(2);

    // turn 2: Wren persists, Vell is new
    renderTurn(
      root,
      {
        ...SAMPLE,
        characters: [
          { name: "Elder Bramble", look: "a stooped old figure" },
          { name: "Wren", look: "a wiry young woman" },
          { name: "Vell", look: "a masked stranger" },
        ],
      },
      {},
    );
    arriving = root.querySelectorAll(".char-col.card-arrive");
    expect(arriving).toHaveLength(1);
    expect(arriving[0].getAttribute("data-char-name")).toBe("Vell");
  });

  it("with no one present shows a quiet empty line", () => {
    renderTurn(root, { ...SAMPLE, characters: [] }, {});
    expect(root.querySelectorAll(".char-col")).toHaveLength(0);
    expect(root.querySelector(".char-empty")).toBeTruthy();
  });
});
