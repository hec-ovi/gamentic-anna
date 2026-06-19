"""Frozen entry point for the gamentic Executa.

PyInstaller bundles this into a self-contained binary so Anna can install and run
the engine on a host with no Python. It just launches the stdio JSON-RPC loop;
all behavior lives in app.executa (the same module `python -m app.executa` runs).
"""
from app.executa import main

if __name__ == "__main__":
    main()
