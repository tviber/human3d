#!/bin/sh
set -eu

case "${1:-}" in
  '') additional=1 ;;
  --npx) additional=2 ;;
  *) printf '%s\n' 'Usage: sh scripts/check-process-limit.sh [--npx]' >&2; exit 2 ;;
esac

if ! command -v ps >/dev/null 2>&1; then
  printf '%s\n' 'Cannot check the Node/ffmpeg process limit; refusing to start.' >&2
  exit 3
fi
process_list=$(ps -A -o comm=) || {
  printf '%s\n' 'Cannot read the Node/ffmpeg process list; refusing to start.' >&2
  exit 3
}
count=$(printf '%s\n' "$process_list" | tr '[:upper:]' '[:lower:]' | awk '{name=$0; sub(/^.*\//,"",name); if (name ~ /^(node_repl|zcode-node-repl-mcp|node(js)?|npm|npx|pnpm|yarn|bun|tsx|vite|vitest|tsserver|ffmpeg)([[:space:]_.-]|$)/) n++} END {print n+0}')
if [ "$count" -gt "$((4 - additional))" ]; then
  printf 'Refusing to start: %s Node/ffmpeg processes are already active; this command may start %s more, and the machine limit is 4.\n' "$count" "$additional" >&2
  exit 3
fi
