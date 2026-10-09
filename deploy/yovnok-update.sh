#!/bin/sh
# Install the newest published image if there is one (GitHub Actions publishes
# ghcr.io/kpoke/yovnok:latest on every push to main). `up -d` recreates the
# game only when the pulled image differs from the running one.
set -eu
cd /opt/yovnok
docker compose pull --quiet game
docker compose up -d game
docker image prune -f >/dev/null
