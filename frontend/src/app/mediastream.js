// Media-ready PUSH: one EventSource per open game on GET /games/{gid}/events.
// The backend announces the moment background media persists - scene art, a
// portrait, an item card, a late image beat - and we re-fetch the cheap
// endpoint that owns it: /state for scene/portrait, /beats?since= for beats,
// and BOTH for items (the unlock card is a beat, but the slot thumbnail lives
// in state's inventories - live: the card landed while the pack slot kept its
// initials). This replaces the blind polling timers (a 40s poll ceiling once
// lost a scene render that landed at +47s; only F5 recovered it).
// EventSource reconnects itself (the server sends retry: 3000); after a drop
// we owe one catch-up fetch of both. A slow 60s sweep stays as the fallback
// for proxies that break SSE - it is the only path when EventSource is
// missing entirely (old embedders, jsdom).

import { mapBeats, mapGameState } from "../adapters.js";
import { api, root, state } from "./ctx.js";
import { announceImage, startReveal } from "./reveal.js";
import { withVoice } from "./speech.js";
import { lastTurnIndexOf } from "./turns.js";
import { render } from "./ui.js";

export const FALLBACK_INTERVAL = 60000;

let stream = null; // the live EventSource
let fallbackTimer = null; // the slow sweep
let dropped = false; // a reconnect owes a catch-up

export function watchMedia(g) {
  stopMediaWatch();
  if (!g) return;
  // No SSE under Anna: the sandboxed iframe cannot reach the engine's /events
  // (api.base is the dead host:8000 there), so the EventSource would only spam
  // connection errors. pollBurst() (post-turn) + the fallback sweep cover media there.
  if (!state.annaMode && typeof EventSource !== "undefined") {
    const es = new EventSource(`${api.base}/games/${encodeURIComponent(g.id)}/events`);
    stream = es;
    es.onmessage = (e) => {
      if (stream !== es || state.active !== g) return;
      let ev;
      try {
        ev = JSON.parse(e.data);
      } catch {
        return; // keepalive noise / malformed line
      }
      if (ev.kind === "scene" || ev.kind === "portrait") refreshArt(g);
      else if (ev.kind === "item") {
        refreshArt(g); // the slot thumbnail (pack/scene/carrying) lives in /state
        pullBeats(g); // the unlock card is a beat
      } else if (ev.kind === "beat") pullBeats(g);
    };
    es.onopen = () => {
      if (stream !== es || state.active !== g) return;
      if (dropped) {
        dropped = false;
        refreshArt(g); // a drop may have swallowed events: catch up on both
        pullBeats(g);
      }
    };
    es.onerror = () => {
      dropped = true; // the browser reconnects on its own (retry: 3000)
    };
  }
  fallbackTimer = setInterval(() => {
    if (state.active !== g) return stopMediaWatch();
    refreshArt(g);
    pullBeats(g);
    pumpRenders(g); // agent path: actively request any still-missing art
  }, FALLBACK_INTERVAL);
}

export function stopMediaWatch() {
  if (stream) stream.close();
  stream = null;
  if (fallbackTimer) clearInterval(fallbackTimer);
  fallbackTimer = null;
  dropped = false;
}

// Post-turn art pickup under Anna. There is no SSE there (the sandboxed iframe cannot
// reach /events and the executa runs no HTTP listener), and the engine now renders a
// turn's art AFTER the reply returns (fire-and-forget), so the art lands in the seconds
// that follow. Poll a short, decaying burst to slot it in promptly instead of waiting
// up to the 60s fallback sweep. No-op outside Anna, where the EventSource push covers it.
const BURST_DELAYS = [1200, 2500, 4500, 7000, 11000, 16000, 24000, 34000, 46000];

export function pollBurst(g) {
  if (!g || !state.annaMode) return;
  for (const ms of BURST_DELAYS) {
    setTimeout(() => {
      if (state.active !== g || state.view !== "play") return;
      refreshArt(g);
      pullBeats(g);
    }, ms);
  }
}

// Active art driver for the Anna AGENT path. The agent tears the executa down per-invoke,
// so the engine's detached render jobs never run there (they do on the long-lived dev
// harness). Instead of passively polling /state for art that will never appear, REQUEST
// each missing image: POST /games/{id}/render renders ONE image synchronously inside its
// own short invoke (executa alive, reverse-RPC token valid) and returns it small enough to
// clear the agent's 64KB stdio frame limit. Serial + single-flight; slots each as it lands.
let pumping = false;

// The sandboxed iframe can only display an image we hold inline as a data: URI; a /media
// path (what /state carries for a persisted-but-not-inlined image) is unfetchable there.
const isDataUri = (u) => typeof u === "string" && u.startsWith("data:");

export async function pumpRenders(g) {
  if (!g || !state.annaMode || pumping) return;
  if (!g.state || !g.state.imagesEnabled) return;
  pumping = true;
  try {
    // An image needs (re)fetching unless we already hold it as a data: URI. The agent path
    // delivers images inline via /render; a /state reply may instead carry a /media PATH
    // (rendered, but not inlined under the per-reply budget), which the sandboxed iframe
    // cannot load - so a non-data: value (null OR /media path) means "pull it via /render".
    const targets = [];
    if (g.state.scene && !isDataUri(g.state.scene.imageUrl)) targets.push({ kind: "scene" });
    for (const c of g.state.characters || []) {
      if (c.present && c.alive !== false && (!isDataUri(c.faceUrl) || !isDataUri(c.bodyUrl)))
        targets.push({ kind: "character", id: c.id });
    }
    // Items: re-fetch any inventory thumbnail the engine already rendered but that came
    // back as a /media path (so it persists across reloads). Keyed by name, deduped across
    // the player pack, the scene, and every character's carried items.
    const itemNames = new Set();
    const scanItems = (items) =>
      (items || []).forEach((it) => {
        if (it && it.name && it.imageUrl && !isDataUri(it.imageUrl)) itemNames.add(it.name);
      });
    scanItems(g.state.player && g.state.player.inventory);
    scanItems(g.state.scene && g.state.scene.items);
    (g.state.characters || []).forEach((c) => scanItems(c.inventory));
    for (const name of itemNames) targets.push({ kind: "item", id: name });
    for (const t of targets) {
      if (state.active !== g || state.view !== "play" || g.generating) break;
      try {
        const res = await api.renderImage(g.id, t);   // synchronous render, returns the image
        if (state.active !== g) break;
        if (slotRender(g, t, res) && state.view === "play" && !g.revealing) render();
      } catch {
        // this image failed/timed out; the next trigger (turn / 60s sweep) retries it.
        // Move on so one slow render never blocks the rest.
      }
    }
  } finally {
    pumping = false;
  }
}

// Fold a /render reply (its own small {kind, image_url | face_url/body_url} shape) into
// the live mapped game state, in place, so the next render() shows it.
function slotRender(g, t, res) {
  if (!g.state || !res || typeof res !== "object") return false;
  if (t.kind === "scene" && g.state.scene && res.image_url) {
    g.state.scene.imageUrl = res.image_url;
    return true;
  }
  if (t.kind === "character") {
    const c = (g.state.characters || []).find((x) => x.id === t.id);
    if (c && (res.face_url || res.body_url || res.body_front_url)) {
      c.faceUrl = res.face_url || c.faceUrl;
      c.bodyUrl = res.body_url || res.body_front_url || c.bodyUrl;
      return true;
    }
  }
  if (t.kind === "item" && res.image_url) {
    let slotted = false;
    const apply = (items) =>
      (items || []).forEach((it) => {
        if (it && it.name === t.id) {
          it.imageUrl = res.image_url;
          slotted = true;
        }
      });
    apply(g.state.player && g.state.player.inventory);
    apply(g.state.scene && g.state.scene.items);
    (g.state.characters || []).forEach((c) => apply(c.inventory));
    return slotted;
  }
  return false;
}

// One-shot /state refetch: slot late-arriving art in (scene image, portraits).
// Never clobbers fresh post-turn state: the turn's own response wins.
export async function refreshArt(g) {
  if (state.active !== g || !g.state || g.generating) return;
  try {
    const mapped = mapGameState(await api.getState(g.id));
    if (state.active !== g || g.generating) return; // turned stale while awaiting
    const prev = g.state;
    // Never downgrade an image we already hold inline (data: URI) back to a /media path:
    // /state carries /media paths for images not inlined under the per-reply budget, and the
    // sandboxed iframe cannot load /media. Keep the delivered data: URI (pumpRenders fills
    // anything still on a /media path). Without this, a /state refresh broke live portraits.
    const keep = (next, prevUrl) => (isDataUri(prevUrl) && !isDataUri(next) ? prevUrl : next);
    if (mapped.scene && prev.scene) mapped.scene.imageUrl = keep(mapped.scene.imageUrl, prev.scene.imageUrl);
    for (const c of mapped.characters || []) {
      const p = (prev.characters || []).find((x) => x.id === c.id);
      if (p) {
        c.faceUrl = keep(c.faceUrl, p.faceUrl);
        c.bodyUrl = keep(c.bodyUrl, p.bodyUrl);
      }
    }
    const prevItemUrls = new Map();
    const idxItems = (items) => (items || []).forEach((it) => it && it.id && prevItemUrls.set(it.id, it.imageUrl));
    idxItems(prev.player && prev.player.inventory);
    idxItems(prev.scene && prev.scene.items);
    (prev.characters || []).forEach((c) => idxItems(c.inventory));
    const keepItems = (items) =>
      (items || []).forEach((it) => {
        if (it && it.id) it.imageUrl = keep(it.imageUrl, prevItemUrls.get(it.id));
      });
    keepItems(mapped.player && mapped.player.inventory);
    keepItems(mapped.scene && mapped.scene.items);
    (mapped.characters || []).forEach((c) => keepItems(c.inventory));
    const gainedPortrait = mapped.characters.some((c) => {
      const p = prev.characters.find((x) => x.id === c.id) || {};
      return (c.faceUrl && !p.faceUrl) || (c.bodyUrl && !p.bodyUrl);
    });
    const gainedScene = mapped.scene && mapped.scene.imageUrl && !(prev.scene && prev.scene.imageUrl);
    // an item thumbnail gain re-renders too: the unlock card may already sit in
    // the stream while the slot still shows initials (every inventory counts -
    // the pack, the scene grid, a character's carrying row)
    const itemArt = (st) => {
      const m = new Map();
      const take = (items) => (items || []).forEach((it) => it && it.id && m.set(it.id, it.imageUrl));
      take(st.player && st.player.inventory);
      take(st.scene && st.scene.items);
      (st.characters || []).forEach((c) => take(c.inventory));
      return m;
    };
    const prevItems = itemArt(prev);
    const gainedItemArt = [...itemArt(mapped)].some(([id, url]) => url && !prevItems.get(id));
    g.state = mapped;
    // don't yank the DOM out from under a running typewriter; the art shows
    // on the next natural render
    if ((gainedPortrait || gainedScene || gainedItemArt) && state.view === "play" && !g.revealing) {
      render();
      if (gainedScene) {
        const art = root.querySelector("#storyStream .prose-art img");
        if (art) announceImage(art.closest(".prose-art") || art);
      }
    }
  } catch {
    /* the fallback sweep retries */
  }
}

// One-shot /beats?since= pull: merge late beats (look images, item unlock
// cards) through the usual staged reveal. While a turn is resolving we stay
// out of its way and note the debt; resolveTurn settles it.
export async function pullBeats(g) {
  if (state.active !== g || !Number.isInteger(g.lastTurnIndex)) return;
  if (g.generating) {
    g.pullOwed = true; // resolveTurn pulls once the turn lands
    return;
  }
  try {
    const res = await api.getBeats(g.id, g.lastTurnIndex);
    if (state.active !== g || g.generating) return;
    const seen = new Set(g.beats.map((b) => b.id));
    const fresh = mapBeats((res && res.beats) || [])
      .filter((b) => !seen.has(b.id))
      .map((b) => withVoice(b));
    if (!fresh.length) return;
    g.beats = [...g.beats, ...fresh];
    g.lastTurnIndex = lastTurnIndexOf(g.beats, g.lastTurnIndex);
    if (fresh.some((b) => b.kind === "image" && b.speaker !== "system")) g.pendingView = false;
    // a panel-launched look's image lands here, seconds later: mirror it
    const tagged = g.lastVia ? fresh.map((b) => (b.kind === "image" ? { ...b, viaProfile: g.lastVia } : b)) : fresh;
    if (g.lastVia) g.beats = [...g.beats.filter((b) => !tagged.some((t) => t.id === b.id)), ...tagged];
    if (state.view === "play") {
      g.revealQueue = [...(g.revealQueue || []), ...fresh.map((b) => b.id)];
      render();
      startReveal(g);
    }
    // any other view: the beats are merged unveiled and simply stand in the
    // log when the player returns (no staged reveal for what they missed)
  } catch {
    /* the fallback sweep retries */
  }
}
