"""Post-turn jobs (art renders, summary folds, origin enrichment) routing.

The Anna dev harness hard-caps a tool invoke at ~65s and RESTARTS the executa on
timeout, but an image render takes 35-90s and origin enrichment is several LLM calls.
So as an Executa, main._schedule runs jobs DETACHED (on a background pool), never on the
invoke thread: the invoke returns immediately and the job finishes after, with the
frontend polling /state to pick up results. Outside the executa it stays Starlette
BackgroundTasks (after the response under uvicorn). A job failure is logged, never
raised - a missing render must not crash the turn.
"""
import threading

from app import hostbridge, main


class _BG:
    def __init__(self):
        self.calls = []

    def add_task(self, fn, *args):
        self.calls.append((fn, args))


def _channel():
    return hostbridge.HostChannel(loop=None, sampling=None, image=None)


def test_schedule_uses_background_tasks_outside_the_executa(monkeypatch):
    monkeypatch.setattr(hostbridge, "_channel", None)          # not running as an executa
    ran = []
    bg = _BG()
    main._schedule(bg, lambda *a: ran.append(a), "g1", 7)
    assert bg.calls and bg.calls[0][1] == ("g1", 7)            # deferred to after the response
    assert ran == []                                           # NOT run inline


def test_schedule_runs_jobs_detached_inside_the_executa(monkeypatch):
    monkeypatch.setattr(hostbridge, "_channel", _channel())
    seen = {}
    done = threading.Event()

    def job(*args):
        seen["args"] = args
        seen["thread"] = threading.current_thread().name
        done.set()

    bg = _BG()
    main._schedule(bg, job, "g1", 7)
    assert done.wait(3.0), "detached job never ran"
    assert seen["args"] == ("g1", 7)
    assert bg.calls == []                                      # NOT deferred to Starlette tasks
    assert seen["thread"] != threading.current_thread().name   # ran OFF the invoke thread
    assert seen["thread"].startswith("render")                 # on the detached render pool


def test_detached_job_failure_is_logged_not_raised(monkeypatch):
    # a failing render must not bubble out; the detached wrapper logs and swallows it
    monkeypatch.setattr(hostbridge, "_channel", _channel())
    started = threading.Event()

    def boom(*_a):
        started.set()
        raise RuntimeError("render failed")

    main._schedule(_BG(), boom, "g1")                          # must NOT raise
    assert started.wait(3.0)                                   # it ran; the pool swallowed the error
