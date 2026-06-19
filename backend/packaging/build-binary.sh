#!/usr/bin/env bash
# Build a self-contained gamentic Executa binary and package it for the Anna `binary`
# distribution profile, in the layout Anna's Agent expects (per the official forum guide
# "packaging Anna Executa as a releasable binary", forum.anna.partners/t/.../140):
#
#   <tool_id>-<platform>.tar.gz
#     bin/<tool_id>        the PyInstaller --onefile binary, NAMED by the tool_id
#     manifest.json        runtime.binary.entrypoint.default = "bin/<tool_id>" (+ perms)
#
# The Agent (More -> Agents -> Install Essentials) downloads this per platform, extracts it,
# reads manifest.json for the entrypoint, and runs the binary over stdio JSON-RPC.
#
# Usage: packaging/build-binary.sh [version]   (run from anywhere; cd's to backend/)
set -euo pipefail
cd "$(dirname "$0")/.."   # -> backend/

VERSION="${1:-0.2.1}"
# the server-minted tool_id (identity cache written by `anna-app executa publish`)
TOOL_ID="$(python3 -c 'import json;print(json.load(open(".anna/executa.json"))["tool_id"])' 2>/dev/null || echo tool-gamentic-engine-7h8aweky)"
PLATFORM="$(python3 -c 'import platform;s=platform.system().lower();m=platform.machine().lower();m={"amd64":"x86_64","x64":"x86_64"}.get(m,m);print(f"{s}-{m}")')"
OUT="${TOOL_ID}-${PLATFORM}.tar.gz"

echo ">> building $OUT (tool_id=$TOOL_ID, v$VERSION)"
rm -rf build dist
uv venv .build-venv --python 3.12 --clear
uv pip install --python .build-venv -r requirements.txt pyinstaller

# --onefile, binary named EXACTLY by the tool_id (Agent matches on it)
.build-venv/bin/pyinstaller --onefile --noconfirm --clean \
  --name "$TOOL_ID" --paths . \
  --add-data "prompts:prompts" \
  --exclude-module uvicorn --exclude-module uvloop \
  --exclude-module watchfiles --exclude-module websockets \
  run_executa.py

# stage the guide's archive layout: bin/<tool_id> + manifest.json
rm -rf stage && mkdir -p stage/bin
cp "dist/$TOOL_ID" "stage/bin/$TOOL_ID"
chmod 0755 "stage/bin/$TOOL_ID"
python3 - "$TOOL_ID" "$VERSION" > stage/manifest.json <<'PY'
import json, sys
tid, ver = sys.argv[1], sys.argv[2]
print(json.dumps({
  "name": tid, "version": ver,
  "runtime": {"binary": {
    "entrypoint": {"default": f"bin/{tid}"},
    "permissions": {f"bin/{tid}": "0o755"},
  }},
}, indent=2))
PY

tar -czf "dist/${OUT}" -C stage .
# portable checksum: Linux has sha256sum, macOS has shasum
( cd dist && { command -v sha256sum >/dev/null 2>&1 && sha256sum "${OUT}" || shasum -a 256 "${OUT}"; } > "${OUT}.sha256" )

echo ">> built dist/${OUT}"
tar -tzf "dist/${OUT}"
ls -lh "dist/${OUT}"
