// app.js - the boot. Renders the Emberlight stage standalone, and connects to
// Anna's host runtime WHEN it is present. The SDK import is dynamic + guarded so
// the page still loads (and renders a full mock turn) in a plain static preview
// where the SDK URL does not exist.
//
// Live turn wiring (asking the GM, persisting state) is a later step; for now the
// handlers log so the standalone view is fully interactive and inspectable.

import { renderTurn, setBusy } from "./render.js";
// core.js stays untouched; we keep importing its public helpers so the live
// wiring step can use them without re-plumbing the boot.
import { askAnna, saveState, loadState, parsePresentation } from "./core.js";

const root = document.getElementById("root");

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

// Handlers. For now they log; the live wiring step swaps these for real turn
// resolution (askAnna -> parsePresentation -> renderTurn, persisted via
// saveState/loadState).
const handlers = {
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
renderTurn(root, MOCK_TURN, handlers);

// keep the imported core helpers referenced so a tree-shaker / linter does not
// flag them while live wiring is pending (they are the seam for the next step).
void askAnna;
void saveState;
void loadState;
void parsePresentation;
void setBusy;

// Try to connect to the Anna host. The SDK lives at an absolute /static path
// inside the Anna sandbox; in a plain static preview that path 404s, so the
// dynamic import is wrapped: failure just means "preview mode".
(async () => {
  try {
    const mod = await import("/static/anna-apps/_sdk/latest/index.js");
    const anna = await mod.AnnaAppRuntime.connect();
    await anna.window.set_title({ title: "Gamentic" });
    // (live turn loop wires in here in the next step)
    console.log("[gamentic] connected to Anna");
  } catch (e) {
    console.log("[gamentic] preview mode (no Anna host):", e?.message || e);
  }
})();
