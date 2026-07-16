// Anna media cache: replies carry small /media refs; each resolves ONCE through the
// engine to a data: URI and is cached for the session. Requests raised in the same
// render pass pool for a beat and travel as ONE POST /media64/batch (rejoining a
// mature adventure used to fire one invoke per image). Outside Anna mode URLs pass
// through untouched. While a fetch is in flight the widgets keep their loading
// affordances (skeleton / initials), and a landed image triggers one batched repaint.

import { test, expect, beforeEach, afterEach, vi } from "vitest";
import { http, HttpResponse } from "msw";
import { server } from "./setup.js";
import { onMediaReady, resolveMediaUrl, resetMediaCache } from "../src/app/mediacache.js";
import { artImg, avatarOrInitials, slotInner } from "../src/render/widgets.js";
import { state } from "../src/app/ctx.js";

const API = "http://localhost:8000";
const URI = "data:image/jpeg;base64,QUJD";

beforeEach(() => {
  resetMediaCache();
  state.annaMode = true;
});

afterEach(() => {
  state.annaMode = false;
  onMediaReady(null);
  resetMediaCache();
});

// past the 25ms pooling window + the request round-trip
const flush = () => new Promise((r) => setTimeout(r, 60));

// one msw handler for the batch endpoint: `resolve` maps url -> uri|null
function batchHandler(resolve, calls) {
  return http.post(`${API}/media64/batch`, async ({ request }) => {
    const body = await request.json();
    calls.push(body.urls);
    const uris = {};
    for (const u of body.urls) uris[u] = resolve(u);
    return HttpResponse.json({ uris });
  });
}

test("outside Anna mode every URL passes through untouched", () => {
  state.annaMode = false;
  expect(resolveMediaUrl("/media/g1/scene.png")).toBe("/media/g1/scene.png");
  expect(resolveMediaUrl("https://cdn/x.png")).toBe("https://cdn/x.png");
  expect(resolveMediaUrl(null)).toBe(null);
});

test("non-/media URLs pass through even under Anna (data: URIs, remote fallbacks)", () => {
  expect(resolveMediaUrl(URI)).toBe(URI);
  expect(resolveMediaUrl("https://cdn/x.png")).toBe("https://cdn/x.png");
});

test("a /media ref resolves once, then serves from the cache", async () => {
  const calls = [];
  server.use(batchHandler(() => URI, calls));
  const landed = vi.fn();
  onMediaReady(landed);

  expect(resolveMediaUrl("/media/g1/scene.png")).toBe(null); // in flight: caller shows its skeleton
  await flush();
  expect(resolveMediaUrl("/media/g1/scene.png")).toBe(URI); // cached now
  resolveMediaUrl("/media/g1/scene.png");
  await flush();
  expect(calls.length).toBe(1); // ONE network fetch, ever
  expect(landed).toHaveBeenCalledTimes(1); // one batched repaint
});

test("refs raised in the same render pass travel as ONE batch call", async () => {
  const calls = [];
  server.use(batchHandler(() => URI, calls));

  resolveMediaUrl("/media/g1/scene.png");
  resolveMediaUrl("/media/g1/char-1-face.png");
  resolveMediaUrl("/media/g1/item-key.png");
  await flush();

  expect(calls.length).toBe(1); // pooled, not one call per image
  expect(calls[0]).toEqual(expect.arrayContaining([
    "/media/g1/scene.png", "/media/g1/char-1-face.png", "/media/g1/item-key.png"]));
  expect(resolveMediaUrl("/media/g1/scene.png")).toBe(URI);
  expect(resolveMediaUrl("/media/g1/char-1-face.png")).toBe(URI);
  expect(resolveMediaUrl("/media/g1/item-key.png")).toBe(URI);
});

test("a missing file stops asking after its retries and settles on the no-image fallback", async () => {
  const calls = [];
  server.use(batchHandler(() => null, calls)); // the engine answers: no such file
  for (let i = 0; i < 5; i++) {
    resolveMediaUrl("/media/g1/gone.png");
    await flush();
  }
  expect(calls.length).toBeLessThanOrEqual(3); // bounded attempts
  expect(resolveMediaUrl("/media/g1/gone.png")).toBe(""); // '' = give up, render fallback
});

test("a transport blip never poisons the cache: the next render retries", async () => {
  let fail = true;
  const calls = [];
  server.use(http.post(`${API}/media64/batch`, async ({ request }) => {
    calls.push((await request.json()).urls);
    if (fail) return HttpResponse.error();
    return HttpResponse.json({ uris: { "/media/g1/late.png": URI } });
  }));

  resolveMediaUrl("/media/g1/late.png");
  await flush();
  expect(resolveMediaUrl("/media/g1/late.png")).toBe(null); // not cached as failed

  fail = false;
  resolveMediaUrl("/media/g1/late.png");
  await flush();
  expect(resolveMediaUrl("/media/g1/late.png")).toBe(URI);
});

test("widgets hold their loading/initials affordances while a ref is in flight", async () => {
  const calls = [];
  server.use(batchHandler(() => URI, calls));

  // artImg: skeleton first (stable data-art identity), the real img once cached
  const pendingArt = artImg({ url: "/media/g1/x.png", alt: "The scene" });
  expect(pendingArt).toContain("art-loading");
  expect(pendingArt).not.toContain("<img");
  // avatar + slot: initials while loading, exactly like no-image
  expect(avatarOrInitials({ url: "/media/g1/x.png", name: "Mara", color: "red", fallbackCls: "f" }))
    .toContain(">M<");
  expect(slotInner({ imageUrl: "/media/g1/x.png", name: "brass key" })).toContain("slot-abbr");

  await flush();
  const art = artImg({ url: "/media/g1/x.png", alt: "The scene" });
  expect(art).toContain(`src="${URI}"`);
  expect(art).toContain('data-art="/media/g1/x.png"'); // reveal identity keeps the stable ref
  expect(avatarOrInitials({ url: "/media/g1/x.png", name: "Mara", color: "red", fallbackCls: "f" }))
    .toContain(`src="${URI}"`);
  expect(slotInner({ imageUrl: "/media/g1/x.png", name: "brass key" })).toContain(`src="${URI}"`);
});
