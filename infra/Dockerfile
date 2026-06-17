# Gamentic on Anna, the whole thing in ONE container.
#
# supervisord runs three long-lived processes, all on container-localhost:
#   :19001  anna-agent  the Anna backend (vendor binary) + one-time sign-in UI
#   :9100   anna-api    OpenAI-compatible face over the agent's copilot (internal)
#   :5180   anna-app    the Anna UI runner: gamentic iframe + engine Executa (stdio)
#
# The engine reaches the LLM via anna-api -> anna-agent -> Anna cloud (no GPU).
# Build context = repo root.
#
# Base MUST be trixie (Debian 13, glibc >= 2.38): the Anna binary is a PyInstaller
# bundle linked against GLIBC_2.38, so bookworm (glibc 2.36) fails to load it.
FROM node:22-trixie-slim

ENV PYTHONUNBUFFERED=1 \
    PYTHONDONTWRITEBYTECODE=1 \
    # user-overridable defaults; compose passes real values through the env and
    # supervisord forwards its environment to every child process.
    ANNA_TEXT_MODEL=anna-copilot \
    ANNA_IMAGE_VIA_COPILOT=true \
    ANNA_AGENT_USERNAME= \
    ANNA_AGENT_PASSWORD=

# Pin the Anna release for reproducible builds.
ARG ANNA_VERSION=1.1.0-beta.17
ARG ANNA_URL=https://releases.anna.partners/releases/production/${ANNA_VERSION}/Anna-${ANNA_VERSION}-linux-x86_64.tar.gz
ARG ANNA_SHA256=c56896ffd7c5a9ec585b0103f01bdc379c1cfe49a97c8b211d957056383f2c5d

# uv + uvx: uv builds the python venvs at image time; `anna-app dev` itself spawns
# its runtime bridge via `uvx anna-app-runtime-local`, so uvx must be on PATH too.
COPY --from=ghcr.io/astral-sh/uv:latest /uv /usr/local/bin/uv
COPY --from=ghcr.io/astral-sh/uv:latest /uvx /usr/local/bin/uvx

RUN apt-get update && apt-get install -y --no-install-recommends \
        ca-certificates curl supervisor \
    && rm -rf /var/lib/apt/lists/*

# The Anna agent (the Anna backend): download, checksum, unpack into /opt/anna.
WORKDIR /opt/anna
RUN curl -fsSL "${ANNA_URL}" -o /tmp/anna.tar.gz \
    && echo "${ANNA_SHA256}  /tmp/anna.tar.gz" | sha256sum -c - \
    && tar -xzf /tmp/anna.tar.gz --strip-components=1 -C /opt/anna \
    && rm /tmp/anna.tar.gz \
    && chmod +x /opt/anna/Anna

# The Anna developer CLI (provides `anna-app`).
RUN npm install -g @anna-ai/cli

WORKDIR /app

# Engine (gamentic orchestrator) + its venv. backend/executa.json runs
# `.venv/bin/python -m app.executa`, so the venv must live at backend/.venv.
COPY backend ./backend
RUN uv venv backend/.venv --python 3.12 \
    && uv pip install --python backend/.venv -r backend/requirements.txt

# anna-api (OpenAI <-> Anna copilot bridge) + its own venv.
COPY infra/anna-api/requirements.txt ./anna-api/requirements.txt
RUN uv venv anna-api/.venv --python 3.12 \
    && uv pip install --python anna-api/.venv -r anna-api/requirements.txt
COPY infra/anna-api/app ./anna-api/app

# UI bundle + the app manifest.
COPY frontend ./frontend
COPY manifest.json ./manifest.json

# Process manager + per-process state dirs (mounted from named volumes at run time).
COPY infra/supervisord.conf /etc/supervisord.conf
RUN mkdir -p /data/anna /data/game

EXPOSE 19001 5180
CMD ["supervisord", "-c", "/etc/supervisord.conf"]
