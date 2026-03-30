FROM claude-runner
COPY skills/ /workspace/.claude/skills/
USER root
RUN apt-get update && apt-get install -y --no-install-recommends python3 && rm -rf /var/lib/apt/lists/*
USER claude
