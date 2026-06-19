#!/bin/sh
# Launch the Anna local Agent (PyInstaller bundle). It is a Python executor (uvicorn),
# so it usually runs headless; if it ever needs a display, we fall back to Xvfb.
set -e
cd /agent/Anna || { echo "Anna/ not found in /agent"; ls -la /agent; exit 1; }
echo ">> launching Anna executor ($(pwd)/Anna) $*"
if [ -n "${USE_XVFB:-}" ] && command -v xvfb-run >/dev/null 2>&1; then
  exec xvfb-run -a -s "-screen 0 1440x900x24" ./Anna "$@"
fi
exec ./Anna "$@"
