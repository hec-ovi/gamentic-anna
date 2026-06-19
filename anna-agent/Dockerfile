# Run the Anna local Agent (the desktop "executor") headless in a container.
#
# The Agent is a Linux Electron app (tar.gz -> ./Anna). Electron needs a display and a
# set of GUI/runtime libs, so we install those plus Xvfb (a virtual framebuffer) and run
# ./Anna under it with --no-sandbox. This is the runtime that installs + executes the
# bundled executa (gamentic-executa) for the published app; the anna.partners web app has
# no executa runtime of its own.
#
# Build expects the Anna Linux download at anna-agent/anna-agent.tar.gz (rename your
# Anna-*.tar.gz from https://anna.partners/download).
# Ubuntu 24.04 ships GLIBC 2.39; the bundled libpython3.11 needs >= 2.38 (bookworm's
# 2.36 is too old). Package names use the t64 suffix on 24.04 where the ABI changed.
FROM ubuntu:24.04

ENV DEBIAN_FRONTEND=noninteractive

# Python/Chromium runtime deps + Xvfb + dbus + fonts (the agent bundles browserforge,
# so it may launch a headless browser). Most .so are vendored in _internal; this covers
# the system libs that are not.
RUN apt-get update && apt-get install -y --no-install-recommends \
      xvfb dbus dbus-x11 ca-certificates \
      libglib2.0-0t64 libnss3 libnspr4 libgtk-3-0t64 \
      libatk1.0-0t64 libatk-bridge2.0-0t64 libatspi2.0-0t64 libcups2t64 \
      libdrm2 libgbm1 libasound2t64 libxcomposite1 libxdamage1 libxrandr2 \
      libxkbcommon0 libxfixes3 libxrender1 libxext6 libx11-xcb1 libxcb1 \
      libpango-1.0-0 libcairo2 libgl1 libegl1 fonts-liberation \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /agent

# Your downloaded Anna Linux agent (any Anna-*.tar.gz dropped in this folder).
COPY *.tar.gz /tmp/agent/
RUN set -e; tar -xzf /tmp/agent/*.tar.gz -C /agent && rm -rf /tmp/agent

COPY entrypoint.sh /entrypoint.sh
RUN chmod +x /entrypoint.sh

ENTRYPOINT ["/entrypoint.sh"]
