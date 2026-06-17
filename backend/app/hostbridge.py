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
from dataclasses import dataclass
from typing import Any

# Anna's executa-side sampling makes max_tokens mandatory and hard-caps it at 8192
# tokens/call. We pass the maximum (never a smaller truncation ceiling) and shape
# length through the prompt, per the project's no-output-cap rule; the field cannot
# be omitted on this API.
MAX_SAMPLING_TOKENS = 8192


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
    coro = ch.sampling.create_message(
        messages=messages,
        max_tokens=MAX_SAMPLING_TOKENS,
        system_prompt=system_prompt,
        temperature=temperature,
        stop_sequences=stop_sequences or None,
        response_format=response_format,
        on_unsupported=on_unsupported,
        timeout=timeout,
    )
    return asyncio.run_coroutine_threadsafe(coro, ch.loop).result(timeout=timeout + 15)


def generate_image_sync(
    *,
    prompt: str,
    size: str | None = None,
    reference_image_urls: list | None = None,
    n: int = 1,
    timeout: float = 180.0,
) -> dict:
    """Blocking `image/generate` from synchronous engine code."""
    ch = _channel
    if ch is None:
        raise RuntimeError("no Anna host channel installed")
    coro = ch.image.generate(
        prompt=prompt,
        n=n,
        size=size,
        reference_image_urls=reference_image_urls or None,
        timeout=timeout,
    )
    return asyncio.run_coroutine_threadsafe(coro, ch.loop).result(timeout=timeout + 15)
