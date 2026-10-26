#!/bin/sh
# Initialize host bind directories; existing host extensions are never overwritten.
set -eu

ROOT=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
IMAGE=${FIORA_BOT_IMAGE:-ghcr.io/ichinose520122/fiora-bot:latest}
if [ "$(id -u)" != 0 ]; then
  printf '%s\n' 'Run this script as root (or with sudo) to prepare UID/GID 1000:1000 directories.' >&2
  exit 1
fi
for folder in data plugins skills; do mkdir -p "$ROOT/$folder"; done

needs_seed=false
for folder in plugins skills; do
  if [ -z "$(find "$ROOT/$folder" -mindepth 1 -maxdepth 1 -print -quit)" ]; then needs_seed=true; fi
done

temporary=''
cleanup() { if [ -n "$temporary" ]; then docker rm -v "$temporary" >/dev/null; fi; }
trap cleanup EXIT
trap 'exit 1' HUP INT TERM
if [ "$needs_seed" = true ]; then
  # Prefer an existing deployment, preserving extensions installed in its old named volumes.
  source=$(cd "$ROOT" && docker compose ps -a -q fiora-bot | head -n 1)
  if [ -z "$source" ]; then
    if ! docker image inspect "$IMAGE" >/dev/null 2>&1; then docker pull "$IMAGE"; fi
    temporary=$(docker create "$IMAGE")
    source=$temporary
  fi
  for folder in plugins skills; do
    if [ -z "$(find "$ROOT/$folder" -mindepth 1 -maxdepth 1 -print -quit)" ]; then
      docker cp "$source:/app/$folder/." "$ROOT/$folder/"
    fi
  done
fi

chown -R 1000:1000 "$ROOT/data" "$ROOT/plugins" "$ROOT/skills"
chmod 700 "$ROOT/data"
printf '%s\n' "Prepared $ROOT/data, $ROOT/plugins and $ROOT/skills (UID/GID 1000:1000)."
