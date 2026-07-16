// Comms client for the Gamentic engine.
//
// COMMS-LAYER SWAP (Anna): the 18 methods below are unchanged from gamentic; only
// `request()` changed. When an Anna transport is injected (createApi(url, { invoke }))
// every call is routed to the backend Executa via `anna.tools.invoke({ path, method,
// body })` instead of `fetch`. With no transport it falls back to the original HTTP
// path (standalone preview, unit tests, and a plain orchestrator all keep working).
// Nothing else in the frontend knows or cares which transport is live.

export class ApiError extends Error {
  constructor(message, { status = 0, body = null } = {}) {
    super(message);
    this.name = "ApiError";
    this.status = status;
    this.body = body;
  }
}

// A hung socket must become an error, never an eternal busy-lock. LLM-bound
// calls legitimately run minutes (the brain's own transport ceiling is 300s);
// plain reads should fail fast.
export const READ_TIMEOUT_MS = 20000;
export const LLM_TIMEOUT_MS = 330000;
export const IMPORT_TIMEOUT_MS = 60000;

// createApi(backendUrl)              -> HTTP transport (fetch), as before.
// createApi(backendUrl, { invoke })  -> Anna transport. `invoke(path, { method, body })`
//                                       resolves to { status, json } (the Executa reply).
export function createApi(backendUrl, { invoke = null } = {}) {
  const base = String(backendUrl || "http://localhost:8000").replace(/\/+$/, "");

  // Returns { status, json } from whichever transport is active. The ok/error
  // handling below is shared, so a 404/422 reads the same over Anna or HTTP.
  async function transport(path, method, body, timeout) {
    if (invoke) {
      const hang = new Promise((_, reject) =>
        setTimeout(() => reject(new ApiError("Anna is taking too long to answer. Try again.", { status: 0 })), timeout),
      );
      const out = await Promise.race([invoke(path, { method, body }), hang]);
      // Peel whatever envelopes the host/SDK did or did not strip:
      //   SDK wrapper:        { ok, result: <below> }
      //   executa tool reply: { success, data: { status, json }, error }
      //   host-stripped:      { status, json }   (or a bare payload)
      let r = out && typeof out === "object" && "result" in out ? out.result : out;
      if (r && typeof r === "object") {
        // An explicit tool-level failure (Anna sampling 502 after retries, a per-invoke
        // cap, a quota/grant error) must RAISE so the caller shows a clean toast - never
        // slip through as a fake 200 carrying a raw Cloudflare error page as the "json".
        if (r.success === false) throw new ApiError(annaErrorMessage(r.error), { status: 502, body: r });
        // success envelope the host did NOT strip: { success:true, data:{ status, json } }
        if (r.success === true && r.data && typeof r.data === "object") r = r.data;
      }
      if (r && typeof r === "object" && "status" in r) return { status: r.status, json: r.json };
      return { status: 200, json: r }; // tolerant: a bare payload reads as 200
    }
    // --- original HTTP path (unchanged behavior) ---
    let response, timer = null;
    try {
      const attempt = fetch(`${base}${path}`, {
        method,
        headers: { Accept: "application/json", ...(body ? { "Content-Type": "application/json" } : {}) },
        body: body ? JSON.stringify(body) : undefined,
      });
      attempt.catch(() => {});
      const hang = new Promise((_, reject) => {
        timer = setTimeout(() => reject(new ApiError("The backend is taking too long to answer. Try again.", { status: 0 })), timeout);
      });
      response = await Promise.race([attempt, hang]);
    } catch (networkError) {
      if (networkError instanceof ApiError) throw networkError;
      throw new ApiError(networkError.message || "Backend unreachable", { status: 0 });
    } finally {
      if (timer) clearTimeout(timer);
    }
    return { status: response.status, json: await readBody(response), ok: response.ok, statusText: response.statusText };
  }

  // The Anna agent runtime recycles the executa on its own; an invoke in flight when it
  // happens is dropped (surfaces as a transport-level ApiError: status 0 from the hang,
  // or 502 from a success:false envelope). GETs are idempotent, so retry them a few times
  // with a short backoff before giving up - this is what keeps resume from bouncing you to
  // the menu when the executa cycles mid-open. POSTs (actions, creation) are NOT retried:
  // they are not idempotent and a slow turn that blows the 65s cap must surface, not double-fire.
  function retriable(err, method) {
    return method === "GET" && err instanceof ApiError && (err.status === 0 || err.status === 502);
  }

  async function request(path, { method = "GET", body, timeout = READ_TIMEOUT_MS } = {}) {
    // Retry only over the Anna invoke transport (where the executa recycles under us); the
    // plain HTTP path has no executa to drop a call, so a hang there surfaces immediately.
    const attempts = invoke && method === "GET" ? 4 : 1;
    let lastErr;
    for (let i = 0; i < attempts; i++) {
      try {
        const { status, json, ok, statusText } = await transport(path, method, body, timeout);
        const good = ok !== undefined ? ok : status >= 200 && status < 300;
        if (!good) throw new ApiError(errorDetail(json, { status, statusText: statusText || "" }), { status, body: json });
        return json;
      } catch (err) {
        lastErr = err;
        if (i + 1 >= attempts || !retriable(err, method)) throw err;
        await new Promise((r) => setTimeout(r, 400 * (i + 1))); // 0.4s, 0.8s, 1.2s - cover one recycle
      }
    }
    throw lastErr;
  }

  return {
    base,
    health: () => request("/health"),
    listGames: () => request("/games"),
    createGame: (worldSheet) => request("/games", { method: "POST", body: worldSheet }),
    getState: (id) => request(`/games/${encodeURIComponent(id)}/state`),
    getBeats: (id, since = null) =>
      request(`/games/${encodeURIComponent(id)}/beats${Number.isInteger(since) ? `?since=${since}` : ""}`),
    takeAction: (id, input, wish) => {
      const body = Array.isArray(input) ? { segments: input } : { action: input };
      if (wish) body.wish = wish;
      return request(`/games/${encodeURIComponent(id)}/action`, { method: "POST", body, timeout: LLM_TIMEOUT_MS });
    },
    continueStory: (id, wish) =>
      request(`/games/${encodeURIComponent(id)}/continue`, { method: "POST", body: wish ? { wish } : {}, timeout: LLM_TIMEOUT_MS }),
    patchSettings: (id, payload) =>
      request(`/games/${encodeURIComponent(id)}/settings`, { method: "PATCH", body: payload }),
    characterProfile: (id, cid) =>
      request(`/games/${encodeURIComponent(id)}/characters/${encodeURIComponent(cid)}/profile`),
    exportGame: (id, kind) => request(`/games/${encodeURIComponent(id)}/export?kind=${encodeURIComponent(kind)}`),
    // '/media/<gid>/<name>' -> { uri: 'data:image/jpeg;base64,...' } (Anna mode: the
    // iframe cannot fetch /media directly; mediacache.js calls this once per image)
    media64: (mediaUrl) => request(`/media64${String(mediaUrl).replace(/^\/media/, "")}`),
    // several refs in ONE round-trip: { uris: { url: dataUriOrNull } } (rejoining a
    // mature adventure resolves its whole backlog in a couple of calls, not one each)
    media64Batch: (urls) => request("/media64/batch", { method: "POST", body: { urls } }),
    // install-wide settings: the player-facing images switch + render health
    appSettings: () => request("/settings/app"),
    patchAppSettings: (payload) => request("/settings/app", { method: "PATCH", body: payload }),
    importGame: (payload) => request("/games/import", { method: "POST", body: payload, timeout: IMPORT_TIMEOUT_MS }),
    deleteGame: (id) => request(`/games/${encodeURIComponent(id)}`, { method: "DELETE" }),
    wipeAll: () => request("/games?confirm=wipe", { method: "DELETE" }),
    clearBeats: (id) => request(`/games/${encodeURIComponent(id)}/beats`, { method: "DELETE" }),
    explain: (id, payload) =>
      request(`/games/${encodeURIComponent(id)}/explain`, { method: "POST", body: payload, timeout: LLM_TIMEOUT_MS }),
    creatorMessage: (sessionId, message) =>
      request("/create/message", { method: "POST", body: { session_id: sessionId, message }, timeout: LLM_TIMEOUT_MS }),
    creatorFinalize: (sessionId) =>
      request("/create/finalize", { method: "POST", body: { session_id: sessionId }, timeout: LLM_TIMEOUT_MS }),
    // One sentence -> a complete seeded game in a single pass (no chat, no function-calling
    // dependency). The backend coerces/falls back so it never 409s; an empty prompt is a
    // surprise-me. LLM timeout: a one-shot world build can run minutes.
    quickCreate: (prompt) =>
      request("/create/quick", { method: "POST", body: { prompt: prompt || "" }, timeout: LLM_TIMEOUT_MS }),
    creatorSession: (sessionId) => request(`/create/${encodeURIComponent(sessionId)}`),
  };
}

async function readBody(response) {
  const text = await response.text();
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

// An executa tool-level failure carries a raw error string: a whole Cloudflare 502
// HTML page, or a "[-32xxx] ..." JSON-RPC error. Map it to ONE short, human line for
// the toast - never echo the payload (megabytes of markup, or an opaque code the
// player cannot act on). Buckets follow Anna's sampling / image / agent error tables.
export function annaErrorMessage(error) {
  const raw = (typeof error === "string" ? error : (error && (error.message || JSON.stringify(error))) || "").toLowerCase();
  if (/\b50[234]\b|bad gateway|gateway|upstream|provider error|-32000|-32003|-32046|-32103/.test(raw))
    return "Anna's model is temporarily unavailable. Please try again in a moment.";
  if (/-32006|-32007|max.?(calls|tokens)|cumulative|too many calls/.test(raw))
    return "That turn asked too much of Anna at once. Try a simpler action.";
  if (/-32002|-32102|quota|usage limit|insufficient (credit|balance|quota)/.test(raw))
    return "Anna usage limit reached for now.";
  if (/-32001|-32101|-32009|-32108|not granted|denied|permission/.test(raw))
    return "Anna hasn't granted this capability. Check the app's permissions.";
  if (/-32005|-32105|timeout|timed out/.test(raw))
    return "Anna took too long to answer. Please try again.";
  return "Anna couldn't complete that action. Please try again.";
}

// FastAPI's 422 detail is an ARRAY of {loc,msg,type}; a plain String() of it
// reads "[object Object]" in a toast. Flatten to the human messages.
function errorDetail(payload, response) {
  const d = payload && typeof payload === "object" ? (payload.detail ?? payload.message) : payload;
  if (Array.isArray(d)) {
    const msgs = d.map((x) => (x && typeof x === "object" ? x.msg || x.message : x)).filter(Boolean);
    if (msgs.length) return msgs.join("; ");
  } else if (d && typeof d === "object") {
    return d.msg || d.message || JSON.stringify(d);
  } else if (d != null && String(d).trim()) {
    return String(d);
  }
  return (response && response.statusText) || "Request failed";
}
