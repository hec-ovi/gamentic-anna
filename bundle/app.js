// app.js - the boot. Renders the Gamentic stage standalone, and connects to
// Anna's host runtime WHEN it is present. The SDK import is dynamic + guarded so
// the page still loads (and renders a full mock turn) in a plain static preview
// where the SDK URL does not exist.
//
// On a live connect this drives THREE modes:
//   - home    : the saved-adventures picker (renderHome, if present).
//   - creator : a short world-building chat (CREATOR_RULESET) that ends in a
//               "Begin the adventure" choice once the world is ready.
//   - play    : the real turn loop (GM_RULESET) - each player action streamed
//               through the session, parsed into a presentation state, folded
//               into the running game, rendered, and persisted per-adventure.
//
// Multiple adventures persist under an INDEX of { id, title, updatedAt } plus a
// per-adventure key `adv:<id>` holding the game object, so the home screen can
// list, resume, and delete saved stories.

// renderTurn + setBusy are REQUIRED contract exports (always present).
import { renderTurn, setBusy } from "./render.js";
// renderHome + pushWhisperReply are OPTIONAL/incremental exports: read them
// through a namespace so a missing one degrades to `undefined` (a static named
// import of a not-yet-shipped export would fail the whole module at link time).
import * as R from "./render.js";
import {
  GM_RULESET,
  CREATOR_RULESET,
  reduceTurn,
  assistantText,
  recap,
  parsePresentation,
  whisperReply,
  saveState,
  loadState,
  isCreatorReady,
  creatorCanBegin,
  upsertAdventure,
  removeAdventure,
  deriveTitle,
} from "./core.js";

let root = document.getElementById("root");

// The index of saved adventures: an array of { id, title, updatedAt }.
const INDEX_KEY = "adventures";

// One-line model switch: leave null to use the host default; set to
// { hints: [{ name: "<model>" }] } to route every session to a stronger model.
const MODEL_PREFS = null;

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
  onHome() {
    console.log("[gamentic] home");
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

  // We are live now, so drop the preview mock cleanly: swap in a fresh #root
  // element. renderTurn keys its built stage per-element, so a new element makes
  // it rebuild from scratch (no leftover mock/preview turn in the story log).
  const freshRoot = root.cloneNode(false);
  root.replaceWith(freshRoot);
  root = freshRoot;

  // --- live mode state -----------------------------------------------------
  // MODE routes every interaction; the rest is the current adventure's session
  // and game, plus the creator's transient readiness/summary.
  let MODE = "home"; // "home" | "creator" | "play"
  let SESS = null; // the open agent session for the current mode
  let GAME = null; // the running game object (play mode)
  let CURRENT_ID = null; // the id of the adventure being created / played
  let NEEDS_RECAP = false; // a resumed game re-seeds the fresh session once
  let creatorReady = false; // the creator has signalled the world is ready
  let creatorTurns = 0; // how many creator exchanges the player has completed
  let lastCreatorText = ""; // the latest creator prose (the agreed-on world)

  // Open a fresh agent session with the given system prompt, routing through the
  // configured model when MODEL_PREFS is set.
  const newSession = (systemPrompt) =>
    anna.agent.session({
      submode: "auto",
      system_prompt: systemPrompt,
      ...(MODEL_PREFS ? { modelPreferences: MODEL_PREFS } : {}),
    });

  // Run one turn against the CURRENT session and parse it. Shared by creator
  // prompts, opening seeds, public play turns, and private whispers.
  const runOnce = async (c) => {
    const frames = [];
    for await (const ev of SESS.run({ content: c })) frames.push(ev);
    return parsePresentation(assistantText(frames));
  };

  // A turn is usable only if it parsed AND carries real narration (not empty,
  // not a raw-JSON fallback blob).
  const usable = (r) => r.ok && String(r.state.scene.text || "").trim().length > 0;

  // Load the saved-adventures index, tolerantly (anything non-array -> []).
  const loadIndex = async () => {
    const i = await loadState(anna, INDEX_KEY);
    return Array.isArray(i) ? i : [];
  };

  // Persist the current game under its per-adventure key and upsert its index
  // entry (so the home screen lists it with a fresh title + timestamp).
  const persist = async () => {
    GAME.title = GAME.title || deriveTitle(GAME.scene && GAME.scene.text);
    await saveState(anna, `adv:` + CURRENT_ID, GAME);
    const idx = upsertAdventure(await loadIndex(), {
      id: CURRENT_ID,
      title: GAME.title,
      updatedAt: Date.now(),
    });
    await saveState(anna, INDEX_KEY, idx);
  };

  // --- handlers ------------------------------------------------------------
  // ONE handlers object, rebound on every renderTurn. It routes by MODE so the
  // same choice/submit affordances drive creation in creator mode and the story
  // in play mode. The whisper drawer is play-only.
  const handlers = {
    onChoice: (text) => onAction(text),
    onSubmit: (text) => onAction(text),
    onWhisper: (name, message) => {
      if (MODE === "play") whisperTurn(name, message);
    },
    onHome: async () => {
      if (MODE === "play" && GAME) {
        try {
          await persist();
        } catch (e) {
          console.log("[gamentic] persist on home failed:", e?.message || e);
        }
      }
      await showHome();
    },
  };

  // The home-screen handlers (passed to renderHome only).
  const homeHandlers = {
    onNewAdventure: () => startCreator(),
    onResume: (id) => resumeAdventure(id),
    onDelete: (id) => deleteAdventure(id),
  };

  // A public action: in creator mode it either begins the adventure (the special
  // "Begin the adventure" choice) or advances the design chat; in play mode it
  // resolves a story turn.
  function onAction(text) {
    if (MODE === "creator") {
      if (text === "Begin the adventure") return beginAdventure();
      return creatorTurn(text);
    }
    if (MODE === "play") return takeTurn(text);
  }

  // --- render helpers ------------------------------------------------------
  // Swap in a fresh, empty #root element so the NEXT renderTurn rebuilds the
  // stage from scratch instead of APPENDING to the prior mode's beats. This is
  // what keeps the world-building chat from bleeding into the opening play scene
  // (creation and gameplay are two different views). renderTurn keys its built
  // stage per-element, so handing it a brand-new element forces a clean rebuild;
  // `root` is reassigned so every later call paints the fresh element.
  const resetStage = () => {
    const fresh = root.cloneNode(false);
    root.replaceWith(fresh);
    root = fresh;
  };

  // renderPlay reads GAME.roster for the persistent cast (the reducer keeps the
  // full roster across turns; an incoming turn only names who is present now).
  const renderPlay = (state) =>
    renderTurn(
      root,
      {
        scene: state.scene,
        characters: (GAME && GAME.roster) || [],
        inventory: state.inventory,
        choices: state.choices,
      },
      handlers,
      { mode: "play" },
    );

  // renderCreator paints the design chat as prose with no cast/inventory; once
  // the world is ready it offers the single "Begin the adventure" choice.
  const renderCreator = (text, ready) =>
    renderTurn(
      root,
      {
        scene: { text, image_prompt: null },
        characters: [],
        inventory: [],
        // The "Begin" choice is always passed (so the button exists in the
        // creator UI), but opts.ready GATES it: the frontend keeps Begin
        // inert/hidden until ready is true. creatorCanBegin computes ready as
        // "[ready] marker OR enough exchanges", so the gate always opens
        // eventually and the player is never deadlocked behind a silent model.
        choices: ["Begin the adventure"],
      },
      handlers,
      { mode: "creator", ready: !!ready },
    );

  // Show a whisper reply: into the drawer if the frontend ships pushWhisperReply,
  // else fall back to a quiet narration beat so the reply is never lost.
  const showWhisper = (name, text) => {
    if (typeof R.pushWhisperReply === "function") {
      R.pushWhisperReply(root, name, text);
    } else {
      renderPlay({
        scene: { text: name + ' (privately): "' + text + '"', image_prompt: null },
        characters: (GAME && GAME.roster) || [],
        inventory: (GAME && GAME.inventory) || [],
        choices: (GAME && GAME.choices) || [],
      });
    }
  };

  // --- flows ---------------------------------------------------------------

  // HOME: list saved adventures. If the renderer has no home screen yet, degrade
  // gracefully - resume the most recent adventure, or start the creator fresh.
  async function showHome() {
    MODE = "home";
    const idx = await loadIndex();
    if (typeof R.renderHome === "function") {
      R.renderHome(root, idx, homeHandlers);
    } else if (idx.length) {
      return resumeAdventure(idx[0].id);
    } else {
      return startCreator();
    }
  }

  // CREATOR: open a world-building session and ask the first question. A new
  // adventure id is minted now so a "Begin" persists under a stable key.
  async function startCreator() {
    MODE = "creator";
    CURRENT_ID = crypto.randomUUID();
    GAME = null;
    creatorReady = false;
    creatorTurns = 0;
    NEEDS_RECAP = false;
    SESS = await newSession(CREATOR_RULESET);
    setBusy(root, true);
    try {
      const res = await runOnce(
        "Greet me warmly and ask your first question to start designing the world.",
      );
      const t =
        (res.state.scene.text || "").trim() ||
        "Let us design your world. What kind of adventure do you want?";
      const { ready, text } = isCreatorReady(t);
      creatorReady = ready;
      lastCreatorText = text;
      renderCreator(text, creatorCanBegin(ready, creatorTurns));
    } catch (e) {
      console.log("[gamentic] creator open failed:", e?.message || e);
      renderCreator(
        "Let us design your world. What kind of adventure do you want?",
        false,
      );
    } finally {
      setBusy(root, false);
    }
  }

  // CREATOR turn: advance the design chat with the player's reply, re-evaluating
  // readiness each time (the architect drops [ready] if they change direction).
  async function creatorTurn(reply) {
    setBusy(root, true);
    try {
      const res = await runOnce(reply);
      const t = (res.state.scene.text || "").trim();
      const { ready, text } = isCreatorReady(t);
      creatorReady = ready;
      creatorTurns += 1;
      if (text) lastCreatorText = text;
      renderCreator(text || "(...)", creatorCanBegin(creatorReady, creatorTurns));
    } catch (e) {
      console.log("[gamentic] creator turn failed:", e?.message || e);
      renderCreator(
        "(The architect pauses for a moment... say more, or try again.)",
        creatorReady,
      );
    } finally {
      setBusy(root, false);
    }
  }

  // BEGIN: leave the creator, open a fresh GM session, and seed the opening
  // scene from the agreed-on world. One nudge-retry if the first turn is unusable;
  // on total failure fall back to the creator so "Begin" can be pressed again.
  async function beginAdventure() {
    setBusy(root, true);
    try {
      MODE = "play";
      SESS = await newSession(GM_RULESET);
      NEEDS_RECAP = false;
      const seed =
        "Begin the adventure we just designed. The world: " +
        (lastCreatorText || "a world of your choosing") +
        "\n\nOpen with the first scene now. Give the player 1 to 3 starting items that fit this world (fill the inventory), and name any characters present.";
      let res = await runOnce(seed);
      if (!usable(res)) {
        const retry = await runOnce(
          "Continue. Output ONLY the JSON turn object (no other text), scene.text a non-empty opening paragraph.",
        );
        if (usable(retry)) res = retry;
      }
      if (!usable(res)) throw new Error("opening failed");
      GAME = reduceTurn(null, res.state);
      GAME.title = deriveTitle(lastCreatorText || res.state.scene.text);
      await persist();
      // Leave the creation chat behind: paint the opening on a fresh stage so the
      // world-building beats do not appear in the playable story.
      resetStage();
      renderPlay(res.state);
    } catch (e) {
      console.log("[gamentic] begin failed:", e?.message || e);
      MODE = "creator";
      renderCreator("(The world resists taking shape... press Begin again.)", true);
    } finally {
      setBusy(root, false);
    }
  }

  /**
   * Resolve one player turn against the GM session: stream the assistant text,
   * parse it into a presentation state, fold it into GAME, render, and persist.
   * Locks the stage (setBusy) while it runs. On any failure it renders a gentle
   * "the world hesitates" beat that keeps the prior choices, so the game is
   * never stuck or blank.
   *
   * @param {string} actionText
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
      const keepTitle = GAME && GAME.title;
      GAME = reduceTurn(GAME, state);
      if (keepTitle) GAME.title = keepTitle;
      renderPlay(state);
      await persist();
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
        { mode: "play" },
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
      // A whisper reply is usually PLAIN PROSE, not the JSON turn shape, so
      // parse.ok is false even though scene.text holds the spoken line.
      // whisperReply reads scene.text regardless of `ok`, so the in-character
      // reply is shown instead of the "silence" fallback (the live whisper bug).
      const reply = whisperReply(res);
      showWhisper(name, reply || "(" + name + " only watches you in silence.)");
    } catch (e) {
      console.log("[gamentic] whisper failed:", e?.message || e);
      showWhisper(name, "(" + name + " seems distracted, and does not answer.)");
    } finally {
      setBusy(root, false);
    }
  }

  // RESUME: open a saved adventure. Validate the save is real (history + a
  // non-empty scene that is not a raw-JSON blob) before trusting it; a corrupt
  // save is removed from the index and we fall back to the home screen. A resumed
  // game opens a fresh (memory-less) GM session, so the first live turn re-seeds
  // it with a recap (NEEDS_RECAP).
  async function resumeAdventure(id) {
    MODE = "play";
    const g = await loadState(anna, `adv:` + id);
    const savedScene = String((g && g.scene && g.scene.text) || "").trim();
    const valid = !!(
      g &&
      Array.isArray(g.history) &&
      g.history.length &&
      savedScene &&
      !savedScene.startsWith("{")
    );
    if (!valid) {
      const idx = removeAdventure(await loadIndex(), id);
      await saveState(anna, INDEX_KEY, idx);
      try {
        await anna.call("storage", "delete", { key: `adv:` + id });
      } catch {
        /* best-effort cleanup */
      }
      return showHome();
    }
    GAME = g;
    CURRENT_ID = id;
    NEEDS_RECAP = true;
    SESS = await newSession(GM_RULESET);
    // Open the saved story on a clean stage (no leftover beats from a prior view).
    resetStage();
    renderPlay({
      scene: GAME.scene,
      characters: GAME.roster,
      inventory: GAME.inventory,
      choices: GAME.choices,
    });
  }

  // DELETE: drop the adventure from the index and remove its per-adventure key,
  // then return to the (now-shorter) home screen.
  async function deleteAdventure(id) {
    const idx = removeAdventure(await loadIndex(), id);
    await saveState(anna, INDEX_KEY, idx);
    try {
      await anna.call("storage", "delete", { key: `adv:` + id });
    } catch {
      /* best-effort cleanup */
    }
    await showHome();
  }

  // BOOT: the home screen decides what to show (picker, resume, or fresh creator).
  await showHome();

  console.log("[gamentic] connected to Anna");
})();
