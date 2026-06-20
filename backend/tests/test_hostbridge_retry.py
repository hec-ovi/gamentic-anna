"""Robustness: the native reverse-RPC path retries transient host-side gateway errors.

Anna confirmed (forum t/114) that text-model 502s are brief upstream outages over the
SAME path image generation succeeds on, and that the host tears its throw-away session
down in `finally`, so retrying leaks no quota and is safe. So `sample_sync` retries a
bounded number of times on transient 5xx / provider / raw-HTTP-wrapper errors, but
surfaces deterministic failures (not-granted, quota, bad-request, timeout) immediately.
`generate_image_sync` runs with NO retry (attempts=1): a render is slow (tens of
seconds), so a retry would stack another full render onto the per-invoke budget and risk
an executa recycle; a failed render surfaces at once and the frontend re-fires a fresh
render invoke instead. These tests drive the real sync facades against a fake host
channel on a real (throwaway) asyncio loop, so the retry, the fresh-coroutine rebuild,
and the loop hop are all exercised.
"""
import asyncio
import threading

import pytest

from app import hostbridge
from executa_sdk.image import ImageError
from executa_sdk.sampling import SamplingError

_MSGS = [{"role": "user", "content": {"type": "text", "text": "hi"}}]


@pytest.fixture
def loop():
    lp = asyncio.new_event_loop()
    threading.Thread(target=lp.run_forever, daemon=True, name="retry-test-loop").start()
    yield lp
    lp.call_soon_threadsafe(lp.stop)


@pytest.fixture(autouse=True)
def _no_real_sleep(monkeypatch):
    # Keep the bounded backoff logic but don't actually wait during the test run.
    monkeypatch.setattr(hostbridge.time, "sleep", lambda *_a, **_k: None)


class _Flaky:
    """Async stub: raise errors[i] on call i (None = succeed) and count the calls.

    One class fakes both SamplingClient.create_message and ImageClient.generate, since
    the retry helper is shared and only branches on the exception, not the method."""

    def __init__(self, errors, ok):
        self._errors = list(errors)
        self._ok = ok
        self.calls = 0

    async def _run(self, **_kw):
        i = self.calls
        self.calls += 1
        if i < len(self._errors) and self._errors[i] is not None:
            raise self._errors[i]
        return self._ok

    create_message = _run
    generate = _run


def _install(monkeypatch, loop, *, sampling=None, image=None):
    monkeypatch.setattr(hostbridge, "_channel",
                        hostbridge.HostChannel(loop=loop, sampling=sampling, image=image))


_OK_TEXT = {"content": {"type": "text", "text": "ok"}, "usage": {}, "stopReason": "stop"}


def test_transient_502_is_retried_then_succeeds(monkeypatch, loop):
    s = _Flaky([SamplingError(-32000, "anna.partners | 502: Bad gateway")], _OK_TEXT)
    _install(monkeypatch, loop, sampling=s)
    out = hostbridge.sample_sync(messages=_MSGS)
    assert out["content"]["text"] == "ok"
    assert s.calls == 2                         # failed once, retried, succeeded


def test_provider_error_code_is_retried(monkeypatch, loop):
    # -32003 PROVIDER_ERROR: the catch-all the host raises for an upstream 5xx
    s = _Flaky([SamplingError(-32003, "provider error")], _OK_TEXT)
    _install(monkeypatch, loop, sampling=s)
    assert hostbridge.sample_sync(messages=_MSGS)["content"]["text"] == "ok"
    assert s.calls == 2


def test_message_only_gateway_hint_is_retried(monkeypatch, loop):
    # code itself is generic, but the message names a 502 -> still transient
    s = _Flaky([SamplingError(-32603, "upstream 502 bad gateway")], _OK_TEXT)
    _install(monkeypatch, loop, sampling=s)
    assert hostbridge.sample_sync(messages=_MSGS)["content"]["text"] == "ok"
    assert s.calls == 2


def test_not_granted_is_not_retried(monkeypatch, loop):
    s = _Flaky([SamplingError(-32001, "sampling not granted")], _OK_TEXT)
    _install(monkeypatch, loop, sampling=s)
    with pytest.raises(SamplingError) as ei:
        hostbridge.sample_sync(messages=_MSGS)
    assert ei.value.code == -32001
    assert s.calls == 1                         # deterministic: surfaced immediately


def test_client_timeout_is_not_retried(monkeypatch, loop):
    s = _Flaky([SamplingError(-32005, "timed out after 300s")], _OK_TEXT)
    _install(monkeypatch, loop, sampling=s)
    with pytest.raises(SamplingError) as ei:
        hostbridge.sample_sync(messages=_MSGS)
    assert ei.value.code == -32005
    assert s.calls == 1


def test_persistent_502_exhausts_retries_then_raises(monkeypatch, loop):
    s = _Flaky([SamplingError(-32000, "502: Bad gateway")] * 9, _OK_TEXT)  # never recovers
    _install(monkeypatch, loop, sampling=s)
    with pytest.raises(SamplingError) as ei:
        hostbridge.sample_sync(messages=_MSGS)
    assert ei.value.code == -32000
    assert s.calls == hostbridge._RETRY_ATTEMPTS      # tried the bounded max, no more


def test_image_path_does_not_retry(monkeypatch, loop):
    # Renders are slow, so generate_image_sync runs attempts=1: even a transient provider
    # error (-32103) surfaces immediately rather than stacking a second render onto the
    # invoke budget. The frontend re-fires a fresh render invoke for that image instead.
    img = _Flaky([ImageError(-32103, "provider error")], {"images": [{"url": "data:image/png;base64,AAA"}]})
    _install(monkeypatch, loop, image=img)
    with pytest.raises(ImageError) as ei:
        hostbridge.generate_image_sync(prompt="a knight")
    assert ei.value.code == -32103
    assert img.calls == 1


def test_image_path_succeeds_without_retry(monkeypatch, loop):
    # A clean render returns on the first try (no retry needed).
    img = _Flaky([None], {"images": [{"url": "data:image/png;base64,AAA"}]})
    _install(monkeypatch, loop, image=img)
    out = hostbridge.generate_image_sync(prompt="a knight")
    assert out["images"][0]["url"].startswith("data:")
    assert img.calls == 1
