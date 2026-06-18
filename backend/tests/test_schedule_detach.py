"""Post-turn jobs (art renders, summary folds, origin enrichment) routing.

Under an Anna Executa, Starlette BackgroundTasks are awaited INSIDE the invoke (httpx
ASGITransport), so a turn would not return until all its art rendered (1 to 3 min) -
long enough that the Anna dev harness tears the executa down ("executa process exited").
So as an Executa, main._schedule dispatches jobs fire-and-forget on a pool; outside the
executa it keeps them as BackgroundTasks (which run AFTER the response under uvicorn).
"""
from app import hostbridge, main


class _BG:
    def __init__(self):
        self.calls = []

    def add_task(self, fn, *args):
        self.calls.append((fn, args))


class _Pool:
    def __init__(self):
        self.calls = []

    def submit(self, fn, *args):
        self.calls.append((fn, args))


def _job(*_a):
    pass


def test_schedule_uses_background_tasks_outside_the_executa(monkeypatch):
    monkeypatch.setattr(hostbridge, "_channel", None)          # not running as an executa
    pool = _Pool()
    monkeypatch.setattr(main, "_DETACHED", pool)
    bg = _BG()
    main._schedule(bg, _job, "g1", 7)
    assert bg.calls == [(_job, ("g1", 7))]                     # deferred to after the response
    assert pool.calls == []                                    # never detached


def test_schedule_detaches_jobs_when_running_as_an_executa(monkeypatch):
    monkeypatch.setattr(hostbridge, "_channel",
                        hostbridge.HostChannel(loop=None, sampling=None, image=None))
    pool = _Pool()
    monkeypatch.setattr(main, "_DETACHED", pool)
    bg = _BG()
    main._schedule(bg, _job, "g1", 7)
    assert pool.calls == [(_job, ("g1", 7))]                   # fire-and-forget
    assert bg.calls == []                                      # the invoke never waits on it
