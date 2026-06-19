#!/usr/bin/env bash
# Build a self-contained gamentic Executa binary and package it for the Anna
# `binary` distribution profile.
#
# PyInstaller --onedir freezes the engine (no Python needed on the host); the
# prompts are bundled as data and resolved via app/paths.py; storage lands under
# EXECUTA_DATA at runtime. Output: dist/gamentic-executa-<platform>.tar.gz (+ .sha256)
# with an in-archive manifest.json pinning the entrypoint. Attach the tarball to a
# GitHub Release whose URL is wired into executa.json's binary_urls.
#
# Usage: packaging/build-binary.sh [version]   (run from anywhere; cd's to backend/)
set -euo pipefail
cd "$(dirname "$0")/.."   # -> backend/

VERSION="${1:-0.2.0}"
PLATFORM="$(python3 -c 'import platform;s=platform.system().lower();m=platform.machine().lower();m={"amd64":"x86_64","x64":"x86_64"}.get(m,m);print(f"{s}-{m}")')"
OUT="gamentic-executa-${PLATFORM}.tar.gz"

echo ">> building $OUT (v$VERSION)"
rm -rf build dist
uv venv .build-venv --python 3.12 --clear
uv pip install --python .build-venv -r requirements.txt pyinstaller

.build-venv/bin/pyinstaller --onedir --noconfirm --clean \
  --name gamentic-executa --paths . \
  --add-data "prompts:prompts" \
  --exclude-module uvicorn --exclude-module uvloop \
  --exclude-module watchfiles --exclude-module websockets \
  run_executa.py

cp packaging/archive-manifest.json dist/gamentic-executa/manifest.json
tar -czf "dist/${OUT}" -C dist/gamentic-executa .
( cd dist && sha256sum "${OUT}" > "${OUT}.sha256" )

echo ">> built dist/${OUT}"
ls -lh "dist/${OUT}"
