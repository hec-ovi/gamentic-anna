#!/bin/sh
# Launch the Anna local Agent (PyInstaller uvicorn server; it bundles a browser, so it
# wants a display -> Xvfb). SUPERVISED, not exec'd: running ./Anna as a direct PID-1 child
# of `exec xvfb-run` makes it exit right after its pre-flight phase (never binds :19001).
# Keeping PID 1 as this shell and running ./Anna as a child (like the working backgrounded
# launch) keeps it up, and the loop restarts it if it ever drops.
set -u
cd /agent/Anna || { echo "Anna/ not found in /agent"; ls -la /agent; exit 1; }
echo ">> supervising Anna executor ($(pwd)/Anna) $*"
while true; do
  if [ -n "${USE_XVFB:-}" ] && command -v xvfb-run >/dev/null 2>&1; then
    xvfb-run -a -s "-screen 0 1440x900x24" ./Anna "$@"
  else
    ./Anna "$@"
  fi
  echo ">> Anna exited ($?); restarting in 3s"
  sleep 3
done
