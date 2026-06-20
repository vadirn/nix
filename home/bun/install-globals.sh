#!/usr/bin/env bash
# Canonical list of globally-installed bun packages.
# Source of truth for `bun install -g` across machines.
# Run by the installBunGlobals home-manager activation step.
#
# --minimum-release-age=0 bypasses the bunfig.toml age gate: the pins below
# are reviewed deliberately, so the supply-chain guard meant for ad-hoc
# installs does not apply. Bump versions consciously, not on a schedule.
# Note: on reruns with the global bun.lock present, this flag is inert — bun
# only re-evaluates age for new resolutions, not lockfile entries (whose
# sha512 hashes also catch malicious republish). The window where the flag is
# consequential is a fresh machine or deleted lockfile, when all pins resolve
# from the registry simultaneously without the 7-day gate.
set -euo pipefail

bun install -g --minimum-release-age=0 \
  modern-web-guidance@0.0.169 \
  firecrawl-cli@1.18.0 \
  vercel@53.3.2 \
  @playwright/cli@0.1.1 \
  @playwright/mcp@0.0.76 \
  @mariozechner/pi-coding-agent@0.73.1 \
  knip@6.14.2 \
  madge@8.0.0 \
  jscodeshift@17.3.0 \
  oxfmt@0.52.0
