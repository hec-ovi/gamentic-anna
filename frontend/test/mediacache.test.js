// Anna media cache: replies carry small /media refs; each resolves ONCE through
// GET /media64 to a data: URI and is cached for the session. Outside Anna mode URLs
// pass through untouched. While a fetch is in flight the widgets keep their loading
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

const flush = () => new Promise((r) => setTimeout(r, 20));

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

test("a /media ref resolves once through /media64, then serves from the cache", async () => {
  let hits = 0;
  server.use(
    http.get(`${API}/media64/g1/scene.png`, () => {
      hits += 1;
      return HttpResponse.json({ uri: URI });
    }),
  );
  const landed = vi.fn();
  onMediaReady(landed);

  expect(resolveMediaUrl("/media/g1/scene.png")).toBe(null); // in flight: caller shows its skeleton
  await flush();
  expect(resolveMediaUrl("/media/g1/scene.png")).toBe(URI); // cached now
  resolveMediaUrl("/media/g1/scene.png");
  await flush();
  expect(hits).toBe(1); // ONE network fetch, ever
  expect(landed).toHaveBeenCalledTimes(1); // one batched repaint
});

test("a missing file stops asking after its retries and settles on the no-image fallback", async () => {
  let hits = 0;
  server.use(
    http.get(`${API}/media64/g1/gone.png`, () => {
      hits += 1;
      return HttpResponse.json({ detail: "not found" }, { status: 404 });
    }),
  );
  for (let i = 0; i < 5; i++) {
    resolveMediaUrl("/media/g1/gone.png");
    await flush();
  }
  expect(hits).toBeLessThanOrEqual(3); // bounded attempts
  expect(resolveMediaUrl("/media/g1/gone.png")).toBe(""); // '' = give up, render fallback
});

test("widgets hold their loading/initials affordances while a ref is in flight", async () => {
  server.use(http.get(`${API}/media64/g1/x.png`, () => HttpResponse.json({ uri: URI })));

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
