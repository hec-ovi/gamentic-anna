// app.js - the boot. Renders the Emberlight stage standalone, and connects to
// Anna's host runtime WHEN it is present. The SDK import is dynamic + guarded so
// the page still loads (and renders a full mock turn) in a plain static preview
// where the SDK URL does not exist.
//
// On a live connect this drives the real turn loop: one agent session with the
// GM ruleset, each player action streamed through it, the assistant text parsed
// into a presentation state, folded into the running game, rendered, and
// persisted under a single storage key so a reload resumes the adventure.

import { renderTurn, setBusy, pushWhisperReply } from "./render.js";
import {
  GM_RULESET,
  reduceTurn,
  assistantText,
  recap,
  parsePresentation,
  saveState,
  loadState,
} from "./core.js";

let root = document.getElementById("root");

// The single storage key the whole game persists under.
const SAVE_KEY = "game";

// The verified-live "Elder Bramble" sample turn (the one data contract). Used as
// the built-in mock so a standalone page is a beautiful, fully-populated view.
const MOCK_TURN = {
  scene: {
    text:
      "You awaken in a damp, moss-covered clearing. The air smells of pine and cold earth. Ancient trees weave a canopy overhead, their branches knit so tight the daylight comes through in coins.\n\nA faint, rhythmic chanting drifts from the woods to the east. It does not rise or fall. It simply continues, patient as rain, and something in you wants to follow it.",
    image_prompt: "a mossy dark forest clearing with ancient towering trees and heavy mist",
  },
  characters: [
    {
      name: "Elder Bramble",
      look: "a stooped old figure, weathered skin, roughspun green tunic, gnarled staff",
    },
    {
      name: "Wren",
      look: "a wiry young woman, short copper braid, freckles, patched traveling cloak",
    },
  ],
  inventory: [
    { name: "A smooth grey river stone" },
    { name: "A sealed letter" },
    { name: "Tinderbox" },
  ],
  choices: [
    "Follow the chanting east",
    "Examine the ancient trees",
    "Speak with Elder Bramble",
    "Rest and observe",
  ],
};

// The fresh-start invitation turn: no SDK story yet, so ask the player what kind
// of adventure they want. Rendered when a live session has no restored history.
const OPENING_INVITE = {
  scene: {
    text:
      "Welcome, traveler. This is a story we will write together.\n\nTell me what kind of adventure you want, in a line or two, or just say \"surprise me\" and I will conjure a world.",
    image_prompt: null,
  },
  characters: [],
  inventory: [],
  choices: ["Surprise me", "A dark fantasy dungeon", "A cozy mystery"],
};

// PREVIEW MODE handlers: no SDK, so no live calls are possible. They log so the
// standalone view is fully interactive and inspectable. Swapped for live
// handlers once Anna connects.
const previewHandlers = {
  onChoice(text) {
    console.log("[gamentic] choice:", text);
  },
  onSubmit(text) {
    console.log("[gamentic] action:", text);
  },
  onWhisper(name, message) {
    console.log("[gamentic] whisper ->", name + ":", message);
  },
};

// Render the mock turn IMMEDIATELY so the page is never blank, connected or not.
renderTurn(root, MOCK_TURN, previewHandlers);

// Try to connect to the Anna host. The SDK lives at an absolute /static path
// inside the Anna sandbox; in a plain static preview that path 404s, so the
// dynamic import is wrapped: failure just means "preview mode" and the mock
// above stays on screen with its logging handlers.
(async () => {
  let anna;
  try {
    const mod = await import("/static/anna-apps/_sdk/latest/index.js");
    anna = await mod.AnnaAppRuntime.connect();
  } catch (e) {
    console.log("[gamentic] preview mode (no Anna host):", e?.message || e);
    return;
  }

  try {
    await anna.window.set_title({ title: "Gamentic" });
  } catch {
    /* a missing title is harmless; press on */
  }

  // Restore the saved game (or start fresh), and open the GM session.
  let GAME = (await loadState(anna, SAVE_KEY)) || null;
  // Only restore a save that is actually usable: real history AND a scene whose
  // narration is non-empty and not a raw-JSON blob (defends against a corrupt
  // save from an older build). Anything else starts fresh.
  const savedScene = String((GAME && GAME.scene && GAME.scene.text) || "").trim();
  const restored = !!(
    GAME &&
    Array.isArray(GAME.history) &&
    GAME.history.length &&
    savedScene &&
    !savedScene.startsWith("{")
  );
  if (GAME && !restored) GAME = null;
  // If we restored a non-empty game, the very first live turn must re-seed the
  // fresh (memory-less) session with a recap of where the story stands.
  let NEEDS_RECAP = restored;

  const SESS = await anna.agent.session({
    submode: "auto",
    system_prompt: GM_RULESET,
  });

  // Run one turn against the GM session and parse it. Shared by public turns
  // and private whispers.
  const runOnce = async (c) => {
    const frames = [];
    for await (const ev of SESS.run({ content: c })) frames.push(ev);
    return parsePresentation(assistantText(frames));
  };
  // A turn is usable only if it parsed AND carries real narration (not empty,
  // not a raw-JSON fallback blob).
  const usable = (r) => r.ok && String(r.state.scene.text || "").trim().length > 0;

  // Live handlers: every interaction resolves a real turn through the GM.
  const handlers = {
    onChoice: (text) => takeTurn(text),
    onSubmit: (text) => takeTurn(text),
    onWhisper: (name, message) => whisperTurn(name, message),
  };

  // We are live now, so drop the preview mock cleanly: swap in a fresh #root
  // element. renderTurn keys its built stage per-element, so a new element makes
  // it rebuild from scratch (no leftover mock/preview turn in the story log).
  const freshRoot = root.cloneNode(false);
  root.replaceWith(freshRoot);
  root = freshRoot;

  // Render the current view: restored games show where they left off; a fresh
  // game shows the opening invitation. Both rebind the live handlers onto the
  // already-built stage.
  if (restored) {
    renderTurn(
      root,
      {
        scene: GAME.scene,
        characters: GAME.roster,
        inventory: GAME.inventory,
        choices: GAME.choices,
      },
      handlers,
    );
  } else {
    renderTurn(root, OPENING_INVITE, handlers);
  }

  /**
   * Resolve one player turn against the GM session: stream the assistant text,
   * parse it into a presentation state, fold it into GAME, render, and persist.
   * Locks the stage (setBusy) while it runs. On any failure it renders a gentle
   * "the world hesitates" beat that keeps the prior choices, so the game is
   * never stuck or blank.
   *
   * @param {string} actionText
   * @param {{ whisperTo?: string }} [opts]
   */
  async function takeTurn(actionText) {
    setBusy(root, true);
    try {
      const content = (NEEDS_RECAP ? recap(GAME) + "\n\n" : "") + actionText;
      NEEDS_RECAP = false;

      let res = await runOnce(content);
      // A turn can come back empty OR unparseable (truncated/malformed JSON; the
      // agent path has no structured-output enforcement). Nudge once for a clean
      // turn before giving up, so the story never shows a blank beat or raw JSON.
      if (!usable(res)) {
        const retry = await runOnce(
          "Continue. Output ONLY the JSON turn object (no other text), and scene.text MUST be a non-empty paragraph describing what happens now.",
        );
        if (usable(retry)) res = retry;
      }
      if (!usable(res)) {
        throw new Error("unusable turn (empty or unparseable)");
      }
      const state = res.state;
      GAME = reduceTurn(GAME, state);

      renderTurn(
        root,
        {
          scene: state.scene,
          characters: GAME.roster,
          inventory: state.inventory,
          choices: state.choices,
        },
        handlers,
      );

      await saveState(anna, SAVE_KEY, GAME);
    } catch (e) {
      console.log("[gamentic] turn failed:", e?.message || e);
      // graceful recovery: keep the prior choices so the player can retry.
      const priorChoices = (GAME && GAME.choices) || [];
      renderTurn(
        root,
        {
          scene: {
            text: "The world hesitates, the thread of the story slipping for a moment... (try again)",
            image_prompt: null,
          },
          characters: (GAME && GAME.roster) || [],
          inventory: (GAME && GAME.inventory) || [],
          choices: priorChoices,
        },
        handlers,
      );
    } finally {
      setBusy(root, false);
    }
  }

  /**
   * A whisper is a PRIVATE side-channel with one character: it does NOT advance
   * the public scene, change choices, or save the main game. The character's
   * reply is rendered into the whisper drawer thread via pushWhisperReply.
   * @param {string} name
   * @param {string} message
   */
  async function whisperTurn(name, message) {
    setBusy(root, true);
    try {
      const content =
        (NEEDS_RECAP ? recap(GAME) + "\n\n" : "") +
        "[private whisper to " + name + "] " + message;
      NEEDS_RECAP = false;
      const res = await runOnce(content);
      const reply = usable(res) ? res.state.scene.text.trim() : "";
      pushWhisperReply(root, name, reply || "(" + name + " only watches you in silence.)");
    } catch (e) {
      console.log("[gamentic] whisper failed:", e?.message || e);
      pushWhisperReply(root, name, "(" + name + " seems distracted, and does not answer.)");
    } finally {
      setBusy(root, false);
    }
  }

  console.log("[gamentic] connected to Anna");
})();
