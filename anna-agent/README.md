# Anna local Agent (the executa runtime)

The **published** gamentic-anna app runs its engine as an Anna **Tool Executa** (a real
process: the FastAPI engine binary + SQLite). A Tool executa only runs **where the Anna
Agent runtime is installed**, and the **anna.partners web app has no executa runtime** of
its own. So when you open the published app in the browser you get:

> No online Agent. Start your local Agent first, then try again.

The fix is to run Anna's **local Agent** (the desktop "executor"). This folder holds a
helper to fetch and launch it. You do NOT need this for the `localhost:5180` dev harness,
which already runs the engine itself.

## Use it

1. Get the Linux agent from **https://anna.partners/download** (a `tar.gz`). Either drop
   the `Anna-*.tar.gz` in this folder, or pass its URL to the script.
2. Run it:
   ```sh
   ./run-agent.sh                 # uses an Anna-*.tar.gz already in this folder
   ./run-agent.sh <download-url>  # or download it first
   ```
3. Sign in with the **same Anna account** (hecovi). The Hub then shows an online Agent.
4. In the Executa Hub, open the **Gamentic** tool and click **Install**. The Agent pulls
   `gamentic-executa-linux-x86_64.tar.gz` (from the GitHub Release) and runs it locally.
5. Open gamentic-anna. It connects (no more "LINK LOST" / "no online Agent").

## Notes

- The Agent is a desktop (Electron-style) app. On a desktop with a display, `./Anna` just
  runs. On a headless box the script falls back to `xvfb-run` (install `xvfb` first); that
  path is unsupported by Anna and only for servers.
- The engine binary is **linux-x86_64** only right now (matches this machine). Other
  platforms need the macOS/Windows builds from the `executa-release` GitHub workflow.
- End users of the published app need this same local Agent to play. That is inherent to a
  Tool executa being a real process, not a limitation of this app.
