"""fal.ai wave (Anna 1.1.0-beta.96): image/generate carries the configured model hint
plus the advanced options (quality / resolution / output_format / web search /
thinking level). Unset knobs stay OFF the wire (an older host never sees a param it
can't validate), and a value outside the documented enum is dropped with a warning
instead of sent (it would fail EVERY render deterministically and burn the asset's
heal allowance). Exercised at both layers: the sync facade against a fake channel on
a real loop, and the SDK client down to the literal JSON-RPC frame."""
import asyncio
import threading

import pytest

from app import hostbridge
from app.config import settings
from executa_sdk.image import ImageClient


@pytest.fixture
def loop():
    lp = asyncio.new_event_loop()
    threading.Thread(target=lp.run_forever, daemon=True, name="img-opts-loop").start()
    yield lp
    lp.call_soon_threadsafe(lp.stop)


@pytest.fixture(autouse=True)
def _clean_knobs(monkeypatch):
    for key in ("IMAGE_MODEL_HINT", "IMAGE_QUALITY", "IMAGE_RESOLUTION",
                "IMAGE_OUTPUT_FORMAT", "IMAGE_THINKING_LEVEL"):
        monkeypatch.setattr(settings, key, "")
    monkeypatch.setattr(settings, "IMAGE_WEB_SEARCH", False)


class _Capture:
    """Fake ImageClient: record the kwargs the facade forwards, answer one image."""

    def __init__(self):
        self.kwargs = None

    async def generate(self, **kw):
        self.kwargs = kw
        return {"images": [{"url": "data:image/png;base64,AAA"}]}


def _install(monkeypatch, loop, image):
    monkeypatch.setattr(hostbridge, "_channel",
                        hostbridge.HostChannel(loop=loop, sampling=None, image=image))


# ─── facade layer: settings -> generate_image_sync -> client kwargs ──────────

def test_defaults_send_no_hint_and_no_advanced_options(monkeypatch, loop):
    img = _Capture()
    _install(monkeypatch, loop, img)
    hostbridge.generate_image_sync(prompt="a knight")
    assert img.kwargs["model_preferences"] is None
    for key in ("quality", "resolution", "output_format",
                "enable_web_search", "thinking_level"):
        assert key not in img.kwargs


def test_fal_hint_and_options_are_forwarded(monkeypatch, loop):
    img = _Capture()
    _install(monkeypatch, loop, img)
    monkeypatch.setattr(settings, "IMAGE_MODEL_HINT", "fal-ai/nano-banana-2")
    monkeypatch.setattr(settings, "IMAGE_QUALITY", "high")
    monkeypatch.setattr(settings, "IMAGE_RESOLUTION", "2K")
    monkeypatch.setattr(settings, "IMAGE_OUTPUT_FORMAT", "webp")
    monkeypatch.setattr(settings, "IMAGE_WEB_SEARCH", True)
    monkeypatch.setattr(settings, "IMAGE_THINKING_LEVEL", "minimal")
    hostbridge.generate_image_sync(prompt="a knight")
    kw = img.kwargs
    assert kw["model_preferences"] == {"hints": [{"name": "fal-ai/nano-banana-2"}]}
    assert kw["quality"] == "high"
    assert kw["resolution"] == "2K"
    assert kw["output_format"] == "webp"
    assert kw["enable_web_search"] is True
    assert kw["thinking_level"] == "minimal"


def test_invalid_option_is_dropped_valid_ones_still_sent(monkeypatch, loop):
    img = _Capture()
    _install(monkeypatch, loop, img)
    monkeypatch.setattr(settings, "IMAGE_QUALITY", "ultra")      # not in the enum
    monkeypatch.setattr(settings, "IMAGE_RESOLUTION", "2K")
    hostbridge.generate_image_sync(prompt="a knight")
    assert "quality" not in img.kwargs
    assert img.kwargs["resolution"] == "2K"


# ─── wire layer: the SDK client puts the options on the literal frame ────────

def _wire_params(method, **call_kwargs):
    frames = []

    def write(frame):
        frames.append(frame)
        client.dispatch_response({"jsonrpc": "2.0", "id": frame["id"],
                                  "result": {"images": []}})

    client = ImageClient(write_frame=write)
    asyncio.run(getattr(client, method)(**call_kwargs))
    return frames[0]["params"]


def test_generate_frame_omits_unset_options():
    params = _wire_params("generate", prompt="p")
    assert set(params) == {"prompt", "n"}


def test_generate_frame_carries_options_and_mcp_key_casing():
    params = _wire_params(
        "generate", prompt="p",
        model_preferences={"hints": [{"name": "fal-ai/nano-banana-2"}]},
        quality="high", resolution="4K", output_format="webp",
        enable_web_search=True, thinking_level="high")
    assert params["modelPreferences"] == {"hints": [{"name": "fal-ai/nano-banana-2"}]}
    assert params["quality"] == "high"
    assert params["resolution"] == "4K"
    assert params["output_format"] == "webp"
    assert params["enable_web_search"] is True
    assert params["thinking_level"] == "high"


def test_edit_frame_carries_options():
    params = _wire_params(
        "edit", image_url="https://x/img.png", prompt="restyle",
        quality="low", resolution="1K", output_format="jpeg")
    assert params["image_url"] == "https://x/img.png"
    assert params["quality"] == "low"
    assert params["resolution"] == "1K"
    assert params["output_format"] == "jpeg"
