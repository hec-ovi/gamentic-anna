// The lightbox accepts BOTH shapes of game media: same-origin /media paths (HTTP
// mode) and the data: URIs the Anna media cache resolves them to. It still ignores
// anything else (external URLs are not our game media).

import { test, expect, afterEach, vi } from "vitest";
import { maybeOpenLightbox, closeLightbox } from "../src/app/media.js";

const URI = "data:image/jpeg;base64,QUJD";

afterEach(() => {
  closeLightbox();
  document.body.innerHTML = "";
});

function clickOn(el) {
  const e = { target: el, preventDefault: vi.fn(), stopPropagation: vi.fn() };
  maybeOpenLightbox(e);
  return e;
}

test("a data: URI game image opens the lightbox (Anna mode)", () => {
  document.body.innerHTML = `<figure class="beat-image"><img src="${URI}" alt="A moment" data-caption="The full concept" /></figure>`;
  clickOn(document.querySelector("img"));
  const box = document.querySelector(".lightbox-overlay");
  expect(box).toBeTruthy();
  expect(box.querySelector("img").getAttribute("src")).toBe(URI);
  expect(box.querySelector(".lightbox-caption").textContent).toBe("The full concept");
});

test("a same-origin /media image still opens the lightbox (HTTP mode)", () => {
  document.body.innerHTML = `<figure class="beat-image"><img src="/media/g1/shot.png" alt="A shot" /></figure>`;
  clickOn(document.querySelector("img"));
  expect(document.querySelector(".lightbox-overlay img").getAttribute("src")).toBe("/media/g1/shot.png");
});

test("external images never open the lightbox", () => {
  document.body.innerHTML = `<figure class="beat-image"><img src="https://elsewhere/x.png" alt="ad" /></figure>`;
  const e = clickOn(document.querySelector("img"));
  expect(document.querySelector(".lightbox-overlay")).toBeNull();
  expect(e.preventDefault).not.toHaveBeenCalled();
});
