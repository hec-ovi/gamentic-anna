"""Bridge from the synchronous game engine to the Anna host's reverse-RPC.

When gamentic runs as an Anna Executa (`app/executa.py`), it installs a HostChannel
here at startup. The engine's provider code (`llm.chat`, the image provider) then
reaches Anna's OWN LLM and image generation through these synchronous facades, which
hop to the executa's asyncio loop and block the calling worker thread for the result.

No third-party bridge: the executa asks the Anna host directly
(`sampling/createMessage`, `image/generate`), with model selection, billing and quota
owned by the host. Outside an executa (plain uvicorn, tests) no channel is installed,
`active()` is False, and the engine falls back to its HTTP provider path unchanged.
"""
from __future__ import annotations

import asyncio
import logging
import time
from concurrent.futures import TimeoutError as _FuturesTimeout
from dataclasses import dataclass
from typing import Any, Callable

from .config import settings

# Anna's executa-side sampling makes max_tokens mandatory and hard-caps it at 8192
# tokens/call. We pass the maximum (never a smaller truncation ceiling) and shape
# length through the prompt, per the project's no-output-cap rule; the field cannot
# be omitted on this API.
MAX_SAMPLING_TOKENS = 8192

# Transient host-side failures we retry. Anna confirmed (forum t/114) that text-model
# 502s are brief upstream outages over the SAME path image succeeds on, and that the
# host tears its throw-away session down in `finally`, so retrying leaks no quota and
# is safe. We retry the provider/gateway error codes (sampling -32003, image -32103,
# agent -32046, and the raw-HTTP wrapper -32000) plus anything whose message names a
# 5xx gateway. We do NOT retry deterministic failures (not-granted -32001/-32101,
# quota -32002/-32102, invalid-request, unsupported-format, user-denied) or client
# timeouts (-32005/-32105): a retry can't change those, and retrying a timeout only
# doubles the wait. Bounded so a real outage surfaces as an error, never a long hang.
_RETRY_ATTEMPTS = 3
_RETRY_BACKOFF = (0.5, 1.5, 3.0)            # seconds before attempt 2, 3, ...
_RETRYABLE_CODES = frozenset({-32000, -32003, -32046, -32103})
_RETRYABLE_HINTS = ("502", "503", "504", "bad gateway", "gateway", "upstream",
                    "provider error", "provider_error")


def _is_transient(exc: BaseException) -> bool:
    """True for host-side gateway/provider blips that are worth retrying."""
    code = getattr(exc, "code", None)
    if isinstance(code, int) and code in _RETRYABLE_CODES:
        return True
    text = f"{getattr(exc, 'message', '')} {exc}".lower()
    return any(hint in text for hint in _RETRYABLE_HINTS)


def _call_with_retry(make_coro: Callable[[], Any], loop, *, result_timeout: float,
                     attempts: int = _RETRY_ATTEMPTS):
    """Run a reverse-RPC coroutine on the executa loop from a worker thread, retrying
    transient host failures with bounded backoff. `make_coro` must build a FRESH
    coroutine each call: a coroutine is single-use, so a retry cannot reuse the last.
    `attempts` is the total tries (pass 1 to disable retry, e.g. for slow image renders
    where a retry would stack another full render onto the invoke budget). On the backstop
    `result_timeout` we CANCEL the orphaned coroutine so a hung hop can't linger on the loop."""
    last: BaseException | None = None
    for attempt in range(attempts):
        fut = asyncio.run_coroutine_threadsafe(make_coro(), loop)
        try:
            return fut.result(timeout=result_timeout)
        except _FuturesTimeout:
            fut.cancel()
            raise
        except Exception as exc:  # noqa: BLE001 - re-raised below; we only branch on transience
            last = exc
            if attempt == attempts - 1 or not _is_transient(exc):
                raise
            time.sleep(_RETRY_BACKOFF[attempt])
    raise last  # unreachable: the loop always returns or raises


@dataclass
class HostChannel:
    loop: Any        # the executa's asyncio event loop (running on its own thread)
    sampling: Any    # executa_sdk.SamplingClient
    image: Any       # executa_sdk.ImageClient


_channel: HostChannel | None = None


def set_channel(channel: HostChannel) -> None:
    global _channel
    _channel = channel


def active() -> bool:
    """True only when running as an Anna Executa with the host channel installed."""
    return _channel is not None


def sample_sync(
    *,
    messages: list,
    system_prompt: str | None = None,
    temperature: float | None = None,
    stop_sequences: list | None = None,
    response_format: dict | None = None,
    on_unsupported: str | None = None,
    timeout: float = 300.0,
) -> dict:
    """Blocking `sampling/createMessage` from synchronous engine code: schedule the
    coroutine on the executa loop and block THIS worker thread for the host result."""
    ch = _channel
    if ch is None:
        raise RuntimeError("no Anna host channel installed")

    def _make():
        return ch.sampling.create_message(
            messages=messages,
            max_tokens=MAX_SAMPLING_TOKENS,
            system_prompt=system_prompt,
            temperature=temperature,
            stop_sequences=stop_sequences or None,
            response_format=response_format,
            on_unsupported=on_unsupported,
            timeout=timeout,
        )

    return _call_with_retry(_make, ch.loop, result_timeout=timeout + 15)


def generate_image_sync(
    *,
    prompt: str,
    size: str | None = None,
    reference_image_urls: list | None = None,
    model_preferences: dict | None = None,
    n: int = 1,
    timeout: float | None = None,
) -> dict:
    """Blocking `image/generate` from synchronous engine code. A render runs INSIDE an
    invoke, so it MUST fail fast: a single render is bounded at IMAGE_RENDER_TIMEOUT_S
    (default 50s) so a render invoke always returns well within the host's per-invoke
    budget (executa._do_invoke), and a stuck render can never drag the invoke past the
    host deadline and trigger an executa recycle. NO retry here (attempts=1): a retry
    would stack another full render onto the budget; the frontend re-fires a fresh render
    invoke instead. `model_preferences` selects a faster/cheaper host model when set."""
    ch = _channel
    if ch is None:
        raise RuntimeError("no Anna host channel installed")
    if timeout is None:
        timeout = settings.IMAGE_RENDER_TIMEOUT_S

    def _make():
        return ch.image.generate(
            prompt=prompt,
            n=n,
            size=size,
            reference_image_urls=reference_image_urls or None,
            model_preferences=model_preferences or None,
            timeout=timeout,
        )

    log = logging.getLogger("gamentic.image")
    log.info("image/generate -> size=%s refs=%d prompt=%.80r", size,
             len(reference_image_urls or []), prompt)
    try:
        result = _call_with_retry(_make, ch.loop, result_timeout=timeout + 15, attempts=1)
    except Exception:
        log.exception("image/generate FAILED")
        raise
    log.info("image/generate <- keys=%s %.400r",
             list((result or {}).keys()) if isinstance(result, dict) else type(result).__name__,
             result)
    return result
