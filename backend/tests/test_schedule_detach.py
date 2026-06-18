"""Post-turn jobs (art renders, summary folds, origin enrichment) routing.

Anna mints the image / sampling reverse-RPC token at invoke time and tears it down when
the invoke returns, so a render deferred past the invoke loses the token and silently
produces no image. As an Executa, main._schedule therefore runs jobs SYNCHRONOUSLY,
inside the live invoke (the same path /view uses). Outside the executa it keeps them as
Starlette BackgroundTasks (which run after the response under uvicorn). A job failure is
logged, never raised - a missing image must not kill the turn.
"""
from app import hostbridge, main


class _BG:
    def __init__(self):
        self.calls = []

    def add_task(self, fn, *args):
        self.calls.append((fn, args))


def test_schedule_uses_background_tasks_outside_the_executa(monkeypatch):
    monkeypatch.setattr(hostbridge, "_channel", None)          # not running as an executa
    ran = []
    bg = _BG()
    main._schedule(bg, lambda *a: ran.append(a), "g1", 7)
    assert bg.calls and bg.calls[0][1] == ("g1", 7)            # deferred to after the response
    assert ran == []                                           # NOT run inline


def test_schedule_runs_jobs_inline_when_running_as_an_executa(monkeypatch):
    monkeypatch.setattr(hostbridge, "_channel",
                        hostbridge.HostChannel(loop=None, sampling=None, image=None))
    ran = []
    bg = _BG()
    main._schedule(bg, lambda *a: ran.append(a), "g1", 7)
    assert ran == [("g1", 7)]                                  # ran inside the invoke (token live)
    assert bg.calls == []                                      # never deferred past the invoke


def test_inline_job_failure_is_logged_not_raised(monkeypatch):
    # a failing render must not bubble out and kill the turn
    monkeypatch.setattr(hostbridge, "_channel",
                        hostbridge.HostChannel(loop=None, sampling=None, image=None))

    def boom(*_a):
        raise RuntimeError("render failed")

    main._schedule(_BG(), boom, "g1")                          # must NOT raise
