# Run the Anna Agent (Docker, foreground)

Runs the Anna local Agent in a container. This build is a FastAPI web app on port
19001 (not a GUI), so there is no Xvfb and no display needed. You sign in through
the web UI and it registers as your online Agent, which is what lets the published
gamentic-anna app actually run.

Prereq: the Anna Linux build sits in this folder as `anna-agent.tar.gz` (download it
from https://anna.partners/download while logged in, then rename). It is gitignored.

## The two commands

Build:

```sh
cd ~/workspace/gamentic-anna/anna-agent
docker build -t anna-agent .
```

Run (foreground, so Ctrl+C stops it; no `--rm`, so the login is kept):

```sh
docker run --name anna-agent -p 127.0.0.1:19001:19001 anna-agent
```

Then open http://localhost:19001, click Login (登录), sign in as hecovi. "Agent
Offline" flips to online once it has a client_id.

Check it went online (optional):

```sh
curl -s http://localhost:19001/api/agent/status   # want "connected":true and a non-empty client_id
```

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
