// Anna runtime boot: the frontend half of the comms-layer swap.
//
// When the bundle runs inside an Anna window, connect the AnnaAppRuntime SDK and
// point the api client at the backend Executa via anna.tools.invoke. Outside Anna
// (standalone preview, unit tests, or a plain orchestrator) this is a no-op and the
// api keeps its default HTTP transport, so nothing else has to know the difference.

import { setApiTransport } from "./ctx.js";

// Served by the Anna host inside the iframe; absent everywhere else.
const SDK_URL = "/static/anna-apps/_sdk/latest/index.js";
// Real ids land in window.__ANNA_TOOL_IDS__ at publish; this is the local-dev id
// (matches TOOL_ID in backend/app/executa.py and the manifest's executa handle).
const DEV_TOOL_ID = "tool-dev-gamentic";

function toolId() {
  const ids = (typeof window !== "undefined" && window.__ANNA_TOOL_IDS__) || {};
  return ids.gamentic || DEV_TOOL_ID;
}

// Connect and install the Executa transport. Returns true when routed through Anna,
// false when standalone. Never throws (a failure just leaves the HTTP transport).
export async function connectAnna() {
  try {
    if (typeof window === "undefined") return false;
    const p = new URLSearchParams(window.location.search);
    if (!p.get("wid") && !p.get("t")) return false;          // not in an Anna window
    const mod = await import(/* @vite-ignore */ SDK_URL);
    const AnnaAppRuntime = mod.AnnaAppRuntime || (mod.default && mod.default.AnnaAppRuntime);
    if (!AnnaAppRuntime) return false;
    const anna = await AnnaAppRuntime.connect();             // rejects in standalone preview
    const tid = toolId();
    const invoke = (path, { method = "GET", body } = {}) =>
      anna.tools.invoke({ tool_id: tid, method: "request", args: { path, method, body } });
    setApiTransport(invoke);
    return true;
  } catch {
    return false;
  }
}
