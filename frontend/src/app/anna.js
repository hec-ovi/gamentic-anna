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

// Static fallback: the publish-injected map (bundle/anna-tool-ids.js sets
// window.__ANNA_TOOL_IDS__ = {"<executa-name>":"<minted-id>"}), else the local-dev id.
function fallbackToolId() {
  const ids = (typeof window !== "undefined" && window.__ANNA_TOOL_IDS__) || {};
  return ids.gamentic || ids.engine || DEV_TOOL_ID;
}

// Ask the host which Executa this app is actually whitelisted to call, rather than
// guessing. The published app bundles the engine under a minted id
// (tool-gamentic-engine-...); local dev uses tool-dev-gamentic. With host_api.tools
// = "required:*", tools.list returns whichever id the host granted, so the SAME bundle
// works published AND in dev. Falls back to the injected map / dev id if list is empty
// or unsupported. Exported for tests.
export async function resolveToolId(anna) {
  try {
    const res = await anna.tools.list();
    const tools = (res && (res.tools || (res.result && res.result.tools))) || [];
    if (tools.length) {
      const ours = tools.find((t) => /gamentic|engine/.test((t && t.tool_id) || ""));
      return ((ours || tools[0]) || {}).tool_id || fallbackToolId();
    }
  } catch {
    // fall through to the static fallback
  }
  return fallbackToolId();
}

// True when this bundle is running inside an Anna window (the host adds a wid/t
// query param). Synchronous and cheap, so boot can switch to Anna mode on the FIRST
// paint - before connectAnna()'s async SDK handshake resolves - instead of flashing
// the standalone UI (the Settings icon, a dead :8000 library fetch) first.
export function inAnnaWindow() {
  if (typeof window === "undefined") return false;
  const p = new URLSearchParams(window.location.search);
  return Boolean(p.get("wid") || p.get("t"));
}

// Build the anna.tools.invoke arg from an api-client call. The api client passes a
// per-call `timeout` (ms); forward it as the host invoke's `timeoutMs` so a long invoke
// (a render, a heavy turn) is NOT killed at the host's 65000ms DEFAULT - that default,
// not a platform cap, is the "65s wall". The host clamps timeoutMs to [1000, 180000]; we
// clamp too so the value we send is explicit. No timeout -> omit it (host default applies).
// Exported for tests.
export function toInvokeArgs(toolId, path, { method = "GET", body, timeout } = {}) {
  const call = { tool_id: toolId, method: "request", args: { path, method, body } };
  if (timeout) call.timeoutMs = Math.max(1000, Math.min(180000, timeout));
  return call;
}

// Connect and install the Executa transport. Returns true when routed through Anna,
// false when standalone. Never throws (a failure just leaves the HTTP transport).
export async function connectAnna() {
  try {
    if (!inAnnaWindow()) return false;                       // not in an Anna window
    const mod = await import(/* @vite-ignore */ SDK_URL);
    const AnnaAppRuntime = mod.AnnaAppRuntime || (mod.default && mod.default.AnnaAppRuntime);
    if (!AnnaAppRuntime) return false;
    const anna = await AnnaAppRuntime.connect();             // rejects in standalone preview
    const tid = await resolveToolId(anna);                   // the id the host actually granted
    const invoke = (path, opts) => anna.tools.invoke(toInvokeArgs(tid, path, opts));
    setApiTransport(invoke);
    return true;
  } catch {
    return false;
  }
}
