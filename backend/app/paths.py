"""Relocatable resource + data paths.

The engine reads bundled prose (the `prompts/` templates) and writes a SQLite DB
plus per-game image files. In dev those sit in the source tree; in Docker they are
pinned by env (DB_PATH); but once the executa is PACKAGED and installed on a user's
Anna it runs from `~/.anna/executa/tools/<tool_id>/current/` with a writable dir
handed to it via `EXECUTA_DATA`, and PyInstaller relocates bundled data under the
frozen base (`sys._MEIPASS` for onefile, the executable dir for onedir). This module
is the single place that resolves both, so neither breaks across those four runtimes.
"""
import os
import sys


def _frozen_base() -> str | None:
    """The directory bundled read-only data lives in when running as a PyInstaller
    binary, or None when running from source. `_MEIPASS` is set for both onefile
    (a temp extract) and onedir (the bundle dir); fall back to the executable dir."""
    if getattr(sys, "frozen", False):
        return getattr(sys, "_MEIPASS", None) or os.path.dirname(os.path.abspath(sys.executable))
    return None


def resource_path(*parts: str) -> str:
    """Absolute path to bundled read-only data (e.g. the prompt templates).

    Frozen: under the PyInstaller base (data is added as `prompts/...`). Source: the
    backend/ root (the parent of the `app` package), matching the repo layout."""
    base = _frozen_base()
    if base is None:
        base = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))  # backend/
    return os.path.join(base, *parts)


def data_dir() -> str | None:
    """The writable per-install data dir Anna injects for an installed executa
    (`EXECUTA_DATA` = `<install>/current/data`), or None when not set (dev/Docker
    pin storage explicitly via DB_PATH instead)."""
    return os.environ.get("EXECUTA_DATA") or None
