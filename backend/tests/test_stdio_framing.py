"""stdio frame sizing: the Anna Agent's reader caps a JSON-RPC line at ~64KB, and a longer
inline frame crashes its reader loop ("Separator is found, but chunk is longer than limit")
and kills the executa mid-invoke. _write_frame must spill oversized RESPONSES to file
transport (a small pointer the host resolves), but NEVER spill reverse-RPC REQUESTS (the
host cannot resolve a request pointer) - those stay inline and the engine keeps them bounded.
The image path depends on this: an image data-URI inlined in a /state reply exceeds 64KB.
"""
import json
import os

from executa_sdk.sampling import _write_frame, MAX_STDIO_MESSAGE_BYTES


class _Cap:
    def __init__(self):
        self.buf = []

    def write(self, s):
        self.buf.append(s)

    def flush(self):
        pass

    @property
    def text(self):
        return "".join(self.buf)


def test_threshold_is_under_the_agent_64kb_reader_limit():
    # The whole point: spill BEFORE a frame can hit the Agent's ~64KB stdio line limit.
    assert MAX_STDIO_MESSAGE_BYTES < 64 * 1024


def test_small_frame_written_inline():
    cap = _Cap()
    _write_frame({"jsonrpc": "2.0", "id": 1, "result": {"x": "y"}}, stdout=cap)
    assert "__file_transport" not in cap.text
    assert json.loads(cap.text.strip())["result"] == {"x": "y"}


def test_large_response_spills_to_file_transport():
    cap = _Cap()
    blob = "A" * (MAX_STDIO_MESSAGE_BYTES + 2000)
    _write_frame({"jsonrpc": "2.0", "id": 2, "result": {"blob": blob}}, stdout=cap)
    line = cap.text.strip()
    frame = json.loads(line)
    # the written line is a SMALL pointer, not the multi-KB blob
    assert "__file_transport" in frame
    assert len(line) < 2000
    try:
        with open(frame["__file_transport"], encoding="utf-8") as f:
            recovered = json.load(f)
        assert recovered["result"]["blob"] == blob
    finally:
        os.remove(frame["__file_transport"])


def test_large_reverse_rpc_request_is_NOT_spilled():
    # A request (has "method") can't use file transport - it must stay inline.
    cap = _Cap()
    blob = "A" * (MAX_STDIO_MESSAGE_BYTES + 2000)
    _write_frame(
        {"jsonrpc": "2.0", "id": 3, "method": "sampling/createMessage",
         "params": {"blob": blob}},
        stdout=cap,
    )
    assert "__file_transport" not in cap.text
    assert json.loads(cap.text.strip())["method"] == "sampling/createMessage"
