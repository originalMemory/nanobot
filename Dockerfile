FROM ghcr.io/astral-sh/uv:python3.12-bookworm-slim

RUN apt-get update && \
    apt-get install -y --no-install-recommends curl ca-certificates git bubblewrap openssh-client && \
    rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Install Python dependencies (cached layer). Source code is mounted at runtime.
COPY pyproject.toml README.md LICENSE THIRD_PARTY_NOTICES.md hatch_build.py ./
RUN mkdir -p nanobot/web/dist bridge && \
    touch nanobot/__init__.py nanobot/web/dist/index.html && \
    NANOBOT_SKIP_WEBUI_BUILD=1 uv pip install --system --no-cache . && \
    rm -rf nanobot bridge

# Create non-root user and config directory
RUN useradd -m -u 1000 -s /bin/bash nanobot && \
    mkdir -p /home/nanobot/.nanobot && \
    chown -R nanobot:nanobot /home/nanobot /app

# 系统级 git 配置，所有用户（含运行时的 uid 99）均可读
RUN git config --system --add safe.directory /home/nanobot/src

COPY entrypoint.sh /usr/local/bin/entrypoint.sh
RUN sed -i 's/\r$//' /usr/local/bin/entrypoint.sh && chmod +x /usr/local/bin/entrypoint.sh

USER nanobot
ENV HOME=/home/nanobot
ENV PATH="/home/nanobot/.nanobot/workspace/bin:/home/nanobot/.local/bin:${PATH}"
# Source code is mounted at /home/nanobot/src; this overrides the placeholder installed above
ENV PYTHONPATH=/home/nanobot/src

# Gateway health endpoint and optional WebUI/WebSocket channel ports
EXPOSE 18790 8765

ENTRYPOINT ["entrypoint.sh"]
CMD ["status"]
