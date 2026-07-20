Hey Anna app developers! 👋

It’s been a huge stretch since beta.55 — 40+ releases packed with new Host APIs, a completely overhauled publishing pipeline, and a mountain of reliability fixes. Here’s everything that matters for your apps, in one friendly digest. Let’s go! 🚀

✨ New Host APIs & SDK Goodies
🌐 Web Search & Fetch Host API (beta.92) — Your apps can now browse the web! anna.web.search / web.fetch / web.imageSearch / web.imageFetch, available to both iframe apps and Executa plugins. Provider chain (Tavily → DDGS fallback), built-in caching, SSRF-hardened image fetch that lands artifacts in APS. Gated behind a new web grant — off by default, users opt in. 🔎
🌊 Streaming LLM completions (beta.71) — anna.llm.stream(req) returns an async iterable: for await token-by-token frames, with a final frame mirroring llm.complete. Same params you already know.
🔑 anna.credentials.* namespace + multi-account (beta.84) — Users can now connect multiple accounts per provider (e.g. two Google accounts). Apps declare ui.host_api.credentials and use credentials.list_accounts / credentials.get_token; Executas get their own short-lived credential tokens, with an auto-injected optional account param for multi-account tools.
🚀 anna.apps.* launcher namespace (beta.70) — List, search, and launch other installed apps, plus anna.apps.deck.* to manage the user’s Deck. Also new: vibrancy window chrome (chrome: "vibrancy", transparent: true) for gorgeous frosted-glass windows. 🪟
🛠️ anna.tools.onChanged(cb) (beta.88) — MCP-style tools-changed events. Plus tools.list entries now carry an optional status (available / deploying / unavailable) so your UI can disable buttons before a click fails.
🎯 Per-run modelPreferences on agent.session.run (beta.95) — Pass MCP-shaped model hints on a single run. And speedPriority finally does something real: models now have measured speed tiers (fast / balanced / thorough) from live latency stats. ⚡
🎨 Image generation leveled up (beta.96) — New fal.ai providers (Nano Banana 2, GPT Image 2, Seedream 5.0 Pro), plus advanced options on image/generate & image/edit: quality, resolution (0.5K–4K), output_format, web-search & thinking add-ons — and request-level modelPreferences hints. Billing tracks actual cost per request.
🔐 Unified permissions view (beta.78) — GET /anna-apps/{id}/permissions returns app + bundled-Executa grants with computed missing lists; the dashboard now shows a friendly permission gate before launch instead of letting apps fail mysteriously.
📦 Publishing & Distribution, Seriously Hardened
⬆️ Executa binary direct upload (beta.81) — Push your binaries straight to Anna: chunked, resumable, content-addressed, server-side sha256 verification. No more GitHub Release mirroring dance.
🤖 OIDC Trusted Publishing (beta.81) — Zero-secret CI! GitHub Actions can exchange its id-token for upload credentials, PyPI-style (repo + workflow + environment matching). Your secrets stay… nonexistent. 🔒
🚦 Release-time binary readiness gate (beta.75–77) — release now verifies every referenced binary is byte-for-byte mirrored before your app goes live. No more shipping apps that 404 on install. Includes fixes for private-repo assets and asset-dict binary_urls shapes.
🧊 Anti-drift frozen snapshots (beta.79) — All install/reinstall/upgrade paths resolve from the immutable ExecutaVersion snapshot bound to the installed app version. Rewriting binary_urls after publish can no longer break installs.
📏 Bigger limits (beta.79) — App bundles: 50MB → 1GB total, 10MB → 100MB per file. Binary assets: up to 1GB per platform, fully streamed.
🏷️ Strict versioning — no more phantom bumps (beta.90, forum #169) — The server never invents versions. Changed content + frozen version = a clear 400 telling you to bump executa.json. Your version history stays traceable to your source.
☁️ Cloud Agent & Runtime Reliability
⏰ Wake-on-demand, everywhere (beta.78–86) — tools.invoke from app windows now wakes suspended Cloud Agents (with prewarm on window open, single-flight dedup, and adaptive wait windows). A polished wake overlay with retry keeps users informed instead of staring at silent failures. New transient agent_waking error code lets SDKs auto-retry.
🔄 Executa deploy reconciliation (P0–P3) (beta.87–89) — A facts table tracks what’s actually deployed on each agent; drift (failed jobs, agent switches, wiped volumes) is detected and auto-healed. Apps opening with missing required tools show a live progress overlay + one-click Repair. Missing plugins on invoke now return a precise, retriable executa_not_deployed.
📊 App Store–style deploy progress (beta.94) — iOS-style pie-fill install animation, per-tool progress bars, and real-time progress even for reconcile-triggered deploys.
🐛 Notable Bug Fixes
🩹 anna-app dev upload 403 fixed (beta.80, forum #159) — Dev registration now grants the full dev bundle (llm + image + upload), and the local harness routes Executa host/uploadFile correctly (inline/negotiate/confirm). Official file-upload demo works end-to-end locally.
🏷️ Upload response fields aligned (beta.91 + CLI 0.1.38, forum #168) — All upload endpoints now return canonical download_url / size_bytes / expires_at and legacy url / bytes / expires_in aliases. Strict SDK validators are happy again.
🎯 Default Agent routing fixed (beta.95) — A wrong-table read meant your default Agent preference was silently ignored, misrouting local Executa calls to Cloud Agents (executa_not_deployed déjà vu). Now resolved properly.
🔁 Repeat app installs no longer 500 (beta.62–64) — Idempotent deploy jobs, transaction cleanup, and rollback of half-installed ghost states on failure.
🛡️ APS cross-owner scope gate enforced (beta.92) — Closed a gap where storage scope capabilities weren’t re-checked on overridden handlers; plus new opt-in cross-app data access via aps.scope.app.read|write.
🧯 Platform stability (beta.94) — DB connection pool exhaustion root-caused and fixed (connections released before long waits), engine-level connect retries, and event-loop blocking eliminated. Fewer mystery timeouts for everyone.
🧩 Compatibility Notes
🟢 Everything is additive — old apps keep working; unknown methods just return -32601 and degrade gracefully.
📌 Current pin matrix: dispatcher_version 0.16.0 · anna-app-schema 0.16.0 · anna-app-core 0.14.0 · @anna-ai/app-runtime 0.13.0 · anna-app-runtime-local 0.2.0a15 · @anna-ai/cli 0.1.38.
⬆️ To use the new goodies (web., llm.stream, credentials., apps.*, tools.onChanged): update @anna-ai/cli to 0.1.38 and @anna-ai/app-runtime to 0.13.0, then declare the new capabilities in your manifest.
📬 Feedback Welcome!
Built something with anna.web.search? Wired up zero-secret CI publishing? We’d love to see it — drop your questions, feedback, or showcase posts below. Happy building! 💜✨
