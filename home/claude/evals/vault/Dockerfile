FROM debian:bookworm-slim

RUN apt-get update && apt-get install -y --no-install-recommends \
    bash curl git ca-certificates \
    && rm -rf /var/lib/apt/lists/*

RUN curl -fsSL https://claude.ai/install.sh | bash

RUN adduser --disabled-password --gecos "" claude
RUN cp -r /root/.local /home/claude/.local && chown -R claude:claude /home/claude/.local \
    && ln -sf /home/claude/.local/share/claude/versions/2.1.79 /home/claude/.local/bin/claude

COPY entrypoint.sh /usr/local/bin/entrypoint.sh
RUN chmod +x /usr/local/bin/entrypoint.sh

USER claude
ENV PATH="/home/claude/.local/bin:$PATH"
WORKDIR /workspace

ENTRYPOINT ["entrypoint.sh"]
