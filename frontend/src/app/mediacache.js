// Anna-mode media resolution. Replies from the Executa carry small /media/... refs
// (the sandboxed iframe cannot fetch them over HTTP, and inlining every image into
// every reply re-shipped megabytes per /state poll). Each ref resolves ONCE through
// GET /media64/{gid}/{name} to a data: URI, cached here for the session; while a
// fetch is in flight the widgets fall back to their existing loading affordances
// (skeleton / initials). Outside Anna mode URLs pass through untouched and the
// browser fetches /media directly, as always.

import { api, state } from "./ctx.js";

const cache = new Map(); // '/media/<gid>/<name>' -> data URI ('' = gave up: renders nothing)
const inflight = new Set();
const failures = new Map(); // url -> attempt count (transient errors retry on later renders)
const MAX_ATTEMPTS = 3;

// Injected render trigger (a direct import of ui.js here would be a cycle:
// ui -> render -> widgets -> mediacache). Batched through a microtask so a
// burst of resolved images repaints once, not once per image.
let notify = null;
let notifyQueued = false;

export function onMediaReady(fn) {
  notify = fn;
}

function scheduleNotify() {
  if (!notify || notifyQueued) return;
  notifyQueued = true;
  queueMicrotask(() => {
    notifyQueued = false;
    if (notify) notify();
  });
}

// Resolve an image URL for rendering. Returns the URL itself outside Anna mode
// (or for non-/media URLs), the cached data: URI when we have it, '' when the
// image is unfetchable (caller renders its no-image fallback), or null while a
// fetch is in flight (caller renders its loading affordance).
export function resolveMediaUrl(url) {
  if (!url || typeof url !== "string") return url;
  if (!state.annaMode || !url.startsWith("/media/")) return url;
  if (cache.has(url)) return cache.get(url);
  fetchMedia(url);
  return null;
}

// A render pass asks for many images at once (rejoining a mature adventure: the
// scene, every avatar, the transcript's shots). Each used to fire its OWN invoke -
// a full host round-trip, four at a time. Requests now pool for a beat and go out
// as POST /media64/batch chunks, collapsing the fan-out into a couple of calls.
const BATCH_DELAY_MS = 25;
const BATCH_MAX = 12; // the engine's MEDIA64_BATCH_MAX
const queued = new Set();
let flushTimer = null;

function fetchMedia(url) {
  if (inflight.has(url) || queued.has(url) || (failures.get(url) || 0) >= MAX_ATTEMPTS) return;
  queued.add(url);
  if (flushTimer == null) flushTimer = setTimeout(flushQueue, BATCH_DELAY_MS);
}

function noteFailure(url, hard) {
  const n = (failures.get(url) || 0) + 1;
  failures.set(url, n);
  // hard = the engine answered and said no (missing file: MOSTLY a race - the beat
  // landed before its file finished persisting). Retriable on later renders until
  // attempts run out, then '' (the caller's no-image fallback). Transport errors
  // never poison the cache: a later render simply retries.
  if (hard && n >= MAX_ATTEMPTS) cache.set(url, "");
}

async function flushQueue() {
  flushTimer = null;
  const urls = [...queued];
  queued.clear();
  urls.forEach((u) => inflight.add(u));
  try {
    for (let i = 0; i < urls.length; i += BATCH_MAX) {
      const chunk = urls.slice(i, i + BATCH_MAX);
      try {
        const res = await api.media64Batch(chunk);
        const uris = (res && res.uris) || {};
        for (const u of chunk) {
          if (uris[u]) {
            cache.set(u, uris[u]);
            failures.delete(u);
          } else {
            noteFailure(u, true);
          }
        }
        scheduleNotify();
      } catch {
        chunk.forEach((u) => noteFailure(u, false)); // transport blip: retriable
      } finally {
        chunk.forEach((u) => inflight.delete(u));
      }
    }
  } finally {
    urls.forEach((u) => inflight.delete(u)); // belt and braces on early exits
  }
}

// Tests + the wipe-all path (a new world must not show a dead game's cached art).
export function resetMediaCache() {
  cache.clear();
  inflight.clear();
  failures.clear();
  queued.clear();
  if (flushTimer != null) clearTimeout(flushTimer);
  flushTimer = null;
}
