# Run the Anna local Agent (Docker)

The published gamentic-anna app runs its engine as an Anna Tool Executa, and a Tool
Executa only runs where the Anna Agent runtime is installed. The anna.partners web app
has no executa runtime of its own, so without a running Agent the app reports
"No online Agent". This folder containerizes that Agent.

The current Anna Linux build is a FastAPI web app on port 19001 (not a GUI), so no
Xvfb or display is needed. You sign in through its web UI and it registers as your
online Agent.

Prereq: download the Anna Linux build from https://anna.partners/download while logged
in, and place it in this folder as `anna-agent.tar.gz` (gitignored).

## Build and run

```sh
cd anna-agent
docker build -t anna-agent .
docker run --name anna-agent -p 127.0.0.1:19001:19001 anna-agent
```

Runs in the foreground, so Ctrl+C stops it; no `--rm`, so the login is kept.

Then open http://localhost:19001, click Login, and sign in. "Agent Offline" flips to
online once it has a client_id. Optional check:

```sh
curl -s http://localhost:19001/api/agent/status   # want "connected":true and a non-empty client_id
```

With the Agent online, Install Essentials on it (Anna: More, then Agents) pulls the
engine from PyPI via `uv tool install` and the app comes alive.

## Lifecycle

| Action | Command / result |
|---|---|
| Stop | Ctrl+C in the terminal (graceful shutdown), or `docker stop anna-agent` |
| Start again, same login | `docker start -a anna-agent` |
| Reboot PC | Stays stopped, nothing auto-starts (no restart policy set) |
| Remove for good | `docker rm -f anna-agent` (only this wipes the login) |

Login survives Ctrl+C and stop/start because the container keeps its writable layer.
Only `docker rm` throws it away. Nothing is installed on your host; the Anna binary
only ever runs inside the container.
