// Boot order (app.js init): inside an Anna window the app must switch to Anna mode on
// the FIRST paint - no standalone Settings flash - and SKIP the synchronous HTTP library
// fetch (there is no :8000 listener inside the sandboxed iframe, so it would only spam
// ERR_CONNECTION_REFUSED). connectAnna() then loads the library over the Executa
// transport; if it never connects, boot heals back to the standalone HTTP path.
//
// anna.js is mocked so both branches (connected / failed-connect / standalone) are
// deterministic: the real init() ordering in app.js is what's under test.
import { test, expect, beforeEach, afterEach, vi } from "vitest";

const ctrl = vi.hoisted(() => ({ annaWin: true, connectResult: true }));
vi.mock("../src/app/anna.js", () => ({
  inAnnaWindow: () => ctrl.annaWin,
  connectAnna: async () => ctrl.connectResult,
}));

import { init } from "../src/app.js";
import { state, setTorn } from "../src/app/ctx.js";

let app = null;
const flush = () => new Promise((r) => setTimeout(r, 0));

beforeEach(() => {
  ctrl.annaWin = true;
  ctrl.connectResult = true;
  setTorn(false); // the global afterEach (setup.js) tears renders; un-tear for these
  state.annaMode = false;
  document.body.innerHTML = '<div id="app"></div>';
});

afterEach(() => {
  if (app && app.destroy) app.destroy();
  app = null;
  state.annaMode = false;
});

test("in an Anna window, boot enters Anna mode on the first paint and skips the :8000 library fetch", () => {
  const fetchSpy = vi.spyOn(globalThis, "fetch");
  app = init({ root: document.querySelector("#app") });
  // Asserted SYNCHRONOUSLY: connectAnna() is async, so nothing has reverted annaMode
  // and the (skipped) synchronous library fetch never fired.
  expect(state.annaMode).toBe(true); // Anna mode from frame 1
  expect(document.querySelector('[data-act="open-settings"]')).toBeNull(); // no Settings flash
  expect(fetchSpy).not.toHaveBeenCalled(); // synchronous :8000 /games fetch skipped
});

test("if connectAnna never connects, boot heals back to the standalone HTTP path (Settings return)", async () => {
  ctrl.connectResult = false; // guessed Anna, but the SDK handshake failed
  app = init({ root: document.querySelector("#app") });
  expect(state.annaMode).toBe(true); // optimistic on the first frame
  await flush(); // let connectAnna() resolve and the heal run
  expect(state.annaMode).toBe(false); // reverted to standalone
  expect(document.querySelector('[data-act="open-settings"]')).not.toBeNull(); // Settings back
});

test("in a standalone window, boot stays in HTTP mode and shows Settings", () => {
  ctrl.annaWin = false;
  app = init({ root: document.querySelector("#app") });
  expect(state.annaMode).toBeFalsy();
  expect(document.querySelector('[data-act="open-settings"]')).not.toBeNull();
});
