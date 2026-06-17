// The comms-layer swap: createApi(url, { invoke }) must route every call through the
// injected Anna Executa transport (anna.tools.invoke) instead of fetch, and map the
// Executa's { status, json } reply onto the same value/ApiError contract as HTTP.
import { describe, it, expect, vi } from "vitest";
import { createApi } from "../src/api.js";

describe("anna executa transport", () => {
  it("routes a GET through invoke and returns the json", async () => {
    const invoke = vi.fn(async () => ({ status: 200, json: { games: [] } }));
    const api = createApi("http://unused", { invoke });
    expect(await api.listGames()).toEqual({ games: [] });
    expect(invoke).toHaveBeenCalledWith("/games", { method: "GET", body: undefined });
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
});
