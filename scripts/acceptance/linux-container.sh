#!/usr/bin/env bash
# Linux host acceptance for Cappy (ADR-021): run the full validation in a
# throwaway Debian bookworm container with Node.js 24, FFmpeg, and headless
# Godot. Nothing is installed on the host; the repository is copied into the
# container (tracked and untracked, unignored files only), so the host's
# node_modules, builds, and workspaces are never used or modified.
#
#   scripts/acceptance/linux-container.sh          # needs Docker (or OrbStack)
#
# Environment: CAPPY_LINUX_IMAGE (default node:24-bookworm-slim) and
# CAPPY_GODOT_VERSION (default 4.7.2). Real OBS is not exercised on Linux.
set -euo pipefail

repo="$(cd "$(dirname "$0")/../.." && pwd)"
image="${CAPPY_LINUX_IMAGE:-node:24-bookworm-slim}"
godot_version="${CAPPY_GODOT_VERSION:-4.7.2}"

docker run --rm -v "$repo:/src:ro" -e GODOT_VERSION="$godot_version" "$image" bash -euo pipefail -c '
  step() { printf "\n== %s\n" "$1"; }
  step "system packages (ffmpeg, git, curl, unzip)"
  apt-get update -qq
  DEBIAN_FRONTEND=noninteractive apt-get install -y -qq --no-install-recommends ffmpeg git curl unzip ca-certificates >/dev/null

  step "Godot ${GODOT_VERSION} (headless)"
  case "$(uname -m)" in
    aarch64) platform=linux.arm64 ;;
    x86_64) platform=linux.x86_64 ;;
    *) echo "unsupported architecture $(uname -m)"; exit 1 ;;
  esac
  curl -fsSL -o /tmp/godot.zip "https://github.com/godotengine/godot/releases/download/${GODOT_VERSION}-stable/Godot_v${GODOT_VERSION}-stable_${platform}.zip"
  unzip -q /tmp/godot.zip -d /opt/godot
  ln -s "/opt/godot/Godot_v${GODOT_VERSION}-stable_${platform}" /usr/local/bin/godot

  step "host"
  . /etc/os-release && echo "${PRETTY_NAME}, $(uname -m), kernel $(uname -r)"
  echo "node $(node --version), npm $(npm --version)"
  ffmpeg -hide_banner -version | head -1
  godot --headless --version

  step "copy the repository"
  git config --global --add safe.directory /src
  mkdir -p /work
  (cd /src && git ls-files -co --exclude-standard -z | tar --null -T - -cf -) | tar -xf - -C /work
  cd /work
  npm ci --no-audit --no-fund --loglevel=error

  step "typecheck";                 npm run typecheck
  step "lint";                      npm run lint
  step "normal suite";              npx vitest run
  step "real FFmpeg and Godot";     CAPPY_REAL_TOOLS=1 npx vitest run
  step "system model";              npm run model:check
  step "Linux acceptance passed"
'
