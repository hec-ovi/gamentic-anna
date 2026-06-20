// The comms-layer swap: createApi(url, { invoke }) must route every call through the
// injected Anna Executa transport (anna.tools.invoke) instead of fetch, and map the
// Executa's { status, json } reply onto the same value/ApiError contract as HTTP.
import { describe, it, expect, vi, afterEach } from "vitest";
import { createApi, annaErrorMessage } from "../src/api.js";
import { inAnnaWindow, resolveToolId, toInvokeArgs } from "../src/app/anna.js";

const CF_502 =
  '[-32000] HTTP 502: <!DOCTYPE html><html><head><title>anna.partners | 502: Bad gateway</title></head>' +
  '<body><h1>Bad gateway<span class="code-label">Error code 502</span></h1>Visit cloudflare.com</body></html>';

describe("anna executa transport", () => {
  it("routes a GET through invoke and returns the json", async () => {
    const invoke = vi.fn(async () => ({ status: 200, json: { games: [] } }));
    const api = createApi("http://unused", { invoke });
    expect(await api.listGames()).toEqual({ games: [] });
    // The transport forwards the per-call timeout so anna.js can map it to the host's
    // invoke timeoutMs (a read uses READ_TIMEOUT_MS = 20000).
    expect(invoke).toHaveBeenCalledWith("/games", { method: "GET", body: undefined, timeout: 20000 });
  });

  it("passes method + body for a turn (same shape as the HTTP client)", async () => {
    const invoke = vi.fn(async () => ({ status: 200, json: { beats: [], state: {} } }));
    const api = createApi("http://unused", { invoke });
    await api.takeAction("g1", "look around");
    const [path, opts] = invoke.mock.calls[0];
    expect(path).toBe("/games/g1/action");
    expect(opts.method).toBe("POST");
    expect(opts.body).toEqual({ action: "look around" });
  });

  it("maps an engine 4xx to an ApiError with the status preserved", async () => {
    const invoke = vi.fn(async () => ({ status: 404, json: { detail: "game not found" } }));
    const api = createApi("http://unused", { invoke });
    await expect(api.getState("nope")).rejects.toMatchObject({ name: "ApiError", status: 404 });
  });

  it("accepts both the SDK { result } wrapper and a bare payload", async () => {
    const wrapped = createApi("x", { invoke: async () => ({ result: { status: 200, json: { ok: 1 } } }) });
    expect(await wrapped.health()).toEqual({ ok: 1 });
    const bare = createApi("x", { invoke: async () => ({ pong: true }) });
    expect(await bare.health()).toEqual({ pong: true });
  });

  it("never calls fetch when a transport is injected", async () => {
    const spy = vi.spyOn(globalThis, "fetch");
    const api = createApi("http://unused", { invoke: async () => ({ status: 200, json: {} }) });
    await api.listGames();
    expect(spy).not.toHaveBeenCalled();
    spy.mockRestore();
  });

  // The executa returns its full {success, data:{status,json}} / {success:false,error}
  // envelope; the host may or may not strip it. The transport must handle every shape.
  it("unwraps the executa success envelope the host did not strip", async () => {
    const api = createApi("x", { invoke: async () => ({ success: true, data: { status: 200, json: { games: [] } }, tool: "request" }) });
    expect(await api.listGames()).toEqual({ games: [] });
  });

  it("still surfaces an engine 4xx that rides inside the success envelope", async () => {
    const api = createApi("x", { invoke: async () => ({ success: true, data: { status: 404, json: { detail: "game not found" } } }) });
    await expect(api.getState("nope")).rejects.toMatchObject({ name: "ApiError", status: 404 });
  });

  it("turns a tool-level failure (Anna 502 after retries) into a clean ApiError, not a fake 200", async () => {
    const api = createApi("x", { invoke: async () => ({ success: false, error: CF_502 }) });
    const err = await api.takeAction("g1", "open the door").then(() => null, (e) => e);
    expect(err).toMatchObject({ name: "ApiError", status: 502 });
    // the player sees a short human line, never the raw Cloudflare page
    expect(err.message).toMatch(/temporarily unavailable/i);
    expect(err.message).not.toMatch(/doctype|<html|cloudflare/i);
  });

  it("surfaces a failure wrapped in the SDK { result } envelope too", async () => {
    const api = createApi("x", { invoke: async () => ({ ok: false, result: { success: false, error: "[-32002] quota exceeded" } }) });
    const err = await api.takeAction("g1", "x").then(() => null, (e) => e);
    expect(err).toMatchObject({ name: "ApiError", status: 502 });
    expect(err.message).toMatch(/usage limit/i);
  });

  // The Anna dev harness recycles the executa on its own; an idempotent GET caught mid-recycle
  // (a dropped invoke -> tool-level 502, or a transport hang -> status 0) must be retried, not
  // bounced. This is what keeps resume from kicking the player back to the menu.
  it("retries a GET through a dropped invoke (executa recycle) and then succeeds", async () => {
    let n = 0;
    const invoke = vi.fn(async () => {
      n += 1;
      if (n < 3) return { success: false, error: "[-32002] executa process exited" };
      return { status: 200, json: { state: { ok: 1 } } };
    });
    const api = createApi("x", { invoke });
    await expect(api.getState("g1")).resolves.toEqual({ state: { ok: 1 } });
    expect(invoke).toHaveBeenCalledTimes(3);
  });

  it("does NOT retry a POST turn through a failure (not idempotent)", async () => {
    const invoke = vi.fn(async () => ({ success: false, error: CF_502 }));
    const api = createApi("x", { invoke });
    await api.takeAction("g1", "x").catch(() => {});
    expect(invoke).toHaveBeenCalledTimes(1);
  });
});

// The synchronous window detector that lets boot switch to Anna mode on the first
// paint (the host adds a wid/t query param inside an Anna window).
describe("inAnnaWindow", () => {
  const setSearch = (s) => window.history.replaceState({}, "", s);
  afterEach(() => setSearch("/"));

  it("is true when the host adds a window id (wid) param", () => {
    setSearch("/?wid=win-123");
    expect(inAnnaWindow()).toBe(true);
  });
  it("is true with a token (t) param too", () => {
    setSearch("/?t=abc.def");
    expect(inAnnaWindow()).toBe(true);
  });
  it("is false for a plain standalone URL", () => {
    setSearch("/");
    expect(inAnnaWindow()).toBe(false);
  });
});

// The same bundle ships to the published app (minted tool-gamentic-engine id) and to
// local dev (tool-dev-gamentic). resolveToolId must use whatever the HOST whitelisted
// (tools.list), so a published install never calls the dev id (which isn't whitelisted).
describe("resolveToolId", () => {
  afterEach(() => { delete window.__ANNA_TOOL_IDS__; });

  it("uses the host's whitelisted tool id (published install)", async () => {
    const anna = { tools: { list: async () => ({ tools: [{ tool_id: "tool-gamentic-engine-xxxb2ewm" }] }) } };
    expect(await resolveToolId(anna)).toBe("tool-gamentic-engine-xxxb2ewm");
  });

  it("picks the gamentic/engine tool when several are whitelisted", async () => {
    const anna = { tools: { list: async () => ({ tools: [{ tool_id: "tool-other-thing-1" }, { tool_id: "tool-gamentic-engine-9" }] }) } };
    expect(await resolveToolId(anna)).toBe("tool-gamentic-engine-9");
  });

  it("falls back to the publish-injected map when the list is empty", async () => {
    window.__ANNA_TOOL_IDS__ = { engine: "tool-gamentic-engine-frommap" };
    const anna = { tools: { list: async () => ({ tools: [] }) } };
    expect(await resolveToolId(anna)).toBe("tool-gamentic-engine-frommap");
  });

  it("falls back to the local-dev id when list throws and no map", async () => {
    const anna = { tools: { list: async () => { throw new Error("not supported"); } } };
    expect(await resolveToolId(anna)).toBe("tool-dev-gamentic");
  });
});

// The "65s wall" fix: the iframe's anna.tools.invoke defaults to a 65000ms timeoutMs and
// the host kills a longer invoke. toInvokeArgs forwards the api client's per-call timeout
// as timeoutMs (clamped to the host's [1000, 180000] window) so a render or heavy turn
// gets the full budget instead of being cut at 65s.
describe("toInvokeArgs (timeoutMs forwarding)", () => {
  it("omits timeoutMs when no timeout is given (host default applies)", () => {
    const a = toInvokeArgs("tool-x", "/games", { method: "GET" });
    expect(a).toEqual({ tool_id: "tool-x", method: "request", args: { path: "/games", method: "GET", body: undefined } });
    expect("timeoutMs" in a).toBe(false);
  });

  it("forwards a normal read timeout unchanged", () => {
    expect(toInvokeArgs("t", "/games", { timeout: 20000 }).timeoutMs).toBe(20000);
  });

  it("clamps an LLM/render timeout up to the host max of 180000", () => {
    // api.js LLM_TIMEOUT_MS is 330000; the host hard-caps at 180000.
    expect(toInvokeArgs("t", "/games/g/action", { method: "POST", timeout: 330000 }).timeoutMs).toBe(180000);
  });

  it("clamps below the host minimum up to 1000", () => {
    expect(toInvokeArgs("t", "/x", { timeout: 100 }).timeoutMs).toBe(1000);
  });

  it("carries method + body through to args", () => {
    const a = toInvokeArgs("t", "/games/g/action", { method: "POST", body: { action: "go" }, timeout: 5000 });
    expect(a.args).toEqual({ path: "/games/g/action", method: "POST", body: { action: "go" } });
  });
});

describe("annaErrorMessage", () => {
  it("maps gateway/provider outages to the temporary-unavailable line", () => {
    for (const e of [CF_502, "[-32000] HTTP 502", "[-32046] agent/complete failed: HTTP 502", "[-32003] provider error", "upstream 503"])
      expect(annaErrorMessage(e)).toMatch(/temporarily unavailable/i);
  });
  it("maps per-invoke caps, quota, grant and timeout to their own lines", () => {
    expect(annaErrorMessage("[-32006] max calls exceeded")).toMatch(/too much of anna/i);
    expect(annaErrorMessage("[-32002] quota exceeded")).toMatch(/usage limit/i);
    expect(annaErrorMessage("[-32001] sampling not granted")).toMatch(/granted/i);
    expect(annaErrorMessage("[-32005] timed out after 300s")).toMatch(/too long/i);
  });
  it("falls back to a generic, action-safe line for anything else", () => {
    expect(annaErrorMessage("kaboom")).toMatch(/couldn't complete/i);
    expect(annaErrorMessage(null)).toMatch(/couldn't complete/i);
  });
});
