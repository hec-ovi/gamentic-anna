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

async function fetchMedia(url) {
  if (inflight.has(url) || (failures.get(url) || 0) >= MAX_ATTEMPTS) return;
  inflight.add(url);
  try {
    const res = await api.media64(url);
    if (res && res.uri) {
      cache.set(url, res.uri);
      failures.delete(url);
    } else {
      cache.set(url, ""); // the engine answered but could not encode: stop asking
    }
    scheduleNotify();
  } catch (err) {
    const n = (failures.get(url) || 0) + 1;
    failures.set(url, n);
    if (err && err.status === 404) {
      // MOSTLY a race: the beat landed before its file finished persisting.
      // Leave it retriable (the next render try re-fetches) until attempts run out.
      if (n >= MAX_ATTEMPTS) cache.set(url, "");
    }
    // transient transport errors: stay out of the cache so a later render retries
  } finally {
    inflight.delete(url);
  }
}

// Tests + the wipe-all path (a new world must not show a dead game's cached art).
export function resetMediaCache() {
  cache.clear();
  inflight.clear();
  failures.clear();
}
