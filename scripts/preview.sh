#!/usr/bin/env sh
# Локальный предпросмотр frontend + мок-ответы не даёт; для полного стека: docker compose up --build
cd "$(dirname "$0")/../frontend" && python3 -m http.server 8080 2>/dev/null || npx --yes http-server -p 8080 .
