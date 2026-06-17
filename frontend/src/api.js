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
      // tools.invoke returns the plugin payload (host strips its envelopes); the
      // SDK may wrap it as { ok, result }. Accept both, expect { status, json }.
      const r = out && typeof out === "object" && "result" in out ? out.result : out;
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

  async function request(path, { method = "GET", body, timeout = READ_TIMEOUT_MS } = {}) {
    const { status, json, ok, statusText } = await transport(path, method, body, timeout);
    const good = ok !== undefined ? ok : status >= 200 && status < 300;
    if (!good) {
      throw new ApiError(errorDetail(json, { status, statusText: statusText || "" }), { status, body: json });
    }
    return json;
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
