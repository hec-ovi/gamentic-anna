# Gamentic on Anna, NATIVE, in ONE container.
#
# `anna-app dev` (Anna's own dev runtime) hosts the gamentic iframe AND spawns the
# gamentic executa. The executa reverse-RPCs the Anna host for LLM text and images
# (sampling/createMessage, image/generate); there is NO third-party bridge and NO
# bundled model server. Sign in once with `anna-app login` (persists on the
# anna-cred volume). Voice off, no GPU.
FROM node:22-bookworm-slim

ENV PYTHONUNBUFFERED=1 \
    PYTHONDONTWRITEBYTECODE=1 \
    HOME=/root \
    ANNA=true \
    IMAGE_ENABLED=false \
    IMAGE_ITEMS=false \
    SUMMARY_ENABLED=false \
    CHAR_SUMMARY_ENABLED=false \
    DB_PATH=/data/game/gamentic.db

# uv + uvx: uv builds the engine venv at image time; `anna-app dev` spawns its own
# runtime bridge via `uvx`, so uvx must be on PATH too.
COPY --from=ghcr.io/astral-sh/uv:latest /uv  /usr/local/bin/uv
COPY --from=ghcr.io/astral-sh/uv:latest /uvx /usr/local/bin/uvx

RUN apt-get update && apt-get install -y --no-install-recommends \
        ca-certificates curl && rm -rf /var/lib/apt/lists/*

# The Anna developer CLI (provides `anna-app`).
RUN npm install -g @anna-ai/cli

WORKDIR /app

# Engine (gamentic) + its venv. backend/executa.json runs `.venv/bin/python -m
# app.executa`, so the venv lives at backend/.venv. The vendored executa_sdk is
# imported from backend/ (the executa's cwd) -- no separate install.
COPY backend ./backend
RUN uv venv backend/.venv --python 3.12 \
    && uv pip install --python backend/.venv -r backend/requirements.txt

# UI bundle + the app manifest.
COPY frontend ./frontend
COPY manifest.json ./manifest.json

RUN mkdir -p /data/game
EXPOSE 5180

# No --no-llm: sampling/image reach REAL Anna (the login PAT persists on the mounted
# /root/.config/anna volume). --no-watch: the harness watcher otherwise hot-reloads
# the iframe and resets the game.
# --slug/--llm-app-slug gamentic-anna: pin the harness to the REGISTERED app the account
# actually granted. Without it the harness mints reverse-RPC tokens under the default slug
# "app", which has no image_grant -> image/generate 403s APP_NOT_GRANTED even though the
# installed "gamentic-anna" app (apps list / apps grants) has image_grant enabled. (Match
# this to the slug shown by `anna-app apps list`.)
CMD ["anna-app", "dev", "--manifest", "manifest.json", "--bundle", "./frontend", \
     "--executa", "dir=./backend", "--slug", "gamentic-anna", "--llm-app-slug", "gamentic-anna", \
     "--port", "5180", "--no-watch"]
