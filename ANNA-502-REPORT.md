# Anna text sampling: 502 Bad Gateway (image works)

**When:** 2026-06-17, ~20:09 to 20:13 UTC
**CLI:** `@anna-ai/cli` 0.1.30
**Account:** https://anna.partners (PAT scope `aps:dev`)
**Code under test:** official `anna-executa-examples` @ `d5ddba6` (2026-06-13), unmodified

## Status update (2026-06-18)

- **Acknowledged by the Anna team.** Root-caused on the forum as a platform-side text-model upstream outage, not an app/auth/SDK bug: https://forum.anna.partners/t/text-sampling-502s-on-anna-partners-platform-side-text-model-outage-not-an-app-bug/114 . Their reasoning matches this report exactly (image OK over the identical path rules out auth, grants, protocol, SDK, Cloudflare).
- **Still down, and NOT a ~4-minute blip.** The forum post described a "~4-minute window" that "likely self-healed." Re-tested at **2026-06-18 12:36:03 UTC** through our own executa (`/create/message`, which calls `sampling/createMessage`): still `-32000` HTTP 502. New Cloudflare Ray ID **`a0da56554f4a77f0`**; the CF diagnostic shows `anna.partners` Host = Error while Browser and Cloudflare = Working. That is **16+ hours** after the first report, so this is a sustained (or recurring) text-model outage, not a transient one.
- **Client-side retry added on our side** (bounded: 3 attempts, 0.5/1.5/3s backoff, only on transient 5xx/provider/`-32000`). It rules out momentary network instability and degrades gracefully, but cannot mask a multi-hour upstream outage, which correctly surfaces as an error rather than a hang.

## TL;DR

Every text reverse-RPC returns **HTTP 502 Bad Gateway**. Image generation over the exact same path works. The fault is isolated to the **text-model upstream**, not auth, grants, protocol, or Cloudflare in general.

## What works

- `anna-app login` (device code), `whoami` ok
- `executa dev` auto-registration + auto-seeded grants (llm, image, upload), protocol v2 negotiated
- `GET /` returns 200, `GET /api/v1/health` returns 200
- `image/generate` returns success, real R2 URL, model `doubao-seedream-5-0-260128`

## What fails (both text methods, identical 502)

| Method | Example used (unmodified) | Result |
| --- | --- | --- |
| `sampling/createMessage` | `python/sampling-summarizer` -> `summarize` | `-32000`, HTTP 502 |
| `agent/complete` | `python/executa-agent-demo` -> `ask_complete` | `-32046`, HTTP 502 |
| `image/generate` | `python/image-poster` -> `poster_create` | success |

So it is not method-specific and not our code: two different text methods 502 while image succeeds in the same session.

## Reproduce

```
anna-app login --host https://anna.partners

anna-app executa dev --dir examples/python/sampling-summarizer --json \
  --invoke summarize --args '{"text":"ping","max_words":5}'
# -> [-32000] HTTP 502: anna.partners | 502: Bad gateway

anna-app executa dev --dir examples/python/executa-agent-demo --json \
  --invoke ask_complete --args '{"prompt":"Reply with the word READY."}'
# -> [-32046] agent/complete failed: HTTP 502
```

## For your log lookup

- Cloudflare Ray ID (one of several): `a0d4b1dfbb43d7d7`
- client IP `190.3.40.114` (Colombia, flagging in case of regional routing to the text provider)
- model listing is locked, so we cannot self-diagnose or pass a model hint:
  `GET /api/v1/llm/models` -> 403 `"Only super admins can perform this action"`, `/api/v1/models` -> 404

## Likely cause to check

The default text model bound to a dev PAT (scope `aps:dev`) looks unreachable (502), while the image provider (`doubao-seedream`) is healthy. Either the text provider is down, or no text model is assigned to dev accounts. Knowing the default text model, or being able to pass `modelPreferences`, would let us confirm from our side.

## How we work around it meanwhile

We build and validate the full native text wiring offline with canned responses, so no work is blocked:

```
anna-app executa dev --dir ./backend --mock-sampling fixtures/text.jsonl --invoke ...
```

Image stays real (`image/generate`). When the text backend is restored we drop `--mock-sampling` and run the full game end to end against real Anna text.
