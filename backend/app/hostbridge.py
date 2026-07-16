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

# Image-side host error codes the engine branches on (Anna reference, 2026-07):
# quota is a rolling per-invoke window, so it clears on its own; the grant/provider
# ones are deterministic per install and only the user can change them.
IMG_QUOTA_CODES = frozenset({-32106, -32107})   # rolling window / per-call grant
IMG_NOT_GRANTED = -32101
IMG_NO_PROVIDER = -32109


class ImageQuotaExhausted(RuntimeError):
    """image/generate hit the host's per-invoke image quota (rolling window).
    Not the asset's fault: callers pause ambient rendering instead of charging
    the asset's heal allowance."""


def _is_transient(exc: BaseException) -> bool:
    """True for host-side gateway/provider blips that are worth retrying."""
    code = getattr(exc, "code", None)
    if isinstance(code, int) and code in _RETRYABLE_CODES:
        return True
    text = f"{getattr(exc, 'message', '')} {exc}".lower()
    return any(hint in text for hint in _RETRYABLE_HINTS)


def _call_with_retry(make_coro: Callable[[], Any], loop, *, result_timeout: float):
    """Run a reverse-RPC coroutine on the executa loop from a worker thread, retrying
    transient host failures with bounded backoff. `make_coro` must build a FRESH
    coroutine each call: a coroutine is single-use, so a retry cannot reuse the last."""
    last: BaseException | None = None
    for attempt in range(_RETRY_ATTEMPTS):
        try:
            return asyncio.run_coroutine_threadsafe(make_coro(), loop).result(timeout=result_timeout)
        except Exception as exc:  # noqa: BLE001 - re-raised below; we only branch on transience
            last = exc
            if attempt == _RETRY_ATTEMPTS - 1 or not _is_transient(exc):
                raise
            time.sleep(_RETRY_BACKOFF[attempt])
    raise last  # unreachable: the loop always returns or raises


@dataclass
class HostChannel:
    loop: Any        # the executa's asyncio event loop (running on its own thread)
    sampling: Any    # executa_sdk.SamplingClient
    image: Any       # executa_sdk.ImageClient
    upload: Any = None   # executa_sdk.HostUploadClient (reference-image uploads)


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


def upload_file_sync(*, filename: str, content: bytes, mime_type: str = "image/png",
                     purpose: str = "image-edit-input", timeout: float = 60.0) -> dict:
    """Blocking `host/uploadFile` (inline mode): push a local file to the host's R2
    bucket and get a transient HTTPS URL back. This is how identity references reach
    image/generate under Anna - the host can only fetch reference_image_urls over
    HTTPS, never our /media paths (they live on the executa's own disk)."""
    ch = _channel
    if ch is None or ch.upload is None:
        raise RuntimeError("no Anna host upload channel installed")

    def _make():
        return ch.upload.upload_inline(filename=filename, mime_type=mime_type,
                                       content=content, purpose=purpose, timeout=timeout)

    return _call_with_retry(_make, ch.loop, result_timeout=timeout + 15)


def generate_image_sync(
    *,
    prompt: str,
    size: str | None = None,
    reference_image_urls: list | None = None,
    n: int = 1,
    timeout: float = 90.0,
) -> dict:
    """Blocking `image/generate` from synchronous engine code. 90s (NOT higher): renders
    run SERIALIZED inside one invoke, and the host kills a tool invoke at 600s. A stuck
    render must fail FAST so several of them can't blow the invoke budget and trigger an
    executa restart-loop. Normal renders are ~35s; 90s is generous headroom, and 4 (the
    per-invoke image cap) x 90s + the turn's LLM calls still fits well under 600s."""
    ch = _channel
    if ch is None:
        raise RuntimeError("no Anna host channel installed")

    prefs = ({"hints": [{"name": settings.IMAGE_MODEL_HINT}]}
             if settings.IMAGE_MODEL_HINT else None)

    def _make():
        return ch.image.generate(
            prompt=prompt,
            n=n,
            size=size,
            reference_image_urls=reference_image_urls or None,
            model_preferences=prefs,
            timeout=timeout,
        )

    log = logging.getLogger("gamentic.image")
    log.info("image/generate -> size=%s refs=%d hint=%s prompt=%.80r", size,
             len(reference_image_urls or []), settings.IMAGE_MODEL_HINT or "-", prompt)
    try:
        result = _call_with_retry(_make, ch.loop, result_timeout=timeout + 15)
    except Exception as exc:
        if getattr(exc, "code", None) in IMG_QUOTA_CODES:
            log.warning("image/generate quota exhausted (%s); ambient renders will pause",
                        getattr(exc, "code", None))
            raise ImageQuotaExhausted(str(exc)) from exc
        log.exception("image/generate FAILED")
        raise
    log.info("image/generate <- model=%s quota=%s keys=%s",
             (result or {}).get("model"), (result or {}).get("quota_used"),
             list((result or {}).keys()) if isinstance(result, dict) else type(result).__name__)
    return result
