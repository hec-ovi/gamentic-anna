// Export/import inside the Anna sandbox. The iframe blocks blob downloads and a
// programmatic file picker, so under annaMode: Export opens the JSON in a modal
// (Copy is the reliable path, the data: link best-effort), and Import opens a
// paste-JSON modal. The standalone download/picker paths are covered in
// play.component.test.js and stay untouched.

import { test, expect } from "vitest";
import { screen, within, waitFor } from "@testing-library/dom";
import userEvent from "@testing-library/user-event";
import { http, HttpResponse } from "msw";
import { server, mountApp } from "./setup.js";

const API = "http://localhost:8000";
const user = () => userEvent.setup({ delay: null });

const EXPORT = { gamentic: "adventure", title: "Test Adventure", setting: "a bar" };

async function mountAnna() {
  await mountApp();
  const { state } = await import("../src/app/ctx.js");
  state.annaMode = true;
  return state;
}

test("Anna export: the JSON opens in a modal; Copy puts it on the clipboard", async () => {
  server.use(http.get(`${API}/games/:id/export`, () => HttpResponse.json(EXPORT)));
  const u = user(); // userEvent installs a working navigator.clipboard stub
  await mountAnna();

  await u.click(await screen.findByRole("button", { name: /enter your saved worlds/i }));
  await u.click(await screen.findByRole("button", { name: /export adventure/i }));
  await u.click(await screen.findByRole("button", { name: /share as adventure/i }));

  const modal = await waitFor(() => {
    const m = document.querySelector(".export-view");
    expect(m).toBeTruthy();
    return m;
  });
  const ta = within(modal).getByRole("textbox", { name: /exported adventure json/i });
  expect(ta.value).toContain('"gamentic": "adventure"');
  // the best-effort download link carries the payload as a data: URI
  const link = within(modal).getByRole("link", { name: /download/i });
  expect(link.getAttribute("href")).toMatch(/^data:application\/json;base64,/);
  expect(link.getAttribute("download")).toBe("test-adventure-template.json");

  await u.click(within(modal).getByRole("button", { name: /copy/i }));
  await waitFor(async () => {
    const copied = await navigator.clipboard.readText();
    expect(JSON.parse(copied)).toEqual(EXPORT);
  });

  await u.click(within(modal).getByRole("button", { name: /close/i }));
  expect(document.querySelector(".export-view")).toBeNull();
});

test("Anna import: paste JSON, import, land in the new game; bad JSON stays put with an error", async () => {
  let importBody = null;
  server.use(http.post(`${API}/games/import`, async ({ request }) => {
    importBody = await request.json();
    return HttpResponse.json({ game_id: "g-test" });
  }));
  const u = user();
  await mountAnna();

  await u.click(await screen.findByRole("button", { name: /enter your saved worlds/i }));
  await screen.findByText("Test Adventure");
  await u.click(screen.getByRole("button", { name: /^import$/i }));

  // the paste modal opens instead of a file picker
  const modal = document.querySelector(".import-view");
  expect(modal).toBeTruthy();
  const ta = within(modal).getByRole("textbox", { name: /adventure json to import/i });

  // invalid JSON: inline error, nothing posted, the text is not lost
  await u.click(ta);
  await u.paste("definitely not json");
  await u.click(within(modal).getByRole("button", { name: /^import$/i }));
  expect((await screen.findByRole("alert")).textContent).toMatch(/not valid export json/i);
  expect(importBody).toBeNull();
  expect(document.querySelector("#importJson").value).toBe("definitely not json");

  // valid JSON: posts the payload and navigates into the returned game
  const fresh = document.querySelector("#importJson");
  fresh.value = "";
  await u.click(fresh);
  await u.paste(JSON.stringify(EXPORT));
  await u.click(within(document.querySelector(".import-view")).getByRole("button", { name: /^import$/i }));
  await waitFor(() => expect(importBody).toEqual(EXPORT));
  await screen.findAllByText("The Last Breath"); // the play view of the new game
});

test("Anna import: an oversized export is refused before it hits the transport", async () => {
  let posted = false;
  server.use(http.post(`${API}/games/import`, () => {
    posted = true;
    return HttpResponse.json({ game_id: "g-test" });
  }));
  const u = user();
  await mountAnna();
  await u.click(await screen.findByRole("button", { name: /enter your saved worlds/i }));
  await u.click(screen.getByRole("button", { name: /^import$/i }));

  const ta = document.querySelector("#importJson");
  // build a >8MB payload without typing it: set, then confirm through the button
  ta.value = JSON.stringify({ gamentic: "checkpoint", blob: "x".repeat(9 * 1024 * 1024) });
  await u.click(within(document.querySelector(".import-view")).getByRole("button", { name: /^import$/i }));
  await waitFor(() => expect(document.querySelector(".toast")).toBeTruthy());
  expect(document.querySelector(".toast").textContent).toMatch(/too large/i);
  expect(posted).toBe(false);
});
