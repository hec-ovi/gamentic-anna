// Post-turn art pickup under Anna. There is no SSE inside the Anna iframe, and the
// engine renders a turn's art after the reply (fire-and-forget), so the frontend polls
// a short decaying burst to slot late art in. The burst must run ONLY under Anna
// (annaMode); elsewhere the EventSource push already covers late media.
import { test, expect, vi, afterEach } from "vitest";
import { pollBurst, pumpRenders, watchMedia, stopMediaWatch } from "../src/app/mediastream.js";
import { state, api } from "../src/app/ctx.js";

afterEach(() => {
  stopMediaWatch();
  vi.useRealTimers();
  vi.unstubAllGlobals();
  state.annaMode = false;
  state.active = null;
  state.view = "menu";
});

test("pollBurst is a no-op outside Anna (SSE handles late art there)", () => {
  vi.useFakeTimers();
  state.annaMode = false;
  pollBurst({ id: "g1" });
  expect(vi.getTimerCount()).toBe(0);
});

test("under Anna, pollBurst schedules a decaying poll burst that goes inert once the game leaves", () => {
  vi.useFakeTimers();
  state.annaMode = true;
  const g = { id: "g1" };
  pollBurst(g);
  expect(vi.getTimerCount()).toBeGreaterThan(3); // a series of polls is queued
  // the player navigates away mid-burst: each queued tick must no-op (state.active!==g),
  // not throw or hit the network
  state.active = null;
  expect(() => vi.runAllTimers()).not.toThrow();
});

// The Anna AGENT tears the executa down per-invoke, so the engine's detached render jobs
// never run there. pumpRenders actively REQUESTS one render per missing image (scene, then
// each present character) via POST /render and slots each result into the live state.
test("under Anna, pumpRenders (re)fetches every non-data image (null OR /media path) and slots it", async () => {
  state.annaMode = true;
  state.view = "play";
  const g = {
    id: "g1",
    state: {
      imagesEnabled: true,
      scene: { imageUrl: "/media/g1/scene.png", items: [] }, // persisted-but-not-inlined: re-fetch
      characters: [
        { id: "c1", present: true, alive: true, faceUrl: null, bodyUrl: null }, // missing: render
        { id: "c2", present: false, alive: true, faceUrl: null, bodyUrl: null }, // absent: skip
        { id: "c3", present: true, alive: true, faceUrl: "data:x", bodyUrl: "data:y" }, // delivered: skip
        { id: "c4", present: true, alive: true, faceUrl: "/media/g1/c4-face.png", bodyUrl: "/media/g1/c4-front.png" }, // path: re-fetch
      ],
      player: { inventory: [{ id: "i1", name: "Key", imageUrl: "/media/g1/item-key.png" }] }, // path: re-fetch
    },
  };
  state.active = g;
  const calls = [];
  const orig = api.renderImage;
  api.renderImage = vi.fn(async (id, body) => {
    calls.push(body);
    if (body.kind === "scene") return { kind: "scene", image_url: "data:scene" };
    if (body.kind === "item") return { kind: "item", id: body.id, image_url: "data:item-" + body.id };
    return { kind: "character", id: body.id, face_url: "data:face-" + body.id, body_url: "data:body-" + body.id };
  });
  try {
    await pumpRenders(g);
  } finally {
    api.renderImage = orig;
  }
  // scene (path) + c1 (null) + c4 (path) + the Key item (path); c2 absent, c3 already delivered
  expect(calls).toEqual([
    { kind: "scene" },
    { kind: "character", id: "c1" },
    { kind: "character", id: "c4" },
    { kind: "item", id: "Key" },
  ]);
  expect(g.state.scene.imageUrl).toBe("data:scene");
  expect(g.state.characters.find((c) => c.id === "c1").faceUrl).toBe("data:face-c1");
  expect(g.state.characters.find((c) => c.id === "c4").bodyUrl).toBe("data:body-c4");
  expect(g.state.player.inventory[0].imageUrl).toBe("data:item-Key");
});

test("pumpRenders is a no-op outside Anna (the executa stays warm there; SSE/detached cover art)", async () => {
  state.annaMode = false;
  const g = { id: "g1", state: { imagesEnabled: true, scene: { imageUrl: null }, characters: [] } };
  state.active = g;
  const orig = api.renderImage;
  api.renderImage = vi.fn();
  try {
    await pumpRenders(g);
    expect(api.renderImage).not.toHaveBeenCalled();
  } finally {
    api.renderImage = orig;
  }
});

test("pumpRenders does nothing when images are disabled", async () => {
  state.annaMode = true;
  state.view = "play";
  const g = { id: "g1", state: { imagesEnabled: false, scene: { imageUrl: null }, characters: [] } };
  state.active = g;
  const orig = api.renderImage;
  api.renderImage = vi.fn();
  try {
    await pumpRenders(g);
    expect(api.renderImage).not.toHaveBeenCalled();
  } finally {
    api.renderImage = orig;
  }
});

test("outside Anna, watchMedia opens an EventSource for live media push", () => {
  vi.useFakeTimers();
  let made = 0;
  class FakeES {
    constructor() {
      made++;
    }
    close() {}
  }
  vi.stubGlobal("EventSource", FakeES);
  state.annaMode = false;
  watchMedia({ id: "g1" });
  expect(made).toBe(1);
});

test("under Anna, watchMedia opens NO EventSource (the iframe can't reach :8000/events)", () => {
  vi.useFakeTimers();
  let made = 0;
  class FakeES {
    constructor() {
      made++;
    }
    close() {}
  }
  vi.stubGlobal("EventSource", FakeES);
  state.annaMode = true;
  watchMedia({ id: "g1" }); // pollBurst + the fallback sweep cover media under Anna
  expect(made).toBe(0);
});
