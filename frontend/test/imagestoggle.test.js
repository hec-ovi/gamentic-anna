// The install-wide images switch. It lives on the library header (so it survives
// Anna mode, where the settings screen is hidden), reads GET /settings/app, and
// PATCHes the flip. Turning images off is not destructive: art that already has a
// URL keeps rendering; only loaders and the look affordances disappear. The scene
// skeleton also explains WHY art is missing when the host is the holdup (quota,
// missing grant) instead of promising art forever.

import { test, expect } from "vitest";
import { screen, waitFor } from "@testing-library/dom";
import userEvent from "@testing-library/user-event";
import { http, HttpResponse } from "msw";
import { server, mountApp } from "./setup.js";
import { makeState } from "./fixtures.js";

const API = "http://localhost:8000";
const user = () => userEvent.setup({ delay: null });

function appSettingsHandlers(store, patches) {
  return [
    http.get(`${API}/settings/app`, () =>
      HttpResponse.json({ images_enabled: store.enabled, images_status: store.status || "ok" })),
    http.patch(`${API}/settings/app`, async ({ request }) => {
      const body = await request.json();
      patches.push(body);
      store.enabled = body.images_enabled;
      return HttpResponse.json({ images_enabled: store.enabled, images_status: store.status || "ok" });
    }),
  ];
}

test("the library switch reflects /settings/app and PATCHes the flip", async () => {
  const store = { enabled: true };
  const patches = [];
  server.use(...appSettingsHandlers(store, patches));
  const u = user();
  await mountApp();
  await u.click(await screen.findByRole("button", { name: /enter your saved worlds/i }));

  const toggle = await screen.findByRole("switch", { name: /images on/i });
  expect(toggle.getAttribute("aria-checked")).toBe("true");

  await u.click(toggle);
  await waitFor(() => expect(patches).toEqual([{ images_enabled: false }]));
  const off = await screen.findByRole("switch", { name: /images off/i });
  expect(off.getAttribute("aria-checked")).toBe("false");
});

test("without /settings/app (older engine) the library renders no switch", async () => {
  const u = user();
  await mountApp(); // setup.js has no /settings/app handler by default
  await u.click(await screen.findByRole("button", { name: /enter your saved worlds/i }));
  await screen.findByText("Test Adventure");
  expect(screen.queryByRole("switch", { name: /images/i })).toBeNull();
});

test("images off keeps already-painted art but drops loaders and the look mode", async () => {
  const st = makeState();
  st.images_enabled = false;
  st.scene.image_url = "/media/g-test/scene.png"; // painted before the switch flipped
  server.use(http.get(`${API}/games/:id/state`, () => HttpResponse.json(st)));

  const u = user();
  await mountApp();
  await u.click(await screen.findByRole("button", { name: /enter your saved worlds/i }));
  await u.click(await screen.findByRole("button", { name: /^enter$/i }));
  await screen.findAllByText("The Last Breath");

  const art = document.querySelector(".prose-art img");
  expect(art).toBeTruthy(); // painted art stays visible
  expect(art.getAttribute("src")).toBe("/media/g-test/scene.png");
  expect(document.querySelector(".prose-art.art-loading")).toBeNull(); // no skeleton
  expect(screen.queryByRole("button", { name: /^look$/i })).toBeNull(); // no look mode chip
});

test("the scene skeleton explains a host-side holdup (quota pause)", async () => {
  const st = makeState();
  st.images_enabled = true;
  st.images_status = "paused_quota";
  st.scene.image_url = null;
  server.use(http.get(`${API}/games/:id/state`, () => HttpResponse.json(st)));

  const u = user();
  await mountApp();
  await u.click(await screen.findByRole("button", { name: /enter your saved worlds/i }));
  await u.click(await screen.findByRole("button", { name: /^enter$/i }));
  await screen.findAllByText("The Last Breath");

  expect(await screen.findByText(/art paused \(image quota\)/i)).toBeTruthy();
});
